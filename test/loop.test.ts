import { afterEach, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openLoopwrightDb, LoopwrightDB } from "../src/db.ts";
import { runLoop } from "../src/loop.ts";
import { registry } from "../src/spawner.ts";
import { cleanupDir, createTempGitRepo, runCmdOrThrow } from "./test-utils.ts";

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
