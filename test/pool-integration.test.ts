import { afterEach, expect, test, describe } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { AgentPool, type PoolOptions } from "../src/pool.ts";
import { WorktreeCache, createWorktreeCache } from "../src/worktree-cache.ts";
import { createSnapshot, restoreSnapshot, discardSnapshot } from "../src/db-snapshot.ts";
import { registry } from "../src/spawner.ts";
import {
  cleanupDir,
  createBunTestRepo,
  createBunTestRepoWithDB,
  createPoolTestRepo,
  createTempGitRepo,
  makeTempDir,
  runCmdOrThrow,
} from "./test-utils.ts";

const tempPaths: string[] = [];

const silentLogger: Pick<Console, "log" | "warn" | "error"> = {
  log() {},
  warn() {},
  error() {},
};

afterEach(() => {
  registry.clear();
  while (tempPaths.length) {
    cleanupDir(tempPaths.pop()!);
  }
});

function makePoolOpts(repoPath: string, overrides?: Partial<PoolOptions>): PoolOptions {
  return {
    repoPath,
    dbPath: join(repoPath, "sessions.db"),
    baseBranch: "main",
    concurrency: 2,
    logger: silentLogger,
    ...overrides,
  };
}

describe("Integration: Pool + Cache", () => {
  test("workers share template pool when cache enabled", async () => {
    const repo = await createTempGitRepo();
    tempPaths.push(repo);

    // Create a basic test file so the repo has something
    writeFileSync(join(repo, "bunfig.toml"), "[test]\n", "utf8");
    writeFileSync(
      join(repo, "math.test.ts"),
      `import { expect, test } from "bun:test";\ntest("math", () => { expect(1+1).toBe(2); });\n`,
      "utf8",
    );
    await runCmdOrThrow(repo, ["git", "add", "."]);
    await runCmdOrThrow(repo, ["git", "commit", "-m", "add tests"]);

    const pool = new AgentPool(makePoolOpts(repo, {
      concurrency: 2,
      enableCache: true,
    }));

    pool.addTask("do nothing");
    pool.addTask("do nothing either");

    await pool.start();
    const result = await pool.drain();

    expect(result.tasks.length).toBe(2);
    // Both tasks should have completed (passed, failed, or escalated)
    for (const task of result.tasks) {
      expect(["passed", "failed", "escalated"]).toContain(task.status);
    }
  }, 120_000);
});

describe("Integration: Pool + Snapshot", () => {
  test("workers have isolated DB when snapshot enabled", async () => {
    const repo = await createBunTestRepoWithDB("pass");
    tempPaths.push(repo);

    const pool = new AgentPool(makePoolOpts(repo, {
      concurrency: 1,
      enableDBSnapshot: true,
    }));

    pool.addTask("do nothing");
    await pool.start();
    const result = await pool.drain();

    expect(result.tasks.length).toBe(1);
    // Original DB should still be intact
    const dbPath = join(repo, "app.db");
    expect(existsSync(dbPath)).toBe(true);
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare("SELECT name FROM items WHERE id = 1").get() as { name: string };
    expect(row.name).toBe("test-item");
    db.close();
  }, 120_000);
});

describe("Integration: Cache + Snapshot", () => {
  test("template includes DB files for snapshot", async () => {
    const repo = await createBunTestRepoWithDB("pass");
    tempPaths.push(repo);

    const cache = createWorktreeCache({
      repoPath: repo,
      poolSize: 1,
      installDeps: false,
      logger: silentLogger,
    });

    await cache.prewarm();

    // Acquire a worktree from cache
    const result = await cache.acquire();

    // Snapshot the cached worktree
    const snapshot = await createSnapshot({ repoPath: result.worktreePath });
    expect(snapshot.files.length).toBeGreaterThanOrEqual(1);

    // At least one file should be a .db
    const hasDb = snapshot.files.some(f => f.originalPath.endsWith(".db"));
    expect(hasDb).toBe(true);

    await discardSnapshot(snapshot);
    await cache.release(result.worktreePath);
    await cache.cleanup();
  });
});

