import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { create_checkpoint } from "./checkpoint.ts";
import { writeCorrectionCycle } from "./correction-writer.ts";
import { openLoopwrightDb, type LoopwrightDB } from "./db.ts";
import { spawnAgent } from "./spawner.ts";
import { runTests, type TestResult } from "./test-runner.ts";

export interface LoopOptions {
  repoPath: string;
  taskPrompt: string;
  dbPath: string;
  baseBranch?: string;
  maxCycles?: number;
  agentType?: "claude" | "cursor" | "codex";
  engramDbPath?: string;
  project?: string;
  logger?: Pick<Console, "log" | "warn" | "error">;
  commandOverride?: string[];
}

export interface LoopResult {
  status: "passed" | "failed" | "escalated";
  worktreeId: number;
  branchName: string;
  worktreePath: string;
  totalCycles: number;
  cycles: CycleResult[];
  duration_ms: number;
  finalCheckpoint?: { id: number; git_sha: string };
}

export interface CycleResult {
  cycleNumber: number;
  action: "initial" | "correction";
  testResult: TestResult;
  passed: boolean;
  checkpointId?: number;
  agentSessionId?: string;
  duration_ms: number;
}

function isoNow(): string {
  return new Date().toISOString();
}

async function runCommand(cwd: string, cmd: string[]): Promise<{ exit_code: number; stdout: string; stderr: string }> {
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

async function createGitWorktree(repoPath: string, worktreePath: string, branchName: string, baseBranch: string): Promise<void> {
  mkdirSync(dirname(worktreePath), { recursive: true });
  const result = await runCommand(repoPath, ["git", "worktree", "add", worktreePath, "-b", branchName, baseBranch]);
  if (result.exit_code !== 0) {
    throw new Error(`Failed to create worktree ${worktreePath}: ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

function buildTriggerError(testResult: TestResult): string {
  const first = testResult.errors[0];
  if (!first) return `Test failed with exit code ${testResult.exit_code}`;
  const loc = first.line === null ? first.file : `${first.file}:${first.line}`;
  return `${first.type}: ${first.message} at ${loc}`;
}

function fallbackBrief(triggerError: string, errorContext: Record<string, unknown>): string {
  const changedFiles = Array.isArray(errorContext.changed_files)
    ? (errorContext.changed_files as unknown[]).filter((v): v is string => typeof v === "string")
    : [];

  return [
    "# Correction Brief (fallback)",
    "",
    "## Error",
    triggerError,
    "",
    "## Changed Files",
    changedFiles.length ? changedFiles.join(", ") : "(none)",
    "",
    "## Context",
    "```json",
    JSON.stringify(errorContext, null, 2),
    "```",
    "",
  ].join("\n");
}

function findEngramPython(worktreePath: string): string | undefined {
  const envCandidate = process.env.ENGRAM_PYTHON;
  if (envCandidate) return envCandidate;

  for (const rel of [".venv/bin/python3", ".venv/bin/python"]) {
    const candidate = join(worktreePath, rel);
    try {
      if (Bun.file(candidate).size > 0) return candidate;
    } catch {
      // ignore and continue
    }
  }

  return "python3";
}

async function injectCorrectionBrief(params: {
  engramDbPath: string;
  worktreeId: number;
  cycleNumber: number;
  triggerError: string;
  errorContext: Record<string, unknown>;
  worktreePath: string;
  project?: string;
  logger?: Pick<Console, "log" | "warn" | "error">;
}): Promise<void> {
  const logger = params.logger ?? console;
  const claudePath = join(params.worktreePath, "CLAUDE.md");
  const pythonPath = findEngramPython(params.worktreePath);

  const payload = {
    engram_db_path: params.engramDbPath,
    worktree_id: params.worktreeId,
    cycle_number: params.cycleNumber,
    trigger_error: params.triggerError,
    error_context: params.errorContext,
    worktree_path: params.worktreePath,
    project: params.project ?? null,
  };

  if (pythonPath) {
    const pyScript = `
import json, sys
payload = json.loads(sys.argv[1])
try:
    from engram.correction_brief import generate_correction_brief, inject_correction_brief
    brief = generate_correction_brief(
        engram_db_path=payload["engram_db_path"],
        worktree_id=payload["worktree_id"],
        cycle_number=payload["cycle_number"],
        trigger_error=payload["trigger_error"],
        error_context=payload["error_context"],
        worktree_path=payload["worktree_path"],
        project=payload.get("project"),
    )
    inject_correction_brief(worktree_path=payload["worktree_path"], brief=brief)
    print("ok")
except Exception as e:
    print(str(e), file=sys.stderr)
    sys.exit(2)
`.trim();

    try {
      const proc = Bun.spawn({
        cmd: [pythonPath, "-c", pyScript, JSON.stringify(payload)],
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stderr).text(),
      ]);
      if (exitCode === 0) return;
      logger.warn(`[loop] engram brief injection failed, using fallback (${stderr.trim() || `exit ${exitCode}`})`);
    } catch (error) {
      logger.warn("[loop] unable to run engram python, using fallback", error);
    }
  }

  writeFileSync(claudePath, fallbackBrief(params.triggerError, params.errorContext), "utf8");
}

export async function runLoop(options: LoopOptions): Promise<LoopResult> {
  const repoPath = resolve(options.repoPath);
  const dbPath = resolve(options.dbPath);
  const baseBranch = options.baseBranch ?? "main";
  const maxCycles = options.maxCycles ?? 3;
  const logger = options.logger ?? console;
  const timestamp = Date.now();
  const branchName = `loopwright-${timestamp}`;
  const worktreePath = join(repoPath, ".loopwright", "runs", `run-${timestamp}`);
  const eventsPath = join(dirname(worktreePath), "events.jsonl");
  const repoName = basename(repoPath);
  const loopStart = performance.now();

  await createGitWorktree(repoPath, worktreePath, branchName, baseBranch);

  const db = openLoopwrightDb(dbPath);
  let worktreeId = 0;

  try {
    worktreeId = db.upsertWorktree({
      branch_name: branchName,
      base_branch: baseBranch,
      status: "active",
      task_description: options.taskPrompt,
    });

    const cycles: CycleResult[] = [];

    const runAgentAndWait = async (
      prompt: string,
      cycleLabel: string,
    ): Promise<{ stdout: string; stderr: string; exit_code: number; duration_ms: number; sessionId: string }> => {
      const startMs = performance.now();
      const agent = await spawnAgent({
        worktreePath,
        prompt,
        agentType: options.agentType ?? "claude",
        dbPath,
        eventsPath,
        worktreeId,
        commandOverride: options.commandOverride,
      });

      logger.log(`[loop] ${cycleLabel}: agent ${agent.agentId} spawned`);

      const [exit_code, stdout, stderr] = await Promise.all([
        agent.process.exited,
        new Response(agent.process.stdout).text(),
        new Response(agent.process.stderr).text(),
      ]);
      const duration_ms = Math.round(performance.now() - startMs);

      logger.log(`[loop] ${cycleLabel}: agent finished (exit=${exit_code}, ${duration_ms}ms)`);
      return { stdout, stderr, exit_code, duration_ms, sessionId: agent.sessionId };
    };

    const runTestsAndRecord = async (): Promise<TestResult> => {
      logger.log("[loop] running tests...");
      const result = await runTests({ worktreePath, baseBranch });
      logger.log(`[loop] tests ${result.passed ? "PASSED" : "FAILED"} (${result.errors.length} errors, ${result.duration_ms}ms)`);
      return result;
    };

    const finishPassed = async (totalCycles: number): Promise<LoopResult> => {
      const cp = await create_checkpoint(worktreePath, worktreeId, dbPath, repoName);
      const lastCycle = cycles[cycles.length - 1];
      if (lastCycle) lastCycle.checkpointId = cp.checkpoint_id;
      db.updateWorktreeStatus(worktreeId, "passed", isoNow());
      return {
        status: "passed",
        worktreeId,
        branchName,
        worktreePath,
        totalCycles,
        cycles,
        duration_ms: Math.round(performance.now() - loopStart),
        finalCheckpoint: { id: cp.checkpoint_id, git_sha: cp.git_sha },
      };
    };

    // Initial run
    const initialRun = await runAgentAndWait(options.taskPrompt, "initial");
    const initialTests = await runTestsAndRecord();
    cycles.push({
      cycleNumber: 0,
      action: "initial",
      testResult: initialTests,
      passed: initialTests.passed,
      agentSessionId: initialRun.sessionId,
      duration_ms: initialRun.duration_ms + initialTests.duration_ms,
    });

    if (initialTests.passed) {
      return await finishPassed(0);
    }

    let cycleNumber = 0;
    while (cycleNumber < maxCycles) {
      cycleNumber += 1;
      const lastTestResult = cycles[cycles.length - 1]!.testResult;

      const { cycleId } = writeCorrectionCycle({
        db,
        worktreeId,
        testResult: lastTestResult,
      });
      logger.log(`[loop] correction-${cycleNumber}: recorded correction cycle ${cycleId}`);

      const errorContext = {
        errors: lastTestResult.errors,
        test_command: lastTestResult.test_command,
        exit_code: lastTestResult.exit_code,
        stdout_tail: lastTestResult.stdout_tail,
        stderr_tail: lastTestResult.stderr_tail,
        changed_files: lastTestResult.changed_files,
      } satisfies Record<string, unknown>;

      await injectCorrectionBrief({
        engramDbPath: options.engramDbPath ?? dbPath,
        worktreeId,
        cycleNumber,
        triggerError: buildTriggerError(lastTestResult),
        errorContext,
        worktreePath,
        project: options.project,
        logger,
      });

      const correctionPrompt =
        "Read CLAUDE.md for the correction brief. Fix the errors described. Run tests to verify your fix.";
      const corrRun = await runAgentAndWait(correctionPrompt, `correction-${cycleNumber}`);
      const corrTests = await runTestsAndRecord();

      cycles.push({
        cycleNumber,
        action: "correction",
        testResult: corrTests,
        passed: corrTests.passed,
        agentSessionId: corrRun.sessionId,
        duration_ms: corrRun.duration_ms + corrTests.duration_ms,
      });

      if (corrTests.passed) {
        return await finishPassed(cycleNumber);
      }
    }

    db.updateWorktreeStatus(worktreeId, "escalated", isoNow());
    return {
      status: "escalated",
      worktreeId,
      branchName,
      worktreePath,
      totalCycles: cycleNumber,
      cycles,
      duration_ms: Math.round(performance.now() - loopStart),
    };
  } catch (error) {
    if (worktreeId > 0) {
      try {
        db.updateWorktreeStatus(worktreeId, "failed", isoNow());
      } catch {
        // best effort
      }
    }
    throw error;
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const [taskPrompt, repoPath, dbPath, baseBranch] = Bun.argv.slice(2);
  if (!taskPrompt || !repoPath) {
    console.error("Usage: bun run src/loop.ts <task_prompt> <repo_path> [db_path] [base_branch]");
    process.exit(1);
  }

  const result = await runLoop({
    taskPrompt,
    repoPath,
    dbPath: dbPath ?? join(repoPath, "sessions.db"),
    baseBranch: baseBranch ?? "main",
  });

  console.log(JSON.stringify(result, null, 2));
  process.exit(result.status === "passed" ? 0 : 1);
}
