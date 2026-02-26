# Agent Prompt — Loopwright Phase 4: corrector.ts

## Context

You are working on the **Loopwright** repository at `/home/prosperitylabs/Desktop/development/Loopwright`.
Branch: `day3/test-runner-codex` (check it out first).

Loopwright is the orchestration brain for an autonomous coding loop. You are building the **corrector** — the module that reads a failed test result, builds a correction brief with full error context and history, injects it into a worktree's CLAUDE.md, and spawns a new agent to fix the problem.

Runtime is **Bun** (not Node.js). All code is TypeScript. Database is SQLite via `bun:sqlite`.

## What Already Exists (all tested and passing)

### `src/db.ts` — Database ORM
Key methods you'll use:
- `getWorktreeById(id): WorktreeRow | undefined`
- `updateWorktreeStatus(id, status, resolvedAt?)`
- `getCorrectionCycles(worktreeId): CorrectionCycleRow[]`
- `getCorrectionCycleCount(worktreeId): number`
- `getLatestCorrectionCycle(worktreeId): CorrectionCycleRow | undefined` (note: returns `undefined` not `null`)
- `listCheckpoints(worktreeId): CheckpointRow[]`
- `insertCheckpoint(input): number`

### `src/correction-writer.ts` — Write test failures to DB
```typescript
import { writeCorrectionCycle, type WriteCorrectionOptions } from "./correction-writer.ts";
// Returns: { cycleId, cycleNumber, shouldContinue }
```

### `src/test-runner.ts` — Run scoped tests
```typescript
import { runTests, detectChangedFiles, type TestResult, type TestError } from "./test-runner.ts";
```

### `src/spawner.ts` — Spawn agents
```typescript
import { spawnAgent, registry, type SpawnAgentOptions, type SpawnedAgent } from "./spawner.ts";
```

### `src/checkpoint.ts` — Create git checkpoints
```typescript
import { create_checkpoint } from "./checkpoint.ts";
// create_checkpoint(worktreePath, worktreeId, dbPath, repoName)
// Returns: { checkpoint_id, git_sha, changed_files }
```

### `src/watchdog.ts` — Agent idle/finish detection
```typescript
import { Watchdog, startWatchdog, type WatchdogOptions } from "./watchdog.ts";
```

### Engram's correction_brief.py (Python, reads same sessions.db)
The Engram repo has `engram/correction_brief.py` with:
- `generate_correction_brief(db, worktree_id, cycle_number, trigger_error, error_context, project) -> str`
- `inject_correction_brief(worktree_path, brief_content, cycle_number) -> dict`

These write to CLAUDE.md with `<!-- ENGRAM_CORRECTION_BRIEF:cycle_N -->` markers.

For corrector.ts, we'll call Engram's Python via `Bun.spawn()` rather than reimplementing in TypeScript. This keeps the correction brief logic in one place.

## What to Build

### `src/corrector.ts`

```typescript
export interface CorrectorOptions {
  db: LoopwrightDB;
  worktreeId: number;
  worktreePath: string;
  testResult: TestResult;
  dbPath: string;
  eventsPath: string;
  engramDbPath?: string;        // path to Engram's sessions.db (default: same as dbPath)
  engramPythonPath?: string;    // path to engram venv python (default: auto-detect)
  maxCycles?: number;           // default: 3
  agentType?: "claude" | "cursor" | "codex";
  project?: string;             // project name for Engram slim brief
  repoName?: string;            // for checkpoint labeling
}

export interface CorrectionResult {
  action: "corrected" | "passed" | "escalated";
  cycleNumber: number;
  cycleId: number;
  checkpointId?: number;
  spawnedAgent?: SpawnedAgent;
  triggerError: string;
}

export async function correctOrEscalate(options: CorrectorOptions): Promise<CorrectionResult>;
```

### Behavior

`correctOrEscalate()` is the main entry point. It orchestrates one correction cycle:

1. **Write the correction cycle** to DB via `writeCorrectionCycle()`:
   ```typescript
   const { cycleId, cycleNumber, shouldContinue } = writeCorrectionCycle({
     db: options.db,
     worktreeId: options.worktreeId,
     testResult: options.testResult,
     checkpointId: lastCheckpoint?.id,
     agentSessionId: undefined, // filled after spawn
   });
   ```

2. **Check if tests passed** — if `testResult.passed`, create a checkpoint and return `{ action: "passed" }`:
   ```typescript
   if (options.testResult.passed) {
     const cp = await create_checkpoint(worktreePath, worktreeId, dbPath, repoName);
     db.updateWorktreeStatus(worktreeId, "passed", isoNow());
     return { action: "passed", cycleNumber, cycleId, checkpointId: cp.checkpoint_id };
   }
   ```

3. **Check if max cycles reached** — if `!shouldContinue`, mark escalated and return:
   ```typescript
   if (!shouldContinue) {
     db.updateWorktreeStatus(worktreeId, "escalated", isoNow());
     return { action: "escalated", cycleNumber, cycleId, triggerError };
   }
   ```

