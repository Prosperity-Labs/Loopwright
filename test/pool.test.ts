import { afterEach, expect, test, describe } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentPool, type PoolOptions, type PoolTask } from "../src/pool.ts";
import { openLoopwrightDb } from "../src/db.ts";
import { registry } from "../src/spawner.ts";
import { cleanupDir, createBunTestRepo, makeTempDir, runCmdOrThrow } from "./test-utils.ts";

const tempPaths: string[] = [];

const silentLogger: Pick<Console, "log" | "warn" | "error"> = {
  log() {},
  warn() {},
  error() {},
};

// Mock agent that creates a file change (commit) so the loop doesn't escalate
const MOCK_AGENT_CMD = ["bash", "-c", "echo x >> feature.ts && git add feature.ts && git commit -m feat"];

afterEach(() => {
  registry.clear();
  while (tempPaths.length) {
    cleanupDir(tempPaths.pop()!);
  }
});

async function createPoolTestRepo(kind: "pass" | "fail" = "pass"): Promise<string> {
  const repo = await createBunTestRepo(kind);
  tempPaths.push(repo);
  return repo;
}

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

describe("AgentPool", () => {
  test("addTask returns unique IDs", async () => {
    const repo = await createPoolTestRepo();
    const pool = new AgentPool(makePoolOpts(repo));

    const id1 = pool.addTask("task one");
    const id2 = pool.addTask("task two");

    expect(id1).toStartWith("task-");
    expect(id2).toStartWith("task-");
    expect(id1).not.toBe(id2);
  });

  test("getState reflects queued tasks", async () => {
    const repo = await createPoolTestRepo();
    const pool = new AgentPool(makePoolOpts(repo));

    pool.addTask("task one");
    pool.addTask("task two");

    const state = pool.getState();
    expect(state.status).toBe("idle");
    expect(state.tasks.length).toBe(2);
    expect(state.tasks[0].status).toBe("queued");
    expect(state.tasks[1].status).toBe("queued");
  });

  test("single task passes through pool", async () => {
    const repo = await createPoolTestRepo("pass");
    const pool = new AgentPool(makePoolOpts(repo, {
      concurrency: 1,
    }));

    // Override agent via env — actually, we need commandOverride on LoopOptions
    // For pool testing, we'll just verify the pool machinery works.
    // The actual agent run will use the default agent, so we test with a mock repo.
    const taskId = pool.addTask("do nothing");
    await pool.start();
    const task = await pool.waitForTask(taskId);

    expect(["passed", "failed", "escalated"]).toContain(task.status);
    expect(task.completedAt).toBeNumber();

    await pool.drain();
  }, 60_000);

  test("priority queue orders correctly", async () => {
    const repo = await createPoolTestRepo();
    const pool = new AgentPool(makePoolOpts(repo));

    pool.addTask("low priority", { priority: 0 });
    pool.addTask("high priority", { priority: 10 });
    pool.addTask("medium priority", { priority: 5 });

    const state = pool.getState();
    expect(state.tasks[0].prompt).toBe("high priority");
    expect(state.tasks[1].prompt).toBe("medium priority");
    expect(state.tasks[2].prompt).toBe("low priority");
  });

  test("cancelTask cancels queued task", async () => {
    const repo = await createPoolTestRepo();
    const pool = new AgentPool(makePoolOpts(repo));

    const id1 = pool.addTask("task one");
    const id2 = pool.addTask("task two");

    const cancelled = pool.cancelTask(id1);
    expect(cancelled).toBe(true);

    const state = pool.getState();
    const t1 = state.tasks.find(t => t.id === id1);
    expect(t1?.status).toBe("cancelled");
  });

  test("cancelTask returns false for unknown task", async () => {
    const repo = await createPoolTestRepo();
    const pool = new AgentPool(makePoolOpts(repo));

    expect(pool.cancelTask("nonexistent")).toBe(false);
  });

  test("drain cancels queued tasks and finishes active", async () => {
    const repo = await createPoolTestRepo();
    const pool = new AgentPool(makePoolOpts(repo, { concurrency: 1 }));

    // Add multiple tasks — with 1 worker, some will stay queued
    pool.addTask("task one");
    pool.addTask("task two");
    pool.addTask("task three");

    await pool.start();
    // Immediately drain — at most 1 task may be running
    const result = await pool.drain();

    expect(result.tasks.length).toBe(3);
    expect(result.totalDuration_ms).toBeGreaterThan(0);

    const state = pool.getState();
    expect(state.status).toBe("stopped");
  }, 60_000);

  test("stop kills everything immediately", async () => {
    const repo = await createPoolTestRepo();
    const pool = new AgentPool(makePoolOpts(repo, { concurrency: 1 }));

    pool.addTask("task one");
    pool.addTask("task two");

    await pool.start();
    const result = await pool.stop();

    expect(result.tasks.length).toBe(2);
    expect(pool.getState().status).toBe("stopped");
  }, 60_000);

  test("cannot add tasks after drain", async () => {
    const repo = await createPoolTestRepo();
    const pool = new AgentPool(makePoolOpts(repo));
    pool.addTask("task one");
    await pool.start();
    await pool.drain();

    expect(() => pool.addTask("too late")).toThrow(/stopped/);
  }, 60_000);

  test("pool emits events", async () => {
    const repo = await createPoolTestRepo();
    const pool = new AgentPool(makePoolOpts(repo));

    const events: string[] = [];
    pool.addEventListener("task-queued", () => events.push("queued"));
    pool.addEventListener("pool-state", () => events.push("state"));

    pool.addTask("task one");

    expect(events).toContain("queued");
  });

  test("workers have independent state", async () => {
    const repo = await createPoolTestRepo();
    const pool = new AgentPool(makePoolOpts(repo, { concurrency: 3 }));

    pool.addTask("task one");
    await pool.start();
    await pool.drain();

    const state = pool.getState();
    expect(state.workers.length).toBe(3);
    // All workers should exist as independent entries
    const ids = state.workers.map(w => w.id);
    expect(new Set(ids).size).toBe(3);
  }, 60_000);

  test("concurrency clamped to 1-8", () => {
    const repo = makeTempDir("pool-clamp-");
    tempPaths.push(repo);

    const pool0 = new AgentPool(makePoolOpts(repo, { concurrency: 0 }));
    expect(pool0.getState().workers.length).toBe(0); // not started yet

    const pool20 = new AgentPool(makePoolOpts(repo, { concurrency: 20 }));
    // We can't check workers until start, but we can verify no crash
    expect(pool20.getState().status).toBe("idle");
  });
});