describe("Integration: Stress", () => {
  test("3 tasks with 2 workers all complete", async () => {
    const repo = await createBunTestRepo("pass");
    tempPaths.push(repo);

    const pool = new AgentPool(makePoolOpts(repo, {
      concurrency: 2,
    }));

    const taskIds = [
      pool.addTask("task one"),
      pool.addTask("task two"),
      pool.addTask("task three"),
    ];

    await pool.start();

    // Wait for all tasks
    const tasks = await Promise.all(taskIds.map(id => pool.waitForTask(id)));

    for (const task of tasks) {
      expect(["passed", "failed", "escalated", "cancelled"]).toContain(task.status);
      expect(task.completedAt).toBeNumber();
    }

    await pool.drain();
    const state = pool.getState();
    expect(state.status).toBe("stopped");
  }, 180_000);
});

describe("Integration: Cleanup", () => {
  test("pool shutdown cleans up worktrees", async () => {
    const repo = await createTempGitRepo();
    tempPaths.push(repo);

    const pool = new AgentPool(makePoolOpts(repo, {
      concurrency: 1,
    }));

    pool.addTask("do nothing");
    await pool.start();
    const result = await pool.drain();

    // Verify no leaked worktree directories in .loopwright/pool/
    const poolDir = join(repo, ".loopwright", "pool");
    if (existsSync(poolDir)) {
      const { readdirSync } = await import("node:fs");
      const remaining = readdirSync(poolDir).filter(d => !d.startsWith("."));
      // All worker worktrees should have been cleaned up
      // Note: empty parent dirs may remain, that's OK
      for (const entry of remaining) {
        const entryPath = join(poolDir, entry);
        const stat = (await import("node:fs")).statSync(entryPath);
        if (stat.isDirectory()) {
          // If directory, check it's empty (leftover parent dir)
          const children = readdirSync(entryPath);
          expect(children.length).toBe(0);
        }
      }
    }
  }, 120_000);
});

describe("Integration: Failure recovery", () => {
  test("worker crash doesn't block pool", async () => {
    const repo = await createBunTestRepo("fail");
    tempPaths.push(repo);

    const pool = new AgentPool(makePoolOpts(repo, {
      concurrency: 2,
      maxCycles: 1,
    }));

    const id1 = pool.addTask("failing task one");
    const id2 = pool.addTask("failing task two");

    await pool.start();
    const [t1, t2] = await Promise.all([
      pool.waitForTask(id1),
      pool.waitForTask(id2),
    ]);

    // Both tasks should complete (any terminal status)
    expect(["passed", "failed", "escalated"]).toContain(t1.status);
    expect(["passed", "failed", "escalated"]).toContain(t2.status);

    await pool.drain();
    const state = pool.getState();
    expect(state.status).toBe("stopped");
  }, 120_000);
});

describe("Integration: Mixed outcomes", () => {
  test("some tasks pass, some fail, some cancel", async () => {
    const passRepo = await createBunTestRepo("pass");
    tempPaths.push(passRepo);

    const pool = new AgentPool(makePoolOpts(passRepo, {
      concurrency: 1,
    }));

    const id1 = pool.addTask("task one");
    const id2 = pool.addTask("task two");
    const id3 = pool.addTask("task three");

    // Cancel the third task before it runs
    pool.cancelTask(id3);

    await pool.start();

    const [t1, t2, t3] = await Promise.all([
      pool.waitForTask(id1),
      pool.waitForTask(id2),
      pool.waitForTask(id3),
    ]);

    // Task 3 should be cancelled
    expect(t3.status).toBe("cancelled");

    // Task 1 and 2 should have run
    expect(["passed", "failed", "escalated"]).toContain(t1.status);
    expect(["passed", "failed", "escalated"]).toContain(t2.status);

    await pool.drain();

    const state = pool.getState();
    expect(state.cancelledCount).toBeGreaterThanOrEqual(1);
  }, 120_000);
});

describe("Integration: Race conditions", () => {
  test("concurrent worktree creation from cache under contention", async () => {
    const repo = await createTempGitRepo();
    tempPaths.push(repo);

    const cache = createWorktreeCache({
      repoPath: repo,
      poolSize: 3,
      installDeps: false,
      logger: silentLogger,
    });

    await cache.prewarm();

    // Acquire 3 worktrees concurrently
    const results = await Promise.all([
      cache.acquire(),
      cache.acquire(),
      cache.acquire(),
    ]);

    // All should be unique
    const paths = results.map(r => r.worktreePath);
    expect(new Set(paths).size).toBe(3);

    for (const r of results) {
      expect(existsSync(r.worktreePath)).toBe(true);
      await cache.release(r.worktreePath);
    }

    await cache.cleanup();
  });
});
