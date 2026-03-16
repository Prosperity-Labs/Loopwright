/**
 * A/B enrichment experiment runner.
 *
 * Runs the SAME task twice — once with Engram enrichment (via proxy), once
 * baseline — from the same git state. A configurable cache gap between runs
 * prevents API-side caching from confounding results.
 *
 * Both runs start from the same git commit in separate worktrees.
 */

import { mkdirSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { runLoop, type LoopOptions, type LoopResult } from "./loop.ts";
import { removeWorktree } from "./ab-runner.ts";
import { registry } from "./spawner.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExperimentOptions {
  /** Task description / prompt. */
  taskPrompt: string;
  /** Path to the repo root (where worktrees will be created). */
  repoPath: string;
  /** Loopwright SQLite DB path. */
  dbPath: string;
  /** Base branch to create worktrees from. Default: "main". */
  baseBranch?: string;
  /** Agent type for both runs. Default: "claude". */
  agentType?: LoopOptions["agentType"];
  /** Model override for both runs. */
  model?: string;
  /** Path to Engram sessions.db for brief generation. */
  engramDbPath?: string;
  /** Max correction cycles per run. Default: 3. */
  maxCycles?: number;
  /** Seconds to wait between runs to flush API cache. Default: 300. */
  cacheGapSec?: number;
  /** Port for the enriched proxy (default 9080). */
  enrichedProxyPort?: number;
  /** Port for the baseline proxy (no enrichment, default 9081). */
  baselineProxyPort?: number;
  /** If true, skip cache gap (for testing). Default: false. */
  skipCacheGap?: boolean;
  /** Logger. */
  logger?: Pick<Console, "log" | "warn" | "error">;
}

export interface RunResult {
  label: "enriched" | "baseline";
  loopResult: LoopResult;
  /** Engram proxy session_id if detectable. */
  proxySessionId?: string;
}

export interface ExperimentResult {
  experimentId: string;
  taskPrompt: string;
  repoPath: string;
  baseBranch: string;
  cacheGapSec: number;
  enriched: RunResult;
  baseline: RunResult;
  comparison: ComparisonSummary;
}

