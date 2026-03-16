/**
 * Multi-agent comparison runner.
 *
 * Takes a single task and runs it concurrently across multiple agent types
 * (e.g., claude, codex, cursor) in separate git worktrees from the same HEAD.
 * Collects per-agent results for comparison.
 */

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { runLoop, type LoopOptions, type LoopResult } from "./loop.ts";
import { removeWorktree } from "./ab-runner.ts";
import { registry } from "./spawner.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentType = NonNullable<LoopOptions["agentType"]>;

export interface MultiAgentOptions {
  /** Task description / prompt. */
  taskPrompt: string;
  /** Path to the repo root. */
  repoPath: string;
  /** Loopwright SQLite DB path. */
  dbPath: string;
  /** Agent types to run concurrently. */
  agentTypes: AgentType[];
  /** Base branch to create worktrees from. Default: "main". */
  baseBranch?: string;
  /** Model overrides per agent type. */
  models?: Partial<Record<AgentType, string>>;
  /** Path to Engram sessions.db. */
  engramDbPath?: string;
  /** Max correction cycles per agent. Default: 3. */
  maxCycles?: number;
  /** Logger. */
  logger?: Pick<Console, "log" | "warn" | "error">;
}

export interface AgentRunResult {
  agentType: AgentType;
  model?: string;
  loopResult: LoopResult;
}

export interface MultiAgentResult {
  runId: string;
  taskPrompt: string;
  repoPath: string;
  baseBranch: string;
  agents: AgentRunResult[];
  comparison: AgentComparisonRow[];
}

export interface AgentComparisonRow {
  agentType: string;
  status: string;
  cycles: number;
  duration_ms: number;
  branchName: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

async function createWorktree(repoPath: string, worktreePath: string, branchName: string, baseBranch: string): Promise<void> {
  mkdirSync(resolve(worktreePath, ".."), { recursive: true });
  const proc = Bun.spawn({
    cmd: ["git", "worktree", "add", worktreePath, "-b", branchName, baseBranch],
    cwd: repoPath,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, , stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`git worktree add failed: ${stderr}`);
  }
}

export function buildComparisonTable(result: MultiAgentResult): string {
  const lines = [
    "## Multi-Agent Comparison",
    "",
    `**Task**: ${result.taskPrompt.slice(0, 200)}`,
    "",
    "| Agent | Status | Cycles | Duration | Branch |",
    "|-------|--------|--------|----------|--------|",
  ];

  for (const row of result.comparison) {
    lines.push(
      `| ${row.agentType} | ${row.status} | ${row.cycles} | ${formatDuration(row.duration_ms)} | ${row.branchName} |`
    );
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export async function runMultiAgent(options: MultiAgentOptions): Promise<MultiAgentResult> {
  const repoPath = resolve(options.repoPath);
  const dbPath = resolve(options.dbPath);
  const baseBranch = options.baseBranch ?? "main";
  const maxCycles = options.maxCycles ?? 3;
  const logger = options.logger ?? console;
  const agentTypes = options.agentTypes;

  if (agentTypes.length === 0) {
    throw new Error("At least one agent type is required");
  }

  const ts = Date.now();
  const runId = `multi-${ts}`;
  const runDir = join(repoPath, ".loopwright", "multi-runs", runId);
  mkdirSync(runDir, { recursive: true });

  // Create a worktree for each agent type
  const worktrees: Array<{ agentType: AgentType; path: string; branch: string }> = [];

  for (const agentType of agentTypes) {
    const branch = `multi-${agentType}-${ts}`;
    const wtPath = join(runDir, `worktree-${agentType}`);
    logger.log(`[multi] Creating worktree for ${agentType}...`);
    await createWorktree(repoPath, wtPath, branch, baseBranch);
    worktrees.push({ agentType, path: wtPath, branch });
  }

  // Run all agents concurrently
  logger.log(`[multi] Running ${agentTypes.length} agents concurrently...`);

  const promises = worktrees.map(async (wt): Promise<AgentRunResult> => {
    const model = options.models?.[wt.agentType];
    try {
      const loopResult = await runLoop({
        taskPrompt: options.taskPrompt,
        repoPath,
        dbPath,
        baseBranch,
        maxCycles,
        agentType: wt.agentType,
        model,
        engramDbPath: options.engramDbPath,
        logger: {
          log: (...args: unknown[]) => logger.log(`[${wt.agentType}]`, ...args),
          warn: (...args: unknown[]) => logger.warn(`[${wt.agentType}]`, ...args),
          error: (...args: unknown[]) => logger.error(`[${wt.agentType}]`, ...args),
        },
        cleanupWorktree: false,
        worktreePath: wt.path,
        worktreeBranch: wt.branch,
      });

      return { agentType: wt.agentType, model, loopResult };
    } catch (err) {
      // On failure, return a synthetic failed result
      logger.error(`[multi] ${wt.agentType} failed: ${err instanceof Error ? err.message : String(err)}`);
      return {
        agentType: wt.agentType,
        model,
        loopResult: {
          status: "failed" as const,
          worktreeId: -1,
          branchName: wt.branch,
          worktreePath: wt.path,
          totalCycles: 0,
          cycles: [],
          duration_ms: 0,
        },
      };
    }
  });

  const agents = await Promise.all(promises);

  // Build comparison
  const comparison: AgentComparisonRow[] = agents.map((a) => ({
    agentType: a.agentType,
    status: a.loopResult.status,
    cycles: a.loopResult.totalCycles,
    duration_ms: a.loopResult.duration_ms,
    branchName: a.loopResult.branchName,
  }));

  return {
    runId,
    taskPrompt: options.taskPrompt,
    repoPath,
    baseBranch,
    agents,
    comparison,
  };
}

export async function cleanupMultiRunWorktrees(repoPath: string, result: MultiAgentResult): Promise<void> {
  for (const agent of result.agents) {
    await removeWorktree(repoPath, agent.loopResult.worktreePath).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const [taskPrompt, repoPath, dbPath] = Bun.argv.slice(2);
  if (!taskPrompt || !repoPath) {
    console.error("Usage: bun run src/multi-agent.ts <task_prompt> <repo_path> [db_path]");
    process.exit(1);
  }

  process.on("SIGINT", async () => {
    console.error("\n[multi-agent] SIGINT — killing agents");
    await registry.killAll();
    process.exit(130);
  });

  const agentTypesRaw = process.env.LOOPWRIGHT_AGENT_TYPES ?? "claude";
  const agentTypes = agentTypesRaw.split(",").map((s) => s.trim()) as AgentType[];

  const result = await runMultiAgent({
    taskPrompt,
    repoPath,
    dbPath: dbPath ?? join(repoPath, ".loopwright", "sessions.db"),
    agentTypes,
    engramDbPath: process.env.ENGRAM_DB_PATH ?? undefined,
  });

  console.log(JSON.stringify(result, null, 2));
  console.error("\n" + buildComparisonTable(result));
  process.exit(0);
}
