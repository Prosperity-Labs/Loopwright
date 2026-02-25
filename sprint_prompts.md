# Loopwright — Sprint 1 Agent Prompts

**Usage:** Paste the relevant prompt into each Claude Code instance at the start of each day.
**Agent 1:** Claude Code instance WITH Engram
**Agent 2:** Claude Code instance WITHOUT Engram

---

## Monitoring Strategy (Built Into Every Day)

Custom local checkpoint/rollback system — no LangGraph. The harder path.

**Components:**
- **Git hooks** in each worktree: `post-commit` writes checkpoint rows to sessions.db, `pre-commit` captures diff snapshots
- **Bun file watcher** (`fs.watch` / `Bun.file`) on worktree directories — detects file changes in real time, writes to events.jsonl
- **Noodlbox graph delta** — at each checkpoint, run `noodlbox_detect_impact` to capture the *structural* change: which symbols changed, what calls them, which communities and processes are affected. Stored as graph_delta JSON in the checkpoint row.
- **sessions.db** as the single source of truth — every checkpoint is a git SHA + artifact snapshot + graph delta
- **Rollback** = `git checkout <sha>` in the worktree. No framework. Just git.

**The pattern we're practicing:**
```
file change detected (fs.watch)
  → event written to events.jsonl
  → bridge pushes event to sessions.db
  → on checkpoint: noodlbox_detect_impact → graph delta stored
      - changed symbols: [validateBooking, formatAmount]
      - impacted callers: [processPayment, createReservation]
      - affected communities: [Payment Processing, Booking Engine]
      - disrupted processes: [checkout-flow, reservation-flow]
  → on test pass: git commit + checkpoint row + graph delta written
  → on test fail: error context + graph delta → correction cycle begins
      - correction brief includes causal chain from graph
      - "you changed validateBooking() which is called by processPayment(), and processPayment() broke"
  → on rollback: git checkout <checkpoint_sha>, restore state
```

**Why graph delta matters:**
- File diffs tell you WHAT changed. Graph deltas tell you WHY something broke.
- Correction briefs with causal chains are dramatically more useful than "tests failed in file X"
- A/B comparison can show: "Agent A's changes had blast radius of 3 communities, Agent B's had 12"
- Over time, sessions.db accumulates graph-level intelligence: which symbol clusters are fragile, which changes propagate furthest

**Infrastructure scaling path:**
- Sprint 1: bare git worktrees, no containers. Learn the pattern first.
- Milestone 2: Podman pods. One pod = one agent loop (worktree volume + agent + watcher + test runner). Rootless, daemonless.
- Milestone 3: Podman + systemd across multiple machines. Loop controller dispatches to worker nodes.
- Day 5 code should be structured so `Bun.spawn()` calls can be swapped for `podman run` commands later without rewriting the loop logic.

This is the exact pattern Loopwright will use in production. We're building it by using it.

---

## Day 1 — Schema Extension + Event Bridge

### Agent 1 Prompt (with Engram)

