/**
 * Paperclip entry point for multi-agent comparison runs.
 *
 * Invoked by Paperclip's `process` adapter via the "loopwright-multi" agent.
 * Fetches the assigned task, runs it across multiple agent types concurrently,
 * and posts the comparison table as an issue comment.
 *
 * Required env:
 *   PAPERCLIP_API_KEY   — auth token (set by Paperclip process adapter)
 *   PAPERCLIP_TASK_ID   — issue UUID (set by Paperclip process adapter)
 *
 * Optional env:
 *   PAPERCLIP_API_URL        — Paperclip server base URL (default: http://localhost:3100)
 *   PAPERCLIP_WORKSPACE_CWD  — working directory
 *   LOOPWRIGHT_AGENT_TYPES    — comma-separated: "claude,codex,cursor" (default: "claude")
 *   LOOPWRIGHT_MODEL          — model override (applied to all agents)
 *   ENGRAM_DB_PATH            — path to engram sessions.db
 */

import { resolve } from "node:path";
import { runMultiAgent, buildComparisonTable, type AgentType, type MultiAgentResult } from "./multi-agent.ts";
import { registry } from "./spawner.ts";

// ---------------------------------------------------------------------------
// Paperclip API client (minimal)
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

  const agentTypesRaw = process.env.LOOPWRIGHT_AGENT_TYPES ?? "claude";
  const agentTypes = agentTypesRaw.split(",").map((s) => s.trim()) as AgentType[];

  const identifier = issue.identifier ?? taskId.slice(0, 8);
  const logger = {
    log: (...args: unknown[]) => console.error(`[${identifier}/multi]`, ...args),
    warn: (...args: unknown[]) => console.error(`[${identifier}/multi] WARN:`, ...args),
    error: (...args: unknown[]) => console.error(`[${identifier}/multi] ERROR:`, ...args),
  };

  await client.postComment(taskId,
    `Starting multi-agent comparison: **${agentTypes.join(", ")}**`
  ).catch(() => {});

  let result: MultiAgentResult;
  try {
    result = await runMultiAgent({
      taskPrompt,
      repoPath,
      dbPath,
      agentTypes,
      engramDbPath: process.env.ENGRAM_DB_PATH ?? undefined,
      logger,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await client.postComment(taskId, `Multi-agent error: ${msg}`).catch(() => {});
    console.log(JSON.stringify({ status: "error", error: msg }));
    process.exit(1);
  }

  // Post comparison table
  const table = buildComparisonTable(result);
  await client.postComment(taskId, table).catch((err) => {
    logger.warn(`Failed to post comparison: ${err}`);
  });

  // Find best agent (passed with fewest cycles, then shortest duration)
  const passed = result.comparison.filter((c) => c.status === "passed");
  const best = passed.sort((a, b) => a.cycles - b.cycles || a.duration_ms - b.duration_ms)[0];

  if (best) {
    await client.postComment(taskId,
      `Best result: **${best.agentType}** — passed in ${best.cycles} cycle(s), branch \`${best.branchName}\``
    ).catch(() => {});
    await client.updateIssue(taskId, { status: "in_review" }).catch(() => {});
  }

  // Output JSON for process adapter
  console.log(JSON.stringify({
    status: "completed",
    runId: result.runId,
    agents: result.comparison,
    bestAgent: best?.agentType ?? null,
  }));

  process.exit(0);
}

// ---------------------------------------------------------------------------
// Signal handling
// ---------------------------------------------------------------------------

process.on("SIGINT", async () => {
  console.error("\n[paperclip-multi] SIGINT — killing agents");
  await registry.killAll();
  process.exit(130);
});

process.on("SIGTERM", async () => {
  console.error("\n[paperclip-multi] SIGTERM — killing agents");
  await registry.killAll();
  process.exit(143);
});

main().catch((err) => {
  console.error("[paperclip-multi] Fatal:", err);
  process.exit(1);
});
