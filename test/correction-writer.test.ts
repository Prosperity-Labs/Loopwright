import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { writeCorrectionCycle } from "../src/correction-writer.ts";
import { openLoopwrightDb } from "../src/db.ts";
import { cleanupDir, makeTempDir } from "../tests/helpers.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) cleanupDir(tempDirs.pop()!);
});

function makeTestResult(overrides: Partial<import("../src/test-runner.ts").TestResult> = {}): import("../src/test-runner.ts").TestResult {
  return {
    passed: false,
    exit_code: 1,
    test_command: "bun test",
    changed_files: ["src/foo.ts"],
    errors: [{
      file: "src/foo.test.ts",
      line: 42,
      type: "AssertionError",
      message: "expected 1 to be 2",
    }],
    stdout_tail: "stdout",
    stderr_tail: "stderr",
    duration_ms: 2300,
    ...overrides,
  };
}

test("writeCorrectionCycle inserts row with correct cycle_number", () => {
  const dir = makeTempDir("loopwright-correction");
  tempDirs.push(dir);
  const db = openLoopwrightDb(join(dir, "sessions.db"));

  try {
    const worktreeId = db.upsertWorktree({ branch_name: "test-branch" });
    const result = writeCorrectionCycle({ db, worktreeId, testResult: makeTestResult() });

    expect(result.cycleNumber).toBe(1);
    const row = db.getLatestCorrectionCycle(worktreeId);
    expect(row?.cycle_number).toBe(1);
    expect(row?.outcome).toBe("failed");
  } finally {
    db.close();
  }
});

test("second call increments cycle_number", () => {
  const dir = makeTempDir("loopwright-correction");
  tempDirs.push(dir);
  const db = openLoopwrightDb(join(dir, "sessions.db"));

  try {
    const worktreeId = db.upsertWorktree({ branch_name: "test-branch" });
    writeCorrectionCycle({ db, worktreeId, testResult: makeTestResult() });
    const second = writeCorrectionCycle({ db, worktreeId, testResult: makeTestResult() });
    expect(second.cycleNumber).toBe(2);
  } finally {
    db.close();
  }
});

test("shouldContinue is false when tests pass", () => {
  const dir = makeTempDir("loopwright-correction");
  tempDirs.push(dir);
  const db = openLoopwrightDb(join(dir, "sessions.db"));

  try {
    const worktreeId = db.upsertWorktree({ branch_name: "test-branch" });
    const result = writeCorrectionCycle({
      db,
      worktreeId,
      testResult: makeTestResult({ passed: true, exit_code: 0, errors: [] }),
    });
    expect(result.shouldContinue).toBe(false);
    expect(db.getLatestCorrectionCycle(worktreeId)?.outcome).toBe("passed");
  } finally {
    db.close();
  }
});

test("shouldContinue is false when cycle_number >= 3", () => {
  const dir = makeTempDir("loopwright-correction");
  tempDirs.push(dir);
  const db = openLoopwrightDb(join(dir, "sessions.db"));

  try {
    const worktreeId = db.upsertWorktree({ branch_name: "test-branch" });
    writeCorrectionCycle({ db, worktreeId, testResult: makeTestResult() });
    writeCorrectionCycle({ db, worktreeId, testResult: makeTestResult() });
    const third = writeCorrectionCycle({ db, worktreeId, testResult: makeTestResult() });
    expect(third.cycleNumber).toBe(3);
    expect(third.shouldContinue).toBe(false);
  } finally {
    db.close();
  }
});

test("error_context JSON is properly stored and retrievable", () => {
  const dir = makeTempDir("loopwright-correction");
  tempDirs.push(dir);
  const db = openLoopwrightDb(join(dir, "sessions.db"));

  try {
    const worktreeId = db.upsertWorktree({ branch_name: "test-branch" });
    writeCorrectionCycle({ db, worktreeId, testResult: makeTestResult() });

    const row = db.getLatestCorrectionCycle(worktreeId);
    expect(row).toBeTruthy();
    const parsed = JSON.parse(row!.error_context ?? "{}") as Record<string, unknown>;
    expect(parsed.test_command).toBe("bun test");
    expect(parsed.exit_code).toBe(1);
    expect(Array.isArray(parsed.errors)).toBe(true);
    expect(Array.isArray(parsed.changed_files)).toBe(true);
  } finally {
    db.close();
  }
});
