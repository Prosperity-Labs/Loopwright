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

---

## Decisions Pending

- LangGraph vs custom checkpointing
- Max correction cycles default
- Agent identity in worktrees
- Test scope detection method
- Worktree cleanup policy
