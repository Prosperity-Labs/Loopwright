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