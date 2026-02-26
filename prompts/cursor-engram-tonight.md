# Cursor Agent Prompt — Engram: Correction Brief Injection + Query Helpers

## Context

You are working on the **Engram** repository at `/home/prosperitylabs/Desktop/development/engram`.

Engram is the memory layer for the Loopwright orchestration system. It owns `sessions.db` — the SQLite database that stores session history, artifacts, worktrees, checkpoints, and correction cycles.

**Sprint 1 Phase 3-4** requires two pieces of work in Engram tonight:

1. **Extend `brief.py` to inject correction context** into worktree CLAUDE.md files before spawning a correction agent
2. **Add query helper methods** that Loopwright's TypeScript side will need to call across the SQLite boundary

## What Already Exists

### Schema (already migrated in `session_db.py`)
The three Loopwright tables are live in sessions.db:
- `worktrees` — tracks git worktree lifecycle (active/passed/failed/escalated/merged)
- `checkpoints` — git SHA + test results + artifact snapshot + graph delta at a point in time
- `correction_cycles` — trigger_error, error_context JSON, cycle_number, outcome, duration

### Existing Methods in `session_db.py`
- `create_checkpoint(worktree_id, *, session_id, git_sha, test_results, artifact_snapshot, graph_delta, ab_variant_label, label) -> int`
- `get_latest_checkpoint(worktree_id) -> dict | None`
- `create_correction_cycle(worktree_id, cycle_number, *, trigger_error, error_context, checkpoint_id, agent_session_id, outcome, duration_seconds) -> int`
- `get_correction_cycles(worktree_id) -> list[dict]`
- `search_correction_errors(query, limit=20) -> list[dict]` (FTS)
- `search_worktrees(query, limit=20) -> list[dict]` (FTS)
- `get_worktree(worktree_id) -> dict | None`
- `update_worktree_status(worktree_id, status) -> None`

### Existing Brief Files
- **`engram/brief.py`** — Generates project briefs from session history. Knows about sessions, artifacts, error patterns, co-change clusters, architecture decisions. **Does NOT know about correction_cycles at all.**
- **`engram/ab_brief.py`** — Generates A/B test briefs. **DOES know about corrections** — calls `db.search_correction_errors()` and `db.search_worktrees()`, renders "Prior correction errors" section. Has `write_brief_to_worktree()` that appends briefs to CLAUDE.md.

### Hook
- `engram/hooks/loopwright_post_commit.py` — auto-creates checkpoints on git commit when `LOOPWRIGHT_WORKTREE_ID` env var is set.

---

## Task 1: Correction Brief Injection

### Goal
Create a function that generates a **correction brief** and injects it into a worktree's CLAUDE.md before a correction agent is spawned. This brief tells the new agent: "Here's what failed, here's what was tried, here's the relevant history — don't repeat the same mistakes."

### What to Build

Create `engram/correction_brief.py` with:

```python
def generate_correction_brief(
    db: SessionDB,
    worktree_id: int,
    cycle_number: int,
    trigger_error: str,
    error_context: dict | None = None,
    project: str | None = None,
) -> str:
    """Generate a correction brief for injection into CLAUDE.md.

    Combines:
    1. The trigger error and structured error context (file:line, error type, message)
    2. Prior correction cycles for this worktree (what was already tried)
    3. The last checkpoint state (git SHA, what files existed)
    4. Similar errors from other worktrees (via FTS search)
    5. Optionally, the slim project brief from brief.py
    """
```

The output should be a markdown string structured like:

```markdown
# Correction Brief (Cycle N of max 3)

## Current Error
<trigger_error text>

### Structured Error Context
- File: <file_path>:<line>
- Type: <error_type>
- Message: <error_message>
- Test output: <relevant stdout/stderr snippet>

## Prior Attempts (This Worktree)
- Cycle 1: <trigger_error> → outcome: <passed/failed>
- Cycle 2: <trigger_error> → outcome: <passed/failed>

## Last Checkpoint
- Git SHA: <sha>
- Files at checkpoint: <list>

## Similar Errors (Other Worktrees)
- Worktree #<id>: <trigger_error> (outcome: <outcome>)

## Instructions
- Do NOT repeat the approaches from prior cycles — they failed.
- Focus on the structured error context to identify root cause.
- If the error is in a test file, check the implementation it tests.
- If this is cycle 3 (max), consider escalating with a clear explanation.
```

