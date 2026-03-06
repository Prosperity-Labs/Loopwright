# Day 5 — Cursor Agent Prompt: Dashboard Abort + Tests

Add dashboard abort endpoint and circuit breaker tests. Run bun test after each change.

## dashboard.ts

1. Track `runningLoopProc` at module level.
2. In POST /api/run: assign before spawn, clear in exited callback.
3. Add POST /api/stop: kill proc, set status="failed", broadcast, push event.
4. Update SIGINT handler to kill running loop proc.

## test-utils.ts

5. Export `createBunTestRepo(kind: "pass" | "fail")` from test-utils.ts.

## loop.test.ts

6. Import `createBunTestRepo` from test-utils. Remove inline version.
7. Add `cleanupWorktree: false` to tests that assert worktree files exist.

## circuit-breaker.test.ts (NEW)

8. Seven tests: waitForAgent timeout, waitForAgent normal, loop agent timeout,
   cleanup on success, cleanup on escalation, keep worktree, killAll.
