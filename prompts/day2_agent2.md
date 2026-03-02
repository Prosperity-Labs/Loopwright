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