import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { correctOrEscalate, buildCorrectionBrief, findEngramPython } from "../src/corrector.ts";
import { openLoopwrightDb } from "../src/db.ts";
import { registry } from "../src/spawner.ts";
import type { TestResult } from "../src/test-runner.ts";
import { cleanupDir, makeTempDir } from "../tests/helpers.ts";

const tempDirs: string[] = [];

afterEach(() => {
  registry.clear();
  while (tempDirs.length) cleanupDir(tempDirs.pop()!);
});

function makeTestResult(overrides: Partial<TestResult> = {}): TestResult {
  return {
    passed: false,
    exit_code: 1,
    test_command: "bun test",
    changed_files: ["src/foo.ts"],
    errors: [
      {
        file: "src/foo.test.ts",
        line: 42,
        type: "AssertionError",
        message: "expected 1 to be 2",
      },
    ],
    stdout_tail: "1 failing",
    stderr_tail: "error: expected 1 to be 2\n  at src/foo.test.ts:42:5",
    duration_ms: 2300,
    ...overrides,
  };
}

function setupTempGitDir(): { dir: string; dbPath: string; eventsPath: string } {
  const dir = makeTempDir("loopwright-corrector");
  tempDirs.push(dir);
  Bun.spawnSync({ cmd: ["git", "init"], cwd: dir, stdout: "ignore", stderr: "ignore" });
  Bun.spawnSync({ cmd: ["git", "checkout", "-b", "main"], cwd: dir, stdout: "ignore", stderr: "ignore" });
  Bun.spawnSync({ cmd: ["git", "config", "user.email", "test@example.com"], cwd: dir, stdout: "ignore", stderr: "ignore" });
  Bun.spawnSync({ cmd: ["git", "config", "user.name", "Test"], cwd: dir, stdout: "ignore", stderr: "ignore" });
  writeFileSync(join(dir, "README.md"), "# test\n", "utf8");
  Bun.spawnSync({ cmd: ["git", "add", "."], cwd: dir, stdout: "ignore", stderr: "ignore" });
  Bun.spawnSync({ cmd: ["git", "commit", "-m", "init"], cwd: dir, stdout: "ignore", stderr: "ignore" });

  const dbPath = join(dir, "sessions.db");
  const eventsPath = join(dir, "events.jsonl");
  return { dir, dbPath, eventsPath };
}

test("correctOrEscalate returns 'passed' when tests pass", async () => {
  const { dir, dbPath, eventsPath } = setupTempGitDir();
  const db = openLoopwrightDb(dbPath);

  try {
    const worktreeId = db.upsertWorktree({ branch_name: "test-branch" });

    const result = await correctOrEscalate({
      db,
      worktreeId,
      worktreePath: dir,
      testResult: makeTestResult({ passed: true, exit_code: 0, errors: [] }),
      dbPath,
      eventsPath,
      repoName: "test-repo",
    });

    expect(result.action).toBe("passed");
    expect(result.cycleNumber).toBe(1);
    expect(result.checkpointId).toBeGreaterThan(0);

    const worktree = db.getWorktreeById(worktreeId);
    expect(worktree?.status).toBe("passed");
    expect(worktree?.resolved_at).toBeTruthy();
  } finally {
    db.close();
  }
});

test("correctOrEscalate returns 'escalated' at max cycles", async () => {
  const { dir, dbPath, eventsPath } = setupTempGitDir();
  const db = openLoopwrightDb(dbPath);

  try {
    const worktreeId = db.upsertWorktree({ branch_name: "test-branch" });

    db.insertCorrectionCycle({
      worktree_id: worktreeId,
      cycle_number: 1,
      trigger_error: "previous error 1",
      outcome: "failed",
    });
    db.insertCorrectionCycle({
      worktree_id: worktreeId,
      cycle_number: 2,
      trigger_error: "previous error 2",
      outcome: "failed",
    });

    const result = await correctOrEscalate({
      db,
      worktreeId,
      worktreePath: dir,
      testResult: makeTestResult(),
      dbPath,
      eventsPath,
      maxCycles: 3,
      commandOverride: ["echo", "correction-agent"],
    });

    expect(result.action).toBe("escalated");
    expect(result.cycleNumber).toBe(3);
    expect(result.triggerError).toContain("AssertionError");

    const worktree = db.getWorktreeById(worktreeId);
    expect(worktree?.status).toBe("escalated");
  } finally {
    db.close();
  }
});

