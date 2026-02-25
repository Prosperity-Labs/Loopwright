# Loopwright — Detailed Technical Roadmap

*February 2026 — Living Document, iterate continuously*

---

## Current State — What Already Exists

Loopwright is not built from scratch. Three components already exist and need to be connected, not rebuilt.

| Component | Status | Details |
|-----------|--------|---------|
| **Engram** | ✅ Production ready | sessions.db with 13K+ artifacts, FTS search, brief generation, PreToolUse hooks, artifact extraction pipeline. The memory layer. |
| **OpenClaw** | ✅ Running locally | Live multi-agent dashboard, git worktrees running, cross-agent file tracking, event store (SSE), Gource + Excalidraw views, replay UI stub. The observability layer. |
| **Git Worktrees** | ✅ The execution foundation | Already working inside OpenClaw. Agents run in isolated branches. Files tracked per agent. |
| **sessions.db schema** | 🔶 Extend, don't rebuild | sessions, artifacts, tool_calls tables. Needs: worktrees table, checkpoints table, correction_cycles table. |
| **Replay Button** | 🔵 Priority feature | UI exists in OpenClaw dashboard. Backend not wired. First thing to make real. |
| **MCP Tools** | 🔵 Phase 2 dependency | Bash/Read/Write tools working. Error observation MCP (browser, MySQL, AWS) not built. |

## Architecture — How the Pieces Connect

The data flow is linear. Every component reads from or writes to sessions.db:

| Step | Description |
|------|-------------|
| **Trigger** | Ticket arrives (Linear/GitHub issue) or manual task description. Stored in sessions.db as new session with `status=pending`. |
| **Worktree spawn** | OpenClaw creates git worktree from main branch. Engram injects brief + blast radius (Axon MCP) into agent context before first write. |
| **Execution** | Agent works. OpenClaw streams every tool call, file write, bash command to event store. Engram writes artifacts in real time. |
| **Test runner** | On agent idle or explicit signal: run delta tests first, then integration suite. Results written to sessions.db. |
| **Checkpoint** | On test pass: write checkpoint to sessions.db (worktree state + artifact snapshot). This is the rollback point. |
| **Error capture** | On test fail: MCP tools capture browser console, DB logs, AWS CloudWatch. Full error context stored in sessions.db. |
| **Correction spawn** | New agent spawned in same worktree. Engram brief includes: last checkpoint, error context, what was tried, blast radius. Agent knows exactly what broke. |
| **Loop limit** | Max N correction cycles (default: 5). On limit: `status=escalated`, human notification sent. Session stays in sessions.db with full audit trail. |
| **Staging deploy** | On clean test pass: auto-deploy to staging. PostHog MCP monitors user behavior metrics. |
| **Merge decision** | If metrics hold for T minutes: auto-merge to main. If metrics drop: rollback to checkpoint. Decision written to sessions.db. |

## Database Schema Extensions

Add three tables to the existing sessions.db. Everything else reads from what Engram already writes.

### New: `worktrees`

Tracks active and historical worktree executions.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PRIMARY KEY | |
| `session_id` | TEXT | Links to existing sessions table |
| `branch_name` | TEXT | Git worktree branch |
| `base_branch` | TEXT | Usually 'main' |
| `status` | TEXT | active \| passed \| failed \| escalated \| merged |
| `task_description` | TEXT | What the agent was asked to do |
| `created_at` | TIMESTAMP | |
| `resolved_at` | TIMESTAMP | Null until terminal state |

### New: `checkpoints`

Snapshot of worktree state at a known-good moment. Rollback target.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PRIMARY KEY | |
| `worktree_id` | INTEGER | FK to worktrees |
| `session_id` | TEXT | FK to sessions |
| `git_sha` | TEXT | Commit hash at checkpoint time |
| `test_results` | JSON | Delta + integration test summary |
| `artifact_snapshot` | JSON | Files written up to this point |
| `created_at` | TIMESTAMP | |
| `label` | TEXT | Optional human label, e.g. 'after auth fix' |

### New: `correction_cycles`

