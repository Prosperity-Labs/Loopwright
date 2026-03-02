# Loopwright — Technical Roadmap v2

> Updated after honest OpenClaw assessment. Based on what actually exists, not what was assumed.
> February 2026 — Living document, update after every sprint

---

## Three Repositories, Clean Boundaries

Loopwright is not a single codebase. It is three repositories with clear ownership. Each does one thing.

### Engram
The memory layer. sessions.db stores artifact history, failure patterns, checkpoints, correction cycles. Brief generation. Artifact extraction. Nothing else.
- **Language:** Python
- **Status:** Production ready. 13K+ artifacts, benchmarks passing.

### OpenClaw
The observability and execution layer. Live dashboard, event streaming, agent tracking, worktree management, programmatic spawning. The eyes and hands of the loop.
- **Language:** Node.js
- **Status:** Monitoring works. Orchestration primitives missing — Sprint 1 builds them.

### Loopwright
The orchestration brain. Loop controller, correction brief builder, staging deploy, A/B decision engine. Calls into OpenClaw's spawner API, reads from Engram's sessions.db. Does not own any data.
- **Language:** Python (consistent with Engram integration).
- **Status:** Does not exist yet. Create repo on Day 4 of Sprint 1.

---

## Honest Current State

Based on direct assessment of the codebase — what is real vs what was assumed.

| Component | Reality |
|-----------|---------|
| Live Dashboard | ✅ Fully working. SSE streaming, 3 collectors, 675 real events, live three-lane UI at :8789. |
| Git Worktrees | ✅ Fully working. engram-control + engram-treatment isolated, 131 tests passing, separate configs. |
| Cross-Agent Tracking | 🔶 Passive telemetry only. Events tagged by agent, run detection via 60s gap heuristic, lease-based task claiming. No active coordination. |
| Event Store | 🔶 Working but minimal. Append-only JSONL, 15 event types, real data. No indexing, no queries, no schema enforcement. |
| Replay | ✅ Fully working in browser. Seek, speed control (0.5x–10x), keyboard shortcuts, timeline. Animates events — does not extract metrics or compare runs. |
| Agent Idle Detection | ❌ Does not exist. No programmatic signal when agent finishes. Shell exit codes only. |
| Programmatic Spawner | ❌ Does not exist. All spawning is shell scripts. No callable API from JS or Python. |
| Agent → Worktree Registry | ❌ Does not exist. Agent identity inferred from log filenames after the fact. No live mapping. |
| Loop Controller | ❌ Does not exist. This is what Loopwright is. |
| Correction Spawner | ❌ Does not exist. No mechanism to spawn agent with error context injected. |
| Checkpoint System | ❌ Does not exist. No rollback point saved anywhere. |
| Test Runner Integration | ❌ Does not exist. Tests run manually. No pipeline trigger. |

---

## The Three Primitives — Build These First

Before the loop controller can exist, OpenClaw needs three capabilities it does not currently have. Everything else in Sprint 1 depends on these.

### Primitive 1 — Agent Idle / Finish Detection

OpenClaw's watchdog monitors the event stream. When an agent produces no new events for N seconds (default: 60s), it emits AGENT_IDLE. When a terminal event arrives (task complete, error, exit), it emits AGENT_FINISHED.

| | |
|---|---|
| **File** | openclaw/watchdog.js |
| **Inputs** | Event stream from event-store.js, configurable idle threshold |
| **Outputs** | AGENT_IDLE and AGENT_FINISHED events appended to events.jsonl |
| **Depends on** | event-store.js (already exists) |
| **Effort** | half day |

### Primitive 2 — Programmatic Agent Spawner

A callable JavaScript function that wraps the existing shell scripts. Takes worktree path, prompt, and agent type. Returns agent ID. The loop controller calls this to start a new agent or correction cycle.

