# Loopwright — Findings & Research

**Updated:** 2026-02-24

---

## What Already Exists (Verified)

### Engram
- sessions.db with 13K+ artifacts
- FTS search working
- Brief generation working
- PreToolUse hooks working
- Artifact extraction pipeline working
- **Status:** Production ready

### OpenClaw
- Live multi-agent dashboard running
- Git worktrees functional — agents run in isolated branches
- Cross-agent file tracking working
- Event store (SSE) with events.jsonl
- Gource + Excalidraw views available
- Replay UI stub exists (backend not wired)
- **Status:** Running locally

### Git Worktrees
- Already working inside OpenClaw
- Agents run in isolated branches
- Files tracked per agent
- **Status:** Execution foundation ready

### sessions.db Current Schema
- `sessions` table — exists
- `artifacts` table — exists
- `tool_calls` table — exists
- `worktrees` table — **needs to be added**
- `checkpoints` table — **needs to be added**
- `correction_cycles` table — **needs to be added**

---

## Key Insight: Two-Agent Strategy

Two Claude Code instances is the right number for Sprint 1:
1. **Agent 1 (with Engram):** Has session history, understands sessions.db internals, best for memory-layer work
2. **Agent 2 (without Engram):** Clean slate, best for greenfield Loopwright orchestration code

More agents don't help because days are sequentially dependent. Within each day, work splits into two clean tracks.

---

## Architecture Discovery

The data flow is linear — everything reads/writes sessions.db:
```
Trigger → Worktree spawn → Execution → Test runner → Checkpoint → Error capture → Correction spawn → Loop limit → Staging deploy → Merge decision
```

The missing piece is the **orchestration layer** (Days 4-5 of sprint). Everything else exists.

---

## Risks & Unknowns

- [ ] events.jsonl format — need to verify exact schema before building bridge
- [ ] Agent idle detection — how does OpenClaw's event stream signal "agent is done"?
- [ ] Test scoping — need Axon/Noodlbox integration for blast radius → delta test mapping
- [ ] Worktree state persistence — does git worktree state survive agent crashes cleanly?

---

## Decisions Made

### Orchestrator Language: Bun/TypeScript (2026-02-24)

**Decision:** Loopwright orchestration layer built in Bun. Engram stays Python. SQLite is the contract.

**Rationale:**
- Bun's event loop is native to the orchestration pattern — spawn N agents, watch all event streams, dispatch decisions without blocking
- Matches OpenClaw (JS ecosystem) — shared tooling, shared mental model
- `better-sqlite3` reads sessions.db synchronously from Bun — no async wrapper needed
- `Bun.spawn()` gives native subprocess management for parallel agent execution
- Claude Code itself is built on Node — same event loop pattern
- Python's asyncio works but fights itself for concurrent subprocess orchestration
- The event loop **is** the loop controller — they're the same concept

**What this means for the stack:**
- **Engram** — Python. The memory layer. Production ready. Don't touch it.
- **Loopwright** — Bun/TypeScript. The orchestration layer. New code.
- **OpenClaw** — JS. The observability layer. Already running.
- **sessions.db** — SQLite. The integration contract. Both runtimes read it natively.

**Parallelization unlock:**
- One Bun process, one event loop, N agents
- Loop controller CPU barely moves as agents scale — it's just reading events and dispatching
- Delegation chain: loop controller → agents → sub-agents → correction agents — all through one event stream

### Infrastructure Scaling: Podman (2026-02-24)

**Decision:** Podman for agent isolation and scaling. No Docker daemon. No Kubernetes (unless 100+ agents).

**Rationale:**
- **Rootless** — agents run without root. Enterprise security teams approve.
- **Daemonless** — no Docker daemon process. Bun's event loop manages containers directly via `podman run` / `podman pod create`.
- **Pod concept** — a Podman pod groups containers sharing a network namespace. One pod = one agent loop: worktree volume + agent container + file watcher sidecar + test runner.
- **Systemd integration** — `podman generate systemd` gives production service management for free on Linux. No orchestrator needed.
- **Docker-compatible** — when enterprise says "we only run Docker," Podman works with Docker too. Same CLI, same images.
- **Self-hosted story stays clean** — no cloud compute, no daemon, no Kubernetes cluster. Just `podman` on the machine.

**Scaling path:**
```
Sprint 1:     git worktrees (bare, no containers)
Milestone 2:  Podman pods (one pod per agent loop, isolation + shadow envs)
Milestone 3:  Podman + systemd on multiple machines (dispatch tasks to worker nodes)
Only if 100+: Kubernetes (each agent = a pod with worktree PVC)
```

**What this means for the sprint:**
- Sprint 1: no containers. Bare worktrees. Learn the pattern.
- Day 5: structure code so `Bun.spawn()` calls can be swapped for `podman run` later
- Milestone 2: each shadow env / staging deploy runs as a Podman pod

### Checkpointing: Custom Local (No LangGraph) (2026-02-24)

**Decision:** Custom checkpoint/rollback using git SHAs + sessions.db. No LangGraph.

**Rationale:**
- Git SHAs are natural checkpoints — every commit is a restorable state
- sessions.db stores the metadata: which SHA, what test results, what artifacts
- Graph delta (from Noodlbox) stored alongside each checkpoint for structural understanding
- Rollback = `git checkout <sha>`. Instant. No framework overhead.
- LangGraph checkpoints conversation state. We checkpoint *codebase* state. The codebase ships, not the conversation.

---

### Temporal Graph: Memgraph (2026-02-24)

**Decision:** Memgraph for temporal awareness in Milestone 2/3. SQLite stays source of truth.

**Rationale:**
- SQLite stores rows with timestamps. Memgraph stores **relationships with temporal properties**.
- Sprint 1: SQLite is enough. Learning the pattern.
- Milestone 2: Recurring failures appear. SQLite queries get awkward (joins + groups + ordering across correction_cycles, checkpoints, graph deltas).
- Milestone 3: Continuous intelligence requires temporal graph queries:
  * "How did the relationship between `validateBooking` and `processPayment` change over 10 correction cycles?"
  * "Every time someone modifies a symbol in the Payment community, Booking breaks 3 cycles later"
  * "This symbol has been corrected 7 times, and each time the fix propagated to the same 3 callers"
- SQLite = source of truth (file over app, portable). Memgraph = temporal query layer (sync from SQLite).
- Noodlbox provides the static graph snapshot. Memgraph accumulates those snapshots over time.

**Data flow:**
```
Noodlbox (static graph at checkpoint time)
  → graph_delta JSON in sessions.db checkpoint row
  → sync to Memgraph with temporal properties (timestamp, cycle_number, worktree_id)
  → temporal queries power correction briefs and continuous intelligence
```

---

## Decisions Pending

- ~~LangGraph vs custom checkpointing~~ (decided: custom)
- Max correction cycles default
- Agent identity in worktrees
- Test scope detection method
- Worktree cleanup policy
