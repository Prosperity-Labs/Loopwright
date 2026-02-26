import { existsSync } from "node:fs";
import type { LoopwrightDB, CheckpointRow } from "./db.ts";
import { openLoopwrightDb } from "./db.ts";
import { writeCorrectionCycle } from "./correction-writer.ts";
import type { TestResult } from "./test-runner.ts";
import { runTests } from "./test-runner.ts";
import { spawnAgent, type SpawnedAgent } from "./spawner.ts";
import { create_checkpoint } from "./checkpoint.ts";

export interface CorrectorOptions {
  db: LoopwrightDB;
  worktreeId: number;
  worktreePath: string;
  testResult: TestResult;
  dbPath: string;
  eventsPath: string;
  engramDbPath?: string;
  engramPythonPath?: string;
  maxCycles?: number;
  agentType?: "claude" | "cursor" | "codex";
  /** Model override (claude only). Aliases: "sonnet", "haiku", "opus" or full model IDs. */
  model?: string;
  project?: string;
  repoName?: string;
  /** Override the spawned agent command (for testing). */
  commandOverride?: string[];
}

export interface CorrectionResult {
  action: "corrected" | "passed" | "escalated";
  cycleNumber: number;
  cycleId: number;
  checkpointId?: number;
  spawnedAgent?: SpawnedAgent;
  triggerError: string;
}

function isoNow(): string {
  return new Date().toISOString();
}

function buildTriggerError(testResult: TestResult): string {
  const first = testResult.errors[0];
  if (!first) {
    return `Test failed with exit code ${testResult.exit_code}`;
  }
  const location = first.line === null ? first.file : `${first.file}:${first.line}`;
  return `${first.type}: ${first.message} at ${location}`;
}

