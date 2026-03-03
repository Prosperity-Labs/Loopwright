import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openLoopwrightDb, LoopwrightDB } from "../src/db.ts";
import { runLoop, writePermissionsFile, writePreSpawnClaudeMd, extractMeasurements } from "../src/loop.ts";
import { registry } from "../src/spawner.ts";
import { cleanupDir, createTempGitRepo, runCmdOrThrow, makeTempDir } from "./test-utils.ts";

const tempPaths: string[] = [];

const silentLogger: Pick<Console, "log" | "warn" | "error"> = {
  log() {},
  warn() {},
  error() {},
};

// Mock agent that creates a file change (commit) so the loop doesn't escalate for no-change
const MOCK_AGENT_WITH_CHANGES = ["bash", "-c", "echo x >> feature.ts && git add feature.ts && git commit -m feat"];

afterEach(() => {
  registry.clear();
  while (tempPaths.length) {
    cleanupDir(tempPaths.pop()!);
  }
});

async function createBunTestRepo(kind: "pass" | "fail"): Promise<string> {
  const repo = await createTempGitRepo();
  tempPaths.push(repo);

  writeFileSync(join(repo, "bunfig.toml"), "[test]\n", "utf8");
  writeFileSync(
    join(repo, "math.test.ts"),
    kind === "pass"
      ? `import { expect, test } from "bun:test";\n\ntest("math", () => {\n  expect(1 + 1).toBe(2);\n});\n`
      : `import { expect, test } from "bun:test";\n\ntest("math", () => {\n  expect(1 + 1).toBe(3);\n});\n`,
    "utf8",
  );

  await runCmdOrThrow(repo, ["git", "add", "bunfig.toml", "math.test.ts"]);
  await runCmdOrThrow(repo, ["git", "commit", "-m", `add ${kind} test`]);
  return repo;
}

test("Loop with passing agent returns passed", async () => {
  const repoPath = await createBunTestRepo("pass");
  const dbPath = join(repoPath, "sessions.db");

  const result = await runLoop({
    repoPath,
    dbPath,
    taskPrompt: "do nothing",
    commandOverride: MOCK_AGENT_WITH_CHANGES,
    logger: silentLogger,
  });

  expect(result.status).toBe("passed");
  expect(result.totalCycles).toBe(0);
  expect(result.finalCheckpoint).toBeTruthy();
  expect(result.cycles.length).toBe(1);
  expect(result.cycles[0]?.action).toBe("initial");
  expect(result.cycles[0]?.checkpointId).toBeNumber();

  const db = openLoopwrightDb(dbPath);
  try {
    const worktree = db.getWorktreeById(result.worktreeId);
    expect(worktree?.status).toBe("passed");
    expect(db.listCheckpoints(result.worktreeId).length).toBe(1);
  } finally {
    db.close();
  }
});

test("Loop escalates after max cycles", async () => {
  const repoPath = await createBunTestRepo("fail");
  const dbPath = join(repoPath, "sessions.db");

  const result = await runLoop({
    repoPath,
    dbPath,
    taskPrompt: "do nothing",
    maxCycles: 1,
    commandOverride: MOCK_AGENT_WITH_CHANGES,
    logger: silentLogger,
  });

  expect(result.status).toBe("escalated");
  expect(result.totalCycles).toBe(1);
  expect(result.cycles.length).toBe(2);
  expect(result.cycles[0]?.action).toBe("initial");
  expect(result.cycles[1]?.action).toBe("correction");

  const db = openLoopwrightDb(dbPath);
  try {
    const worktree = db.getWorktreeById(result.worktreeId);
    expect(worktree?.status).toBe("escalated");
    expect(db.getCorrectionCycleCount(result.worktreeId)).toBe(1);
  } finally {
    db.close();
  }
});

test("Loop creates worktree and branch", async () => {
  const repoPath = await createBunTestRepo("pass");
  const dbPath = join(repoPath, "sessions.db");

  const result = await runLoop({
    repoPath,
    dbPath,
    taskPrompt: "noop",
    commandOverride: MOCK_AGENT_WITH_CHANGES,
    logger: silentLogger,
  });

  expect(existsSync(result.worktreePath)).toBe(true);
  expect(result.branchName).toMatch(/^loopwright-\d+$/);
  expect(result.worktreePath).toContain(`${join(".loopwright", "runs")}`);

  const branch = (await runCmdOrThrow(result.worktreePath, ["git", "rev-parse", "--abbrev-ref", "HEAD"])).trim();
  expect(branch).toBe(result.branchName);
});

