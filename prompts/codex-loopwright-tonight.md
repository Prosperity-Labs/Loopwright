# Codex Agent Prompt — Loopwright: Watchdog, Spawner, Test Runner, Correction Writer

## Context

You are working on the **Loopwright** repository at `/home/prosperitylabs/Desktop/development/Loopwright`.

Loopwright is the orchestration brain for an autonomous coding loop. It calls agents, watches for completion, runs tests, and triggers correction cycles. The runtime is **Bun** (not Node.js). All code is TypeScript. The database is SQLite via `bun:sqlite`.

**Sprint 1 Phase 3** requires four new modules tonight. They are mostly independent of each other.

## What Already Exists

### `src/db.ts` — Full schema + ORM (480 lines)
Tables: `sessions`, `tool_calls`, `artifacts`, `worktrees`, `checkpoints`, `comparisons`

**NOTE:** `db.ts` does NOT have a `correction_cycles` table yet. You need to add it as part of this work (Task 4).

Key interfaces already defined:
- `WorktreeUpsertInput`, `WorktreeRow`
- `CheckpointInsertInput`, `CheckpointRow`
- `LoopwrightDB` class with methods: `upsertWorktree()`, `updateWorktreeStatus()`, `getWorktreeById()`, `insertCheckpoint()`, `listCheckpoints()`, `insertArtifact()`, `listArtifactsByWorktree()`

### `src/bridge.ts` — JSONL event bridge (275 lines)
Watches `events.jsonl`, parses JSONL lines, routes events to db.ts by type. Handles: `session_start`, `session_end`, `tool_call`, `file_write`, `worktree_file_change`, `file_change`.

### `src/ab-runner.ts` — A/B test runner (320 lines)
Creates git worktrees, spawns agents via `Bun.spawn()`, captures stdout/stderr, creates checkpoints. Key patterns to reuse:
- `spawnCapturedProcess(cwd, cmd)` — spawn + capture with timing
- `runCommand(cwd, cmd)` — basic spawn wrapper
- `createGitWorktree()` / `removeWorktree()` — git worktree management

### `src/checkpoint.ts` — Git checkpoint manager (143 lines)
`create_checkpoint(worktreePath, worktreeId, dbPath, repoName)` — gets HEAD SHA, lists changed files, writes checkpoint to db.

### `src/watcher.ts` — File change watcher (137 lines)
Watches a worktree directory, emits `worktree_file_change` events to `events.jsonl`.

### Event Format
Events in `events.jsonl` are newline-delimited JSON objects:
```json
{"event_type": "tool_call", "session_id": "abc", "timestamp": "2026-02-25T...", "tool_name": "Write", ...}
{"event_type": "session_start", "session_id": "abc", "timestamp": "...", "project": "monra-app"}
{"event_type": "session_end", "session_id": "abc", "timestamp": "..."}
{"event_type": "file_write", "file_path": "/path/to/file", "worktree_id": 1, ...}
```

### Testing
- `bun test` runs all tests
- Test helpers in `tests/helpers.ts` and `test/test-utils.ts`
- 8 existing tests, 42 expects, all passing

### Conventions (from CLAUDE.md)
- Use `bun:sqlite`, NOT `better-sqlite3`
- Use `Bun.spawn()`, NOT child_process
- Use `Bun.file()`, NOT `fs.readFile()`
- Use `bun test` with `import { test, expect } from "bun:test"`
- No external dependencies — Bun built-ins only

---

## Task 1: `src/watchdog.ts` — Agent Idle/Finish Detection

### Goal
Poll `events.jsonl` and detect when an agent has gone idle (no events for N seconds) or finished (terminal event). Emit `AGENT_IDLE` and `AGENT_FINISHED` events back to the event stream.

### Interface

```typescript
export interface WatchdogOptions {
  eventsPath: string;           // path to events.jsonl
  idleThresholdMs?: number;     // default: 60_000 (60s)
  pollIntervalMs?: number;      // default: 5_000 (5s)
  logger?: Pick<Console, "log" | "warn" | "error">;
}

export interface WatchdogState {
  /** Map of session_id -> last event timestamp (ms since epoch) */
  sessions: Map<string, number>;
  /** Sessions that have been marked idle (don't re-emit) */
  idleEmitted: Set<string>;
  /** Sessions that have been marked finished (don't re-emit) */
  finishedEmitted: Set<string>;
}

export class Watchdog {
  constructor(options: WatchdogOptions);

  /** Start polling. Returns the watchdog instance for chaining. */
  start(): this;

  /** Stop polling and clean up. */
  stop(): void;

  /** Get current state snapshot (for testing). */
  getState(): WatchdogState;
}

export function startWatchdog(options: WatchdogOptions): Watchdog;
```