| | |
|---|---|
| **File** | openclaw/spawner.js |
| **API** | `spawnAgent(worktreePath, prompt, agentType) → agentId` |
| **Internals** | Wraps existing run-multi.sh / docker run calls. Registers agent in registry on spawn. Emits AGENT_STARTED event. |
| **Depends on** | registry.js (Primitive 3), existing shell scripts |
| **Effort** | half day |

### Primitive 3 — Live Agent → Worktree Registry

An in-memory Map that tracks what is running right now. Written on spawn, updated on each event, cleared on finish. Exposed via /api/agents endpoint.

| | |
|---|---|
| **File** | openclaw/registry.js |
| **Schema per entry** | agentId, agentType, worktreePath, branch, taskDescription, status, startedAt, lastEventAt, sessionId, correctionCycle |
| **API** | `GET /api/agents → array of current registry entries` |
| **Persistence** | In-memory for now. Add SQLite backing in Milestone 2 if needed. |
| **Effort** | 2 hours |

---

## Engram Schema Extensions

Three new tables in sessions.db. Migration script runs once. Everything else reads and writes through Engram's existing Python interface.

### worktrees

| Column | Type |
|--------|------|
| id | INTEGER PRIMARY KEY |
| session_id | TEXT — links to existing sessions table |
| branch_name | TEXT — git worktree branch |
| base_branch | TEXT — usually 'main' |
| status | TEXT — active \| passed \| failed \| escalated \| merged |
| task_description | TEXT — what the agent was asked to do |
| created_at | TIMESTAMP |
| resolved_at | TIMESTAMP — null until terminal state |

### checkpoints

| Column | Type |
|--------|------|
| id | INTEGER PRIMARY KEY |
| worktree_id | INTEGER — FK to worktrees |
| session_id | TEXT — FK to sessions |
| git_sha | TEXT — commit hash at checkpoint time |
| test_results | JSON — delta + integration test summary |
| artifact_snapshot | JSON — files written up to this point |
| created_at | TIMESTAMP |
| label | TEXT — optional human label |

### correction_cycles

| Column | Type |
|--------|------|
| id | INTEGER PRIMARY KEY |
| worktree_id | INTEGER — FK to worktrees |
| cycle_number | INTEGER — 1, 2, 3… up to max |
| trigger_error | TEXT — what caused this correction |
| error_context | JSON — parsed test output, future: browser/DB/AWS logs |
| checkpoint_id | INTEGER — which checkpoint was base for this cycle |
| agent_session_id | TEXT — the new agent session spawned |
| outcome | TEXT — passed \| failed \| escalated |
| duration_seconds | INTEGER |
| created_at | TIMESTAMP |

---

## Sprint 1 — Build the Primitives and Close the Loop

5 days. Goal: one real task runs autonomously through the full correction loop on monra-app. Everything after is iteration on top of this.

| Day | Repo | Task | Output |
|-----|------|------|--------|
| 1 | Engram | Write migration script: add worktrees, checkpoints, correction_cycles tables to sessions.db. Verify with Engram test suite. | sessions.db extended, migration passing |
| 1 | OpenClaw | Build registry.js: in-memory Map, written on spawn/event/finish, /api/agents endpoint returning live state. | /api/agents returns live agent list |
| 2 | OpenClaw | Build watchdog.js: poll event stream, detect 60s idle gap, emit AGENT_IDLE / AGENT_FINISHED events to events.jsonl. | AGENT_FINISHED events flowing in dashboard |
| 2 | OpenClaw | Build spawner.js: spawnAgent(worktreePath, prompt, agentType) wrapping existing shell scripts. Register in registry on spawn. | Agents launchable from one function call |
| 3 | OpenClaw | Test runner integration: on AGENT_FINISHED event, detect changed files, run pytest/jest scoped to delta, parse output into structured error object. | Test results written to correction_cycles table |
| 3 | Engram | Checkpoint writer: on test pass, read current git SHA + artifact state from sessions.db, write checkpoint row. | Checkpoints created and queryable |
| 4 | Loopwright | Create Loopwright repo. Build corrector.py: reads error from correction_cycles, queries Engram for prior session history, builds correction brief, calls OpenClaw spawner API. | First correction brief generated and agent spawned |
| 4 | Loopwright | Build loop.py: orchestrate spawn → AGENT_FINISHED → test → checkpoint/correct → repeat. Max 3 cycles. Write final status to worktrees table. | Full loop runs end to end |
| 5 | All | Run one real task on monra-app through the full loop. Pick something small — fix a failing test, add a missing validation. Observe, fix what breaks. | Real task completes autonomously or escalates cleanly |
| 5 | OpenClaw | Dashboard update: add correction cycles panel showing cycle number, trigger error, outcome per worktree in live view. | Loop visible in dashboard while running |

