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