test("Loop records all cycles in result", async () => {
  const repoPath = await createBunTestRepo("fail");
  const dbPath = join(repoPath, "sessions.db");

  const result = await runLoop({
    repoPath,
    dbPath,
    taskPrompt: "noop",
    maxCycles: 2,
    commandOverride: MOCK_AGENT_WITH_CHANGES,
    logger: silentLogger,
  });

  expect(result.status).toBe("escalated");
  expect(result.totalCycles).toBe(2);
  expect(result.cycles.length).toBe(3);
  expect(result.cycles.map((c) => c.action)).toEqual(["initial", "correction", "correction"]);
  expect(result.cycles.map((c) => c.cycleNumber)).toEqual([0, 1, 2]);
});

test("Loop escalates immediately when agent makes no changes", async () => {
  const repoPath = await createBunTestRepo("pass");
  const dbPath = join(repoPath, "sessions.db");

  const result = await runLoop({
    repoPath,
    dbPath,
    taskPrompt: "do nothing",
    commandOverride: ["echo", "done"],
    logger: silentLogger,
  });

  expect(result.status).toBe("escalated");
  expect(result.totalCycles).toBe(0);
  expect(result.cycles.length).toBe(1);
  expect(result.cycles[0]?.action).toBe("initial");
  expect(result.cycles[0]?.passed).toBe(true); // tests were skipped (no changes)
  expect(result.finalCheckpoint).toBeUndefined();

  const db = openLoopwrightDb(dbPath);
  try {
    const worktree = db.getWorktreeById(result.worktreeId);
    expect(worktree?.status).toBe("escalated");
  } finally {
    db.close();
  }
});

test("Loop cleans up DB on all exit paths", async () => {
  const originalClose = LoopwrightDB.prototype.close;
  let closeCalls = 0;

  LoopwrightDB.prototype.close = function patchedClose(this: LoopwrightDB): void {
    closeCalls += 1;
    return originalClose.call(this);
  };

  try {
    const passRepo = await createBunTestRepo("pass");
    await runLoop({
      repoPath: passRepo,
      dbPath: join(passRepo, "sessions.db"),
      taskPrompt: "noop",
      commandOverride: MOCK_AGENT_WITH_CHANGES,
      logger: silentLogger,
    });

    const failRepo = await createBunTestRepo("fail");
    await runLoop({
      repoPath: failRepo,
      dbPath: join(failRepo, "sessions.db"),
      taskPrompt: "noop",
      maxCycles: 1,
      commandOverride: MOCK_AGENT_WITH_CHANGES,
      logger: silentLogger,
    });
  } finally {
    LoopwrightDB.prototype.close = originalClose;
  }

  expect(closeCalls).toBeGreaterThanOrEqual(3);
});

// --- Fix 1: Atomic Prompt (CLAUDE.md in worktree) ---

test("writePreSpawnClaudeMd creates CLAUDE.md with full task and measurements header", () => {
  const dir = makeTempDir("claude-md-");
  tempPaths.push(dir);

  writePreSpawnClaudeMd(dir, "Add a logout button to the navbar with confirmation dialog", "test-task-42");

  const content = readFileSync(join(dir, "CLAUDE.md"), "utf8");
  expect(content).toContain("TASK_ID: test-task-42");
  expect(content).toContain("STARTED_AT:");
  expect(content).toContain("METRIC: tool_calls / files_changed / tests_passed");
  expect(content).toContain("## Full Task");
  expect(content).toContain("Add a logout button to the navbar with confirmation dialog");
  expect(content).toContain("## Record when done");
  expect(content).toContain("- tool_calls_made:");
  expect(content).toContain("- files_changed:");
  expect(content).toContain("- tests_passed:");
  expect(content).toContain("- tests_failed:");
  expect(content).toContain("- unexpected_behaviors:");
});

