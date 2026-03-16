/**
 * Loopwright ↔ Paperclip integration entry point.
 *
 * Invoked by Paperclip's `process` adapter. Fetches the assigned task from
 * the Paperclip API, runs Loopwright's self-correcting loop, and posts
 * progress comments back to the issue.
 *
 * Required env:
 *   PAPERCLIP_API_KEY   — auth token (set by Paperclip process adapter)
 *   PAPERCLIP_TASK_ID   — issue UUID (set by Paperclip process adapter)
 *
 * Optional env:
 *   PAPERCLIP_API_URL        — Paperclip server base URL (default: http://localhost:3100)
 *   PAPERCLIP_WORKSPACE_CWD  — working directory (set by process adapter)
 *   LOOPWRIGHT_AGENT_TYPE     — "claude" | "cursor" | "codex" (default: "claude")
 *   LOOPWRIGHT_MODEL          — model override
 *   LOOPWRIGHT_MAX_CYCLES     — max correction cycles (default: 3)
 *   ENGRAM_DB_PATH            — path to engram sessions.db
 *   ANTHROPIC_BASE_URL        — proxy URL (inherited by spawned agents)
 */

import { resolve } from "node:path";
import { runLoop, type LoopOptions, type LoopResult, type CycleResult } from "./loop.ts";
import { registry } from "./spawner.ts";

// ---------------------------------------------------------------------------
// Paperclip API client
// ---------------------------------------------------------------------------

interface PaperclipIssue {
  id: string;
  title: string;
  description: string | null;
  status: string;
  identifier: string | null;
  projectId: string | null;
}

interface PaperclipComment {
  id: string;
  body: string;
  issueId: string;
}

class PaperclipClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "(no body)");
      throw new Error(`Paperclip API ${method} ${path} → ${res.status}: ${text}`);
    }

    return res.json() as Promise<T>;
  }

  async getIssue(issueId: string): Promise<PaperclipIssue> {
    return this.request<PaperclipIssue>("GET", `/api/issues/${issueId}`);
  }

  async postComment(issueId: string, body: string): Promise<PaperclipComment> {
    return this.request<PaperclipComment>("POST", `/api/issues/${issueId}/comments`, { body });
  }

  async updateIssue(issueId: string, patch: Record<string, unknown>): Promise<PaperclipIssue> {
    return this.request<PaperclipIssue>("PATCH", `/api/issues/${issueId}`, patch);
  }
}

// ---------------------------------------------------------------------------
// Progress reporting
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

function cycleComment(cycle: CycleResult): string {
  const { cycleNumber, action, testResult, passed, duration_ms } = cycle;
  const dur = formatDuration(duration_ms);

  if (action === "initial") {
    if (passed) {
      return `**Cycle ${cycleNumber}**: Initial run complete — all tests passed (${dur})`;
    }
    const failures = testResult.errors.length;
    const files = testResult.errors.map((e) => e.file).filter(Boolean);
    const unique = [...new Set(files)];
    return `**Cycle ${cycleNumber}**: Initial run complete — ${failures} test failure${failures !== 1 ? "s" : ""}${unique.length ? ` in ${unique.join(", ")}` : ""}. Running correction...`;
  }

  // correction
  if (passed) {
    return `**Cycle ${cycleNumber}**: Correction applied — tests now passing (${dur})`;
  }
  const failures = testResult.errors.length;
  return `**Cycle ${cycleNumber}**: Correction applied — ${failures} failure${failures !== 1 ? "s" : ""} remain. ${cycleNumber < 3 ? "Retrying..." : "Escalating."}`;
}

