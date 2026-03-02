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