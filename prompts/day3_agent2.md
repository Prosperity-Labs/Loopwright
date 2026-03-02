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