```
You are working on Loopwright, an autonomous CI/CD system with self-correcting agents.

YOUR TASK: Extend sessions.db with 3 new tables and set up git hooks for worktree monitoring.

CONTEXT:
- Engram's sessions.db is at: (find it in the engram repo)
- Schema is managed in engram/session_db.py
- Existing tables: sessions, artifacts, tool_calls
- You need to ADD (not replace) three new tables

NEW TABLES TO ADD:

1. worktrees
   - id INTEGER PRIMARY KEY
   - session_id TEXT (FK to sessions)
   - branch_name TEXT
   - base_branch TEXT (usually 'main')
   - status TEXT (active | passed | failed | escalated | merged)
   - task_description TEXT
   - created_at TIMESTAMP
   - resolved_at TIMESTAMP (null until terminal state)

2. checkpoints
   - id INTEGER PRIMARY KEY
   - worktree_id INTEGER (FK to worktrees)
   - session_id TEXT (FK to sessions)
   - git_sha TEXT (commit hash at checkpoint time)
   - test_results JSON
   - artifact_snapshot JSON (files written up to this point)
   - graph_delta JSON (Noodlbox impact analysis: changed symbols, impacted callers, affected communities, disrupted processes)
   - created_at TIMESTAMP
   - label TEXT (optional, e.g. 'after auth fix')

3. correction_cycles
   - id INTEGER PRIMARY KEY
   - worktree_id INTEGER (FK to worktrees)
   - cycle_number INTEGER (1, 2, 3… up to max)
   - trigger_error TEXT
   - error_context JSON (browser logs, DB errors, AWS logs)
   - checkpoint_id INTEGER (FK to checkpoints — which checkpoint was base)
   - agent_session_id TEXT (the new agent session spawned)
   - outcome TEXT (passed | failed | escalated)
   - duration_seconds INTEGER
   - created_at TIMESTAMP

ALSO BUILD:
- A migration script that safely adds these tables to an existing sessions.db
- Git hook templates: post-commit hook that writes a checkpoint row to sessions.db (git_sha from HEAD, artifact_snapshot from git diff --name-only)
- Git hook template: pre-commit hook that captures the current diff as a snapshot
- Helper functions in Python: create_worktree(), create_checkpoint(), create_correction_cycle(), get_latest_checkpoint()
- Verify FTS indexing works on new tables
- Write tests that create a sessions.db, run migration, insert rows, query them back

DO NOT modify existing tables. Only add new ones.
The migration must be idempotent — safe to run multiple times.

When done, commit to the engram repo with a clear message about what was added.
```

### Agent 2 Prompt (without Engram)

```
You are working on Loopwright, an autonomous CI/CD system with self-correcting agents.

YOUR TASK: Build the events.jsonl → sessions.db bridge in Bun/TypeScript, plus a file watcher for worktree monitoring.

CONTEXT:
- OpenClaw writes agent events to events.jsonl (one JSON object per line)
- Engram's sessions.db stores session history and artifacts
- We need a bridge that reads events.jsonl and writes relevant data into sessions.db
- This is the first Bun/TypeScript code in the Loopwright repo

PROJECT SETUP:
- Working directory: /home/prosperitylabs/Desktop/development/Loopwright
- Initialize with: bun init
- Add dependency: bun add better-sqlite3 @types/better-sqlite3
- TypeScript strict mode

BUILD:

1. src/bridge.ts — The event bridge
   - Watch events.jsonl using Bun's file watcher (fs.watch or Bun.file)
   - Parse each new line as JSON
   - Route events to the correct sessions.db table:
     * tool_call events → tool_calls table
     * file_write events → artifacts table
     * session_start/end events → sessions table
   - Use better-sqlite3 for synchronous SQLite writes
   - Handle the case where events.jsonl doesn't exist yet (wait for it)
   - Handle malformed JSON lines gracefully (log and skip)

2. src/watcher.ts — Worktree file watcher
   - Accept a worktree path as argument
   - Use fs.watch (recursive) to detect file changes in the worktree
   - On file change: write an event to events.jsonl with:
     * timestamp
     * event_type: "file_change"
     * file_path (relative to worktree root)
     * change_type: "created" | "modified" | "deleted"
     * worktree_id (from config or arg)
   - Ignore .git directory, node_modules, __pycache__
   - This is the real-time monitoring layer — every file touch is recorded

3. src/checkpoint.ts — Custom checkpoint manager (no LangGraph)
   - create_checkpoint(worktree_path, worktree_id, db_path, repo_name):
     * Get current git SHA: Bun.spawn(['git', 'rev-parse', 'HEAD'])
     * Get changed files: Bun.spawn(['git', 'diff', '--name-only', 'HEAD~1'])
     * Get graph delta: call Noodlbox noodlbox_detect_impact(repository=repo_name) to capture:
       - changed_symbols: which functions/classes were modified
       - impacted_callers: what calls those symbols (the blast radius)
       - affected_communities: which functional modules are disrupted
       - disrupted_processes: which execution flows are broken
     * Store graph_delta as JSON in the checkpoint row
     * Write checkpoint row to sessions.db checkpoints table
     * Return checkpoint_id
   - rollback_to_checkpoint(worktree_path, checkpoint_id, db_path):
     * Read checkpoint row, get git_sha
     * Bun.spawn(['git', 'checkout', sha]) in the worktree
     * Update worktree status in sessions.db
     * Return success/failure
   - list_checkpoints(worktree_id, db_path):
     * Query checkpoints table, return ordered list

4. src/db.ts — Database helper
   - Open sessions.db with better-sqlite3
   - Prepared statements for common operations
   - Type-safe wrappers for each table

TESTING:
- Create a test that: starts the bridge, writes a fake event to events.jsonl, verifies it appears in sessions.db
- Create a test that: creates a checkpoint, verifies the row, rolls back, verifies git state
- Create a test that: starts the watcher on a temp directory, creates a file, verifies the event was emitted

When done, commit to the Loopwright repo. This is the foundation of the orchestration layer.
```