---

## Milestone 1 — Full Task List

Everything needed for a working local loop. Sprint 1 covers the core. These are the remaining tasks to complete Milestone 1.

| Task | Repo / File | Effort | Day | Status |
|------|-------------|--------|-----|--------|
| sessions.db migration: worktrees + checkpoints + correction_cycles | Engram — session_db.py | 2h | 1 | 🔵 Todo |
| registry.js — live agent → worktree mapping + /api/agents | OpenClaw — registry.js | 2h | 1 | 🔵 Todo |
| watchdog.js — idle/finish detection, AGENT_FINISHED events | OpenClaw — watchdog.js | half day | 2 | 🔵 Todo |
| spawner.js — spawnAgent() API wrapping shell scripts | OpenClaw — spawner.js | half day | 2 | 🔵 Todo |
| Test runner: delta file detection + pytest/jest + structured error output | OpenClaw — test-runner.js | 1 day | 3 | 🔵 Todo |
| Checkpoint writer: git SHA + artifact snapshot on test pass | Engram — checkpoint.py | half day | 3 | 🔵 Todo |
| Create Loopwright repo. corrector.py: build correction brief from error + history | Loopwright — corrector.py | 1 day | 4 | 🔵 Todo |
| loop.py: orchestrate up to 3 correction cycles, write final status | Loopwright — loop.py | 1 day | 4 | 🔵 Todo |
| Engram brief injection into worktree CLAUDE.md before agent starts | Engram — brief.py (extend) | 2h | 4 | 🔶 Partial |
| Axon MCP wired into spawned worktree for blast radius before first write | OpenClaw — spawner.js (extend) | half day | 5 | 🔵 Todo |
| OpenClaw dashboard: correction cycles live panel | OpenClaw — index.html | half day | 5 | 🔵 Todo |
| Real task test run on monra-app. Observe. Fix what breaks. | All | 1 day | 5 | 🔵 Todo |

---

## Milestone 2 — Staging Integration

Target: 8 weeks. Adds real infrastructure observation (browser, DB, AWS logs) and automatic staging deploy. This is what enterprises see.

| Task | Repo / File | Effort | Day | Status |
|------|-------------|--------|-----|--------|
| MCP tool: browser console capture via Playwright | Loopwright — mcp/browser.py | 1 day | W3 | 🔵 Todo |
| MCP tool: MySQL / Postgres error log capture | Loopwright — mcp/database.py | half day | W3 | 🔵 Todo |
| MCP tool: AWS CloudWatch log capture | Loopwright — mcp/aws.py | 1 day | W4 | 🔵 Todo |
| Staging deploy on test pass: Docker or SSH deploy script | Loopwright — deployer.py | 1 day | W4 | 🔵 Todo |
| Staging health check: smoke tests after deploy, rollback on fail | Loopwright — health.py | half day | W5 | 🔵 Todo |
| Escalation: Slack notification on loop limit with full audit trail link | Loopwright — escalation.py | half day | W5 | 🔵 Todo |
| Integration tests against Docker shadow env (not staging) | Loopwright — shadow.py | 2 days | W6 | 🔵 Todo |
| Event store migration: move from JSONL to SQLite-backed store in OpenClaw | OpenClaw — event-store.js | 1 day | W6 | 🔵 Todo |
| Full audit trail in OpenClaw replay: step through correction cycles | OpenClaw — replay (extend) | 1 day | W7 | 🔵 Todo |
| Opt-in telemetry: anonymised cycle counts, error rates, durations | Loopwright — telemetry.py | half day | W8 | 🔵 Todo |