export interface ComparisonSummary {
  enriched_status: string;
  baseline_status: string;
  enriched_cycles: number;
  baseline_cycles: number;
  enriched_duration_ms: number;
  baseline_duration_ms: number;
  duration_delta_pct: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function buildComparisonTable(result: ExperimentResult): string {
  const e = result.enriched.loopResult;
  const b = result.baseline.loopResult;
  const deltaPct = result.comparison.duration_delta_pct;
  const deltaSign = deltaPct <= 0 ? "" : "+";

  const lines = [
    "## A/B Enrichment Experiment Results",
    "",
    `**Task**: ${result.taskPrompt.slice(0, 200)}`,
    `**Cache gap**: ${result.cacheGapSec}s`,
    "",
    "| Metric | Enriched | Baseline | Delta |",
    "|--------|----------|----------|-------|",
    `| Status | ${e.status} | ${b.status} | - |`,
    `| Cycles | ${e.totalCycles} | ${b.totalCycles} | ${e.totalCycles - b.totalCycles} |`,
    `| Duration | ${formatDuration(e.duration_ms)} | ${formatDuration(b.duration_ms)} | ${deltaSign}${deltaPct.toFixed(0)}% |`,
    `| Branch | ${e.branchName} | ${b.branchName} | - |`,
  ];

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main experiment runner
// ---------------------------------------------------------------------------

export async function runExperiment(options: ExperimentOptions): Promise<ExperimentResult> {
  const repoPath = resolve(options.repoPath);
  const dbPath = resolve(options.dbPath);
  const baseBranch = options.baseBranch ?? "main";
  const agentType = options.agentType ?? "claude";
  const maxCycles = options.maxCycles ?? 3;
  const cacheGapSec = options.cacheGapSec ?? 300;
  const enrichedPort = options.enrichedProxyPort ?? 9080;
  const baselinePort = options.baselineProxyPort ?? 9081;
  const logger = options.logger ?? console;

  const ts = Date.now();
  const experimentId = `experiment-${ts}`;
  const runDir = join(repoPath, ".loopwright", "experiments", experimentId);
  mkdirSync(runDir, { recursive: true });

  const enrichedWorktreePath = join(runDir, "worktree-enriched");
  const baselineWorktreePath = join(runDir, "worktree-baseline");
  const enrichedBranch = `experiment-enriched-${ts}`;
  const baselineBranch = `experiment-baseline-${ts}`;

  // Create both worktrees from the same HEAD
  logger.log(`[experiment] Creating worktrees from ${baseBranch}...`);
  await createWorktree(repoPath, enrichedWorktreePath, enrichedBranch, baseBranch);
  await createWorktree(repoPath, baselineWorktreePath, baselineBranch, baseBranch);

  let enrichedResult: LoopResult | undefined;
  let baselineResult: LoopResult | undefined;

  try {
    // --- Run A: enriched (proxy with enrichment ON) ---
    logger.log("[experiment] Starting Run A (enriched)...");

    const enrichedEnv: Record<string, string> = {};
    if (process.env.ANTHROPIC_API_KEY) {
      enrichedEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    }

    enrichedResult = await runLoop({
      taskPrompt: options.taskPrompt,
      repoPath,
      dbPath,
      baseBranch,
      maxCycles,
      agentType,
      model: options.model,
      engramDbPath: options.engramDbPath,
      logger,
      cleanupWorktree: false,
      worktreePath: enrichedWorktreePath,
      worktreeBranch: enrichedBranch,
    });

    logger.log(`[experiment] Run A complete: ${enrichedResult.status} (${formatDuration(enrichedResult.duration_ms)})`);

    // --- Cache gap ---
    if (!options.skipCacheGap && cacheGapSec > 0) {
      logger.log(`[experiment] Waiting ${cacheGapSec}s cache gap...`);
      await sleep(cacheGapSec * 1000);
    }

    // --- Run B: baseline (proxy with enrichment OFF, or no proxy) ---
    logger.log("[experiment] Starting Run B (baseline)...");

    // For baseline: point to a proxy instance running with --no-enrich,
    // or if a separate baseline port is configured, use that.
    // The key difference is the ANTHROPIC_BASE_URL env var.
    const baselineEnvOverride: Record<string, string> = {};
    if (baselinePort !== enrichedPort) {
      // Separate proxy on different port with --no-enrich
      baselineEnvOverride.ANTHROPIC_BASE_URL = `http://127.0.0.1:${baselinePort}`;
    }

    // Override ANTHROPIC_BASE_URL for this run by setting it in process.env
    // temporarily (runLoop inherits process.env for spawned agents).
    const originalBaseUrl = process.env.ANTHROPIC_BASE_URL;
    if (baselineEnvOverride.ANTHROPIC_BASE_URL) {
      process.env.ANTHROPIC_BASE_URL = baselineEnvOverride.ANTHROPIC_BASE_URL;
    }

    try {
      baselineResult = await runLoop({
        taskPrompt: options.taskPrompt,
        repoPath,
        dbPath,
        baseBranch,
        maxCycles,
        agentType,
        model: options.model,
        // No engramDbPath for baseline — skip brief generation
        logger,
        cleanupWorktree: false,
        worktreePath: baselineWorktreePath,
        worktreeBranch: baselineBranch,
      });
    } finally {
      // Restore original ANTHROPIC_BASE_URL
      if (originalBaseUrl !== undefined) {
        process.env.ANTHROPIC_BASE_URL = originalBaseUrl;
      } else {
        delete process.env.ANTHROPIC_BASE_URL;
      }
    }

    logger.log(`[experiment] Run B complete: ${baselineResult.status} (${formatDuration(baselineResult.duration_ms)})`);

    // --- Build comparison ---
    const durationDeltaPct = baselineResult.duration_ms > 0
      ? ((enrichedResult.duration_ms - baselineResult.duration_ms) / baselineResult.duration_ms) * 100
      : 0;

    const experimentResult: ExperimentResult = {
      experimentId,
      taskPrompt: options.taskPrompt,
      repoPath,
      baseBranch,
      cacheGapSec,
      enriched: {
        label: "enriched",
        loopResult: enrichedResult,
      },
      baseline: {
        label: "baseline",
        loopResult: baselineResult,
      },
      comparison: {
        enriched_status: enrichedResult.status,
        baseline_status: baselineResult.status,
        enriched_cycles: enrichedResult.totalCycles,
        baseline_cycles: baselineResult.totalCycles,
        enriched_duration_ms: enrichedResult.duration_ms,
        baseline_duration_ms: baselineResult.duration_ms,
        duration_delta_pct: Math.round(durationDeltaPct),
      },
    };

    return experimentResult;
  } catch (err) {
    // Cleanup on failure
    for (const wt of [enrichedWorktreePath, baselineWorktreePath]) {
      await removeWorktree(repoPath, wt).catch(() => {});
    }
    throw err;
  }
}

export { buildComparisonTable };

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const [taskPrompt, repoPath, dbPath] = Bun.argv.slice(2);
  if (!taskPrompt || !repoPath) {
    console.error("Usage: bun run src/experiment.ts <task_prompt> <repo_path> [db_path]");
    process.exit(1);
  }

  process.on("SIGINT", async () => {
    console.error("\n[experiment] SIGINT — killing agents");
    await registry.killAll();
    process.exit(130);
  });

  const cacheGapSec = process.env.LOOPWRIGHT_CACHE_GAP_SEC
    ? Number(process.env.LOOPWRIGHT_CACHE_GAP_SEC)
    : 300;

  const result = await runExperiment({
    taskPrompt,
    repoPath: repoPath,
    dbPath: dbPath ?? join(repoPath, ".loopwright", "sessions.db"),
    agentType: (process.env.LOOPWRIGHT_AGENT_TYPE as LoopOptions["agentType"]) ?? "claude",
    model: process.env.LOOPWRIGHT_MODEL ?? undefined,
    engramDbPath: process.env.ENGRAM_DB_PATH ?? undefined,
    cacheGapSec,
    skipCacheGap: process.env.LOOPWRIGHT_SKIP_CACHE_GAP === "1",
  });

  console.log(JSON.stringify(result, null, 2));
  console.error("\n" + buildComparisonTable(result));
  process.exit(0);
}