---

## Day 2 — Scripted A/B Runner

### Agent 1 Prompt (with Engram)

```
You are working on Loopwright, an autonomous CI/CD system with self-correcting agents.

YOUR TASK: Build the Engram-side support for A/B worktree comparison — brief injection and result capture.

CONTEXT:
- Day 1 delivered: sessions.db with worktrees/checkpoints/correction_cycles tables, event bridge, file watcher
- Engram's brief.py generates context briefs for agents
- We need to inject different briefs into different worktrees for A/B comparison
- Results from each worktree need to be captured and stored for comparison

BUILD:

1. Extend brief.py (or create engram/ab_brief.py):
   - generate_ab_briefs(task_description, variant_a_config, variant_b_config):
     * Generate two briefs from the same task
     * Variant A: with full Engram history (what failed before, session context)
     * Variant B: cold start (no history injection, baseline)
     * Return both briefs as strings
   - write_brief_to_worktree(worktree_path, brief_content):
     * Write the brief to worktree's CLAUDE.md
     * Record which brief variant was written to sessions.db

2. Result capture:
   - capture_worktree_result(worktree_id):
     * Read the worktree's final state from sessions.db (artifacts, tool_calls, errors)
     * Compute metrics: files_touched, errors_hit, tool_calls_count, duration
     * Write a result summary row (could be a new ab_results column in worktrees or a JSON field)
   - compare_results(worktree_id_a, worktree_id_b):
     * Query both result summaries
     * Return structured comparison: which was faster, fewer errors, more files touched
     * This is what replaces eyeballing

3. Update the git hooks from Day 1:
   - post-commit hook should now also record which A/B variant this worktree belongs to
   - Checkpoint rows should include the variant label

TESTING:
- Test that two different briefs are generated from the same task
- Test that results can be captured and compared
- Test the full flow: create two worktree rows, inject briefs, capture fake results, compare

Commit to engram repo.
```

### Agent 2 Prompt (without Engram)

