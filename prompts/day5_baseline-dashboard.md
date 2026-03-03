# Plan: Baseline Test Snapshot + Dashboard Visualization

## Context

When the loop runs tests after the agent makes changes, **pre-existing test failures** (already broken in the base branch) get attributed to the agent, causing false escalations. In our real test just now, the agent correctly added a docstring but 2 pre-existing FK constraint failures in engram triggered an escalation. The fix: run tests on the clean worktree *before* the agent, then only judge the agent on *new* failures.

Separately, the dashboard at `:8790` needs to show what's actually happening — baseline results, new vs pre-existing errors, and the baseline phase in the pipeline.

---

## Files to Modify

| File | Change |
|------|--------|
| `src/test-runner.ts` | Add `forceRun` option (2 lines) |
| `src/loop.ts` | Baseline step, error comparison, `emitLoopEvent()`, updated types |
| `src/dashboard.ts` | Handle `BASELINE_STARTED/FINISHED` events, fix `type`/`event_type` mismatch, baseline state fields |
| `public/dashboard.html` | Baseline pipeline node, baseline stats card, cycle card new/pre-existing breakdown |
| `test/loop.test.ts` | Tests for baseline filtering, error signatures |

---

## Step 1: `src/test-runner.ts` — `forceRun` option

- Add `forceRun?: boolean` to `TestRunnerOptions` interface
- Change skip condition (line ~344) from:
  `if (changedFiles.length === 0 && !options.testCommand)`
  to:
  `if (changedFiles.length === 0 && !options.testCommand && !options.forceRun)`
- When `forceRun` is true + no changed files, scoped test collection returns `[]`, so the bare `pytest`/`bun test` runs the **full suite** — exactly what we want for baseline

## Step 2: `src/loop.ts` — Baseline + comparison logic

### New types/functions
- `ErrorSignature` type (`"type:file:line"` string)
- `errorSignature(err: TestError)` — builds stable key
- `buildErrorSignatures(result: TestResult)` — returns `Set<ErrorSignature>`
- `filterNewErrors(result, baselineSignatures)` — returns only new errors
- `BaselineResult` interface: `{ testResult, errorSignatures, duration_ms }`
- `emitLoopEvent(eventsPath, event)` — writes JSONL line (mirrors spawner's `appendEvent`)

### Add `baseline` to `LoopResult`, `newErrors`/`preExistingErrorCount` to `CycleResult`

### In `runLoop()`:
1. **After worktree creation, before agent spawn**: run baseline tests with `forceRun: true`
2. Emit `BASELINE_STARTED` / `BASELINE_FINISHED` events to JSONL
3. **Modify `runTestsAndRecord()`** to return `effectivelyPassed` and `newErrors`:
   - `effectivelyPassed = result.passed || filterNewErrors(result, baselineSignatures).length === 0`
   - Log when all failures are pre-existing
4. **Replace `initialTests.passed` / `corrTests.passed`** checks with `effectivelyPassed`
5. Include `baseline` in all `LoopResult` return paths
6. Include `newErrors` + `preExistingErrorCount` in all `cycles.push()` calls

### Edge case: if baseline itself throws (no test framework), catch and proceed without filtering

## Step 3: `src/dashboard.ts` — New event handling

- Add `baselineErrors`, `baselinePassed`, `baselineSignatures` to `DashboardState`
- In `pollEvents()`, handle:
  - `BASELINE_STARTED` → set `phase = "baseline"`, push feed event
  - `BASELINE_FINISHED` → set `phase = "spawn"`, store baseline data, push feed event
- Fix existing `event_type` vs `type` mismatch: read `ev.type ?? ev.event_type`
- Broadcast baseline data in status updates

## Step 4: `public/dashboard.html` — UI additions

### Pipeline: add Baseline node (before Spawn)
```
Baseline → Spawn → Test → Checkpoint → [gap] → Correct
```
- New `pipe-node` with data-phase="baseline" + connector `conn-baseline-spawn`
- Update `setPhase()` to handle 5-node progression

### Stats panel: Baseline summary card
- Shows "Clean" (green) or "N pre-existing failures" (amber)
- Hidden until baseline completes

### Cycle cards: error breakdown
- Show "Pre-existing: N" and "New errors: N" instead of just error count
- Badge shows "PASSED (pre-existing only)" when `effectivelyPassed` but `!passed`

## Step 5: `test/loop.test.ts` — New tests

1. **`errorSignature` produces stable keys** — unit test
2. **`filterNewErrors` separates new from pre-existing** — unit test with mock data
3. **Loop treats pre-existing failures as passed** — integration test: create repo with failing test on `main`, run loop, verify `status === "passed"` and `baseline` populated
4. **Baseline result included in LoopResult** — shape test

---

## What NOT to change

- **`src/db.ts`** — no schema changes; baseline is ephemeral (in-memory + events.jsonl)
- **`src/spawner.ts`** — not involved in baseline/test logic
- **`src/correction-writer.ts`** — records actual `TestResult` as-is; baseline filtering is above it in `loop.ts`

## Verification

1. `bun test` — all existing 47 tests + new baseline tests pass
2. Run loop on engram with the same docstring task — should now return `status: "passed"` since the 2 FK failures are pre-existing
3. Open `http://localhost:8790/` — see Baseline node light up, baseline stats card, cycle cards showing "0 new errors, 2 pre-existing"

---

## Evidence from Tonight's Real Run

- **Task**: "Add a one-line docstring to `_render_error_context` in `engram/correction_brief.py`"
- **Agent**: Claude Code, completed in 28s, exit 0, made 1 correct change
- **Result**: Escalated (false positive) — 216 passed, 2 pre-existing FK failures
- **Pre-existing failures**: `test_auto_sync::TestSessionStartHook::test_hook_indexes_and_generates_brief`, `test_loopwright_post_commit_hook::test_post_commit_hook_records_ab_variant`
- **Root cause**: `sqlite3.IntegrityError: FOREIGN KEY constraint failed` in `session_db.py:788`
- **Day 5 features confirmed working**: CLAUDE.md written, permissions file created, measurements extracted (`tool_calls_made: 4, files_changed: 1`), `agent_context` stored in DB
