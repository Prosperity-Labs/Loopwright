# Agent Prompt — Loopwright Phase 5: loop.ts (Loop Controller)

## Context

You are working on the **Loopwright** repository at `/home/prosperitylabs/Desktop/development/Loopwright`.
Branch: `day3/test-runner-codex` (check it out first).

You are building the **loop controller** — the top-level orchestrator that runs an autonomous correction loop: spawn agent → wait for finish → run tests → checkpoint or correct → repeat. This is the capstone of Sprint 1.

Runtime is **Bun** (not Node.js). All code is TypeScript. Database is SQLite via `bun:sqlite`.

## What Already Exists (all tested and passing, 26 tests)

### Core modules you'll import:

```typescript
// Database
import { openLoopwrightDb, type LoopwrightDB, type WorktreeRow } from "./db.ts";

// Spawn agents
import { spawnAgent, registry, type SpawnedAgent } from "./spawner.ts";

// Watch for agent completion
import { Watchdog } from "./watchdog.ts";

// Run tests after agent finishes
import { runTests, type TestResult } from "./test-runner.ts";

// Write test results to correction_cycles
import { writeCorrectionCycle } from "./correction-writer.ts";

// Create git checkpoints
import { create_checkpoint } from "./checkpoint.ts";

// Correct failures or escalate
import { correctOrEscalate, type CorrectionResult } from "./corrector.ts";
// NOTE: corrector.ts is being built in parallel. If it's not ready yet,
// inline the correction logic directly using the modules above.
```

### Key interfaces from existing modules:

```typescript
// spawner.ts
interface SpawnedAgent {
  agentId: string;
  sessionId: string;
  worktreeId: number | undefined;
  process: ReturnType<typeof Bun.spawn>;  // has .exited Promise
  startedAt: string;
  agentType: string;
  worktreePath: string;
  prompt: string;
}

// test-runner.ts
interface TestResult {
  passed: boolean;
  exit_code: number;
  test_command: string;
  changed_files: string[];
  errors: TestError[];
  stdout_tail: string;
  stderr_tail: string;
  duration_ms: number;
}

// correction-writer.ts
function writeCorrectionCycle(options): { cycleId: number; cycleNumber: number; shouldContinue: boolean; }

// checkpoint.ts
function create_checkpoint(worktreePath, worktreeId, dbPath, repoName): Promise<{ checkpoint_id, git_sha, changed_files }>
```

### Git worktree management (from ab-runner.ts patterns):
```typescript
// Create a worktree
async function runCommand(cwd: string, cmd: string[]): Promise<{ exit_code, stdout, stderr }> {
  const proc = Bun.spawn({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  const [exit_code, stdout, stderr] = await Promise.all([
    proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()
  ]);
  return { exit_code, stdout, stderr };
}

await runCommand(repoPath, ["git", "worktree", "add", worktreePath, "-b", branchName, baseBranch]);
```

## What to Build

### `src/loop.ts`

```typescript
export interface LoopOptions {
  /** Path to the target repository */
  repoPath: string;
  /** Task prompt for the agent */
  taskPrompt: string;
  /** Path to sessions.db */
  dbPath: string;
  /** Git base branch (default: "main") */
  baseBranch?: string;
  /** Max correction cycles before escalating (default: 3) */
  maxCycles?: number;
  /** Agent type to use (default: "claude") */
  agentType?: "claude" | "cursor" | "codex";
  /** Engram sessions.db path (default: same as dbPath) */
  engramDbPath?: string;
  /** Project name for Engram brief context */
  project?: string;
  /** Logger */
  logger?: Pick<Console, "log" | "warn" | "error">;
  /** Command override for testing (default: use real agent CLI) */
  commandOverride?: string[];
}

export interface LoopResult {
  /** Final status */
  status: "passed" | "failed" | "escalated";
  /** Worktree ID in sessions.db */
  worktreeId: number;
  /** Branch name of the worktree */
  branchName: string;
  /** Path to the worktree */
  worktreePath: string;
  /** Total correction cycles run */
  totalCycles: number;
  /** All cycle results */
  cycles: CycleResult[];
  /** Total duration in ms */
  duration_ms: number;
  /** Final checkpoint (if passed) */
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

export async function runLoop(options: LoopOptions): Promise<LoopResult>;
```

### Behavior of `runLoop()`

This is the full autonomous loop:

```
1. Setup: create worktree + branch, register in DB, setup events.jsonl
2. Initial run: spawn agent with task prompt
3. Wait: monitor for agent completion (process.exited)
4. Test: run scoped tests on changed files
5. Branch:
   a. Tests pass → create checkpoint → mark passed → return
   b. Tests fail, cycles < max → write correction cycle → inject brief → spawn correction agent → goto 3
   c. Tests fail, cycles >= max → mark escalated → return
```

#### Step-by-step implementation:

**1. Setup**
```typescript
const repoPath = resolve(options.repoPath);
const dbPath = resolve(options.dbPath);
const baseBranch = options.baseBranch ?? "main";
const maxCycles = options.maxCycles ?? 3;
const timestamp = Date.now();
const branchName = `loopwright-${timestamp}`;
const worktreePath = join(repoPath, ".loopwright", "runs", `run-${timestamp}`);
const eventsPath = join(dirname(worktreePath), "events.jsonl");
const repoName = basename(repoPath);
const logger = options.logger ?? console;

// Create git worktree
await runCommand(repoPath, ["git", "worktree", "add", worktreePath, "-b", branchName, baseBranch]);

// Register in DB
const db = openLoopwrightDb(dbPath);
const worktreeId = db.upsertWorktree({
  branch_name: branchName,
  base_branch: baseBranch,
  status: "active",
  task_description: options.taskPrompt,
});
```

**2. Run agent**
```typescript
async function runAgentAndWait(prompt: string, cycleLabel: string): Promise<{ stdout: string; stderr: string; exit_code: number; duration_ms: number }> {
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

  // Wait for the agent process to exit
  const exit_code = await agent.process.exited;
  const stdout = await new Response(agent.process.stdout).text();
  const stderr = await new Response(agent.process.stderr).text();
  const duration_ms = Math.round(performance.now() - startMs);

  logger.log(`[loop] ${cycleLabel}: agent finished (exit=${exit_code}, ${duration_ms}ms)`);
  return { stdout, stderr, exit_code, duration_ms };
}
```

**3. Test**
```typescript
async function runTestsAndRecord(): Promise<TestResult> {
  logger.log(`[loop] running tests...`);
  const result = await runTests({ worktreePath, baseBranch });
  logger.log(`[loop] tests ${result.passed ? "PASSED" : "FAILED"} (${result.errors.length} errors, ${result.duration_ms}ms)`);
  return result;
}
```

**4. Main loop**
```typescript
const cycles: CycleResult[] = [];
const loopStart = performance.now();

// --- Initial agent run ---
const initialRun = await runAgentAndWait(options.taskPrompt, "initial");
const initialTests = await runTestsAndRecord();

cycles.push({
  cycleNumber: 0,
  action: "initial",
  testResult: initialTests,
  passed: initialTests.passed,
  duration_ms: initialRun.duration_ms + initialTests.duration_ms,
});

if (initialTests.passed) {
  const cp = await create_checkpoint(worktreePath, worktreeId, dbPath, repoName);
  db.updateWorktreeStatus(worktreeId, "passed", isoNow());
  db.close();
  return {
    status: "passed",
    worktreeId, branchName, worktreePath,
    totalCycles: 0,
    cycles,
    duration_ms: Math.round(performance.now() - loopStart),
    finalCheckpoint: { id: cp.checkpoint_id, git_sha: cp.git_sha },
  };
}

// --- Correction loop ---
let cycleNumber = 0;
while (cycleNumber < maxCycles) {
  cycleNumber++;
  const lastTestResult = cycles[cycles.length - 1].testResult;

  // Write correction cycle to DB
  const { cycleId, shouldContinue } = writeCorrectionCycle({
    db,
    worktreeId,
    testResult: lastTestResult,
  });

  if (!shouldContinue) {
    db.updateWorktreeStatus(worktreeId, "escalated", isoNow());
    db.close();
    return {
      status: "escalated",
      worktreeId, branchName, worktreePath,
      totalCycles: cycleNumber,
      cycles,
      duration_ms: Math.round(performance.now() - loopStart),
    };
  }

  // Build + inject correction brief via Engram Python
  await injectCorrectionBrief({
    engramDbPath: options.engramDbPath ?? dbPath,
    worktreeId,
    cycleNumber,
    triggerError: buildTriggerError(lastTestResult),
    errorContext: lastTestResult,
    worktreePath,
    project: options.project,
  });

  // Spawn correction agent
  const correctionPrompt = "Read CLAUDE.md for the correction brief. Fix the errors described. Run tests to verify your fix.";
  const corrRun = await runAgentAndWait(correctionPrompt, `correction-${cycleNumber}`);
  const corrTests = await runTestsAndRecord();

  cycles.push({
    cycleNumber,
    action: "correction",
    testResult: corrTests,
    passed: corrTests.passed,
    duration_ms: corrRun.duration_ms + corrTests.duration_ms,
  });

  if (corrTests.passed) {
    const cp = await create_checkpoint(worktreePath, worktreeId, dbPath, repoName);
    db.updateWorktreeStatus(worktreeId, "passed", isoNow());
    db.close();
    return {
      status: "passed",
      worktreeId, branchName, worktreePath,
      totalCycles: cycleNumber,
      cycles,
      duration_ms: Math.round(performance.now() - loopStart),
      finalCheckpoint: { id: cp.checkpoint_id, git_sha: cp.git_sha },
    };
  }
}

// Max cycles exhausted
db.updateWorktreeStatus(worktreeId, "escalated", isoNow());
db.close();
return {
  status: "escalated",
  worktreeId, branchName, worktreePath,
  totalCycles: cycleNumber,
  cycles,
  duration_ms: Math.round(performance.now() - loopStart),
};
```

