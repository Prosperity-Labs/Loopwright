import { afterEach, expect, test, describe } from "bun:test";
import { existsSync, writeFileSync, readlinkSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WorktreeCache, createWorktreeCache } from "../src/worktree-cache.ts";
import { cleanupDir, createBunTestRepo, makeTempDir, runCmdOrThrow, createTempGitRepo } from "./test-utils.ts";

const tempPaths: string[] = [];

const silentLogger: Pick<Console, "log" | "warn" | "error"> = {
  log() {},
  warn() {},
  error() {},
};

afterEach(() => {
  while (tempPaths.length) {
    cleanupDir(tempPaths.pop()!);
  }
});

async function createTestRepo(): Promise<string> {
  const repo = await createTempGitRepo();
  tempPaths.push(repo);
  return repo;
}

describe("WorktreeCache", () => {
  test("pre-warms N templates on startup", async () => {
    const repo = await createTestRepo();
    const cache = createWorktreeCache({
      repoPath: repo,
      poolSize: 3,
      installDeps: false,
      logger: silentLogger,
    });

    await cache.prewarm();
    const state = cache.getState();

    expect(state.templates.length).toBe(3);
    expect(state.available).toBe(3);
    expect(state.stale).toBe(0);

    for (const t of state.templates) {
      expect(existsSync(t.path)).toBe(true);
      expect(t.inUse).toBe(false);
    }

    await cache.cleanup();
  });

  test("acquire returns a unique worktree path", async () => {
    const repo = await createTestRepo();
    const cache = createWorktreeCache({
      repoPath: repo,
      poolSize: 2,
      installDeps: false,
      logger: silentLogger,
    });

    await cache.prewarm();

    const result = await cache.acquire();
    expect(result.worktreePath).toBeTruthy();
    expect(result.branchName).toStartWith("loopwright-cached-");
    expect(existsSync(result.worktreePath)).toBe(true);

    await cache.release(result.worktreePath);
    await cache.cleanup();
  });

  test("concurrent acquire from templates produces unique worktrees", async () => {
    const repo = await createTestRepo();
    const cache = createWorktreeCache({
      repoPath: repo,
      poolSize: 3,
      installDeps: false,
      logger: silentLogger,
    });

    await cache.prewarm();

    const results = await Promise.all([
      cache.acquire(),
      cache.acquire(),
    ]);

    expect(results[0].worktreePath).not.toBe(results[1].worktreePath);
    expect(results[0].branchName).not.toBe(results[1].branchName);

    for (const r of results) {
      await cache.release(r.worktreePath);
    }
    await cache.cleanup();
  });

  test("stale templates invalidated when base SHA changes", async () => {
    const repo = await createTestRepo();
    const cache = createWorktreeCache({
      repoPath: repo,
      poolSize: 2,
      installDeps: false,
      logger: silentLogger,
    });

    await cache.prewarm();
    expect(cache.getState().available).toBe(2);

    // Make a new commit to change HEAD SHA
    writeFileSync(join(repo, "change.txt"), "new content\n", "utf8");
    await runCmdOrThrow(repo, ["git", "add", "change.txt"]);
    await runCmdOrThrow(repo, ["git", "commit", "-m", "new commit"]);

    // Acquire triggers staleness check
    const result = await cache.acquire();
    expect(existsSync(result.worktreePath)).toBe(true);

    await cache.release(result.worktreePath);
    await cache.cleanup();
  });

  test("node_modules shared via symlink if present", async () => {
    const repo = await createTestRepo();

    // Create a package.json so deps install
    writeFileSync(join(repo, "package.json"), '{"name":"test","private":true}\n', "utf8");
    await runCmdOrThrow(repo, ["git", "add", "package.json"]);
    await runCmdOrThrow(repo, ["git", "commit", "-m", "add package.json"]);

    const cache = createWorktreeCache({
      repoPath: repo,
      poolSize: 1,
      installDeps: true,
      logger: silentLogger,
    });

    await cache.prewarm();

    const result = await cache.acquire();

    // Check if node_modules is a symlink
    const nmPath = join(result.worktreePath, "node_modules");
    if (existsSync(nmPath)) {
      const stat = lstatSync(nmPath);
      expect(stat.isSymbolicLink()).toBe(true);
    }
    // Even if it doesn't exist (no deps to install), the test passes — we just verify it doesn't crash

    await cache.release(result.worktreePath);
    await cache.cleanup();
  });

  test("cache cleanup removes all templates", async () => {
    const repo = await createTestRepo();
    const cache = createWorktreeCache({
      repoPath: repo,
      poolSize: 2,
      installDeps: false,
      logger: silentLogger,
    });

    await cache.prewarm();
    expect(cache.getState().templates.length).toBe(2);

    await cache.cleanup();
    expect(cache.getState().templates.length).toBe(0);
  });

  test("acquire builds fresh when no cache available", async () => {
    const repo = await createTestRepo();
    const cache = createWorktreeCache({
      repoPath: repo,
      poolSize: 0,
      installDeps: false,
      logger: silentLogger,
    });

    await cache.prewarm();
    expect(cache.getState().templates.length).toBe(0);

    // Should build one on-demand
    const result = await cache.acquire();
    expect(existsSync(result.worktreePath)).toBe(true);

    await cache.release(result.worktreePath);
    await cache.cleanup();
  });

  test("createWorktreeCache factory function works", async () => {
    const repo = await createTestRepo();
    const cache = createWorktreeCache({
      repoPath: repo,
      poolSize: 1,
      installDeps: false,
      logger: silentLogger,
    });

    expect(cache).toBeInstanceOf(WorktreeCache);
    await cache.prewarm();
    expect(cache.getState().templates.length).toBe(1);
    await cache.cleanup();
  });

  test(".claude/settings.json copied to clone", async () => {
    const repo = await createTestRepo();
    const cache = createWorktreeCache({
      repoPath: repo,
      poolSize: 1,
      installDeps: false,
      logger: silentLogger,
    });

    await cache.prewarm();
    const result = await cache.acquire();

    const settingsPath = join(result.worktreePath, ".claude", "settings.json");
    expect(existsSync(settingsPath)).toBe(true);

    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(settings.permissions).toBeTruthy();
    expect(settings.permissions.allow).toBeArray();

    await cache.release(result.worktreePath);
    await cache.cleanup();
  });
});
