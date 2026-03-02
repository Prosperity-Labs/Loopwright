/**
 * Loopwright Dashboard Server
 *
 * Bun.serve() backend that:
 * - Serves the dashboard HTML at GET /
 * - Provides SSE at GET /api/stream for real-time loop events
 * - REST endpoints for status, cycles, and events
 * - Watches events.jsonl for real-time updates
 * - Reads from Loopwright's SQLite DB
 *
 * Usage:
 *   bun run src/dashboard.ts [db_path] [events_path] [port]
 */

import { existsSync, readFileSync, statSync, watchFile, unwatchFile } from "node:fs";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { openLoopwrightDb, type LoopwrightDB, type CorrectionCycleRow, type WorktreeRow, type CheckpointRow } from "./db.ts";

// ──── Types ────

interface DashboardState {
  status: "idle" | "running" | "passed" | "failed" | "escalated";
  phase: string | null;
  cycle: number;
  maxCycles: number;
  taskPrompt: string;
  repo: string;
  branch: string;
  worktreePath: string;
  worktreeId: number | null;
  gitSha: string | null;
  startTime: number | null;
}

interface SSEClient {
  controller: ReadableStreamDefaultController;
  closed: boolean;
}

// ──── Globals ────

const dbPath = resolve(Bun.argv[2] ?? "./sessions.db");
const eventsPath = resolve(Bun.argv[3] ?? "./events.jsonl");
const port = Number(Bun.argv[4] ?? 8790);
const dashboardHtml = resolve(import.meta.dir, "../public/dashboard.html");

let db: LoopwrightDB | null = null;
const clients: SSEClient[] = [];
const feedHistory: Array<{ type: string; html: string; time: string }> = [];

const state: DashboardState = {
  status: "idle",
  phase: null,
  cycle: 0,
  maxCycles: 3,
  taskPrompt: "",
  repo: "",
  branch: "",
  worktreePath: "",
  worktreeId: null,
  gitSha: null,
  startTime: null,
};

// ──── Helpers ────