Also create:

```python
def inject_correction_brief(
    worktree_path: str | os.PathLike,
    brief_content: str,
    cycle_number: int,
) -> dict:
    """Append correction brief to worktree CLAUDE.md.

    Similar to ab_brief.py's write_brief_to_worktree() but uses
    a CORRECTION marker instead of AB marker.
    """
```

This should:
- Append to CLAUDE.md with marker `<!-- ENGRAM_CORRECTION_BRIEF:cycle_N -->`
- Create CLAUDE.md if it doesn't exist
- Return `{"claude_md": str, "cycle_number": int, "appended": bool}`

### Design Notes
- Reuse `ab_brief.py`'s `_recent_history_summary()` pattern for FTS queries
- Reuse `brief.py`'s `generate_slim_brief()` for the optional project context section
- Keep the output under 800 tokens — agents have limited context
- The `error_context` dict follows this shape (from Loopwright's test-runner):
  ```json
  {
    "errors": [
      {"file": "src/foo.ts", "line": 42, "type": "TypeError", "message": "..."},
    ],
    "test_command": "bun test",
    "exit_code": 1,
    "stdout_tail": "last 50 lines of stdout",
    "stderr_tail": "last 50 lines of stderr",
    "changed_files": ["src/foo.ts", "src/bar.ts"]
  }
  ```

---

## Task 2: Query Helpers for Loopwright

### Goal
Add methods to `session_db.py` that Loopwright's TypeScript side needs but doesn't have yet. Loopwright reads sessions.db directly via `bun:sqlite`, but some queries are complex enough that having them as Python helpers (callable via CLI or importable) makes testing easier.

### What to Add to `session_db.py`

```python
def get_correction_cycle_count(self, worktree_id: int) -> int:
    """Return number of correction cycles for a worktree."""

def get_latest_correction_cycle(self, worktree_id: int) -> dict | None:
    """Return the most recent correction cycle, or None."""

def list_worktrees_by_status(self, status: str, limit: int = 50) -> list[dict]:
    """List worktrees filtered by status."""

def get_worktree_with_cycles(self, worktree_id: int) -> dict | None:
    """Return worktree with its correction_cycles and latest checkpoint embedded."""
```

The last method (`get_worktree_with_cycles`) is the most important — it's what `corrector.ts` will eventually need to build the correction brief. It should return:

```python
{
    "id": 1,
    "branch_name": "...",
    "status": "failed",
    "task_description": "...",
    "correction_cycles": [...],  # from get_correction_cycles()
    "latest_checkpoint": {...},   # from get_latest_checkpoint()
}
```

---

## Testing

Add tests to `tests/test_loopwright.py` (which already has 29 tests for the existing schema).

Test:
1. `generate_correction_brief()` with a fresh worktree + 1 error → valid markdown output
2. `generate_correction_brief()` with 2 prior cycles → "Prior Attempts" section populated
3. `inject_correction_brief()` creates CLAUDE.md with correct marker
4. `inject_correction_brief()` appends to existing CLAUDE.md
5. `get_correction_cycle_count()` returns correct count
6. `get_latest_correction_cycle()` returns most recent
7. `get_worktree_with_cycles()` returns nested structure
8. `list_worktrees_by_status()` filters correctly

Run tests with: `cd /home/prosperitylabs/Desktop/development/engram && python -m pytest tests/test_loopwright.py -v`

---

## Branch

Create branch: `day3/correction-brief-cursor`

Commit messages should be descriptive. One commit per logical unit:
1. "Add correction brief generator with error context injection"
2. "Add query helpers: get_worktree_with_cycles, list_worktrees_by_status"
3. "Add tests for correction brief and query helpers"

---

## Files to Modify/Create

| File | Action |
|------|--------|
| `engram/correction_brief.py` | **CREATE** — correction brief generator + injector |
| `engram/recall/session_db.py` | **MODIFY** — add 4 query helper methods |
| `tests/test_loopwright.py` | **MODIFY** — add 8+ tests |

## Do NOT
- Modify `brief.py` or `ab_brief.py` — those are stable
- Change the schema — it's already correct
- Add external dependencies
- Touch anything outside the Engram repo