test("writePreSpawnClaudeMd generates UUID when no taskId provided", () => {
  const dir = makeTempDir("claude-md-uuid-");
  tempPaths.push(dir);

  writePreSpawnClaudeMd(dir, "some task");
  const content = readFileSync(join(dir, "CLAUDE.md"), "utf8");

  // Should have a UUID-format TASK_ID
  const match = content.match(/TASK_ID: (.+)/);
  expect(match).toBeTruthy();
  expect(match![1].length).toBeGreaterThanOrEqual(36);
});

// --- Fix 2: Pre-approve Permissions ---

test("writePermissionsFile creates .claude/settings.json with allow list", () => {
  const dir = makeTempDir("perms-");
  tempPaths.push(dir);

  writePermissionsFile(dir);

  const settingsPath = join(dir, ".claude", "settings.json");
  expect(existsSync(settingsPath)).toBe(true);

  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  expect(settings.permissions).toBeTruthy();
  expect(settings.permissions.allow).toBeArray();
  expect(settings.permissions.allow).toContain("Bash(bun test*)");
  expect(settings.permissions.allow).toContain("Bash(pytest*)");
  expect(settings.permissions.allow).toContain("Read");
  expect(settings.permissions.allow).toContain("Write");
  expect(settings.permissions.allow).toContain("Edit");
});

// --- Fix 3: Measurement Tracking ---

test("extractMeasurements returns section content when present", () => {
  const dir = makeTempDir("measure-");
  tempPaths.push(dir);

  writeFileSync(join(dir, "CLAUDE.md"), `# Loopwright Task

TASK_ID: abc
STARTED_AT: 2026-03-02T00:00:00Z

## Full Task
Do something

## Record when done
- tool_calls_made: 5
- files_changed: 2
- tests_passed: 3
- tests_failed: 0
- unexpected_behaviors: none
`, "utf8");

  const result = extractMeasurements(dir);
  expect(result).toBeTruthy();
  expect(result).toContain("tool_calls_made: 5");
  expect(result).toContain("files_changed: 2");
  expect(result).toContain("tests_passed: 3");
});

test("extractMeasurements returns undefined when CLAUDE.md missing", () => {
  const dir = makeTempDir("measure-missing-");
  tempPaths.push(dir);

  expect(extractMeasurements(dir)).toBeUndefined();
});

test("extractMeasurements returns undefined when section not present", () => {
  const dir = makeTempDir("measure-nosection-");
  tempPaths.push(dir);

  writeFileSync(join(dir, "CLAUDE.md"), "# Just a regular file\n\nNo measurements here.\n", "utf8");
  expect(extractMeasurements(dir)).toBeUndefined();
});

test("agent_context column stored in correction_cycles", () => {
  const dir = makeTempDir("db-ctx-");
  tempPaths.push(dir);

  const db = openLoopwrightDb(join(dir, "sessions.db"));
  try {
    const wtId = db.upsertWorktree({ branch_name: "test-branch" });
    const cycleId = db.insertCorrectionCycle({
      worktree_id: wtId,
      cycle_number: 1,
      trigger_error: "test error",
      agent_context: "- tool_calls_made: 10\n- files_changed: 3",
    });

    const cycles = db.getCorrectionCycles(wtId);
    expect(cycles.length).toBe(1);
    expect(cycles[0].agent_context).toBe("- tool_calls_made: 10\n- files_changed: 3");

    const latest = db.getLatestCorrectionCycle(wtId);
    expect(latest?.agent_context).toBe("- tool_calls_made: 10\n- files_changed: 3");
  } finally {
    db.close();
  }
});

test("Loop creates CLAUDE.md and .claude/settings.json in worktree", async () => {
  const repoPath = await createBunTestRepo("pass");
  const dbPath = join(repoPath, "sessions.db");

  const result = await runLoop({
    repoPath,
    dbPath,
    taskPrompt: "Add a feature with full context test",
    commandOverride: MOCK_AGENT_WITH_CHANGES,
    logger: silentLogger,
  });

  // CLAUDE.md should exist in worktree
  expect(existsSync(join(result.worktreePath, "CLAUDE.md"))).toBe(true);
  const claudeContent = readFileSync(join(result.worktreePath, "CLAUDE.md"), "utf8");
  expect(claudeContent).toContain("Add a feature with full context test");

  // .claude/settings.json should exist
  expect(existsSync(join(result.worktreePath, ".claude", "settings.json"))).toBe(true);
});