---

## Milestone 3 — Full CI/CD Replacement

Target: 16 weeks. A/B testing, metrics-based merge decisions, team dashboard, self-hosted deployment package. The product that competes with GitHub Actions + human review.

| Task | Repo / File | Effort | Day | Status |
|------|-------------|--------|-----|--------|
| PostHog MCP: read user behavior metrics from staging | Loopwright — mcp/posthog.py | 1 day | W9 | 🔵 Todo |
| A/B flag injection: deploy feature to % of staging users | Loopwright — ab.py | 1 day | W10 | 🔵 Todo |
| Metrics-based merge decision: auto-merge or auto-rollback | Loopwright — decider.py | 1 day | W10 | 🔵 Todo |
| Progressive rollout: 5% → 25% → 100% with metric checks | Loopwright — rollout.py | 1 day | W11 | 🔵 Todo |
| GitHub / Linear trigger: issue created → loop starts automatically | Loopwright — triggers.py | 1 day | W11 | 🔵 Todo |
| Continuous intelligence: inject prior correction history into brief | Engram — brief.py (extend) | 1 day | W12 | 🔵 Todo |
| Team dashboard: what shipped, what is running, what escalated | OpenClaw — index.html (extend) | 1 day | W13 | 🔵 Todo |
| Cross-run comparison in replay: diff two correction cycles side by side | OpenClaw — replay (extend) | 1 day | W13 | 🔵 Todo |
| Self-hosted deployment: Docker compose for all three repos + docs | All — docker-compose.yml | 2 days | W14 | 🔵 Todo |
| Usage-based billing: count successful merges, emit billing events | Loopwright — billing.py | 1 day | W15 | 🔵 Todo |

---

## Open Decisions

Things that need a choice before or during Sprint 1. Pick one and move — don't block on them.

**Max correction cycles** — How many times does the loop retry before escalating? Too low = escalates constantly. Too high = wastes tokens on unsolvable problems.
*Recommendation: 3, configurable per task type.*

**LangGraph vs custom checkpointing** — LangGraph gives checkpoint + rollback for free but adds a dependency. Custom checkpointing in sessions.db is simpler and the schema is already designed.
*Recommendation: custom first. Add LangGraph if complexity demands it.*

**Idle detection threshold** — 60 seconds default. Too short = false positives on slow agents. Too long = loop waits unnecessarily.
*Recommendation: 60s default, configurable, with explicit TASK_COMPLETE event as override.*

**Test scope: how to detect delta files** — What tests run when agent finishes? All tests = slow. Only changed files = may miss integration breakage.
*Recommendation: use Axon's impact analysis — blast radius files → run their test files. Rest = integration scope.*

**Worktree cleanup policy** — When does a worktree get deleted? On merge, on escalation, or kept for audit?
*Recommendation: keep for 30 days, then archive branch and delete local worktree.*

**Loopwright language** — Python for Engram consistency or Node.js for OpenClaw consistency?
*Recommendation: Python. Engram integration is tighter — loop reads/writes sessions.db constantly.*

---

## How to Iterate on This Document

- **After Sprint 1:** update Status column in Milestone 1 task table. Add rows for anything that emerged. Strike through decisions that resolved themselves.
- **After first autonomous task ships:** write Case Study #5. Send to Chad and Sungman.
- **After Milestone 1 demo:** revisit Open Decisions — most will have answered themselves through building.
- **After first external user:** add a section with their feedback. External validation changes the roadmap.
- **Version this doc:** rename to v3, v4 as major direction changes happen. Keep old versions.

*The roadmap is a map, not a contract. The territory will be different. Update accordingly.*

---

*Loopwright — Engram + OpenClaw + Loopwright — February 2026 — v2*
