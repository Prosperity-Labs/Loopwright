import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { create_checkpoint, list_checkpoints, rollback_to_checkpoint } from "../src/checkpoint.ts";
import { cleanupDir, makeTempDir, runSync } from "./helpers.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) cleanupDir(tempDirs.pop()!);
});

test("checkpoint create/list/rollback works against git repo", async () => {
  const dir = makeTempDir("loopwright-checkpoint-test");
  tempDirs.push(dir);

  const repoPath = join(dir, "repo");
  const dbPath = join(dir, "sessions.db");

  runSync(dir, ["mkdir", "-p", repoPath]);
  runSync(repoPath, ["git", "init"]);
  runSync(repoPath, ["git", "config", "user.email", "loopwright@example.com"]);
  runSync(repoPath, ["git", "config", "user.name", "Loopwright Test"]);

  writeFileSync(join(repoPath, "tracked.txt"), "v1\n", "utf8");
  runSync(repoPath, ["git", "add", "tracked.txt"]);
  runSync(repoPath, ["git", "commit", "-m", "initial"]);

  const firstSha = runSync(repoPath, ["git", "rev-parse", "HEAD"]).trim();
  const created = await create_checkpoint(repoPath, 1, dbPath, "repo-under-test");
  expect(created.git_sha).toBe(firstSha);
  expect(created.checkpoint_id).toBeGreaterThan(0);

  const checkpoints = list_checkpoints(1, dbPath);
  expect(checkpoints.length).toBe(1);
  expect(checkpoints[0]?.git_sha).toBe(firstSha);

  writeFileSync(join(repoPath, "tracked.txt"), "v2\n", "utf8");
  runSync(repoPath, ["git", "add", "tracked.txt"]);
  runSync(repoPath, ["git", "commit", "-m", "second"]);
  const secondSha = runSync(repoPath, ["git", "rev-parse", "HEAD"]).trim();
  expect(secondSha).not.toBe(firstSha);

  await rollback_to_checkpoint(repoPath, created.checkpoint_id, dbPath);

  const headAfterRollback = runSync(repoPath, ["git", "rev-parse", "HEAD"]).trim();
  expect(headAfterRollback).toBe(firstSha);
});
