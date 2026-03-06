import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { create_checkpoint } from "./checkpoint.ts";
import { writeCorrectionCycle } from "./correction-writer.ts";
import { openLoopwrightDb, type LoopwrightDB } from "./db.ts";
import { spawnAgent, waitForAgent, registry } from "./spawner.ts";
import { removeWorktree } from "./ab-runner.ts";
import { runTests, type TestResult } from "./test-runner.ts";

export interface LoopOptions {
  repoPath: string;
  taskPrompt: string;
  dbPath: string;
  baseBranch?: string;
  maxCycles?: number;
  agentType?: "claude" | "cursor" | "codex";
  /** Model override (claude only). Aliases: "sonnet", "haiku", "opus" or full model IDs. */
  model?: string;
  engramDbPath?: string;
  /** Path to Engram source root (for PYTHONPATH). Falls back to ENGRAM_PATH env or auto-detect from engramDbPath. */
  engramPath?: string;
  project?: string;
  logger?: Pick<Console, "log" | "warn" | "error">;
  commandOverride?: string[];
  /** Override auto-detected test command (e.g. "pytest tests/" or "bun test src/"). */
  testCommand?: string;
  /** Max time (ms) for a single agent run before killing it. Default: 600_000 (10 min). */
  agentTimeoutMs?: number;
  /** Max time (ms) for the entire loop before aborting. Default: 1_800_000 (30 min). */
  loopTimeoutMs?: number;
  /** Remove the worktree directory after loop finishes. Default: true. */
  cleanupWorktree?: boolean;
}

export class LoopTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoopTimeoutError";
  }
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
  agentContext?: string;
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

async function getGitSnapshot(cwd: string): Promise<string> {
  const [head, status] = await Promise.all([
    runCommand(cwd, ["git", "rev-parse", "HEAD"]),
    runCommand(cwd, ["git", "status", "--porcelain", "-uno"]),
  ]);
  return `${head.stdout.trim()}|${status.stdout.trim()}`;
}

const ACTION_VERBS = /\b(add|edit|delete|move|create|update|fix|remove|rename|replace|insert|modify|write|change)\b/i;
const MAX_PROMPT_WORDS = 50;

/**
 * Decompose a complex task prompt into the smallest actionable instruction.
 *
 * Complex prompts cause Claude Code to plan-without-acting in --print mode.
 * This extracts the first concrete action (≤50 words, one action verb) so
 * the agent edits files instead of describing what it would do.
 */
