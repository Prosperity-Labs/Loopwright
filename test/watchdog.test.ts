import { afterEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Watchdog } from "../src/watchdog.ts";
import { cleanupDir, makeTempDir } from "../tests/helpers.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) cleanupDir(tempDirs.pop()!);
});

function readEvents(eventsPath: string): Array<Record<string, unknown>> {
  if (!existsSync(eventsPath)) return [];
  return readFileSync(eventsPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("watchdog detects idle after threshold and emits AGENT_IDLE", async () => {
  const dir = makeTempDir("loopwright-watchdog");
  tempDirs.push(dir);
  const eventsPath = join(dir, "events.jsonl");

  appendFileSync(eventsPath, `${JSON.stringify({
    event_type: "tool_call",
    session_id: "sess-idle",
    timestamp: new Date(Date.now() - 120_000).toISOString(),
  })}\n`);

  const watchdog = new Watchdog({
    eventsPath,
    idleThresholdMs: 1_000,
    pollIntervalMs: 10,
    logger: console,
  });

  await watchdog.pollOnce();
  const events = readEvents(eventsPath);
  const idle = events.find((event) => event.event_type === "AGENT_IDLE");

  expect(idle).toBeTruthy();
  expect(idle?.session_id).toBe("sess-idle");
  expect(typeof idle?.idle_duration_ms).toBe("number");
});

test("watchdog detects session_end and emits AGENT_FINISHED", async () => {
  const dir = makeTempDir("loopwright-watchdog");
  tempDirs.push(dir);
  const eventsPath = join(dir, "events.jsonl");

  appendFileSync(eventsPath, `${JSON.stringify({
    event_type: "session_end",
    session_id: "sess-finish",
    timestamp: new Date().toISOString(),
  })}\n`);

  const watchdog = new Watchdog({ eventsPath, pollIntervalMs: 10, logger: console });
  await watchdog.pollOnce();

  const finished = readEvents(eventsPath).find((event) => event.event_type === "AGENT_FINISHED");
  expect(finished).toBeTruthy();
  expect(finished?.session_id).toBe("sess-finish");
  expect(finished?.reason).toBe("session_end");
});

test("watchdog does not re-emit for same session", async () => {
  const dir = makeTempDir("loopwright-watchdog");
  tempDirs.push(dir);
  const eventsPath = join(dir, "events.jsonl");

  const ended = {
    event_type: "session_end",
    session_id: "sess-once",
    timestamp: new Date().toISOString(),
  };
  appendFileSync(eventsPath, `${JSON.stringify(ended)}\n${JSON.stringify(ended)}\n`);

  const watchdog = new Watchdog({ eventsPath, pollIntervalMs: 10, logger: console });
  await watchdog.pollOnce();
  await watchdog.pollOnce();

  const finishedEvents = readEvents(eventsPath).filter((event) => event.event_type === "AGENT_FINISHED");
  expect(finishedEvents).toHaveLength(1);
});

test("watchdog handles missing events file gracefully", async () => {
  const dir = makeTempDir("loopwright-watchdog");
  tempDirs.push(dir);
  const eventsPath = join(dir, "missing", "events.jsonl");

  const watchdog = new Watchdog({ eventsPath, pollIntervalMs: 10, logger: console });
  await watchdog.pollOnce();

  const state = watchdog.getState();
  expect(state.sessions.size).toBe(0);
  expect(state.idleEmitted.size).toBe(0);
  expect(state.finishedEmitted.size).toBe(0);
});