export function findEngramPython(override?: string): string {
  if (override) return override;

  const candidates = [
    "/home/prosperitylabs/Desktop/development/engram/.venv/bin/python3",
    "/home/prosperitylabs/Desktop/development/engram/.venv/bin/python",
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return "python3";
}

export async function buildCorrectionBrief(params: {
  engramDbPath: string;
  engramPythonPath?: string;
  worktreeId: number;
  cycleNumber: number;
  triggerError: string;
  errorContext: Record<string, unknown>;
  worktreePath: string;
  project?: string;
}): Promise<{ claude_md: string; cycle_number: number; appended: boolean }> {
  const pythonPath = findEngramPython(params.engramPythonPath);

  const errorContextJson = JSON.stringify(params.errorContext);
  const triggerErrorJson = JSON.stringify(params.triggerError);
  const worktreePathJson = JSON.stringify(params.worktreePath);
  const dbPathJson = JSON.stringify(params.engramDbPath);
  const projectPy = params.project ? JSON.stringify(params.project) : "None";

  const script = [
    "import json, sys",
    "from engram.recall.session_db import SessionDB",
    "from engram.correction_brief import generate_correction_brief, inject_correction_brief",
    "",
    `db = SessionDB(db_path=${dbPathJson})`,
    `brief = generate_correction_brief(`,
    `    db,`,
    `    worktree_id=${params.worktreeId},`,
    `    cycle_number=${params.cycleNumber},`,
    `    trigger_error=${triggerErrorJson},`,
    `    error_context=json.loads(${JSON.stringify(errorContextJson)}),`,
    `    project=${projectPy},`,
    `)`,
    `result = inject_correction_brief(${worktreePathJson}, brief, ${params.cycleNumber})`,
    `print(json.dumps(result))`,
  ].join("\n");

  const proc = Bun.spawn({
    cmd: [pythonPath, "-c", script],
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  if (exitCode !== 0) {
    throw new Error(`Engram correction brief failed (exit ${exitCode}): ${stderr.trim() || stdout.trim()}`);
  }

  try {
    return JSON.parse(stdout.trim()) as { claude_md: string; cycle_number: number; appended: boolean };
  } catch {
    throw new Error(`Failed to parse Engram output: ${stdout.trim()}`);
  }
}

export async function correctOrEscalate(options: CorrectorOptions): Promise<CorrectionResult> {
  const {
    db,
    worktreeId,
    worktreePath,
    testResult,
    dbPath,
    eventsPath,
    maxCycles = 3,
    repoName = "loopwright",
  } = options;

  const checkpoints = db.listCheckpoints(worktreeId);
  const lastCheckpoint: CheckpointRow | undefined = checkpoints[checkpoints.length - 1];

  const { cycleId, cycleNumber, shouldContinue } = writeCorrectionCycle({
    db,
    worktreeId,
    testResult,
    checkpointId: lastCheckpoint?.id,
    agentSessionId: undefined,
  });

  const triggerError = buildTriggerError(testResult);

  if (testResult.passed) {
    const cp = await create_checkpoint(worktreePath, worktreeId, dbPath, repoName);
    db.updateWorktreeStatus(worktreeId, "passed", isoNow());
    return { action: "passed", cycleNumber, cycleId, checkpointId: cp.checkpoint_id, triggerError };
  }

  const effectiveMaxReached = !shouldContinue || cycleNumber > maxCycles;
  if (effectiveMaxReached) {
    db.updateWorktreeStatus(worktreeId, "escalated", isoNow());
    return { action: "escalated", cycleNumber, cycleId, triggerError };
  }

  try {
    await buildCorrectionBrief({
      engramDbPath: options.engramDbPath ?? dbPath,
      engramPythonPath: options.engramPythonPath,
      worktreeId,
      cycleNumber,
      triggerError,
      errorContext: {
        errors: testResult.errors,
        test_command: testResult.test_command,
        exit_code: testResult.exit_code,
        stdout_tail: testResult.stdout_tail,
        stderr_tail: testResult.stderr_tail,
        changed_files: testResult.changed_files,
      },
      worktreePath,
      project: options.project,
    });
  } catch (err) {
    const marker = `<!-- ENGRAM_CORRECTION_BRIEF:cycle_${cycleNumber} -->`;
    const fallbackBrief = [
      marker,
      `# Correction Cycle ${cycleNumber}`,
      "",
      `## Trigger Error`,
      "```",
      triggerError,
      "```",
      "",
      `## Test Output (stderr tail)`,
      "```",
      testResult.stderr_tail,
      "```",
      "",
      `## Changed Files`,
      ...testResult.changed_files.map((f) => `- ${f}`),
      "",
      `<!-- END_CORRECTION_BRIEF:cycle_${cycleNumber} -->`,
    ].join("\n");

    const claudeMdPath = `${worktreePath}/CLAUDE.md`;
    const existing = existsSync(claudeMdPath) ? await Bun.file(claudeMdPath).text() : "";
    await Bun.write(claudeMdPath, existing + "\n\n" + fallbackBrief + "\n");
  }

  const agent = await spawnAgent({
    worktreePath,
    prompt: "Read CLAUDE.md for the correction brief, then fix the errors described. Run tests to verify.",
    agentType: options.agentType ?? "claude",
    model: options.model,
    dbPath,
    eventsPath,
    worktreeId,
    commandOverride: options.commandOverride,
  });

  return { action: "corrected", cycleNumber, cycleId, spawnedAgent: agent, triggerError };
}

if (import.meta.main) {
  const [worktreeIdArg, dbPathArg, eventsPathArg, worktreePathArg] = Bun.argv.slice(2);

  if (!worktreeIdArg || !dbPathArg || !eventsPathArg || !worktreePathArg) {
    console.error("Usage: bun run src/corrector.ts <worktree_id> <db_path> <events_path> <worktree_path>");
    process.exit(1);
  }

  const worktreeId = Number(worktreeIdArg);
  const db = openLoopwrightDb(dbPathArg);

  try {
    const testResult = await runTests({ worktreePath: worktreePathArg });

    const result = await correctOrEscalate({
      db,
      worktreeId,
      worktreePath: worktreePathArg,
      testResult,
      dbPath: dbPathArg,
      eventsPath: eventsPathArg,
    });

    console.log(JSON.stringify({
      action: result.action,
      cycleNumber: result.cycleNumber,
      cycleId: result.cycleId,
      checkpointId: result.checkpointId,
      triggerError: result.triggerError,
      agentId: result.spawnedAgent?.agentId,
    }, null, 2));
  } finally {
    db.close();
  }
}