One row per self-correction attempt. Enables replay and post-incident analysis.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PRIMARY KEY | |
| `worktree_id` | INTEGER | FK to worktrees |
| `cycle_number` | INTEGER | 1, 2, 3… up to max |
| `trigger_error` | TEXT | What caused this correction |
| `error_context` | JSON | Browser logs, DB errors, AWS logs captured by MCP |
| `checkpoint_id` | INTEGER | Which checkpoint was used as base |
| `agent_session_id` | TEXT | The new agent session spawned for this cycle |
| `outcome` | TEXT | passed \| failed \| escalated |
| `duration_seconds` | INTEGER | |
| `created_at` | TIMESTAMP | |

## Milestone 1 — The Loop Exists Locally

**Target: 4 weeks.** Goal: one end-to-end correction cycle working on monra-app. No staging, no A/B testing. Just: agent writes → tests fail → error captured → new agent corrects → checkpoint saved.

| Task | Connects / Depends On | Effort | Status |
|------|----------------------|--------|--------|
| Add worktrees + checkpoints + correction_cycles tables to sessions.db | Engram `session_db.py` — extend schema. 10 lines of SQL. | 2h | 🔵 Todo |
| Wire replay button in OpenClaw to actual session replay | OpenClaw `event-store.js` + `server.js`. Load JSONL for session_id, stream events back through SSE. | 1 day | 🔵 Todo |
| Build worktree spawner: create branch, install deps, return worktree path | OpenClaw `run-multi.sh` or new `loopwright/spawner.ts`. Git worktree add + setup. | half day | 🔶 Partial |
| Wire Engram brief injection before agent starts in worktree | Engram `brief.py` → write to worktree's CLAUDE.md before agent launch. Already works for monra-app. | 2h | 🔶 Partial |
| Add Axon MCP to agent context: blast radius before first write | Add axon to `.mcp.json` in spawned worktree. `axon impact <changed_symbol>` before write. | half day | 🔵 Todo |
| Test runner integration: run pytest/jest on delta files after agent idles | Detect agent idle from event stream. Run tests scoped to changed files. Write results to sessions.db. | 1 day | 🔵 Todo |
| Checkpoint writer: on test pass, save git SHA + artifact snapshot | New `engram/checkpoint.py`. Reads current worktree git SHA + artifact state from sessions.db. | half day | 🔵 Todo |
| Error capture (local only): parse test output into structured error context | No MCP yet — just parse pytest/jest stdout. Extract file:line, error type, message. Write to correction_cycles. | half day | 🔵 Todo |
| Correction cycle spawner: new agent with error context + checkpoint injected | `loopwright/corrector.ts`. Builds correction brief from error context + prior checkpoint. Launches new agent in same worktree. | 1 day | 🔵 Todo |
| Loop controller: orchestrate up to N cycles, write final status to sessions.db | `loopwright/loop.ts`. Manages the cycle: spawn → test → checkpoint/correct → repeat. Max cycles config. Bun event loop handles N agents concurrently. | 1 day | 🔵 Todo |
| OpenClaw dashboard: show correction cycles in live view | Add correction_cycles panel to `index.html`. Show cycle number, trigger error, outcome per worktree. | half day | 🔵 Todo |
| Test on monra-app: one real task through the full loop | Pick a small real ticket. Run it. Observe. Fix what breaks. | 1 day | 🔵 Todo |

## Milestone 2 — Staging Integration

**Target: 8 weeks.** Goal: loop deploys to staging automatically. MCP error observation from real infrastructure. Escalation to human on loop limit.

| Task | Connects / Depends On | Effort | Status |
|------|----------------------|--------|--------|
| MCP tool: browser console capture (Playwright) | New MCP server: playwright → capture console errors, network failures, screenshots on test. Write to `correction_cycles.error_context`. | 1 day | 🔵 Todo |
| MCP tool: MySQL/Postgres error capture | Query error logs table or `pg_stat_activity` for recent errors matching session timeframe. Write to `error_context`. | half day | 🔵 Todo |
| MCP tool: AWS CloudWatch log capture | AWS SDK → fetch log events for relevant Lambda/service in correction window. Write to `error_context`. | 1 day | 🔵 Todo |
| Staging deploy on test pass: Docker or SSH deploy script | `loopwright/deployer.ts`. On checkpoint created: trigger deploy to staging env. Write deploy status to worktrees table. | 1 day | 🔵 Todo |
| Staging health check: verify deploy didn't break existing flows | Run smoke tests against staging after deploy. If fail: rollback to prior checkpoint, mark worktree as failed. | half day | 🔵 Todo |
| Escalation: notify human on loop limit reached | Slack MCP or email. Include: task description, correction cycle history, last error, link to OpenClaw session replay. | half day | 🔵 Todo |
| Full audit trail: every correction cycle readable in OpenClaw replay | Wire correction_cycles to replay view. Step through: what agent wrote → what test said → what error captured → what correction tried. | 1 day | 🔵 Todo |
| Integration tests against main replica: Docker compose shadow env | Spin up shadow DB + services from docker-compose. Run integration suite against shadow, not staging. Prevents staging pollution. | 2 days | 🔵 Todo |
| Loop telemetry: anonymized stats (cycle counts, error rates, durations) | `loopwright/telemetry.ts`. Opt-in. Sends only numbers, never content. Informs product improvement. | half day | 🔵 Todo |

