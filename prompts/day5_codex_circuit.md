# Day 5 — Codex Agent Prompt: Circuit Breakers (spawner.ts + loop.ts)

Add circuit breakers to spawner.ts and loop.ts. Run bun test after each change.

## spawner.ts

1. Add `waitForAgent(agent, timeoutMs?)` that wraps proc.exited with setTimeout + kill.
   Return `{ stdout, stderr, exitCode, timedOut }`. If timedOut: exitCode=124, append "Agent timed out" to stderr.
2. Add `killAll()` to AgentRegistry — kill all agents, await all proc.exited, clear map.

## loop.ts

3. Add to LoopOptions: `agentTimeoutMs?` (default 600_000), `loopTimeoutMs?` (default 1_800_000), `cleanupWorktree?` (default true).
4. Replace raw `Promise.all([proc.exited, ...])` with `waitForAgent(agent, agentTimeoutMs)`.
5. If agent times out: escalate immediately.
6. Add `checkLoopTimeout()` — throw `LoopTimeoutError` if exceeded. Call before each spawn.
7. Catch `LoopTimeoutError` → escalate (don't re-throw).
8. In finally: kill worktree agents, remove worktree if `cleanupWorktree !== false`.
9. SIGINT handler: `registry.killAll()` then `process.exit(130)`.