function focusPrompt(taskPrompt: string): string {
  const words = taskPrompt.trim().split(/\s+/);
  if (words.length <= MAX_PROMPT_WORDS) return taskPrompt.trim();

  // Split into lines/sentences — try newlines first, then periods
  const lines = taskPrompt
    .split(/\n/)
    .map((l) => l.replace(/^[\s\-*#>]+/, "").trim())
    .filter((l) => l.length > 10);

  // Find the first line containing an action verb
  for (const line of lines) {
    if (ACTION_VERBS.test(line)) {
      const lineWords = line.split(/\s+/);
      if (lineWords.length <= MAX_PROMPT_WORDS) return line;
      return lineWords.slice(0, MAX_PROMPT_WORDS).join(" ");
    }
  }

  // Fallback: first non-empty line, trimmed
  const first = lines[0] ?? taskPrompt.trim();
  return first.split(/\s+/).slice(0, MAX_PROMPT_WORDS).join(" ");
}

/**
 * Write .claude/settings.json into the worktree with pre-approved permissions.
 * Prevents headless agents from hanging on permission prompts.
 */
export function writePermissionsFile(worktreePath: string): void {
  const claudeDir = join(worktreePath, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  const settings = {
    permissions: {
      allow: [
        "Bash(engram search*)",
        "Bash(engram brief*)",
        "Bash(pytest*)",
        "Bash(bun test*)",
        "Bash(git *)",
        "Read",
        "Write",
        "Edit",
        "Glob",
        "Grep",
      ],
    },
  };
  writeFileSync(join(claudeDir, "settings.json"), JSON.stringify(settings, null, 2), "utf8");
}

/**
 * Write CLAUDE.md into the worktree before agent spawn.
 * Contains the full untruncated task and a measurement tracking header
 * so the agent has full context even when the spawn prompt is focused/truncated.
 */
export function writePreSpawnClaudeMd(worktreePath: string, taskPrompt: string, taskId?: string): void {
  const id = taskId ?? randomUUID();
  const startedAt = new Date().toISOString();
  const content = `# Loopwright Task

TASK_ID: ${id}
STARTED_AT: ${startedAt}
METRIC: tool_calls / files_changed / tests_passed

## Full Task
${taskPrompt}

## Record when done
- tool_calls_made:
- files_changed:
- tests_passed:
- tests_failed:
- unexpected_behaviors:
`;
  writeFileSync(join(worktreePath, "CLAUDE.md"), content, "utf8");
}

/**
 * Read CLAUDE.md from worktree and extract the "Record when done" measurements section.
 * Returns the raw text block if found, undefined otherwise.
 */
export function extractMeasurements(worktreePath: string): string | undefined {
  const claudePath = join(worktreePath, "CLAUDE.md");
  try {
    const content = readFileSync(claudePath, "utf8");
    const marker = "## Record when done";
    const idx = content.indexOf(marker);
    if (idx === -1) return undefined;
    const section = content.slice(idx + marker.length).trim();
    if (!section) return undefined;
    return section;
  } catch {
    return undefined;
  }
}

/**
 * Auto-commit any uncommitted agent work in the worktree.
 * Called before worktree cleanup so changes survive on the branch.
 */
async function autoCommitWorktree(worktreePath: string, logger: Pick<Console, "log" | "warn">): Promise<boolean> {
  // Check if there's anything to commit
  const status = await runCommand(worktreePath, ["git", "status", "--porcelain"]);
  if (!status.stdout.trim()) {
    logger.log("[loop] auto-commit: nothing to commit");
    return false;
  }

  const addResult = await runCommand(worktreePath, ["git", "add", "-A"]);
  if (addResult.exit_code !== 0) {
    logger.warn(`[loop] auto-commit: git add failed (exit ${addResult.exit_code})`);
    return false;
  }

  const commitResult = await runCommand(worktreePath, [
    "git", "commit", "-m", "loopwright: auto-save agent work before cleanup",
  ]);
  if (commitResult.exit_code !== 0) {
    logger.warn(`[loop] auto-commit: git commit failed (exit ${commitResult.exit_code})`);
    return false;
  }

  logger.log("[loop] auto-commit: saved agent work to branch");
  return true;
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

/**
 * Resolve the Engram source root for PYTHONPATH.
 * Priority: explicit path → ENGRAM_PATH env → dirname(engramDbPath) if it contains engram/__init__.py.
 */
function resolveEngramPath(explicit?: string, engramDbPath?: string): string | undefined {
  if (explicit) return resolve(explicit);

  const envPath = process.env.ENGRAM_PATH;
  if (envPath && existsSync(join(envPath, "engram", "__init__.py"))) return resolve(envPath);

  if (engramDbPath) {
    const candidate = dirname(resolve(engramDbPath));
    if (existsSync(join(candidate, "engram", "__init__.py"))) return candidate;
  }

  return undefined;
}

function buildPythonEnv(engramPath: string | undefined): Record<string, string> | undefined {
  if (!engramPath) return undefined;
  const existing = process.env.PYTHONPATH;
  return {
    ...(process.env as Record<string, string>),
    PYTHONPATH: existing ? `${engramPath}:${existing}` : engramPath,
  };
}

async function generateProjectBrief(params: {
  repoPath: string;
  worktreePath: string;
  engramDbPath: string;
  engramPath?: string;
  project?: string;
  logger?: Pick<Console, "log" | "warn" | "error">;
}): Promise<string | undefined> {
  const logger = params.logger ?? console;
  const pythonPath = findEngramPython(params.worktreePath) ?? findEngramPython(params.repoPath);

  if (!pythonPath) return undefined;

  const pyScript = `
import sys
try:
    from engram.recall.session_db import SessionDB
    from engram.recall.artifact_extractor import ArtifactExtractor
    from engram.brief import generate_brief
    db = SessionDB(sys.argv[1])
    ArtifactExtractor(db)  # ensures artifacts table exists
    project = sys.argv[2] if sys.argv[2] != "null" else None
    brief = generate_brief(db=db, project=project or "default")
    print(brief)
except Exception as e:
    print(str(e), file=sys.stderr)
    sys.exit(2)
`.trim();

  try {
    const pyEnv = buildPythonEnv(params.engramPath);
    const proc = Bun.spawn({
      cmd: [pythonPath, "-c", pyScript, params.engramDbPath, params.project ?? "null"],
      stdout: "pipe",
      stderr: "pipe",
      ...(pyEnv ? { env: pyEnv } : {}),
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (exitCode === 0 && stdout.trim()) {
      logger.log(`[loop] engram project brief generated (${stdout.trim().length} chars)`);
      return stdout.trim();
    }
    logger.warn(`[loop] engram brief generation failed: ${stderr.trim() || `exit ${exitCode}`}`);
  } catch (error) {
    logger.warn("[loop] unable to run engram for project brief", error);
  }

  return undefined;
}

async function injectCorrectionBrief(params: {
  engramDbPath: string;
  engramPath?: string;
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
    from engram.recall.session_db import SessionDB
    from engram.recall.artifact_extractor import ArtifactExtractor
    from engram.correction_brief import generate_correction_brief, inject_correction_brief
    db = SessionDB(payload["engram_db_path"])
    ArtifactExtractor(db)  # ensures artifacts table exists
    brief = generate_correction_brief(
        db=db,
        worktree_id=payload["worktree_id"],
        cycle_number=payload["cycle_number"],
        trigger_error=payload["trigger_error"],
        error_context=payload["error_context"],
        project=payload.get("project"),
    )
    inject_correction_brief(
        worktree_path=payload["worktree_path"],
        brief_content=brief,
        cycle_number=payload["cycle_number"],
    )
    print("ok")
except Exception as e:
    print(str(e), file=sys.stderr)
    sys.exit(2)
`.trim();

    try {
      const pyEnv = buildPythonEnv(params.engramPath);
      const proc = Bun.spawn({
        cmd: [pythonPath, "-c", pyScript, JSON.stringify(payload)],
        stdout: "pipe",
        stderr: "pipe",
        ...(pyEnv ? { env: pyEnv } : {}),
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
  const agentTimeoutMs = options.agentTimeoutMs ?? 600_000;
  const loopTimeoutMs = options.loopTimeoutMs ?? 1_800_000;
  const shouldCleanup = options.cleanupWorktree !== false;
  const timestamp = Date.now();
  const branchName = `loopwright-${timestamp}`;
  const worktreePath = join(repoPath, ".loopwright", "runs", `run-${timestamp}`);
  const eventsPath = join(dirname(worktreePath), "events.jsonl");
  const repoName = basename(repoPath);
  const loopStart = performance.now();

  function checkLoopTimeout(): void {
    if (performance.now() - loopStart > loopTimeoutMs) {
      throw new LoopTimeoutError(`Loop exceeded ${loopTimeoutMs}ms timeout`);
    }
  }

  await createGitWorktree(repoPath, worktreePath, branchName, baseBranch);

  const engramDbPath = options.engramDbPath ?? dbPath;
  const engramPath = resolveEngramPath(options.engramPath, engramDbPath);
  if (engramPath) {
    logger.log(`[loop] engram source root: ${engramPath}`);
  }

  const db = openLoopwrightDb(dbPath);
  let worktreeId = 0;

  try {
    worktreeId = db.upsertWorktree({
      branch_name: branchName,
      base_branch: baseBranch,
      status: "active",
      task_description: options.taskPrompt,
    });

    // Pre-approve permissions so headless agents don't hang on prompts
    writePermissionsFile(worktreePath);

    // Write CLAUDE.md with full task context + measurement header
    const taskId = `${branchName}-${timestamp}`;
    writePreSpawnClaudeMd(worktreePath, options.taskPrompt, taskId);

    // Generate project brief from Engram for agent context
    const projectBrief = await generateProjectBrief({
      repoPath,
      worktreePath,
      engramDbPath,
      engramPath,
      project: options.project,
      logger,
    });

    const cycles: CycleResult[] = [];

    const runAgentAndWait = async (
      prompt: string,
      cycleLabel: string,
      systemPrompt?: string,
    ): Promise<{ stdout: string; stderr: string; exit_code: number; duration_ms: number; sessionId: string; timedOut: boolean }> => {
      const startMs = performance.now();
      const agent = await spawnAgent({
        worktreePath,
        prompt,
        agentType: options.agentType ?? "claude",
        model: options.model,
        systemPrompt,
        dbPath,
        eventsPath,
        worktreeId,
        commandOverride: options.commandOverride,
      });

      logger.log(`[loop] ${cycleLabel}: agent ${agent.agentId} spawned`);

      const result = await waitForAgent(agent, agentTimeoutMs);
      const duration_ms = Math.round(performance.now() - startMs);

      if (result.timedOut) {
        logger.warn(`[loop] ${cycleLabel}: agent timed out after ${agentTimeoutMs}ms`);
      }

      logger.log(`[loop] ${cycleLabel}: agent finished (exit=${result.exitCode}, ${duration_ms}ms)`);

      // Log agent output tail for debuggability
      const tail = (s: string) => s.slice(-500).trim();
      if (result.exitCode !== 0 || result.stdout.trim()) {
        logger.log(`[loop] ${cycleLabel} stdout (last 500):\n${tail(result.stdout)}`);
      }
      if (result.stderr.trim()) {
        logger.warn(`[loop] ${cycleLabel} stderr (last 500):\n${tail(result.stderr)}`);
      }

      return { stdout: result.stdout, stderr: result.stderr, exit_code: result.exitCode, duration_ms, sessionId: agent.sessionId, timedOut: result.timedOut };
    };

    const runTestsAndRecord = async (): Promise<TestResult> => {
      logger.log("[loop] running tests...");
      const result = await runTests({ worktreePath, baseBranch, testCommand: options.testCommand });
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

    // Decompose complex prompts into a single actionable instruction.
    // Complex prompts cause Claude Code --print to plan-without-acting.
    const agentPrompt = focusPrompt(options.taskPrompt);
    if (agentPrompt !== options.taskPrompt) {
      logger.log(`[loop] prompt focused (${options.taskPrompt.split(/\s+/).length} → ${agentPrompt.split(/\s+/).length} words): ${agentPrompt}`);
    }

    // Initial run — pass project brief as system prompt for context
    checkLoopTimeout();
    const initialRun = await runAgentAndWait(agentPrompt, "initial", projectBrief);
    if (initialRun.timedOut) {
      logger.warn("[loop] initial agent timed out — escalating");
      db.updateWorktreeStatus(worktreeId, "escalated", isoNow());
      return {
        status: "escalated",
        worktreeId,
        branchName,
        worktreePath,
        totalCycles: 0,
        cycles: [],
        duration_ms: Math.round(performance.now() - loopStart),
      };
    }
    const initialMeasurements = extractMeasurements(worktreePath);
    const initialTests = await runTestsAndRecord();

    cycles.push({
      cycleNumber: 0,
      action: "initial",
      testResult: initialTests,
      passed: initialTests.passed,
      agentSessionId: initialRun.sessionId,
      agentContext: initialMeasurements,
      duration_ms: initialRun.duration_ms + initialTests.duration_ms,
    });

    // If the agent made zero changes, it failed to execute — escalate immediately
    if (initialTests.changed_files.length === 0) {
      logger.warn("[loop] initial agent made no file changes — escalating");
      db.updateWorktreeStatus(worktreeId, "escalated", isoNow());
      return {
        status: "escalated",
        worktreeId,
        branchName,
        worktreePath,
        totalCycles: 0,
        cycles,
        duration_ms: Math.round(performance.now() - loopStart),
      };
    }

    if (initialTests.passed) {
      return await finishPassed(0);
    }

    let cycleNumber = 0;
    while (cycleNumber < maxCycles) {
      cycleNumber += 1;
      checkLoopTimeout();
      const lastTestResult = cycles[cycles.length - 1]!.testResult;

      // Grab agent context from previous cycle (if agent filled in measurements)
      const prevCycle = cycles[cycles.length - 1];
      const { cycleId } = writeCorrectionCycle({
        db,
        worktreeId,
        testResult: lastTestResult,
        agentContext: prevCycle?.agentContext,
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
        engramDbPath,
        engramPath,
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
      const snapshotBefore = await getGitSnapshot(worktreePath);
      const corrRun = await runAgentAndWait(correctionPrompt, `correction-${cycleNumber}`);
      if (corrRun.timedOut) {
        logger.warn(`[loop] correction-${cycleNumber}: agent timed out — escalating`);
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
      }
      const corrMeasurements = extractMeasurements(worktreePath);
      const snapshotAfter = await getGitSnapshot(worktreePath);

      // If correction agent made no changes, escalate rather than burning another cycle
      if (snapshotBefore === snapshotAfter) {
        logger.warn(`[loop] correction-${cycleNumber}: agent made no changes — escalating`);
        cycles.push({
          cycleNumber,
          action: "correction",
          testResult: lastTestResult,
          passed: false,
          agentSessionId: corrRun.sessionId,
          agentContext: corrMeasurements,
          duration_ms: corrRun.duration_ms,
        });
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
      }

      const corrTests = await runTestsAndRecord();

      cycles.push({
        cycleNumber,
        action: "correction",
        testResult: corrTests,
        passed: corrTests.passed,
        agentSessionId: corrRun.sessionId,
        agentContext: corrMeasurements,
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
    if (error instanceof LoopTimeoutError) {
      logger.warn(`[loop] ${error.message} — escalating`);
      if (worktreeId > 0) {
        try {
          db.updateWorktreeStatus(worktreeId, "escalated", isoNow());
        } catch {
          // best effort
        }
      }
      return {
        status: "escalated",
        worktreeId,
        branchName,
        worktreePath,
        totalCycles: 0,
        cycles: [],
        duration_ms: Math.round(performance.now() - loopStart),
      };
    }
    logger.error(`[loop] FATAL ERROR:`, error);
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

    // Kill any agents still running in this worktree
    for (const agent of registry.list()) {
      if (agent.worktreePath === worktreePath) {
        try {
          agent.process.kill();
        } catch {
          // no-op
        }
      }
    }

    // Auto-commit any uncommitted agent work so it survives on the branch
    if (shouldCleanup) {
      try {
        await autoCommitWorktree(worktreePath, logger);
      } catch (err) {
        logger.warn(`[loop] auto-commit failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Clean up worktree directory
    if (shouldCleanup) {
      try {
        await removeWorktree(repoPath, worktreePath);
      } catch (err) {
        logger.warn(`[loop] worktree cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

if (import.meta.main) {
  const [taskPrompt, repoPath, dbPath, baseBranch] = Bun.argv.slice(2);
  if (!taskPrompt || !repoPath) {
    console.error("Usage: bun run src/loop.ts <task_prompt> <repo_path> [db_path] [base_branch]");
    process.exit(1);
  }

  process.on("SIGINT", async () => {
    console.warn("\n[loop] SIGINT received — killing all agents");
    await registry.killAll();
    process.exit(130);
  });

  const agentType = (process.env.LOOPWRIGHT_AGENT_TYPE as LoopOptions["agentType"]) ?? undefined;
  const agentTimeoutMs = process.env.LOOPWRIGHT_AGENT_TIMEOUT_MS ? Number(process.env.LOOPWRIGHT_AGENT_TIMEOUT_MS) : undefined;
  const loopTimeoutMs = process.env.LOOPWRIGHT_LOOP_TIMEOUT_MS ? Number(process.env.LOOPWRIGHT_LOOP_TIMEOUT_MS) : undefined;

  const result = await runLoop({
    taskPrompt,
    repoPath,
    dbPath: dbPath ?? join(repoPath, "sessions.db"),
    baseBranch: baseBranch ?? "main",
    agentType,
    agentTimeoutMs,
    loopTimeoutMs,
  });

  console.log(JSON.stringify(result, null, 2));
  process.exit(result.status === "passed" ? 0 : 1);
}
