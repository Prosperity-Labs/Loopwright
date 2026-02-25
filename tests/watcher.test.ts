import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startWorktreeWatcher } from "../src/watcher.ts";
import { cleanupDir, makeTempDir, waitFor } from "./helpers.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) cleanupDir(tempDirs.pop()!);
});

test("worktree watcher emits file change events to events.jsonl", async () => {
  const dir = makeTempDir("loopwright-watcher-test");
  tempDirs.push(dir);

  const worktreePath = join(dir, "worktree");
  mkdirSync(worktreePath, { recursive: true });
  const eventsPath = join(dir, "events.jsonl");

  const watcher = startWorktreeWatcher({
    worktreePath,
    eventsPath,
    worktreeId: "wt-1",
    logger: console,
  });

  writeFileSync(join(worktreePath, "hello.txt"), "hello", "utf8");

  await waitFor(() => {
    expect(existsSync(eventsPath)).toBe(true);
    const lines = readFileSync(eventsPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const parsed = lines.map((line) => JSON.parse(line));
    const match = parsed.find((event) => event.file_path.endsWith("hello.txt"));
    expect(match).toBeTruthy();
    expect(match.event_type).toBe("file_write");
    expect(match.worktree_id).toBe("wt-1");
  });

  watcher.close();
});
