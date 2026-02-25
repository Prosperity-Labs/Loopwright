import { resolve } from "node:path";
import { openLoopwrightDb, type ArtifactRow, type CheckpointRow, type JsonValue } from "./db.ts";

export interface ABCompareOptions {
  worktree_a_id: number;
  worktree_b_id: number;
  db_path: string;
  repo_path?: string;
}

interface SideSummary {
  worktree_id: number;
  branch_name: string;
  status: string;
  duration_ms: number | null;
  changed_files: string[];
  error_count: number;
  exit_code: number | null;
  stderr: string | null;
  checkpoint_id: number | null;
  git_sha: string | null;
}

export interface ABComparisonJSON {
  worktree_a_id: number;
  worktree_b_id: number;
  duration: {
    a_seconds: number | null;
    b_seconds: number | null;
  };
  files_touched: {
    a: string[];
    b: string[];
  };
  errors: {
    a: number;
    b: number;
  };
  branches: {
    a: string;
    b: string;
  };
  git_diff: string;
  summary: {
    faster: "A" | "B" | "tie" | "unknown";
    fewer_errors: "A" | "B" | "tie";
  };
}

export interface ABComparisonReport {
  comparison_id: number;
  json: ABComparisonJSON;
  markdown: string;
}

function safeParseJson(value: string | null): JsonValue | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return undefined;
  }
}

function checkpointChangedFiles(checkpoint: CheckpointRow | undefined): string[] {
  const parsed = safeParseJson(checkpoint?.graph_delta ?? null);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const changed = (parsed as Record<string, unknown>).changed_files;
  if (!Array.isArray(changed)) return [];
  return changed.filter((item): item is string => typeof item === "string");
}

function latestCheckpoint(checkpoints: CheckpointRow[]): CheckpointRow | undefined {
  return checkpoints.at(-1);
}

