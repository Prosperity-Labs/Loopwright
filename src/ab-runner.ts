import { mkdirSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { create_checkpoint } from "./checkpoint.ts";
import { EventBridge } from "./bridge.ts";
import { openLoopwrightDb } from "./db.ts";
import { startWorktreeWatcher, type WorktreeWatcher } from "./watcher.ts";

export interface ABRunnerOptions {
  task_prompt: string;
  base_branch?: string;
  repo_path: string;
  db_path: string;
  agent_command_factory?: (taskPrompt: string) => string[];
}

export interface ABSideResult {
  label: "A" | "B";
  session_id: string;
  worktree_id: number;
  worktree_path: string;
  branch_name: string;
  agent_command: string[];
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
  changed_files: string[];
  checkpoint_id: number;
  git_sha: string;
  error_count: number;
}

export interface ABRunResult {
  run_id: string;
  events_path: string;
  base_branch: string;
  repo_path: string;
  db_path: string;
  a: ABSideResult;
  b: ABSideResult;
}

interface SpawnResult {
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
}

const DEFAULT_BASE_BRANCH = "main";

function nowIso(): string {
  return new Date().toISOString();
}

function defaultAgentCommand(taskPrompt: string): string[] {
  return ["claude", "--print", taskPrompt];
}

async function runCommand(cwd: string, cmd: string[]): Promise<{ stdout: string; stderr: string; exit_code: number }> {
  const proc = Bun.spawn({
    cmd,
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exit_code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return { exit_code, stdout, stderr };
}

export async function spawnCapturedProcess(cwd: string, cmd: string[]): Promise<SpawnResult> {
  const startedAt = performance.now();
  const result = await runCommand(cwd, cmd);
  return {
    ...result,
    duration_ms: Math.round(performance.now() - startedAt),
  };
}

function makeRunPaths(repoPath: string, runId: string): { root: string; pathA: string; pathB: string; eventsPath: string } {
  const root = join(repoPath, ".loopwright", "ab-runs", runId);
  mkdirSync(root, { recursive: true });
  return {
    root,
    pathA: join(root, "worktree-a"),
    pathB: join(root, "worktree-b"),
    eventsPath: join(root, "events.jsonl"),
  };
}

export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  const result = await runCommand(repoPath, ["git", "worktree", "remove", worktreePath, "--force"]);
  if (result.exit_code !== 0) {
    throw new Error(`Failed to remove worktree ${worktreePath}: ${result.stderr || result.stdout}`);
  }
}

async function createGitWorktree(repoPath: string, worktreePath: string, branchName: string, baseBranch: string): Promise<void> {
  mkdirSync(resolve(worktreePath, ".."), { recursive: true });
  const result = await runCommand(repoPath, ["git", "worktree", "add", worktreePath, "-b", branchName, baseBranch]);
  if (result.exit_code !== 0) {
    throw new Error(`Failed to create worktree ${worktreePath}: ${result.stderr || result.stdout}`);
  }
}

function parseErrorCount(exitCode: number, stderr: string): number {
  if (exitCode !== 0) return 1;
  return stderr.trim() ? 1 : 0;
}

async function buildSideResult(params: {
  label: "A" | "B";
  sessionId: string;
  worktreeId: number;
  worktreePath: string;
  branchName: string;
  agentCommand: string[];
  repoName: string;
  dbPath: string;
  spawnResult: SpawnResult;
}): Promise<ABSideResult> {
  const checkpoint = await create_checkpoint(
    params.worktreePath,
    params.worktreeId,
    params.dbPath,
    params.repoName,
  );

  return {
    label: params.label,
    session_id: params.sessionId,
    worktree_id: params.worktreeId,
    worktree_path: params.worktreePath,
    branch_name: params.branchName,
    agent_command: params.agentCommand,
    exit_code: params.spawnResult.exit_code,
    stdout: params.spawnResult.stdout,
    stderr: params.spawnResult.stderr,
    duration_ms: params.spawnResult.duration_ms,
    changed_files: checkpoint.changed_files,
    checkpoint_id: checkpoint.checkpoint_id,
    git_sha: checkpoint.git_sha,
    error_count: parseErrorCount(params.spawnResult.exit_code, params.spawnResult.stderr),
  };
}

export async function runABTest(options: ABRunnerOptions): Promise<ABRunResult> {
  const repoPath = resolve(options.repo_path);
  const dbPath = resolve(options.db_path);
  const baseBranch = options.base_branch ?? DEFAULT_BASE_BRANCH;
  const timestamp = Date.now();
  const runId = `ab-${timestamp}`;
  const branchA = `ab-test-a-${timestamp}`;
  const branchB = `ab-test-b-${timestamp}`;
  const sessionA = `${runId}-a`;
  const sessionB = `${runId}-b`;
  const repoName = basename(repoPath);
  const { pathA, pathB, eventsPath } = makeRunPaths(repoPath, runId);

  await createGitWorktree(repoPath, pathA, branchA, baseBranch);
  try {
    await createGitWorktree(repoPath, pathB, branchB, baseBranch);
  } catch (error) {
    await removeWorktree(repoPath, pathA).catch(() => undefined);
    throw error;
  }

  const db = openLoopwrightDb(dbPath);
  let watcherA: WorktreeWatcher | undefined;
  let watcherB: WorktreeWatcher | undefined;
  let bridge: EventBridge | undefined;

  try {
    db.markSessionStart(sessionA, nowIso(), { filepath: pathA, project: repoPath });
    db.markSessionStart(sessionB, nowIso(), { filepath: pathB, project: repoPath });

    const worktreeAId = db.upsertWorktree({
      session_id: sessionA,
      branch_name: branchA,
      base_branch: baseBranch,
      status: "active",
      task_description: options.task_prompt,
    });
    const worktreeBId = db.upsertWorktree({
      session_id: sessionB,
      branch_name: branchB,
      base_branch: baseBranch,
      status: "active",
      task_description: options.task_prompt,
    });

    bridge = new EventBridge({ eventsPath, dbPath });
    await bridge.start();

    watcherA = startWorktreeWatcher({ worktreePath: pathA, eventsPath, worktreeId: worktreeAId });
    watcherB = startWorktreeWatcher({ worktreePath: pathB, eventsPath, worktreeId: worktreeBId });

    const commandFactory = options.agent_command_factory ?? defaultAgentCommand;
    const commandA = commandFactory(options.task_prompt);
    const commandB = commandFactory(options.task_prompt);

    const [spawnA, spawnB] = await Promise.all([
      spawnCapturedProcess(pathA, commandA),
      spawnCapturedProcess(pathB, commandB),
    ]);

    watcherA.close();
    watcherB.close();
    watcherA = undefined;
    watcherB = undefined;

    await bridge.processAvailableLines();

    const [a, b] = await Promise.all([
      buildSideResult({
        label: "A",
        sessionId: sessionA,
        worktreeId: worktreeAId,
        worktreePath: pathA,
        branchName: branchA,
        agentCommand: commandA,
        repoName,
        dbPath,
        spawnResult: spawnA,
      }),
      buildSideResult({
        label: "B",
        sessionId: sessionB,
        worktreeId: worktreeBId,
        worktreePath: pathB,
        branchName: branchB,
        agentCommand: commandB,
        repoName,
        dbPath,
        spawnResult: spawnB,
      }),
    ]);

    db.insertArtifact({
      worktree_id: worktreeAId,
      session_id: sessionA,
      file_path: "__ab_runner__/result.json",
      event_type: "ab_result",
      metadata_json: a,
    });
    db.insertArtifact({
      worktree_id: worktreeBId,
      session_id: sessionB,
      file_path: "__ab_runner__/result.json",
      event_type: "ab_result",
      metadata_json: b,
    });

    db.updateWorktreeStatus(worktreeAId, a.exit_code === 0 ? "passed" : "failed", nowIso());
    db.updateWorktreeStatus(worktreeBId, b.exit_code === 0 ? "passed" : "failed", nowIso());
    db.markSessionEnd(sessionA, nowIso());
    db.markSessionEnd(sessionB, nowIso());

    return {
      run_id: runId,
      events_path: eventsPath,
      base_branch: baseBranch,
      repo_path: repoPath,
      db_path: dbPath,
      a,
      b,
    };
  } catch (error) {
    if (watcherA) watcherA.close();
    if (watcherB) watcherB.close();
    throw error;
  } finally {
    bridge?.close();
    db.close();
  }
}

export async function cleanupABRunWorktrees(result: Pick<ABRunResult, "repo_path" | "a" | "b">): Promise<void> {
  const failures: string[] = [];
  for (const path of [result.a.worktree_path, result.b.worktree_path]) {
    try {
      await removeWorktree(result.repo_path, path);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  try {
    rmSync(join(result.repo_path, ".loopwright", "ab-runs"), { recursive: false });
  } catch {
    // best-effort cleanup of empty parent folder; ignore if non-empty/missing
  }

  if (failures.length > 0) {
    throw new Error(failures.join("\n"));
  }
}

if (import.meta.main) {
  const [taskPrompt, repoPath = process.cwd(), dbPath = join(process.cwd(), "sessions.db"), baseBranch = "main"] = Bun.argv.slice(2);
  if (!taskPrompt) {
    console.error("Usage: bun run src/ab-runner.ts <task_prompt> [repo_path] [db_path] [base_branch]");
    process.exit(1);
  }

  const result = await runABTest({
    task_prompt: taskPrompt,
    repo_path: repoPath,
    db_path: dbPath,
    base_branch: baseBranch,
  });
  console.log(JSON.stringify(result, null, 2));
}
