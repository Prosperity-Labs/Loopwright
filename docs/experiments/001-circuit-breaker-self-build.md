# Experiment 001: Circuit Breaker Implementation

> Date: 2026-03-05
> Status: Complete
> Branch: `day5/circuit-breakers`

## Hypothesis

Circuit breakers (agent timeouts, loop timeouts, worktree cleanup) can be added to Loopwright
without breaking existing functionality, and verified with targeted tests.

## Setup

- **Scope**: `src/spawner.ts`, `src/loop.ts`, `src/dashboard.ts`, tests
- **Baseline**: 47 tests passing, 14 source files, 0 circuit breakers
- **Branch**: `day5/circuit-breakers` from `day5/atomic-prompts-permissions-metrics`

## Changes Made

### spawner.ts
- Added `waitForAgent(agent, timeoutMs?)` — wraps proc.exited with setTimeout + kill
- Added `WaitResult` interface (stdout, stderr, exitCode, timedOut)
- Added `killAll()` method to `AgentRegistry` — kills all registered agents

### loop.ts
- Added `agentTimeoutMs` option (default 600s / 10 min)
- Added `loopTimeoutMs` option (default 1800s / 30 min)
- Added `cleanupWorktree` option (default true)
- Added `LoopTimeoutError` class
- `runAgentAndWait` now uses `waitForAgent` instead of raw Promise.all
- Agent timeout → immediate escalation (no wasted correction cycles)
- Loop timeout check before each agent spawn and correction cycle
- `finally` block: kills worktree agents, removes worktree directory
- SIGINT handler in import.meta.main calls `registry.killAll()`

### dashboard.ts
- Added `runningLoopProc` tracking
- Added `POST /api/stop` endpoint — kills running loop, broadcasts abort
- SIGINT handler now kills running loop process

### test-utils.ts
- Exported `createBunTestRepo(kind)` for shared use across test files

### test/circuit-breaker.test.ts (NEW)
7 tests covering:
1. waitForAgent kills process after timeout
2. waitForAgent does not kill within timeout
3. Loop escalates when agent exceeds agentTimeoutMs
4. Loop cleans up worktree by default on success
5. Loop cleans up worktree by default on escalation
6. Loop keeps worktree when cleanupWorktree=false
7. registry.killAll terminates all running agents

## Metrics

| Metric | Value |
|--------|-------|
| Files changed | 6 |
| Tests added | 7 |
| Tests passing (post) | 54 |
| Tests failing | 0 |
| Conflicts | 0 |

## Results

All 54 tests pass (47 existing + 7 new). No breaking changes to existing functionality.
Worktree cleanup is automatic by default, with opt-out via `cleanupWorktree: false`.

## Observations

- The timeout pattern from `test-runner.ts` (setTimeout + kill + finally clearTimeout) transferred cleanly to spawner.ts
- Default cleanup (worktree removal) required updating 2 existing tests that asserted worktree files exist
- `removeWorktree` was already available in `ab-runner.ts` — reused it rather than duplicating
