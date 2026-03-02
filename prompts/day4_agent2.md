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