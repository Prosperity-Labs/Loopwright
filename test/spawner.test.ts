import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { registry, spawnAgent } from "../src/spawner.ts";
import { cleanupDir, makeTempDir, waitFor } from "../tests/helpers.ts";

const tempDirs: string[] = [];

afterEach(() => {
  registry.clear();
  while (tempDirs.length) cleanupDir(tempDirs.pop()!);
});

test("spawnAgent returns SpawnedAgent with correct fields", async () => {
  const dir = makeTempDir("loopwright-spawner");
  tempDirs.push(dir);
  const eventsPath = join(dir, "events.jsonl");

  const agent = await spawnAgent({
    worktreePath: dir,
    prompt: "hello",
    agentType: "claude",
    dbPath: join(dir, "sessions.db"),
    eventsPath,
    worktreeId: 12,
    sessionId: "sess-spawn",
    commandOverride: ["bash", "-lc", "sleep 0.05; echo hello"],
  });

  expect(agent.agentId).toContain("agent-claude-");
  expect(agent.sessionId).toBe("sess-spawn");
  expect(agent.worktreeId).toBe(12);
  expect(agent.agentType).toBe("claude");
  expect(agent.worktreePath).toBe(dir);

  await agent.process.exited;
});

test("registry tracks spawned agent", async () => {
  const dir = makeTempDir("loopwright-spawner");
  tempDirs.push(dir);

  const agent = await spawnAgent({
    worktreePath: dir,
    prompt: "registry",
    dbPath: join(dir, "sessions.db"),
    eventsPath: join(dir, "events.jsonl"),
    commandOverride: ["bash", "-lc", "sleep 0.15"],
  });

  expect(registry.get(agent.agentId)?.agentId).toBe(agent.agentId);
  expect(registry.list().some((item) => item.agentId === agent.agentId)).toBe(true);

  await agent.process.exited;
});

test("agent auto-unregisters after process exits", async () => {
  const dir = makeTempDir("loopwright-spawner");
  tempDirs.push(dir);

  const agent = await spawnAgent({
    worktreePath: dir,
    prompt: "exit",
    dbPath: join(dir, "sessions.db"),
    eventsPath: join(dir, "events.jsonl"),
    commandOverride: ["echo", "hello"],
  });

  await agent.process.exited;
  await waitFor(() => {
    expect(registry.get(agent.agentId)).toBeUndefined();
  }, 1000);
});

test("AGENT_STARTED event appears in events.jsonl", async () => {
  const dir = makeTempDir("loopwright-spawner");
  tempDirs.push(dir);
  const eventsPath = join(dir, "events.jsonl");

  const agent = await spawnAgent({
    worktreePath: dir,
    prompt: "event",
    dbPath: join(dir, "sessions.db"),
    eventsPath,
    worktreeId: 7,
    commandOverride: ["echo", "hello"],
  });

  expect(existsSync(eventsPath)).toBe(true);
  const lines = readFileSync(eventsPath, "utf8").split(/\r?\n/).filter(Boolean);
  const parsed = lines.map((line) => JSON.parse(line));
  const started = parsed.find((event) => event.event_type === "AGENT_STARTED");
  expect(started).toBeTruthy();
  expect(started.agent_id).toBe(agent.agentId);
  expect(started.session_id).toBe(agent.sessionId);
  expect(started.worktree_id).toBe(7);

  await agent.process.exited;
});
