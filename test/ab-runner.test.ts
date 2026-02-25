import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { removeWorktree, runABTest } from "../src/ab-runner.ts";
import { cleanupDir, createTempGitRepo } from "./test-utils.ts";

const tempPaths: string[] = [];

afterEach(() => {
  while (tempPaths.length) {
    const path = tempPaths.pop();
    if (path) cleanupDir(path);
  }
});

test("runABTest creates two worktrees, runs concurrent agents, and cleanup removes them", async () => {
  const repoPath = await createTempGitRepo();
  tempPaths.push(repoPath);
  const dbPath = join(repoPath, "sessions.db");

  const started = performance.now();
  const result = await runABTest({
    task_prompt: "write a file",
    repo_path: repoPath,
    db_path: dbPath,
    agent_command_factory: () => ["bash", "-lc", "sleep 0.25; echo ok > ab-output.txt"],
  });
  const elapsed = performance.now() - started;

  expect(result.a.worktree_id).toBeGreaterThan(0);
  expect(result.b.worktree_id).toBeGreaterThan(0);
  expect(result.a.changed_files).toContain("ab-output.txt");
  expect(result.b.changed_files).toContain("ab-output.txt");
  expect(existsSync(result.a.worktree_path)).toBe(true);
  expect(existsSync(result.b.worktree_path)).toBe(true);
  expect(elapsed).toBeLessThan(480);

  await removeWorktree(repoPath, result.a.worktree_path);
  await removeWorktree(repoPath, result.b.worktree_path);

  expect(existsSync(result.a.worktree_path)).toBe(false);
  expect(existsSync(result.b.worktree_path)).toBe(false);
});