```
You are working on Loopwright, an autonomous CI/CD system with self-correcting agents.

YOUR TASK: Build the A/B runner script in Bun that spawns two worktrees with the same prompt and captures results.

CONTEXT:
- Day 1 delivered: Bun project initialized, event bridge (src/bridge.ts), file watcher (src/watcher.ts), checkpoint manager (src/checkpoint.ts)
- OpenClaw already manages git worktrees
- We need to automate: same prompt → two worktrees → capture both results → compare

BUILD:

1. src/ab-runner.ts — The A/B orchestrator
   - accept: task_prompt, base_branch (default: main), repo_path
   - Create two git worktrees using Bun.spawn():
     * Bun.spawn(['git', 'worktree', 'add', path_a, '-b', 'ab-test-a-<timestamp>'])
     * Bun.spawn(['git', 'worktree', 'add', path_b, '-b', 'ab-test-b-<timestamp>'])
   - Write worktree rows to sessions.db for both (status: active)
   - Start file watchers on both worktrees (from src/watcher.ts)
   - Start event bridge to capture events from both
   - Spawn agents in both worktrees concurrently:
     * Bun.spawn(['claude', '--print', task_prompt], { cwd: path_a })
     * Bun.spawn(['claude', '--print', task_prompt], { cwd: path_b })
   - Wait for both to complete (Promise.all on the subprocess promises)
   - Create checkpoints for both worktrees
   - Capture results: files changed, errors, duration, token usage if available

2. src/ab-compare.ts — Comparison report
   - Read results for both worktrees from sessions.db
   - Generate structured comparison:
     * Duration: A took Xs, B took Ys
     * Files touched: A modified [list], B modified [list]
     * Errors: A had N errors, B had M errors
     * Diff: git diff between the two worktree branches
   - Output as both JSON (for programmatic use) and markdown (for human reading)
   - Write comparison to sessions.db

3. src/cli.ts — CLI entry point
   - bun run src/cli.ts ab --prompt "fix the login validation" --repo /path/to/repo
   - bun run src/cli.ts compare --worktree-a <id> --worktree-b <id>
   - Wire to ab-runner.ts and ab-compare.ts

MONITORING:
- Both worktrees should have file watchers running during the A/B test
- All file changes should flow through: fs.watch → events.jsonl → bridge → sessions.db
- Checkpoints should be created at completion using src/checkpoint.ts from Day 1

TESTING:
- Test worktree creation and cleanup
- Test that two concurrent Bun.spawn() processes run and complete
- Test comparison output format
- Integration test: run a real A/B test on a small repo (can use Loopwright itself as the test target)

Commit to Loopwright repo.
```

---

## Day 3 — Test Runner Integration

### Agent 1 Prompt (with Engram)

```
You are working on Loopwright, an autonomous CI/CD system with self-correcting agents.

YOUR TASK: Build idle detection from the OpenClaw event stream and wire test results into sessions.db.

CONTEXT:
- Day 2 delivered: A/B runner, comparison reports, brief injection
- OpenClaw streams events via SSE and writes to events.jsonl
- We need to detect when an agent goes idle (stops producing events) and trigger tests
- Test results need to be written to sessions.db in a structured format

BUILD:

1. In Engram, create engram/test_results.py:
   - store_test_results(worktree_id, test_output, test_type='delta'):
     * Parse test output (support both pytest and jest formats)
     * Extract: total tests, passed, failed, errors, skipped
     * Extract per-test details: test name, file:line, error message, stack trace
     * Write structured results to sessions.db (as JSON in checkpoints.test_results or a new field)
   - get_delta_test_files(worktree_path, base_branch='main'):
     * Run git diff --name-only against base branch
     * Map changed source files to their test files (convention-based: foo.ts → foo.test.ts, foo.py → test_foo.py)
     * Return list of test files to run
   - store_error_context(correction_cycle_id, error_data):
     * Write structured error into correction_cycles.error_context JSON field
     * Include: file_path, line_number, error_type, error_message, stack_trace, surrounding_code

2. Update the checkpoint writer from Day 1:
   - On checkpoint creation, include test_results JSON
   - If tests passed: create checkpoint with test_results
   - If tests failed: DON'T create checkpoint, instead create correction_cycle row with error_context

TESTING:
- Test pytest output parsing with real pytest output samples
- Test jest output parsing with real jest output samples
- Test delta file detection with a mock git diff
- Test error context storage and retrieval

Commit to engram repo.
```

### Agent 2 Prompt (without Engram)