## Milestone 3 — Full CI/CD Replacement

**Target: 16 weeks.** Goal: A/B testing, progressive rollout, metrics-based merge, team dashboard. This is the product that competes with GitHub Actions + human review.

| Task | Connects / Depends On | Effort | Status |
|------|----------------------|--------|--------|
| PostHog MCP: read user behavior metrics from staging | PostHog API → fetch session counts, error rates, funnel completion for feature flag cohort. Write to sessions.db. | 1 day | 🔵 Todo |
| A/B flag injection: deploy feature to % of staging users | Feature flag via PostHog or LaunchDarkly. Agent decides cohort size based on risk (Axon blast radius). | 1 day | 🔵 Todo |
| Metrics-based merge decision: auto-merge or auto-rollback | `loopwright/decider.ts`. Compare metrics between control and treatment. If within threshold: merge. If degraded: rollback. | 1 day | 🔵 Todo |
| Progressive rollout: 5% → 25% → 100% with metric checks at each step | Configurable rollout ladder. Each step waits T minutes, checks metrics, proceeds or halts. | 1 day | 🔵 Todo |
| Team dashboard: what shipped this week, what is running now | OpenClaw new view. Per-task status: running / passed / escalated / merged. Filter by agent, by file, by date. | 1 day | 🔵 Todo |
| GitHub/Linear trigger integration: task arrives, loop starts automatically | Webhook receiver. Issue created → extract task description → spawn worktree → begin loop. | 1 day | 🔵 Todo |
| Continuous intelligence: loop learns from prior correction cycles | Before each correction, query correction_cycles for same file + similar error. Inject 'last time this broke, here is what fixed it' into agent brief. | 1 day | 🔵 Todo |
| Self-hosted deployment package: Docker compose, license, docs | `docker-compose.yml` for Loopwright + Engram + OpenClaw. One command install. License check on startup. | 2 days | 🔵 Todo |
| Usage-based billing: count successful merges, emit billing events | `loopwright/billing.ts`. On merge: emit event with worktree_id, cycle_count, task_type. Integrate with Stripe or Lago. | 1 day | 🔵 Todo |

## Sprint 1 — Start Now (This Week)

The first three days connect what already exists. No new architecture. Just wire the pieces together.

| Day | Task | Output |
|-----|------|--------|
| **Day 1** | Add worktrees + checkpoints + correction_cycles to sessions.db. Write migration script. Verify Engram reads/writes correctly. | sessions.db extended, migration passes |
| **Day 1** | Wire replay button: load JSONL for session_id, stream through existing SSE endpoint. Test with a real past session. | Replay button works in OpenClaw |
| **Day 2** | Build `loop.py` skeleton: spawn worktree → inject brief → wait for agent → run tests → write result. No correction yet — just the happy path. | Happy path: agent writes, tests run, result in DB |
| **Day 2** | Test runner integration: detect agent idle from event stream, run pytest on changed files, parse output into structured error. | Test results appear in sessions.db |
| **Day 3** | Checkpoint writer: on test pass, write git SHA + artifact snapshot. Verify rollback restores to correct state. | Checkpoint created and restorable |
| **Day 3** | Correction spawner: on test fail, build correction brief from error + checkpoint, spawn new agent. Hard-code max 2 cycles for now. | First correction cycle runs end to end |
| **Day 4** | Run a real task on monra-app through the full loop. Pick something small: fix a failing test, add a missing validation. | Real task completes autonomously or escalates cleanly |
| **Day 5** | OpenClaw dashboard update: show correction cycles in live view. Add worktree status panel. | Dashboard shows the loop running live |

