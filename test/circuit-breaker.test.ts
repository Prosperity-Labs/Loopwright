import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { waitForAgent, registry, spawnAgent } from "../src/spawner.ts";
import { runLoop } from "../src/loop.ts";
import { createBunTestRepo, cleanupDir, makeTempDir } from "./test-utils.ts";

const tempPaths: string[] = [];

const silentLogger: Pick<Console, "log" | "warn" | "error"> = {
  log() {},
  warn() {},
  error() {},
};

// Mock agent that creates a file change so the loop doesn't escalate for no-change
const MOCK_AGENT_WITH_CHANGES = ["bash", "-c", "echo x >> feature.ts && git add feature.ts && git commit -m feat"];

afterEach(async () => {
  // Kill any leftover agents
  await registry.killAll();
  while (tempPaths.length) {
    cleanupDir(tempPaths.pop()!);
  }
});

test("waitForAgent kills process after timeout", async () => {
  const dir = makeTempDir("cb-timeout-");
  tempPaths.push(dir);
  const dbPath = join(dir, "sessions.db");
  const eventsPath = join(dir, "events.jsonl");

  const agent = await spawnAgent({
    worktreePath: dir,
    prompt: "sleep",
    dbPath,
    eventsPath,
    commandOverride: ["sleep", "60"],
  });

  const result = await waitForAgent(agent, 200);
  expect(result.timedOut).toBe(true);
  expect(result.exitCode).not.toBe(0);
});

test("waitForAgent does not kill within timeout", async () => {
  const dir = makeTempDir("cb-notimeout-");
  tempPaths.push(dir);
  const dbPath = join(dir, "sessions.db");
  const eventsPath = join(dir, "events.jsonl");

  const agent = await spawnAgent({
    worktreePath: dir,
    prompt: "echo",
    dbPath,
    eventsPath,
    commandOverride: ["echo", "hello"],
  });

  const result = await waitForAgent(agent, 5000);
  expect(result.timedOut).toBe(false);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("hello");
});

test("Loop escalates when agent exceeds agentTimeoutMs", async () => {
  const repoPath = await createBunTestRepo("pass");
  tempPaths.push(repoPath);
  const dbPath = join(repoPath, "sessions.db");

  const result = await runLoop({
    repoPath,
    dbPath,
    taskPrompt: "sleep forever",
    commandOverride: ["sleep", "60"],
    agentTimeoutMs: 200,
    cleanupWorktree: false,
    logger: silentLogger,
  });

  expect(result.status).toBe("escalated");
});

test("Loop cleans up worktree by default on success", async () => {
  const repoPath = await createBunTestRepo("pass");
  tempPaths.push(repoPath);
  const dbPath = join(repoPath, "sessions.db");

  const result = await runLoop({
    repoPath,
    dbPath,
    taskPrompt: "noop",
    commandOverride: MOCK_AGENT_WITH_CHANGES,
    logger: silentLogger,
  });

  expect(result.status).toBe("passed");
  expect(existsSync(result.worktreePath)).toBe(false);
});

test("Loop cleans up worktree by default on escalation", async () => {
  const repoPath = await createBunTestRepo("fail");
  tempPaths.push(repoPath);
  const dbPath = join(repoPath, "sessions.db");

  const result = await runLoop({
    repoPath,
    dbPath,
    taskPrompt: "noop",
    maxCycles: 1,
    commandOverride: MOCK_AGENT_WITH_CHANGES,
    logger: silentLogger,
  });

  expect(result.status).toBe("escalated");
  expect(existsSync(result.worktreePath)).toBe(false);
});

test("Loop keeps worktree when cleanupWorktree=false", async () => {
  const repoPath = await createBunTestRepo("pass");
  tempPaths.push(repoPath);
  const dbPath = join(repoPath, "sessions.db");

  const result = await runLoop({
    repoPath,
    dbPath,
    taskPrompt: "noop",
    commandOverride: MOCK_AGENT_WITH_CHANGES,
    cleanupWorktree: false,
    logger: silentLogger,
  });

  expect(result.status).toBe("passed");
  expect(existsSync(result.worktreePath)).toBe(true);
});

test("registry.killAll terminates all running agents", async () => {
  const dir = makeTempDir("cb-killall-");
  tempPaths.push(dir);
  const dbPath = join(dir, "sessions.db");
  const eventsPath = join(dir, "events.jsonl");

  await spawnAgent({
    worktreePath: dir,
    prompt: "sleep1",
    dbPath,
    eventsPath,
    commandOverride: ["sleep", "60"],
  });

  await spawnAgent({
    worktreePath: dir,
    prompt: "sleep2",
    dbPath,
    eventsPath,
    commandOverride: ["sleep", "60"],
  });

  expect(registry.list().length).toBe(2);
  await registry.killAll();
  expect(registry.list().length).toBe(0);
});