function resultSummary(result: LoopResult): string {
  const statusEmoji = result.status === "passed" ? "PASSED" : result.status === "failed" ? "FAILED" : "ESCALATED";
  const dur = formatDuration(result.duration_ms);
  return `**Result: ${statusEmoji}** after ${result.totalCycles} correction cycle${result.totalCycles !== 1 ? "s" : ""} (${dur})`;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const apiKey = process.env.PAPERCLIP_API_KEY;
  const taskId = process.env.PAPERCLIP_TASK_ID;

  if (!apiKey || !taskId) {
    console.error("Missing required env: PAPERCLIP_API_KEY, PAPERCLIP_TASK_ID");
    process.exit(1);
  }

  const apiUrl = process.env.PAPERCLIP_API_URL ?? "http://localhost:3100";
  const client = new PaperclipClient(apiUrl, apiKey);

  // --- Fetch the assigned issue ---
  const issue = await client.getIssue(taskId);
  if (!issue.title) {
    console.error(`Issue ${taskId} has no title`);
    process.exit(1);
  }

  const taskPrompt = issue.description
    ? `${issue.title}\n\n${issue.description}`
    : issue.title;

  const cwd = process.env.PAPERCLIP_WORKSPACE_CWD ?? process.cwd();
  const repoPath = resolve(cwd);

  // --- Build LoopOptions ---
  const agentType = (process.env.LOOPWRIGHT_AGENT_TYPE as LoopOptions["agentType"]) ?? "claude";
  const model = process.env.LOOPWRIGHT_MODEL ?? undefined;
  const maxCycles = process.env.LOOPWRIGHT_MAX_CYCLES ? Number(process.env.LOOPWRIGHT_MAX_CYCLES) : 3;
  const engramDbPath = process.env.ENGRAM_DB_PATH ?? undefined;
  const agentTimeoutMs = process.env.LOOPWRIGHT_AGENT_TIMEOUT_MS ? Number(process.env.LOOPWRIGHT_AGENT_TIMEOUT_MS) : undefined;
  const loopTimeoutMs = process.env.LOOPWRIGHT_LOOP_TIMEOUT_MS ? Number(process.env.LOOPWRIGHT_LOOP_TIMEOUT_MS) : undefined;

  const dbPath = resolve(repoPath, ".loopwright", "sessions.db");

  const identifier = issue.identifier ?? taskId.slice(0, 8);
  const logger = {
    log: (...args: unknown[]) => console.error(`[${identifier}]`, ...args),
    warn: (...args: unknown[]) => console.error(`[${identifier}] WARN:`, ...args),
    error: (...args: unknown[]) => console.error(`[${identifier}] ERROR:`, ...args),
  };

  // Post initial comment
  await client.postComment(taskId, `Loopwright picking up task. Agent: **${agentType}**${model ? ` (${model})` : ""}. Max cycles: ${maxCycles}.`).catch((err) => {
    logger.warn(`Failed to post initial comment: ${err}`);
  });

  // --- Run the loop ---
  let result: LoopResult;
  try {
    result = await runLoop({
      taskPrompt,
      repoPath,
      dbPath,
      baseBranch: "main",
      maxCycles,
      agentType,
      model,
      engramDbPath,
      logger,
      agentTimeoutMs,
      loopTimeoutMs,
      cleanupWorktree: false, // keep worktree for inspection
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await client.postComment(taskId, `Loopwright error: ${msg}`).catch(() => {});
    await client.updateIssue(taskId, { status: "blocked" }).catch(() => {});

    // Output error as JSON for process adapter
    console.log(JSON.stringify({ status: "error", error: msg }));
    process.exit(1);
  }

  // --- Post per-cycle comments ---
  for (const cycle of result.cycles) {
    await client.postComment(taskId, cycleComment(cycle)).catch((err) => {
      logger.warn(`Failed to post cycle comment: ${err}`);
    });
  }

  // Post final result
  await client.postComment(taskId, resultSummary(result)).catch((err) => {
    logger.warn(`Failed to post result comment: ${err}`);
  });

  // Update issue status based on outcome
  if (result.status === "passed") {
    await client.updateIssue(taskId, { status: "in_review" }).catch(() => {});
  } else if (result.status === "escalated") {
    await client.updateIssue(taskId, { status: "blocked" }).catch(() => {});
  }

  // --- Output JSON for process adapter (stdout) ---
  const output = {
    status: result.status,
    totalCycles: result.totalCycles,
    duration_ms: result.duration_ms,
    branchName: result.branchName,
    worktreePath: result.worktreePath,
    finalCheckpoint: result.finalCheckpoint,
    issueId: taskId,
    issueIdentifier: identifier,
  };

  console.log(JSON.stringify(output));
  process.exit(result.status === "passed" ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Signal handling
// ---------------------------------------------------------------------------

process.on("SIGINT", async () => {
  console.error("\n[paperclip-entry] SIGINT — killing agents");
  await registry.killAll();
  process.exit(130);
});

process.on("SIGTERM", async () => {
  console.error("\n[paperclip-entry] SIGTERM — killing agents");
  await registry.killAll();
  process.exit(143);
});

main().catch((err) => {
  console.error("[paperclip-entry] Fatal:", err);
  process.exit(1);
});