test("correctOrEscalate returns 'corrected' and spawns agent", async () => {
  const { dir, dbPath, eventsPath } = setupTempGitDir();
  const db = openLoopwrightDb(dbPath);

  try {
    const worktreeId = db.upsertWorktree({ branch_name: "test-branch" });

    const result = await correctOrEscalate({
      db,
      worktreeId,
      worktreePath: dir,
      testResult: makeTestResult(),
      dbPath,
      eventsPath,
      agentType: "claude",
      commandOverride: ["echo", "correction-agent"],
    });

    expect(result.action).toBe("corrected");
    expect(result.cycleNumber).toBe(1);
    expect(result.spawnedAgent).toBeTruthy();
    expect(result.spawnedAgent!.agentType).toBe("claude");
    expect(result.triggerError).toContain("AssertionError");

    const claudeMd = join(dir, "CLAUDE.md");
    expect(existsSync(claudeMd)).toBe(true);
    const content = readFileSync(claudeMd, "utf8");
    expect(content).toContain("ENGRAM_CORRECTION_BRIEF:cycle_1");
    expect(content).toContain("Cycle 1");

    await result.spawnedAgent!.process.exited;
  } finally {
    db.close();
  }
});

test("triggerError is formatted correctly from TestResult errors", async () => {
  const { dir, dbPath, eventsPath } = setupTempGitDir();
  const db = openLoopwrightDb(dbPath);

  try {
    // Each sub-case gets its own worktree to avoid accumulating correction cycles
    const wt1 = db.upsertWorktree({ branch_name: "test-trigger-1" });
    const withLineErr = await correctOrEscalate({
      db,
      worktreeId: wt1,
      worktreePath: dir,
      testResult: makeTestResult({
        errors: [{ file: "src/app.ts", line: 10, type: "TypeError", message: "x is not a function" }],
      }),
      dbPath,
      eventsPath,
      commandOverride: ["echo", "correction-agent"],
    });
    expect(withLineErr.triggerError).toBe("TypeError: x is not a function at src/app.ts:10");
    await withLineErr.spawnedAgent?.process.exited;

    const wt2 = db.upsertWorktree({ branch_name: "test-trigger-2" });
    const noLineErr = await correctOrEscalate({
      db,
      worktreeId: wt2,
      worktreePath: dir,
      testResult: makeTestResult({
        errors: [{ file: "unknown", line: null, type: "ImportError", message: "no module" }],
      }),
      dbPath,
      eventsPath,
      commandOverride: ["echo", "correction-agent"],
    });
    expect(noLineErr.triggerError).toBe("ImportError: no module at unknown");
    await noLineErr.spawnedAgent?.process.exited;

    const wt3 = db.upsertWorktree({ branch_name: "test-trigger-3" });
    const noErrors = await correctOrEscalate({
      db,
      worktreeId: wt3,
      worktreePath: dir,
      testResult: makeTestResult({ errors: [], exit_code: 137 }),
      dbPath,
      eventsPath,
      commandOverride: ["echo", "correction-agent"],
    });
    expect(noErrors.triggerError).toBe("Test failed with exit code 137");
    await noErrors.spawnedAgent?.process.exited;
  } finally {
    db.close();
  }
});

const engramPython = "/home/prosperitylabs/Desktop/development/engram/.venv/bin/python3";
const skipPython = !existsSync(engramPython);

test("buildCorrectionBrief calls Engram Python", async () => {
  if (skipPython) {
    console.log("Skipping: Engram Python venv not found at", engramPython);
    return;
  }

  const { dir, dbPath } = setupTempGitDir();
  writeFileSync(join(dir, "CLAUDE.md"), "# Project\n", "utf8");

  const result = await buildCorrectionBrief({
    engramDbPath: dbPath,
    engramPythonPath: engramPython,
    worktreeId: 1,
    cycleNumber: 1,
    triggerError: "AssertionError: expected 1 to be 2 at src/foo.test.ts:42",
    errorContext: {
      errors: [{ file: "src/foo.test.ts", line: 42, type: "AssertionError", message: "expected 1 to be 2" }],
      test_command: "bun test",
      exit_code: 1,
    },
    worktreePath: dir,
    project: "test-project",
  });

  expect(result.cycle_number).toBe(1);

  const claudeMd = readFileSync(join(dir, "CLAUDE.md"), "utf8");
  expect(claudeMd).toContain("ENGRAM_CORRECTION_BRIEF:cycle_1");
});

test("findEngramPython returns override when provided", () => {
  expect(findEngramPython("/custom/python3")).toBe("/custom/python3");
});

test("findEngramPython falls back to python3 when no venv found", () => {
  const result = findEngramPython(undefined);
  if (existsSync("/home/prosperitylabs/Desktop/development/engram/.venv/bin/python3")) {
    expect(result).toBe("/home/prosperitylabs/Desktop/development/engram/.venv/bin/python3");
  } else if (existsSync("/home/prosperitylabs/Desktop/development/engram/.venv/bin/python")) {
    expect(result).toBe("/home/prosperitylabs/Desktop/development/engram/.venv/bin/python");
  } else {
    expect(result).toBe("python3");
  }
});