4. **Build the correction brief** by calling Engram's Python:
   ```typescript
   const briefResult = await buildCorrectionBrief({
     engramDbPath: options.engramDbPath ?? options.dbPath,
     engramPythonPath: options.engramPythonPath,
     worktreeId: options.worktreeId,
     cycleNumber,
     triggerError,
     errorContext: { errors, test_command, exit_code, stdout_tail, stderr_tail, changed_files },
     worktreePath: options.worktreePath,
     project: options.project,
   });
   ```

5. **Spawn a correction agent** in the same worktree:
   ```typescript
   const agent = await spawnAgent({
     worktreePath: options.worktreePath,
     prompt: `Read CLAUDE.md for the correction brief, then fix the errors described. Run tests to verify.`,
     agentType: options.agentType ?? "claude",
     dbPath: options.dbPath,
     eventsPath: options.eventsPath,
     worktreeId: options.worktreeId,
   });
   ```

6. **Return** `{ action: "corrected", cycleNumber, cycleId, spawnedAgent: agent, triggerError }`

### Helper: `buildCorrectionBrief()`

This calls Engram's Python to generate and inject the brief:

```typescript
async function buildCorrectionBrief(params: {
  engramDbPath: string;
  engramPythonPath?: string;
  worktreeId: number;
  cycleNumber: number;
  triggerError: string;
  errorContext: Record<string, unknown>;
  worktreePath: string;
  project?: string;
}): Promise<{ claude_md: string; cycle_number: number; appended: boolean }>;
```

Implementation approach — call a small Python script via `Bun.spawn()`:

```typescript
const pythonPath = params.engramPythonPath ?? findEngramPython();
const script = `
import json, sys
from engram.recall.session_db import SessionDB
from engram.correction_brief import generate_correction_brief, inject_correction_brief

db = SessionDB(db_path="${params.engramDbPath}")
brief = generate_correction_brief(
    db,
    worktree_id=${params.worktreeId},
    cycle_number=${params.cycleNumber},
    trigger_error=${JSON.stringify(params.triggerError)},
    error_context=json.loads(${JSON.stringify(JSON.stringify(params.errorContext))}),
    project=${params.project ? JSON.stringify(params.project) : "None"},
)
result = inject_correction_brief("${params.worktreePath}", brief, ${params.cycleNumber})
print(json.dumps(result))
`;

const proc = Bun.spawn({
  cmd: [pythonPath, "-c", script],
  stdout: "pipe",
  stderr: "pipe",
});
```

### Helper: `findEngramPython()`

Auto-detect the Engram venv Python path:

```typescript
function findEngramPython(): string {
  const candidates = [
    "/home/prosperitylabs/Desktop/development/engram/.venv/bin/python3",
    "/home/prosperitylabs/Desktop/development/engram/.venv/bin/python",
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return "python3"; // fallback to system python
}
```

### `src/corrector.ts` — standalone mode

Add `if (import.meta.main)` block for CLI testing:

```typescript
if (import.meta.main) {
  // Usage: bun run src/corrector.ts <worktree_id> <db_path> <events_path> <worktree_path>
  // Reads latest correction cycle, re-runs tests, and attempts correction
}
```

## Testing

Create `test/corrector.test.ts`:

1. **correctOrEscalate returns "passed" when tests pass** — mock a passing TestResult, verify checkpoint created and status updated
2. **correctOrEscalate returns "escalated" at max cycles** — insert 2 prior cycles, run with failing TestResult, verify escalated
3. **correctOrEscalate returns "corrected" and spawns agent** — failing TestResult with 0 prior cycles, verify agent spawned and CLAUDE.md written
4. **buildCorrectionBrief calls Engram Python** — verify CLAUDE.md gets correction marker (skip if Python not available)
5. **triggerError is formatted correctly from TestResult errors**

Use `commandOverride: ["echo", "correction-agent"]` in spawner to avoid launching real agents.

For tests that call Engram Python, check if the venv exists first:
```typescript
const engramPython = "/home/prosperitylabs/Desktop/development/engram/.venv/bin/python3";
const skipPython = !existsSync(engramPython);
```

Run: `bun test`

## Conventions
- Use `bun:sqlite`, `Bun.spawn()`, `Bun.file()`
- No external npm dependencies
- `import { test, expect } from "bun:test"`
- Follow existing patterns from spawner.ts and correction-writer.ts

## Branch
Stay on `day3/test-runner-codex`. Commit:
1. "Add corrector: correction brief injection and agent respawning"
2. "Add tests for corrector"

## Do NOT
- Reimplement the correction brief in TypeScript — call Engram's Python
- Modify existing files (db.ts, spawner.ts, etc.) unless truly necessary
- Add npm dependencies
- Block on the spawned agent — return immediately after spawn