```
You are working on Loopwright, an autonomous CI/CD system with self-correcting agents.

YOUR TASK: Build the test runner and idle detection in Bun. This detects when an agent stops working and runs tests automatically.

CONTEXT:
- Day 2 delivered: A/B runner (src/ab-runner.ts), comparison (src/ab-compare.ts), CLI
- We need to detect agent idle state and automatically run tests
- Test results flow into correction_cycles table via the bridge

BUILD:

1. src/idle-detector.ts — Agent idle detection
   - Watch events.jsonl for new events from a specific worktree_id
   - Track the timestamp of the last event
   - If no new events for N seconds (configurable, default: 30), emit "agent_idle" event
   - Handle false positives: agent might be thinking (waiting for API response)
     * Look for patterns: if last event was a tool_call with no result, agent is still working
     * Only trigger idle after: last event was a tool_result or file_write AND N seconds elapsed
   - Emit idle event to events.jsonl so the bridge picks it up

2. src/test-runner.ts — Delta test execution
   - On idle detection: determine which files changed in the worktree
     * Bun.spawn(['git', 'diff', '--name-only', base_branch], { cwd: worktree_path })
   - Map changed files to test files:
     * foo.ts → foo.test.ts / foo.spec.ts
     * foo.py → test_foo.py / foo_test.py
     * Support configurable mapping patterns
   - Run tests:
     * For JS/TS: Bun.spawn(['bun', 'test', ...test_files], { cwd: worktree_path })
     * For Python: Bun.spawn(['pytest', ...test_files], { cwd: worktree_path })
     * Capture stdout and stderr
   - Parse test output into structured format:
     * { total, passed, failed, errors: [{ file, line, type, message, stack }] }
   - On pass: call checkpoint.create_checkpoint() from Day 1
   - On fail: write correction_cycle row with error_context to sessions.db
   - Write test_complete event to events.jsonl

3. src/orchestrator.ts — Wire idle → test → checkpoint/correct
   - This is a mini loop controller for Day 3 (Day 5 will expand it)
   - Start idle detector for a worktree
   - On idle: run tests
   - On test pass: checkpoint + write "ready_for_merge" status
   - On test fail: write correction_cycle row + emit "needs_correction" event
   - This is event-driven: the Bun event loop handles all of it without blocking

MONITORING:
- The file watcher from Day 1 should still be running on the worktree
- Idle detection adds another layer: file watcher catches changes, idle detector catches silence
- Both write to events.jsonl → bridge → sessions.db

TESTING:
- Test idle detection with simulated event streams (write events to events.jsonl with delays)
- Test test-runner with a repo that has both passing and failing tests
- Test the full flow: agent writes → goes idle → tests run → checkpoint or correction_cycle created

Commit to Loopwright repo.
```

---

## Day 4 — Correction Spawner

### Agent 1 Prompt (with Engram)

```
You are working on Loopwright, an autonomous CI/CD system with self-correcting agents.

YOUR TASK: Build the correction brief generator — the intelligence that tells a new agent exactly what went wrong and what to try next.

CONTEXT:
- Day 3 delivered: idle detection, test runner, structured error capture in correction_cycles
- When tests fail, a correction_cycle row exists with error_context JSON
- A new agent needs to be spawned with full knowledge of: what was tried, what broke, what the blast radius is
- The brief is the single most important piece — it's what makes correction cycles actually work

BUILD:

1. engram/correction_brief.py — The correction brief generator
   - generate_correction_brief(correction_cycle_id, db_path):
     * Read the correction_cycle row: trigger_error, error_context, cycle_number
     * Read the checkpoint it's based on: git_sha, test_results, artifact_snapshot
     * Read the worktree: task_description, branch_name
     * Read prior correction cycles for this worktree (if cycle_number > 1): what was already tried
     * Query Engram's session history: has this file/error pattern appeared before?
     * Build the brief as structured markdown:

       ## Correction Cycle {N} for: {task_description}

       ### What Failed
       {trigger_error}

       ### Error Details
       {structured error: file, line, type, message, stack trace}

       ### What Was Already Tried
       {list of prior correction cycles and their outcomes}

       ### Checkpoint State
       Based on commit {git_sha}. Files modified since base: {list}

       ### Graph Delta (from Noodlbox)
       Changed symbols: {list of functions/classes modified}
       Impacted callers: {what calls those symbols — the causal chain}
       Affected communities: {which functional modules are disrupted}
       Disrupted processes: {which execution flows are broken}
       → "You changed {symbol}, which is called by {caller}, and {caller} broke because {error}"

       ### Historical Context (from Engram)
       {similar errors from past sessions, what fixed them}

       ### Constraints
       - Do NOT repeat: {list of approaches that already failed}
       - Max correction cycles remaining: {max - current}
       - If you cannot fix this, explain why so the human can take over

     * Return the brief as a string

   - inject_correction_brief(worktree_path, brief_content):
     * Write to worktree's CLAUDE.md (append, don't overwrite)
     * Also write to a dedicated .loopwright/correction_brief.md in the worktree
     * Record the injection in sessions.db

2. engram/history_query.py — Query past failures
   - find_similar_errors(file_path, error_type, db_path):
     * Search correction_cycles for similar trigger_error patterns
     * Use FTS if available, fallback to LIKE queries
     * Return: what fixed it last time, how many cycles it took
   - find_file_failure_history(file_path, db_path):
     * All correction cycles that touched this file
     * Frequency, common error types, average cycles to resolution
     * This is the "continuous intelligence" — the loop gets smarter over time

TESTING:
- Test brief generation with mock correction_cycle data
- Test history queries with multiple past correction cycles
- Test that the brief includes "do not repeat" constraints from prior cycles
- Test injection: brief appears in worktree CLAUDE.md

Commit to engram repo.
```

