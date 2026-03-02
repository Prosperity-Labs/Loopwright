You are working on Loopwright, an autonomous CI/CD system with self-correcting agents.

YOUR TASK: Build the full loop controller in Bun and run a real task on monra-app.

CONTEXT:
- Day 4 delivered: corrector.ts, rollback.ts, orchestrator updates
- All pieces exist: event bridge, file watcher, checkpoint manager, idle detector, test runner, corrector, rollback
- Today we wire them all into loop.ts and run for real

BUILD:

1. src/loop.ts — The loop controller (this is the core of Loopwright)
   - Configuration:
     * max_correction_cycles: number (default: 3)
     * idle_timeout_seconds: number (default: 30)
     * test_command: string (auto-detect or configure)
     * repo_path: string
     * task_prompt: string

   - async runLoop(config: LoopConfig):
     * Step 1: Create worktree
       - Bun.spawn(['git', 'worktree', 'add', ...])
       - Write worktree row to sessions.db (status: active)
     * Step 2: Inject initial brief
       - Call Engram: Bun.spawn(['python', 'engram/loop_integration.py', 'prepare-brief', ...])
       - Or read pre-written brief from sessions.db
     * Step 3: Spawn agent
       - Bun.spawn(['claude', '--print', task_prompt], { cwd: worktree_path })
       - Start file watcher + idle detector
     * Step 4: Wait for idle
       - Event loop handles this — idle-detector.ts emits event
     * Step 5: Run tests
       - test-runner.ts handles this
     * Step 6: Branch on result
       - PASS → create checkpoint, mark worktree passed, DONE
       - FAIL → create correction_cycle, check cycle count
         * If cycles < max: rollback to last checkpoint, generate correction brief, GOTO Step 3
         * If cycles >= max: mark worktree escalated, generate escalation summary, DONE

   - The event loop runs the whole thing:
     * file watcher events, idle events, test events, correction events
     * All non-blocking, all concurrent if running multiple loops
     * This is where Bun's event loop shines — one process managing N loops

2. src/multi-loop.ts — Parallel loop execution (the parallelization unlock)
   - Run N loops concurrently on different tasks
   - Each loop gets its own worktree, its own file watcher, its own idle detector
   - All share the same events.jsonl and sessions.db
   - The Bun event loop handles all of them in one process
   - This is the demo of why Bun was the right choice

3. src/spawner.ts — Podman-ready agent spawner (abstraction layer)
   - Abstract agent spawning behind an interface:
     * interface AgentSpawner { spawn(config): Promise<AgentProcess> }
     * class LocalSpawner — uses Bun.spawn() directly (Sprint 1, current)
     * class PodmanSpawner — uses Bun.spawn(['podman', 'run', ...]) (Milestone 2)
   - LocalSpawner for now:
     * Bun.spawn(['claude', '--print', prompt], { cwd: worktree_path })
   - PodmanSpawner stub (implement in Milestone 2):
     * Bun.spawn(['podman', 'pod', 'create', '--name', pod_name])
     * Bun.spawn(['podman', 'run', '--pod', pod_name, '-v', worktree_path + ':/workspace', image, 'claude', '--print', prompt])
     * Each pod gets: agent container + worktree volume mount + shared network namespace
   - loop.ts and multi-loop.ts use the interface, not the implementation
   - This means swapping from local to Podman is a config change, not a rewrite
   - Rootless Podman: no Docker daemon, no root. Enterprise-ready from day one.

4. Update src/cli.ts:
   - bun run src/cli.ts loop --task "fix the login validation" --repo /path/to/repo --max-cycles 3
   - bun run src/cli.ts multi --tasks tasks.json --repo /path/to/repo
   - bun run src/cli.ts status --worktree-id <id>

5. RUN THE REAL TASK:
   - Target: monra-app at /home/prosperitylabs/Desktop/development/monra.app
   - Task: (whatever Agent 1 identified as the test task)
   - Run: bun run src/cli.ts loop --task "<task>" --repo /home/prosperitylabs/Desktop/development/monra.app --max-cycles 3
   - Document everything that happens in progress.md:
     * Did the agent complete the task?
     * How many correction cycles?
     * Did tests pass?
     * Did rollback work?
     * What broke? What was surprising?

MONITORING:
- Every component is producing events → events.jsonl → bridge → sessions.db
- The file watcher catches every change
- Checkpoints track every known-good state
- correction_cycles track every failure and recovery
- This is full observability of the autonomous loop

TESTING:
- Test loop.ts with a mock task (simple repo with an intentionally failing test)
- Test multi-loop.ts with 2 concurrent loops
- Test the full flow end to end on monra-app (THE REAL TEST)

Commit to Loopwright repo. Update progress.md with results.