> After Sprint 1, you have something real: an autonomous loop that writes, tests, and self-corrects on your own codebase. That is the demo. Everything after is iteration.

## Sprint 1 (Revised) — Based on Reality

The original Sprint 1 was aspirational. This revision is grounded in what actually exists: Engram is production-ready, OpenClaw is running locally with worktrees, and events.jsonl captures everything. Nothing is stubbed or faked. The foundation is solid. What's missing is the orchestration layer — the loop controller that makes it autonomous. That's one week of focused building.

| Day | Task | Output |
|-----|------|--------|
| **Day 1** | **Schema extension only.** Add worktrees + checkpoints + correction_cycles tables to sessions.db. Wire `events.jsonl` → sessions.db bridge so OpenClaw events flow into Engram's database with indexing. | sessions.db extended, event bridge flowing, migration passes |
| **Day 2** | **Scripted A/B runner.** Automate what's currently manual: same prompt, two worktrees, capture results without eyeballing. Structured comparison output. | Repeatable A/B runs, results in DB |
| **Day 3** | **Test runner integration.** Detect agent idle from event stream, run tests on delta files, parse output into structured error in correction_cycles table. | Test results appear in correction_cycles with structured errors |
| **Day 4** | **Correction spawner.** This is the new build. Takes error from correction_cycles, builds injection brief, launches new agent in same worktree. This is what doesn't exist yet. | `loopwright/corrector.ts` — first correction cycle runs |
| **Day 5** | **Loop controller.** Orchestrate: spawn → test → checkpoint → correct → repeat. Max cycles. Real task on monra-app. | End-to-end loop on a real task, autonomous or escalated cleanly |

> The bottom line: nothing is stubbed or faked. The foundation is solid. What's missing is the orchestration layer — the loop controller that makes it autonomous. That's one week of focused building.

## Open Decisions

Things that need a decision before or during Sprint 1. Don't block on them — pick one and move.

| Decision | Recommendation |
|----------|---------------|
| ~~**Loop orchestrator language** — Python (consistent with Engram) or Node.js (consistent with OpenClaw).~~ | ✅ **Decided: Bun/TypeScript.** Event loop is native to the orchestration pattern. Matches OpenClaw (JS). `better-sqlite3` reads sessions.db synchronously. Bun's `spawn()` gives native subprocess management for parallel agents. Engram stays Python — SQLite is the contract between them. |
| **LangGraph vs custom checkpointing** — LangGraph gives you checkpointing + rollback for free but adds a dependency. Custom checkpointing in sessions.db is simpler and you already have the schema. | Custom first, LangGraph if complexity demands it. |
| **Max correction cycles default** — Too low (2) and it escalates constantly. Too high (10) and it wastes tokens on unsolvable problems. | 3, configurable per task type. |
| **Agent identity in worktrees** — Should each correction cycle use the same agent type or try different ones (Claude → Codex → Cursor)? | Same agent, different context injection. Multi-agent correction adds complexity without proven benefit yet. |
| **Test scope detection** — How does the loop know which tests are 'delta' vs 'integration'? | Use Axon's impact analysis — blast radius files → run their test files. Files outside blast radius = integration scope. |
| **Worktree cleanup** — When does a worktree get deleted? On merge, on escalation, or keep forever for audit? | Keep for 30 days (configurable), then archive branch and delete local worktree. |

## How to Iterate on This Roadmap

This document is a living artifact. After each sprint, update the status column in the task tables. Add rows when new tasks emerge. Strike through decisions that have been made.

- **After Sprint 1:** update task statuses, add anything that was harder or easier than expected
- **After first real task ships autonomously:** write it up as Case Study #5. That is the next piece of content.
- **After Chad or Sungman tries it:** add their feedback as a section. External validation changes the roadmap.
- **After Milestone 1 demo:** revisit the Open Decisions table. Most will have answered themselves.

> The roadmap is not a contract. It is a map. The territory will be different.

---

*Loopwright — Built on Engram + OpenClaw — February 2026*