### Agent 2 Prompt (without Engram)

```
You are working on Loopwright, an autonomous CI/CD system with self-correcting agents.

YOUR TASK: Build the correction spawner in Bun — the component that takes a failed test, gets a correction brief, and launches a new agent to fix it.

CONTEXT:
- Day 3 delivered: idle detection (src/idle-detector.ts), test runner (src/test-runner.ts), orchestrator stub
- When tests fail, a correction_cycle row exists in sessions.db with error_context
- Engram (Agent 1) is building the correction brief generator in Python
- We need a Bun component that: reads the error, calls Engram for a brief, spawns a new agent

BUILD:

1. src/corrector.ts — The correction spawner
   - async correctWorktre(worktree_id: number, correction_cycle_id: number):
     * Read correction_cycle from sessions.db: trigger_error, error_context, checkpoint_id
     * Read checkpoint: git_sha (this is the rollback point if correction fails too)
     * Call Engram's brief generator:
       - Option A: Bun.spawn(['python', 'engram/correction_brief.py', '--cycle-id', id])
       - Option B: Read the brief directly from sessions.db if Engram wrote it there
     * Write the correction brief to the worktree's CLAUDE.md
     * Spawn a new Claude agent in the worktree:
       - Bun.spawn(['claude', '--print', 'Read CLAUDE.md for your correction brief. Fix the failing tests.'], { cwd: worktree_path })
     * Start file watcher + idle detector on the worktree (reuse from Days 1 and 3)
     * When agent completes: run tests again (reuse test-runner.ts)
     * If tests pass: create checkpoint, update correction_cycle outcome = 'passed'
     * If tests fail: update correction_cycle outcome = 'failed', return failure

2. src/rollback.ts — Rollback on correction failure
   - rollback_worktree(worktree_id: number, checkpoint_id: number):
     * Get checkpoint git_sha from sessions.db
     * Bun.spawn(['git', 'checkout', sha], { cwd: worktree_path })
     * Verify the rollback: git log -1 should show the checkpoint commit
     * Update worktree status in sessions.db
     * This is the safety net — if correction makes things worse, we go back to known good

3. Update src/orchestrator.ts from Day 3:
   - On test fail → call corrector.ts instead of just writing correction_cycle
   - Flow: idle detected → run tests → fail → create correction_cycle → spawn correction agent → run tests again
   - If correction passes: checkpoint + done
   - If correction fails: rollback to checkpoint + create new correction_cycle (next iteration)
   - This is the correction loop running for the first time

MONITORING:
- The correction agent gets its own file watcher
- All events from the correction agent flow through the same events.jsonl → bridge → sessions.db pipeline
- The correction_cycle row tracks the full lifecycle: spawned → running → passed/failed

TESTING:
- Test that corrector reads error context correctly from sessions.db
- Test that a new agent process is spawned in the worktree
- Test rollback: create a checkpoint, make changes, rollback, verify state
- Integration test: simulate a test failure → correction spawn → test pass → checkpoint

Commit to Loopwright repo.
```

