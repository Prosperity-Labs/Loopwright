/**
 * Paperclip entry point for A/B enrichment experiments.
 *
 * Invoked by Paperclip's `process` adapter via the "loopwright-experiment"
 * agent. Fetches the assigned task, runs an A/B experiment (enriched vs
 * baseline), and posts the comparison table as an issue comment.
 *
 * Required env:
 *   PAPERCLIP_API_KEY   — auth token (set by Paperclip process adapter)
 *   PAPERCLIP_TASK_ID   — issue UUID (set by Paperclip process adapter)
 *
 * Optional env:
 *   PAPERCLIP_API_URL        — Paperclip server base URL (default: http://localhost:3100)
 *   PAPERCLIP_WORKSPACE_CWD  — working directory
 *   LOOPWRIGHT_AGENT_TYPE     — "claude" | "cursor" | "codex" (default: "claude")
 *   LOOPWRIGHT_MODEL          — model override
 *   LOOPWRIGHT_CACHE_GAP_SEC  — seconds between A/B runs (default: 300)
 *   LOOPWRIGHT_SKIP_CACHE_GAP — set "1" to skip (for testing)
 *   ENGRAM_DB_PATH            — path to engram sessions.db
 *   ANTHROPIC_BASE_URL        — enriched proxy URL
 */

import { resolve } from "node:path";
import { runExperiment, buildComparisonTable, type ExperimentResult } from "./experiment.ts";
import { registry } from "./spawner.ts";
import type { LoopOptions } from "./loop.ts";

// ---------------------------------------------------------------------------
// Paperclip API client (minimal — same contract as paperclip-entry.ts)
// ---------------------------------------------------------------------------

interface PaperclipIssue {
  id: string;
  title: string;
  description: string | null;
  status: string;
  identifier: string | null;
}

class PaperclipClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "(no body)");
      throw new Error(`Paperclip API ${method} ${path} → ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
  }

  async getIssue(issueId: string): Promise<PaperclipIssue> {
    return this.request("GET", `/api/issues/${issueId}`);
  }

  async postComment(issueId: string, body: string): Promise<void> {
    await this.request("POST", `/api/issues/${issueId}/comments`, { body });
  }

  async updateIssue(issueId: string, patch: Record<string, unknown>): Promise<void> {
    await this.request("PATCH", `/api/issues/${issueId}`, patch);
  }
}

// ---------------------------------------------------------------------------
// Main
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

  const issue = await client.getIssue(taskId);
  const taskPrompt = issue.description
    ? `${issue.title}\n\n${issue.description}`
    : issue.title;

  const cwd = process.env.PAPERCLIP_WORKSPACE_CWD ?? process.cwd();
  const repoPath = resolve(cwd);
  const dbPath = resolve(repoPath, ".loopwright", "sessions.db");

  const identifier = issue.identifier ?? taskId.slice(0, 8);
  const logger = {
    log: (...args: unknown[]) => console.error(`[${identifier}/exp]`, ...args),
    warn: (...args: unknown[]) => console.error(`[${identifier}/exp] WARN:`, ...args),
    error: (...args: unknown[]) => console.error(`[${identifier}/exp] ERROR:`, ...args),
  };

  const cacheGapSec = process.env.LOOPWRIGHT_CACHE_GAP_SEC
    ? Number(process.env.LOOPWRIGHT_CACHE_GAP_SEC)
    : 300;

  await client.postComment(taskId,
    `Starting A/B enrichment experiment. Cache gap: ${cacheGapSec}s.`
  ).catch(() => {});

  let result: ExperimentResult;
  try {
    result = await runExperiment({
      taskPrompt,
      repoPath,
      dbPath,
      agentType: (process.env.LOOPWRIGHT_AGENT_TYPE as LoopOptions["agentType"]) ?? "claude",
      model: process.env.LOOPWRIGHT_MODEL ?? undefined,
      engramDbPath: process.env.ENGRAM_DB_PATH ?? undefined,
      cacheGapSec,
      skipCacheGap: process.env.LOOPWRIGHT_SKIP_CACHE_GAP === "1",
      logger,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await client.postComment(taskId, `Experiment error: ${msg}`).catch(() => {});
    console.log(JSON.stringify({ status: "error", error: msg }));
    process.exit(1);
  }

  // Post comparison table
  const table = buildComparisonTable(result);
  await client.postComment(taskId, table).catch((err) => {
    logger.warn(`Failed to post comparison: ${err}`);
  });

  // Update issue status
  const bestRun = result.enriched.loopResult.status === "passed" ? "enriched" : "baseline";
  if (result.enriched.loopResult.status === "passed" || result.baseline.loopResult.status === "passed") {
    await client.updateIssue(taskId, { status: "in_review" }).catch(() => {});
  }

  // Output JSON for process adapter
  console.log(JSON.stringify({
    status: "completed",
    experimentId: result.experimentId,
    enriched_status: result.comparison.enriched_status,
    baseline_status: result.comparison.baseline_status,
    enriched_cycles: result.comparison.enriched_cycles,
    baseline_cycles: result.comparison.baseline_cycles,
    duration_delta_pct: result.comparison.duration_delta_pct,
    bestRun,
  }));

  process.exit(0);
}

// ---------------------------------------------------------------------------
// Signal handling
// ---------------------------------------------------------------------------

process.on("SIGINT", async () => {
  console.error("\n[paperclip-experiment] SIGINT — killing agents");
  await registry.killAll();
  process.exit(130);
});

process.on("SIGTERM", async () => {
  console.error("\n[paperclip-experiment] SIGTERM — killing agents");
  await registry.killAll();
  process.exit(143);
});

main().catch((err) => {
  console.error("[paperclip-experiment] Fatal:", err);
  process.exit(1);
});
