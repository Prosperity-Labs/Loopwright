import { afterEach, expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { EventBridge } from "../src/bridge.ts";
import { openLoopwrightDb } from "../src/db.ts";
import { cleanupDir, makeTempDir, waitFor } from "./helpers.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) cleanupDir(tempDirs.pop()!);
});

test("bridge ingests tool_call events from events.jsonl into sessions.db", async () => {
  const dir = makeTempDir("loopwright-bridge-test");
  tempDirs.push(dir);

  const eventsPath = join(dir, "events.jsonl");
  const dbPath = join(dir, "sessions.db");
  const bridge = new EventBridge({ eventsPath, dbPath, logger: console });
  await bridge.start();

  const event = {
    timestamp: new Date().toISOString(),
    event_type: "tool_call",
    session_id: "sess-123",
    tool_name: "shell",
    args: { cmd: "echo hi" },
    result: { exitCode: 0 },
    status: "ok",
  };

  appendFileSync(eventsPath, `${JSON.stringify(event)}\n`, "utf8");

  await waitFor(() => {
    const db = openLoopwrightDb(dbPath);
    try {
      const row = db.sqlite
        .prepare("SELECT tool_name, session_id FROM tool_calls WHERE session_id = ?")
        .get("sess-123") as { tool_name: string; session_id: string } | null;
      expect(row).toBeTruthy();
      expect(row?.tool_name).toBe("shell");
      expect(row?.session_id).toBe("sess-123");
    } finally {
      db.close();
    }
  });

  bridge.close();
});