---

## Day 5 — Loop Controller + Real Task

### Agent 1 Prompt (with Engram)

```
You are working on Loopwright, an autonomous CI/CD system with self-correcting agents.

YOUR TASK: Wire Engram's full intelligence into the loop and prepare for the real task test.

CONTEXT:
- Day 4 delivered: correction brief generator, correction spawner, rollback system
- Today we run a real task through the full loop on monra-app
- Engram needs to provide full context at every stage: initial brief, correction briefs, history queries

BUILD:

1. engram/loop_integration.py — Full loop integration
   - prepare_initial_brief(task_description, worktree_path, db_path):
     * Generate standard Engram brief for the task
     * Include: relevant session history, blast radius (if Axon available), file change patterns
     * Write to worktree's CLAUDE.md
     * Record in sessions.db
   - on_test_pass(worktree_id, test_results, db_path):
     * Create checkpoint with test results
     * Update worktree status to 'passed'
     * Log success metrics for continuous intelligence
   - on_test_fail(worktree_id, test_output, cycle_number, db_path):
     * Parse test output into structured error
     * Create correction_cycle row
     * Generate correction brief (reuse from Day 4)
     * Return the brief for injection
   - on_escalation(worktree_id, db_path):
     * Mark worktree as 'escalated'
     * Generate human-readable summary: what was tried, what failed, why it couldn't be fixed
     * This is what a human sees when the loop gives up
   - get_loop_stats(db_path):
     * Total worktrees, pass rate, average cycles to resolution
     * Most-failed files, most common error types
     * This feeds the dashboard and continuous intelligence

2. Prepare monra-app for the real test:
   - Identify a small, real task on monra-app (a failing test, a missing validation, a small feature)
   - Verify monra-app has tests that can be run automatically
   - Verify the Engram brief for monra-app is current
   - Document the task in the Loopwright progress.md

TESTING:
- Test full loop integration: prepare_initial_brief → on_test_fail → on_test_fail → on_test_pass
- Test escalation path: 3 failures → escalation summary generated
- Test loop stats with mock data

Commit to engram repo.
```

### Agent 2 Prompt (without Engram)