### Behavior
1. On each poll, read new lines from `events.jsonl` (track byte offset like bridge.ts does)
2. For each event with a `session_id` and `timestamp`, update the session's last-seen time
3. After processing new events, check all tracked sessions:
   - If `now - lastEventTime > idleThresholdMs` and not already emitted → append `AGENT_IDLE` event to events.jsonl
   - If event type is `session_end` or agent explicitly signals completion → append `AGENT_FINISHED` event
4. Emitted events should follow the standard format:
   ```json
   {"event_type": "AGENT_IDLE", "session_id": "...", "timestamp": "...", "idle_since": "...", "idle_duration_ms": 65000}
   {"event_type": "AGENT_FINISHED", "session_id": "...", "timestamp": "...", "reason": "session_end"}
   ```
5. Append events using `Bun.file(eventsPath)` — use `appendFileSync` from `node:fs` or `Bun.write()` with append

### Edge Cases
- File doesn't exist yet → wait for it
- File gets truncated → reset offset to 0 (bridge.ts already handles this pattern — follow it)
- Multiple sessions in same file → track each independently
- Agent sends `session_end` → immediately emit `AGENT_FINISHED` (don't wait for idle timeout)

---

## Task 2: `src/spawner.ts` — Programmatic Agent Spawner

### Goal
A callable function that spawns an agent in a worktree. Wraps `Bun.spawn()`, assigns an agent ID, registers in an in-memory registry, and emits `AGENT_STARTED` to the event stream.

### Interface

```typescript
export interface SpawnAgentOptions {
  worktreePath: string;
  prompt: string;
  agentType?: "claude" | "cursor" | "codex";  // default: "claude"
  dbPath: string;
  eventsPath: string;
  sessionId?: string;           // auto-generated if not provided
  worktreeId?: number;
  env?: Record<string, string>; // extra env vars for the spawned process
}

export interface SpawnedAgent {
  agentId: string;
  sessionId: string;
  worktreeId: number | undefined;
  process: ReturnType<typeof Bun.spawn>;
  startedAt: string;
  agentType: string;
  worktreePath: string;
  prompt: string;
}

/** In-memory registry of running agents */
export class AgentRegistry {
  register(agent: SpawnedAgent): void;
  unregister(agentId: string): void;
  get(agentId: string): SpawnedAgent | undefined;
  list(): SpawnedAgent[];
  clear(): void;
}

export const registry: AgentRegistry;

export async function spawnAgent(options: SpawnAgentOptions): Promise<SpawnedAgent>;
```

### Behavior
1. Generate `agentId` as `agent-{agentType}-{Date.now()}-{random4chars}`
2. Generate `sessionId` if not provided: `session-{agentId}`
3. Build the command based on `agentType`:
   - `"claude"` → `["claude", "--print", prompt]`
   - `"cursor"` → `["cursor", "--cli", prompt]` (placeholder — may not exist)
   - `"codex"` → `["codex", prompt]` (placeholder)
4. Spawn via `Bun.spawn({ cmd, cwd: worktreePath, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...options.env, LOOPWRIGHT_WORKTREE_ID: String(worktreeId), LOOPWRIGHT_SESSION_ID: sessionId } })`
5. Register in `AgentRegistry`
6. Emit `AGENT_STARTED` event to events.jsonl:
   ```json
   {"event_type": "AGENT_STARTED", "session_id": "...", "agent_id": "...", "agent_type": "claude", "worktree_path": "...", "timestamp": "..."}
   ```
7. Set up `process.exited.then(...)` to auto-unregister on exit
8. Return the `SpawnedAgent` object

### Notes
- Do NOT `await` the process — return immediately so the loop controller can manage multiple agents
- The registry is a singleton module export — the loop controller and watchdog both need to read it
- Keep the `agentType` command mapping simple — we only really use `"claude"` right now

---

## Task 3: `src/test-runner.ts` — Delta File Detection + Scoped Test Execution

### Goal
After an agent finishes, detect which files changed, run tests scoped to those files, and parse the output into structured errors.

### Interface

```typescript
export interface TestRunnerOptions {
  worktreePath: string;
  baseBranch?: string;          // default: "main" — for git diff
  testCommand?: string;         // default: auto-detect (bun test / pytest)
  timeout?: number;             // default: 120_000 (2 min)
}

export interface TestError {
  file: string;
  line: number | null;
  type: string;                 // "TypeError", "AssertionError", etc.
  message: string;
}

export interface TestResult {
  passed: boolean;
  exit_code: number;
  test_command: string;
  changed_files: string[];
  errors: TestError[];
  stdout_tail: string;          // last 50 lines
  stderr_tail: string;          // last 50 lines
  duration_ms: number;
}

export async function detectChangedFiles(worktreePath: string, baseBranch?: string): Promise<string[]>;
export async function runTests(options: TestRunnerOptions): Promise<TestResult>;
```

### Behavior

#### `detectChangedFiles(worktreePath, baseBranch)`
1. Run `git diff --name-only {baseBranch}...HEAD` in the worktree
2. Also include `git diff --name-only` (unstaged changes)
3. Deduplicate and return the list

#### `runTests(options)`
1. Call `detectChangedFiles()` to get the delta
2. Auto-detect test framework:
   - If `package.json` exists with `"bun:test"` or `bunfig.toml` → use `bun test`
   - If `pytest.ini`, `pyproject.toml` with `[tool.pytest]`, or `setup.cfg` with `[tool:pytest]` → use `pytest`
   - Fallback to `options.testCommand` or error
3. Scope tests to changed files:
   - For `bun test`: find matching `*.test.ts` / `*.spec.ts` files for each changed `.ts` file
   - For `pytest`: find matching `test_*.py` files for each changed `.py` file
   - If no matching test files found, run the full test suite
4. Spawn the test command with timeout
5. Parse stdout/stderr for errors:
   - **Bun test** errors look like:
     ```
     error: expect(received).toBe(expected)
       at /path/to/file.test.ts:42:5
     ```
   - **Pytest** errors look like:
     ```
     FAILED tests/test_foo.py::test_bar - TypeError: ...
     ```
   - Use regex to extract file, line, error type, message
6. Return `TestResult` with `passed: exit_code === 0`

### Error Parsing Patterns

```typescript
// Bun test: "at /path/to/file.ts:42:5"
const BUN_ERROR_RE = /at\s+(.+?):(\d+):\d+/;
// Bun test: "error: expect(received).toX(expected)"
const BUN_EXPECT_RE = /error:\s*(.+)/;

// Pytest: "FAILED tests/test_foo.py::test_bar - TypeError: ..."
const PYTEST_FAIL_RE = /FAILED\s+(\S+?)::(\S+)\s*-\s*(\w+Error):\s*(.*)/;
// Pytest: "E       TypeError: ..."
const PYTEST_E_LINE_RE = /^E\s+(\w+Error):\s*(.*)/m;
```

---

## Task 4: `src/correction-writer.ts` — Write Structured Errors to correction_cycles

### Goal
Take a `TestResult` from the test runner and write a `correction_cycles` row to sessions.db.

**First**, add the `correction_cycles` table to `db.ts`'s schema and the `LoopwrightDB` class. Then build the writer module.

### Schema Addition to `db.ts`

Add to `SCHEMA_SQL`:
```sql
CREATE TABLE IF NOT EXISTS correction_cycles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worktree_id INTEGER NOT NULL REFERENCES worktrees(id),
  cycle_number INTEGER NOT NULL,
  trigger_error TEXT,
  error_context TEXT,
  checkpoint_id INTEGER REFERENCES checkpoints(id),
  agent_session_id TEXT,
  outcome TEXT CHECK(outcome IN ('passed','failed','escalated')),
  duration_seconds INTEGER,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_correction_cycles_worktree ON correction_cycles(worktree_id);
```

Add interfaces:
```typescript
export interface CorrectionCycleInsertInput {
  worktree_id: number;
  cycle_number: number;
  trigger_error?: string | null;
  error_context?: JsonValue;
  checkpoint_id?: number | null;
  agent_session_id?: string | null;
  outcome?: "passed" | "failed" | "escalated" | null;
  duration_seconds?: number | null;
  created_at?: string;
}

export interface CorrectionCycleRow {
  id: number;
  worktree_id: number;
  cycle_number: number;
  trigger_error: string | null;
  error_context: string | null;
  checkpoint_id: number | null;
  agent_session_id: string | null;
  outcome: string | null;
  duration_seconds: number | null;
  created_at: string;
}
```

Add methods to `LoopwrightDB`:
```typescript
insertCorrectionCycle(input: CorrectionCycleInsertInput): number;
getCorrectionCycles(worktreeId: number): CorrectionCycleRow[];
getCorrectionCycleCount(worktreeId: number): number;
getLatestCorrectionCycle(worktreeId: number): CorrectionCycleRow | undefined;
```

### Writer Module — `src/correction-writer.ts`

```typescript
import type { TestResult } from "./test-runner.ts";
import type { LoopwrightDB } from "./db.ts";

export interface WriteCorrectionOptions {
  db: LoopwrightDB;
  worktreeId: number;
  testResult: TestResult;
  checkpointId?: number;
  agentSessionId?: string;
}

export function writeCorrectionCycle(options: WriteCorrectionOptions): {
  cycleId: number;
  cycleNumber: number;
  shouldContinue: boolean;  // false if max cycles reached or passed
};
```

### Behavior
1. Query `db.getCorrectionCycleCount(worktreeId)` to determine `cycle_number`
2. Build `trigger_error` from the first error in `testResult.errors`:
   - Format: `"{error.type}: {error.message} at {error.file}:{error.line}"`
   - If no structured errors, use `"Test failed with exit code {exit_code}"`
3. Build `error_context` JSON:
   ```json
   {
     "errors": [...testResult.errors],
     "test_command": "bun test",
     "exit_code": 1,
     "stdout_tail": "...",
     "stderr_tail": "...",
     "changed_files": [...]
   }
   ```
4. Determine outcome: `testResult.passed ? "passed" : "failed"`
5. Insert via `db.insertCorrectionCycle()`
6. Return `shouldContinue: !testResult.passed && cycleNumber < 3`

---

## Testing

Create `test/watchdog.test.ts`, `test/spawner.test.ts`, `test/test-runner.test.ts`, `test/correction-writer.test.ts`.

### `watchdog.test.ts`
1. Watchdog detects idle after threshold — write events with old timestamps, poll, verify AGENT_IDLE emitted
2. Watchdog detects session_end as AGENT_FINISHED
3. Watchdog does not re-emit for same session
4. Watchdog handles missing events file gracefully

### `spawner.test.ts`
1. spawnAgent returns SpawnedAgent with correct fields
2. Registry tracks spawned agent
3. Agent auto-unregisters after process exits
4. AGENT_STARTED event appears in events.jsonl

Use a mock command like `["echo", "hello"]` for testing — don't actually spawn claude.

### `test-runner.test.ts`
1. detectChangedFiles returns list of changed files from git diff
2. runTests with a passing test returns `{ passed: true, errors: [] }`
3. runTests with a failing test returns structured errors
4. Bun error output is parsed correctly
5. Pytest error output is parsed correctly (test with mock stdout)

Create a temp git repo with a simple bun test for integration testing.

### `correction-writer.test.ts`
1. writeCorrectionCycle inserts row with correct cycle_number
2. Second call increments cycle_number
3. shouldContinue is false when tests pass
4. shouldContinue is false when cycle_number >= 3
5. error_context JSON is properly stored and retrievable

Run all tests: `bun test`

---

## Branch

Create branch: `day3/test-runner-codex`

Commit in logical units:
1. "Add correction_cycles table and methods to db.ts"
2. "Add watchdog: agent idle/finish detection from events.jsonl"
3. "Add spawner: programmatic agent launching with registry"
4. "Add test-runner: delta file detection and scoped test execution"
5. "Add correction-writer: structured error persistence to correction_cycles"
6. "Add tests for watchdog, spawner, test-runner, correction-writer"

---

## Files to Create/Modify

| File | Action |
|------|--------|
| `src/db.ts` | **MODIFY** — add correction_cycles table, interfaces, methods |
| `src/watchdog.ts` | **CREATE** — agent idle/finish detection |
| `src/spawner.ts` | **CREATE** — programmatic agent spawner with registry |
| `src/test-runner.ts` | **CREATE** — delta detection + scoped tests + error parsing |
| `src/correction-writer.ts` | **CREATE** — write TestResult → correction_cycles |
| `test/watchdog.test.ts` | **CREATE** |
| `test/spawner.test.ts` | **CREATE** |
| `test/test-runner.test.ts` | **CREATE** |
| `test/correction-writer.test.ts` | **CREATE** |

## Do NOT
- Use Node.js APIs when Bun equivalents exist (no `child_process`, no `better-sqlite3`)
- Add external npm dependencies
- Modify existing test files
- Touch `bridge.ts`, `ab-runner.ts`, `ab-compare.ts`, or `cli.ts`
- Block the main thread — all agent spawning must be async