function getDb(): LoopwrightDB {
  if (!db) {
    db = openLoopwrightDb(dbPath);
  }
  return db;
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function broadcast(eventName: string, data: unknown): void {
  const msg = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (let i = clients.length - 1; i >= 0; i--) {
    const client = clients[i];
    if (client.closed) {
      clients.splice(i, 1);
      continue;
    }
    try {
      client.controller.enqueue(new TextEncoder().encode(msg));
    } catch {
      client.closed = true;
      clients.splice(i, 1);
    }
  }
}

function pushEvent(type: string, html: string): void {
  const time = formatTime(new Date());
  const ev = { type, html, time };
  feedHistory.push(ev);
  if (feedHistory.length > 200) feedHistory.shift();
  broadcast("event", ev);
}

function broadcastStatus(): void {
  broadcast("status", { ...state });
}

// ──── DB Polling ────

let lastWorktreeCount = 0;
let lastCycleCount = 0;

function pollDb(): void {
  try {
    const database = getDb();

    // Find latest active or recent worktree
    const worktrees = database.sqlite
      .prepare("SELECT * FROM worktrees ORDER BY id DESC LIMIT 1")
      .all() as WorktreeRow[];

    if (worktrees.length === 0) return;

    const wt = worktrees[0];
    const worktreeId = wt.id;

    // Detect new worktree
    if (worktreeId !== state.worktreeId) {
      state.worktreeId = worktreeId;
      state.branch = wt.branch_name;
      state.taskPrompt = wt.task_description ?? "";
      state.worktreePath = "";
      state.cycle = 0;
      state.gitSha = null;

      // Extract repo name from branch
      if (wt.branch_name.startsWith("loopwright-")) {
        state.repo = wt.base_branch ?? "unknown";
      }

      if (wt.status === "active") {
        state.status = "running";
        state.startTime = new Date(wt.created_at).getTime();
        pushEvent("spawn", `<strong>Loop started</strong> on branch <code>${wt.branch_name}</code>`);
      } else {
        state.status = wt.status as DashboardState["status"];
      }

      broadcastStatus();
    }

    // Check status changes
    if (wt.status !== state.status && wt.status !== "active") {
      const prevStatus = state.status;
      state.status = wt.status as DashboardState["status"];

      if (state.status === "passed") {
        state.phase = "checkpoint";
        pushEvent("checkpoint", `<strong>Loop passed!</strong> All tests green.`);
      } else if (state.status === "escalated") {
        state.phase = null;
        pushEvent("escalate", `<strong>Loop escalated</strong> after ${state.cycle} correction cycles.`);
      } else if (state.status === "failed") {
        state.phase = null;
        pushEvent("test-fail", `<strong>Loop failed.</strong>`);
      }

      broadcastStatus();
    }

    // Check correction cycles
    const cycles = database.getCorrectionCycles(worktreeId);
    if (cycles.length > lastCycleCount) {
      for (let i = lastCycleCount; i < cycles.length; i++) {
        const cycle = cycles[i];
        state.cycle = cycle.cycle_number;

        const outcome = cycle.outcome ?? "failed";
        const passed = outcome === "passed";

        pushEvent(
          passed ? "test-pass" : "test-fail",
          `<strong>Cycle ${cycle.cycle_number}</strong> &mdash; ${outcome}${cycle.trigger_error ? `: <code>${cycle.trigger_error.slice(0, 80)}</code>` : ""}`
        );

        if (!passed && cycle.cycle_number < state.maxCycles) {
          state.phase = "correct";
          pushEvent("correct", `Injecting correction brief for cycle ${cycle.cycle_number + 1}...`);
        }

        broadcast("cycle", {
          cycleNumber: cycle.cycle_number,
          action: cycle.cycle_number === 1 ? "initial" : "correction",
          passed,
          duration_ms: (cycle.duration_seconds ?? 0) * 1000,
          testResult: {
            errors: cycle.error_context ? tryParse(cycle.error_context)?.errors ?? [] : [],
            changed_files: cycle.error_context ? tryParse(cycle.error_context)?.changed_files ?? [] : [],
          },
        });
      }
      lastCycleCount = cycles.length;
      broadcastStatus();
    }

    // Check checkpoints for git SHA
    const checkpoints = database.listCheckpoints(worktreeId);
    if (checkpoints.length > 0) {
      const latest = checkpoints[checkpoints.length - 1];
      if (latest.git_sha && latest.git_sha !== state.gitSha) {
        state.gitSha = latest.git_sha;
        pushEvent("checkpoint", `Checkpoint created: <code>${latest.git_sha.slice(0, 8)}</code>`);
        broadcastStatus();
      }
    }
  } catch (err) {
    console.error("[poll] DB error:", (err as Error).message);
  }
}

function tryParse(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// ──── Events.jsonl Watching ────

let lastEventsSize = 0;

function pollEvents(): void {
  if (!existsSync(eventsPath)) return;

  try {
    const stat = statSync(eventsPath);
    if (stat.size <= lastEventsSize) return;

    const content = readFileSync(eventsPath, "utf8");
    const lines = content.trim().split("\n");
    const newLines = lines.slice(Math.max(0, lines.length - 10)); // process last 10 new lines

    for (const line of newLines) {
      try {
        const ev = JSON.parse(line);

        if (ev.type === "AGENT_STARTED") {
          state.phase = "spawn";
          pushEvent("spawn", `Agent <code>${ev.agent_id?.slice(0, 8) ?? "?"}</code> spawned (${ev.agent_type ?? "claude"})`);
          broadcastStatus();
        } else if (ev.type === "AGENT_FINISHED") {
          state.phase = "test";
          pushEvent("info", `Agent <code>${ev.agent_id?.slice(0, 8) ?? "?"}</code> finished (exit ${ev.exit_code ?? "?"})`);
          broadcastStatus();
        } else if (ev.type === "TEST_STARTED") {
          state.phase = "test";
          pushEvent("info", `Running tests...`);
          broadcastStatus();
        } else if (ev.type === "TEST_PASSED") {
          state.phase = "checkpoint";
          pushEvent("test-pass", `<strong>Tests passed!</strong>`);
          broadcastStatus();
        } else if (ev.type === "TEST_FAILED") {
          state.phase = "correct";
          pushEvent("test-fail", `<strong>Tests failed</strong> with ${ev.error_count ?? "?"} errors`);
          broadcastStatus();
        }
      } catch {
        // invalid JSON line
      }
    }

    lastEventsSize = stat.size;
  } catch {
    // file not readable
  }
}

// ──── Server ────

const server = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);

    // Serve dashboard HTML
    if (url.pathname === "/" || url.pathname === "/dashboard") {
      if (existsSync(dashboardHtml)) {
        return new Response(Bun.file(dashboardHtml), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      return new Response("Dashboard HTML not found", { status: 404 });
    }

    // SSE stream
    if (url.pathname === "/api/stream") {
      const stream = new ReadableStream({
        start(controller) {
          const client: SSEClient = { controller, closed: false };
          clients.push(client);

          // Send current state immediately
          const statusMsg = `event: status\ndata: ${JSON.stringify({ ...state })}\n\n`;
          controller.enqueue(new TextEncoder().encode(statusMsg));
        },
        cancel() {
          // Client disconnected — cleanup happens in broadcast()
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // REST: current status
    if (url.pathname === "/api/status") {
      return Response.json({ ...state });
    }

    // REST: correction cycles for a worktree
    const cycleMatch = url.pathname.match(/^\/api\/cycles\/(\d+)$/);
    if (cycleMatch) {
      const worktreeId = Number(cycleMatch[1]);
      try {
        const database = getDb();
        const cycles = database.getCorrectionCycles(worktreeId);
        return Response.json(
          cycles.map((c) => ({
            cycleNumber: c.cycle_number,
            action: c.cycle_number === 1 ? "initial" : "correction",
            passed: c.outcome === "passed",
            duration_ms: (c.duration_seconds ?? 0) * 1000,
            testResult: {
              errors: c.error_context ? tryParse(c.error_context)?.errors ?? [] : [],
              changed_files: c.error_context ? tryParse(c.error_context)?.changed_files ?? [] : [],
            },
            triggerError: c.trigger_error,
          }))
        );
      } catch {
        return Response.json([]);
      }
    }

    // REST: recent feed events
    if (url.pathname === "/api/events") {
      return Response.json(feedHistory.slice(-50));
    }

    // REST: trigger a loop (POST /api/run)
    if (url.pathname === "/api/run" && req.method === "POST") {
      const body = await req.json() as { taskPrompt: string; repoPath: string; dbPath?: string; baseBranch?: string; maxCycles?: number };

      // Reset state
      state.status = "running";
      state.phase = "spawn";
      state.cycle = 0;
      state.gitSha = null;
      state.taskPrompt = body.taskPrompt;
      state.repo = body.repoPath;
      state.maxCycles = body.maxCycles ?? 3;
      state.startTime = Date.now();
      lastCycleCount = 0;
      feedHistory.length = 0;

      pushEvent("info", `<strong>Starting loop</strong> for <code>${body.repoPath}</code>`);
      broadcastStatus();

      // Spawn loop.ts in background
      const loopCmd = [
        "bun", "run", resolve(import.meta.dir, "loop.ts"),
        body.taskPrompt,
        body.repoPath,
        body.dbPath ?? dbPath,
        body.baseBranch ?? "main",
      ];

      const proc = Bun.spawn({
        cmd: loopCmd,
        stdout: "pipe",
        stderr: "pipe",
        cwd: resolve(import.meta.dir, ".."),
      });

      // Don't await — let it run in background
      proc.exited.then(async (exitCode) => {
        const stdout = await new Response(proc.stdout).text();
        try {
          const result = JSON.parse(stdout);
          state.status = result.status;
          state.gitSha = result.finalCheckpoint?.git_sha ?? null;
          state.phase = null;
          broadcastStatus();
          pushEvent(
            result.status === "passed" ? "checkpoint" : "escalate",
            `<strong>Loop finished:</strong> ${result.status} after ${result.totalCycles} cycles (${(result.duration_ms / 1000).toFixed(1)}s)`
          );
        } catch {
          state.status = exitCode === 0 ? "passed" : "failed";
          state.phase = null;
          broadcastStatus();
        }
      });

      return Response.json({ status: "started", pid: proc.pid });
    }

    return new Response("Not found", { status: 404 });
  },
});

// ──── Polling intervals ────
const dbPollInterval = setInterval(pollDb, 2000);
const eventsPollInterval = setInterval(pollEvents, 1000);

console.log(`\n  Loopwright Dashboard`);
console.log(`  http://localhost:${port}\n`);
console.log(`  DB:     ${dbPath}`);
console.log(`  Events: ${eventsPath}\n`);

// Cleanup on exit
process.on("SIGINT", () => {
  clearInterval(dbPollInterval);
  clearInterval(eventsPollInterval);
  db?.close();
  server.stop();
  process.exit(0);
});