```
You are working on Loopwright, an autonomous CI/CD system with self-correcting agents.

YOUR TASK: Build the full loop controller in Bun and run a real task on monra-app.

CONTEXT:
- Day 4 delivered: corrector.ts, rollback.ts, orchestrator updates
- All pieces exist: event bridge, file watcher, checkpoint manager, idle detector, test runner, corrector, rollback
- Today we wire them all into loop.ts and run for real

BUILD:

1. src/loop.ts — The loop controller (this is the core of Loopwright)
   - Configuration:
     * max_correction_cycles: number (default: 3)
     * idle_timeout_seconds: number (default: 30)
     * test_command: string (auto-detect or configure)
     * repo_path: string
     * task_prompt: string

   - async runLoop(config: LoopConfig):
     * Step 1: Create worktree
       - Bun.spawn(['git', 'worktree', 'add', ...])
       - Write worktree row to sessions.db (status: active)
     * Step 2: Inject initial brief
       - Call Engram: Bun.spawn(['python', 'engram/loop_integration.py', 'prepare-brief', ...])
       - Or read pre-written brief from sessions.db
     * Step 3: Spawn agent
       - Bun.spawn(['claude', '--print', task_prompt], { cwd: worktree_path })
       - Start file watcher + idle detector
     * Step 4: Wait for idle
       - Event loop handles this — idle-detector.ts emits event
     * Step 5: Run tests
       - test-runner.ts handles this
     * Step 6: Branch on result
       - PASS → create checkpoint, mark worktree passed, DONE
       - FAIL → create correction_cycle, check cycle count
         * If cycles < max: rollback to last checkpoint, generate correction brief, GOTO Step 3
         * If cycles >= max: mark worktree escalated, generate escalation summary, DONE

   - The event loop runs the whole thing:
     * file watcher events, idle events, test events, correction events
     * All non-blocking, all concurrent if running multiple loops
     * This is where Bun's event loop shines — one process managing N loops

2. src/multi-loop.ts — Parallel loop execution (the parallelization unlock)
   - Run N loops concurrently on different tasks
   - Each loop gets its own worktree, its own file watcher, its own idle detector
   - All share the same events.jsonl and sessions.db
   - The Bun event loop handles all of them in one process
   - This is the demo of why Bun was the right choice

3. src/spawner.ts — Podman-ready agent spawner (abstraction layer)
   - Abstract agent spawning behind an interface:
     * interface AgentSpawner { spawn(config): Promise<AgentProcess> }
     * class LocalSpawner — uses Bun.spawn() directly (Sprint 1, current)
     * class PodmanSpawner — uses Bun.spawn(['podman', 'run', ...]) (Milestone 2)
   - LocalSpawner for now:
     * Bun.spawn(['claude', '--print', prompt], { cwd: worktree_path })
   - PodmanSpawner stub (implement in Milestone 2):
     * Bun.spawn(['podman', 'pod', 'create', '--name', pod_name])
     * Bun.spawn(['podman', 'run', '--pod', pod_name, '-v', worktree_path + ':/workspace', image, 'claude', '--print', prompt])
     * Each pod gets: agent container + worktree volume mount + shared network namespace
   - loop.ts and multi-loop.ts use the interface, not the implementation
   - This means swapping from local to Podman is a config change, not a rewrite
   - Rootless Podman: no Docker daemon, no root. Enterprise-ready from day one.

4. Update src/cli.ts:
   - bun run src/cli.ts loop --task "fix the login validation" --repo /path/to/repo --max-cycles 3
   - bun run src/cli.ts multi --tasks tasks.json --repo /path/to/repo
   - bun run src/cli.ts status --worktree-id <id>

5. RUN THE REAL TASK:
   - Target: monra-app at /home/prosperitylabs/Desktop/development/monra.app
   - Task: (whatever Agent 1 identified as the test task)
   - Run: bun run src/cli.ts loop --task "<task>" --repo /home/prosperitylabs/Desktop/development/monra.app --max-cycles 3
   - Document everything that happens in progress.md:
     * Did the agent complete the task?
     * How many correction cycles?
     * Did tests pass?
     * Did rollback work?
     * What broke? What was surprising?

MONITORING:
- Every component is producing events → events.jsonl → bridge → sessions.db
- The file watcher catches every change
- Checkpoints track every known-good state
- correction_cycles track every failure and recovery
- This is full observability of the autonomous loop

TESTING:
- Test loop.ts with a mock task (simple repo with an intentionally failing test)
- Test multi-loop.ts with 2 concurrent loops
- Test the full flow end to end on monra-app (THE REAL TEST)

Commit to Loopwright repo. Update progress.md with results.
```

---

## Post-Sprint: What to Check

After Day 5, verify:

1. **sessions.db has data** — worktrees, checkpoints, correction_cycles rows from the real run
2. **events.jsonl has events** — full trace of everything that happened
3. **Checkpoints work** — can you rollback to a prior state?
4. **Correction briefs worked** — did the correction agent know what was tried before?
5. **The loop terminated** — did it pass or escalate cleanly (not hang)?
6. **File watchers caught everything** — no gaps in the event stream
7. **Multi-loop potential** — could you run 2+ loops concurrently?
8. **Podman-ready abstraction** — could you swap LocalSpawner for PodmanSpawner without rewriting loop logic?
9. **Graph deltas captured** — does each checkpoint have structural impact data from Noodlbox?

If all 9 check out: Sprint 1 is complete. The loop exists. Everything after is iteration.