function parseAbResultArtifacts(artifacts: ArtifactRow[]): Record<string, unknown> | undefined {
  for (let i = artifacts.length - 1; i >= 0; i--) {
    const artifact = artifacts[i];
    if (!artifact || artifact.event_type !== "ab_result") continue;
    const parsed = safeParseJson(artifact.metadata_json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  }
  return undefined;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function summarizeSide(worktreeId: number, dbPath: string): SideSummary {
  const db = openLoopwrightDb(dbPath);
  try {
    const worktree = db.getWorktreeById(worktreeId);
    if (!worktree) {
      throw new Error(`Worktree not found: ${worktreeId}`);
    }
    const checkpoints = db.listCheckpoints(worktreeId);
    const checkpoint = latestCheckpoint(checkpoints);
    const artifacts = db.listArtifactsByWorktree(worktreeId);
    const abResult = parseAbResultArtifacts(artifacts) ?? {};

    const changedFilesFromCheckpoint = checkpointChangedFiles(checkpoint);
    const changedFilesFromArtifacts = [...new Set(
      artifacts
        .filter((artifact) => artifact.event_type === "file_write")
        .map((artifact) => artifact.file_path),
    )];

    const exitCode = asNumber(abResult.exit_code);
    const stderr = asString(abResult.stderr);
    const errorCount = asNumber(abResult.error_count) ?? (exitCode && exitCode !== 0 ? 1 : 0);

    return {
      worktree_id: worktreeId,
      branch_name: worktree.branch_name,
      status: worktree.status,
      duration_ms: asNumber(abResult.duration_ms),
      changed_files: (changedFilesFromCheckpoint.length > 0 ? changedFilesFromCheckpoint : changedFilesFromArtifacts).sort(),
      error_count: errorCount,
      exit_code: exitCode,
      stderr,
      checkpoint_id: checkpoint?.id ?? null,
      git_sha: checkpoint?.git_sha ?? null,
    };
  } finally {
    db.close();
  }
}

async function gitDiff(repoPath: string, branchA: string, branchB: string): Promise<string> {
  const proc = Bun.spawn({
    cmd: ["git", "diff", branchA, branchB],
    cwd: repoPath,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`git diff failed for ${branchA} vs ${branchB}: ${stderr.trim() || stdout.trim()}`);
  }
  return stdout;
}

function seconds(ms: number | null): number | null {
  if (ms === null) return null;
  return Math.round((ms / 1000) * 100) / 100;
}

function pickFaster(aMs: number | null, bMs: number | null): "A" | "B" | "tie" | "unknown" {
  if (aMs === null || bMs === null) return "unknown";
  if (aMs === bMs) return "tie";
  return aMs < bMs ? "A" : "B";
}

function pickFewerErrors(a: number, b: number): "A" | "B" | "tie" {
  if (a === b) return "tie";
  return a < b ? "A" : "B";
}

function renderMarkdown(a: SideSummary, b: SideSummary, diffText: string): string {
  const aSeconds = seconds(a.duration_ms);
  const bSeconds = seconds(b.duration_ms);
  const diffBlock = diffText.trim() ? `\n\`\`\`diff\n${diffText.trimEnd()}\n\`\`\`\n` : "\n_No diff output._\n";

  return [
    "# A/B Comparison Report",
    "",
    `- Worktree A: \`${a.worktree_id}\` (\`${a.branch_name}\`)`,
    `- Worktree B: \`${b.worktree_id}\` (\`${b.branch_name}\`)`,
    "",
    "## Duration",
    "",
    `- A took ${aSeconds ?? "unknown"}s`,
    `- B took ${bSeconds ?? "unknown"}s`,
    "",
    "## Files Touched",
    "",
    `- A modified: ${a.changed_files.length ? a.changed_files.join(", ") : "(none)"}`,
    `- B modified: ${b.changed_files.length ? b.changed_files.join(", ") : "(none)"}`,
    "",
    "## Errors",
    "",
    `- A had ${a.error_count} error(s)`,
    `- B had ${b.error_count} error(s)`,
    "",
    "## Diff",
    diffBlock,
  ].join("\n");
}

export async function compareWorktrees(options: ABCompareOptions): Promise<ABComparisonReport> {
  const repoPath = resolve(options.repo_path ?? process.cwd());
  const dbPath = resolve(options.db_path);
  const a = summarizeSide(options.worktree_a_id, dbPath);
  const b = summarizeSide(options.worktree_b_id, dbPath);
  const diffText = await gitDiff(repoPath, a.branch_name, b.branch_name);

  const json: ABComparisonJSON = {
    worktree_a_id: a.worktree_id,
    worktree_b_id: b.worktree_id,
    duration: {
      a_seconds: seconds(a.duration_ms),
      b_seconds: seconds(b.duration_ms),
    },
    files_touched: {
      a: a.changed_files,
      b: b.changed_files,
    },
    errors: {
      a: a.error_count,
      b: b.error_count,
    },
    branches: {
      a: a.branch_name,
      b: b.branch_name,
    },
    git_diff: diffText,
    summary: {
      faster: pickFaster(a.duration_ms, b.duration_ms),
      fewer_errors: pickFewerErrors(a.error_count, b.error_count),
    },
  };
  const markdown = renderMarkdown(a, b, diffText);

  const db = openLoopwrightDb(dbPath);
  try {
    const comparison_id = db.insertComparison({
      worktree_a_id: options.worktree_a_id,
      worktree_b_id: options.worktree_b_id,
      json_report: json,
      markdown_report: markdown,
    });
    return { comparison_id, json, markdown };
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const [worktreeAId, worktreeBId, dbPath = "sessions.db", repoPath = process.cwd()] = Bun.argv.slice(2);
  if (!worktreeAId || !worktreeBId) {
    console.error("Usage: bun run src/ab-compare.ts <worktreeAId> <worktreeBId> [dbPath] [repoPath]");
    process.exit(1);
  }
  const report = await compareWorktrees({
    worktree_a_id: Number(worktreeAId),
    worktree_b_id: Number(worktreeBId),
    db_path: dbPath,
    repo_path: repoPath,
  });
  console.log(report.markdown);
  console.log(JSON.stringify(report.json, null, 2));
}
