# Plan: Fix Smoke Test Failures — Brief Generation & No-Change Test Scoping

## Context

Smoke tests on engram revealed two issues that waste correction cycles:

1. **Brief generation fails** with `no such column: a.target` — Engram's `generate_brief()` queries the `artifacts` table, but that table is created lazily by `ArtifactExtractor.__init__()`, not in the main schema. The table exists in the DB but may be missing if `ArtifactExtractor` was never instantiated.

2. **Full test suite runs when agent makes no changes** — When `changed_files` is empty, scoped test collection returns `[]`, so bare `pytest` runs the entire suite. Pre-existing failures (like the FK bug in `test_loopwright_post_commit_hook.py`) trigger correction cycles that blame the agent for failures it didn't cause. In the last smoke test, this burned 3 correction cycles before the agent eventually fixed a pre-existing bug instead of doing its actual task.

## Fix 1: Ensure artifacts table before brief generation

**File:** `src/loop.ts` — `generateProjectBrief()` (line ~140)

**Root cause:** `engram.brief.generate_brief()` runs SQL against the `artifacts` table, but that table is only created when `ArtifactExtractor(db)` is instantiated. Engram's own tests use this exact workaround (see `tests/test_brief.py:64`).

**Change:** In the Python script string inside `generateProjectBrief()`, add one line before calling `generate_brief()`:

```python
from engram.recall.artifact_extractor import ArtifactExtractor
ArtifactExtractor(db)  # ensures artifacts table exists
```

Same fix needed in `injectCorrectionBrief()` Python script (it calls `generate_correction_brief()` which queries `correction_cycles_fts`, but the brief.py functions called internally may also touch artifacts).

**Why not fix in engram?** We should eventually move the `CREATE TABLE artifacts` into `session_db.py`'s `_SCHEMA_SQL`. But that's an engram-side change. This workaround is the same pattern engram's own test suite uses, costs nothing, and unblocks us now.

## Fix 2: Skip full test suite when agent made no changes

**File:** `src/test-runner.ts` — `runTests()` (line ~338)

**Problem chain:**
- `detectChangedFiles()` returns `[]`
- `collectPytestScopedTests(path, [])` returns `[]`
- Command becomes bare `pytest` with no paths → full suite
- Pre-existing failure → correction cycle for something agent didn't cause

**Change:** In `runTests()`, after detecting changed files and before building the command, if `changedFiles` is empty AND no `testCommand` override was provided, return early with a synthetic result:

```ts
if (changedFiles.length === 0 && !options.testCommand) {
  return {
    passed: true,
    exit_code: 0,
    test_command: "(skipped — no files changed)",
    changed_files: [],
    errors: [],
    stdout_tail: "",
    stderr_tail: "",
    duration_ms: 0,
  };
}
```

This is correct because: if the agent made zero changes, it cannot have broken anything. The test runner's job is to verify *agent changes*, not police the entire repo.

## Fix 3: Escalate immediately when agent makes no changes

**File:** `src/loop.ts` — `runLoop()` (line ~385)

**Problem:** Even with Fix 2 returning `passed: true` for no-change runs, the loop would finish with status "passed" — but the task wasn't actually done. The agent explored without making changes, which is a failure to execute, not a success.

**Change:** After the initial run, if `changed_files` is empty, don't enter correction cycles — escalate immediately:

```ts
if (initialTests.changed_files.length === 0) {
  logger.warn("[loop] initial agent made no file changes — escalating");
  db.updateWorktreeStatus(worktreeId, "escalated", isoNow());
  return {
    status: "escalated",
    worktreeId, branchName, worktreePath,
    totalCycles: 0, cycles,
    duration_ms: Math.round(performance.now() - loopStart),
  };
}
```

Similarly, inside the correction loop: if a correction agent makes no changes, escalate rather than burning another cycle.

## Files to Modify

1. `src/loop.ts` — Add `ArtifactExtractor(db)` to both Python script strings; escalate on no-change runs
2. `src/test-runner.ts` — Return early when `changedFiles` is empty and no testCommand override

## Verification

1. `bun test` — all 38 existing tests still pass
2. Smoke test on engram — verify:
   - Brief generation succeeds (no `no such column` error)
   - Agent no-change run escalates immediately instead of burning correction cycles
   - Agent with changes → tests scoped correctly → passes or enters correction