### Helper: `injectCorrectionBrief()`

Same pattern as corrector.ts — call Engram's Python:

```typescript
async function injectCorrectionBrief(params: {
  engramDbPath: string;
  worktreeId: number;
  cycleNumber: number;
  triggerError: string;
  errorContext: Record<string, unknown>;
  worktreePath: string;
  project?: string;
}): Promise<void> {
  const pythonPath = findEngramPython();
  // Call engram.correction_brief.generate_correction_brief + inject_correction_brief
  // via Bun.spawn([pythonPath, "-c", script])
  // On failure, fall back to writing a plain-text error summary to CLAUDE.md
}
```

**Fallback:** If Engram Python is not available, write a simple markdown error summary directly to CLAUDE.md:

```typescript
function fallbackBrief(triggerError: string, errorContext: Record<string, unknown>): string {
  return `# Correction Brief (fallback)\n\n## Error\n${triggerError}\n\n## Changed Files\n${(errorContext.changed_files as string[] || []).join(", ")}\n`;
}
```

### Helper: `buildTriggerError()`

Extract from TestResult (same logic as correction-writer.ts):

```typescript
function buildTriggerError(testResult: TestResult): string {
  const first = testResult.errors[0];
  if (!first) return `Test failed with exit code ${testResult.exit_code}`;
  const loc = first.line === null ? first.file : `${first.file}:${first.line}`;
  return `${first.type}: ${first.message} at ${loc}`;
}
```

### CLI mode

```typescript
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
```

## Testing

Create `test/loop.test.ts`:

1. **Loop with passing agent returns "passed"** — use `commandOverride: ["echo", "done"]` and a worktree with pre-existing passing tests. Verify: status=passed, checkpoint created, worktree status=passed.

2. **Loop escalates after max cycles** — use `commandOverride: ["echo", "fail"]` with a repo that has a permanently failing test. Set `maxCycles: 1`. Verify: status=escalated, totalCycles=1, worktree status=escalated.

3. **Loop creates worktree and branch** — verify git worktree exists at the expected path, branch name matches.

4. **Loop records all cycles in result** — run with maxCycles=2, verify cycles array has entries with correct action labels ("initial", "correction").

5. **Loop cleans up DB on all exit paths** — verify db.close() is called (no open handles).

For integration tests, create a temp git repo with a simple test file:
```typescript
// Setup: create temp repo, add a test that passes
const tmpRepo = createTempGitRepo();
writeFileSync(join(tmpRepo, "add.test.ts"), `
import { test, expect } from "bun:test";
test("1+1", () => expect(1+1).toBe(2));
`);
runCmdOrThrow(tmpRepo, ["git", "add", "."]);
runCmdOrThrow(tmpRepo, ["git", "commit", "-m", "init"]);
```

Use `commandOverride: ["echo", "agent-output"]` to avoid spawning real agents.

Run: `bun test`

## Conventions
- Use `bun:sqlite`, `Bun.spawn()`, `Bun.file()`
- No external npm dependencies
- `import { test, expect } from "bun:test"`
- Follow patterns from ab-runner.ts for git worktree management
- Follow patterns from spawner.ts for process management

## Branch
Stay on `day3/test-runner-codex`. Commit:
1. "Add loop controller: autonomous spawn-test-correct cycle"
2. "Add tests for loop controller"

## Do NOT
- Modify existing src/ files unless absolutely necessary
- Add npm dependencies
- Create real agent processes in tests — always use commandOverride
- Make the loop infinite — always respect maxCycles
- Leave DB handles open — always close in finally blocks
