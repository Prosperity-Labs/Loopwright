import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { compareWorktrees } from "../src/ab-compare.ts";
import { openLoopwrightDb } from "../src/db.ts";
import { cleanupDir, createBranchCommit, createTempGitRepo } from "./test-utils.ts";

const tempPaths: string[] = [];

afterEach(() => {
  while (tempPaths.length) {
    const path = tempPaths.pop();
    if (path) cleanupDir(path);
  }
});

test("compareWorktrees returns JSON and markdown report and persists comparison", async () => {
  const repoPath = await createTempGitRepo();
  tempPaths.push(repoPath);
  await createBranchCommit(repoPath, "cmp-a", "feature-a.txt", "A\n");
  await createBranchCommit(repoPath, "cmp-b", "feature-b.txt", "B\n");

  const dbPath = join(repoPath, "sessions.db");
  const db = openLoopwrightDb(dbPath);
  const worktreeAId = db.upsertWorktree({
    session_id: "sess-a",
    branch_name: "cmp-a",
    base_branch: "main",
    status: "passed",
    task_description: "compare test",
  });
  const worktreeBId = db.upsertWorktree({
    session_id: "sess-b",
    branch_name: "cmp-b",
    base_branch: "main",
    status: "failed",
    task_description: "compare test",
  });
  db.insertCheckpoint({
    worktree_id: worktreeAId,
    git_sha: "sha-a",
    graph_delta: { changed_files: ["feature-a.txt"] },
  });
  db.insertCheckpoint({
    worktree_id: worktreeBId,
    git_sha: "sha-b",
    graph_delta: { changed_files: ["feature-b.txt"] },
  });
  db.insertArtifact({
    worktree_id: worktreeAId,
    session_id: "sess-a",
    file_path: "__ab_runner__/result.json",
    event_type: "ab_result",
    metadata_json: { duration_ms: 1000, error_count: 0, exit_code: 0 },
  });
  db.insertArtifact({
    worktree_id: worktreeBId,
    session_id: "sess-b",
    file_path: "__ab_runner__/result.json",
    event_type: "ab_result",
    metadata_json: { duration_ms: 2200, error_count: 1, exit_code: 1 },
  });
  db.close();

  const report = await compareWorktrees({
    worktree_a_id: worktreeAId,
    worktree_b_id: worktreeBId,
    repo_path: repoPath,
    db_path: dbPath,
  });

  expect(report.comparison_id).toBeGreaterThan(0);
  expect(report.json.duration.a_seconds).toBe(1);
  expect(report.json.duration.b_seconds).toBe(2.2);
  expect(report.json.files_touched.a).toEqual(["feature-a.txt"]);
  expect(report.json.files_touched.b).toEqual(["feature-b.txt"]);
  expect(report.json.errors.a).toBe(0);
  expect(report.json.errors.b).toBe(1);
  expect(report.markdown).toContain("A/B Comparison Report");
  expect(report.markdown).toContain("## Diff");

  const dbVerify = openLoopwrightDb(dbPath);
  const saved = dbVerify.getLatestComparisonForPair(worktreeAId, worktreeBId);
  dbVerify.close();
  expect(saved).toBeDefined();
});
