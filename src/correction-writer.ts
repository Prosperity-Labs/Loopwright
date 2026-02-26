import type { LoopwrightDB } from "./db.ts";
import type { TestResult } from "./test-runner.ts";

export interface WriteCorrectionOptions {
  db: LoopwrightDB;
  worktreeId: number;
  testResult: TestResult;
  checkpointId?: number;
  agentSessionId?: string;
}

function buildTriggerError(testResult: TestResult): string {
  const first = testResult.errors[0];
  if (!first) {
    return `Test failed with exit code ${testResult.exit_code}`;
  }

  const location = first.line === null ? first.file : `${first.file}:${first.line}`;
  return `${first.type}: ${first.message} at ${location}`;
}

export function writeCorrectionCycle(options: WriteCorrectionOptions): {
  cycleId: number;
  cycleNumber: number;
  shouldContinue: boolean;
} {
  const currentCount = options.db.getCorrectionCycleCount(options.worktreeId);
  const cycleNumber = currentCount + 1;
  const outcome = options.testResult.passed ? "passed" : "failed";

  const cycleId = options.db.insertCorrectionCycle({
    worktree_id: options.worktreeId,
    cycle_number: cycleNumber,
    trigger_error: buildTriggerError(options.testResult),
    error_context: {
      errors: options.testResult.errors,
      test_command: options.testResult.test_command,
      exit_code: options.testResult.exit_code,
      stdout_tail: options.testResult.stdout_tail,
      stderr_tail: options.testResult.stderr_tail,
      changed_files: options.testResult.changed_files,
    },
    checkpoint_id: options.checkpointId ?? null,
    agent_session_id: options.agentSessionId ?? null,
    outcome,
    duration_seconds: Math.round(options.testResult.duration_ms / 1000),
  });

  return {
    cycleId,
    cycleNumber,
    shouldContinue: !options.testResult.passed && cycleNumber < 3,
  };
}
