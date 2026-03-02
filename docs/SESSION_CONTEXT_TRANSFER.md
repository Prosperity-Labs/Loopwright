# Complete Context Transfer — Loopwright / Engram / OpenClaw
*This document reconstructs the full context of the build session. Paste into new Claude session to continue without losing thread.*

---

## Who You Are

Building Loopwright — autonomous CI/CD with self-correcting agents. Based in Serbia. Fintech background (monra-app). Two months runway. Child (Munja) wakes up early. Building every night. Committed to finishing before deciding what's next.

Philosophy: "file over app, SQLite is just a file." Local-first. Data never leaves your machine. Competing only with yourself.

---

## The Three Repositories

### Engram (Python)
The memory layer. sessions.db stores everything agents do — artifacts, tool calls, co-change patterns, failure history, correction cycles. FTS5 search. Brief generation. NL search MCP server (just built tonight). 13K+ artifacts from real production sessions on monra-app.

Key files:
- `engram/recall/session_db.py` — all DB operations, 46 tests passing
- `engram/correction_brief.py` — generates correction-aware briefs, NEW tonight
- `engram/mcp_server.py` — NL search MCP, NEW tonight, one bug fixed (NoneType sort)
- `~/.config/engram/sessions.db` — the actual data, irreplaceable

### OpenClaw (Node.js)
The observability layer. Live dashboard at :8789, SSE streaming, 675 real events, three-lane agent visualization, replay engine (fully working), git worktree tracking.

Honest state (verified):
- Live dashboard: ✅ fully working
- Git worktrees: ✅ working (engram-control + engram-treatment)
- Cross-agent tracking: 🔶 passive telemetry only — no active coordination
- Event store: 🔶 append-only JSONL, no indexing
- Replay: ✅ fully working in browser
- Agent idle detection: ❌ not built yet
- Programmatic spawner: ❌ not built yet
- Live agent→worktree registry: ❌ not built yet

### Loopwright (TypeScript/Bun)
The orchestration brain. New repo. Phase 3 complete tonight.

Built so far:
- `src/db.ts` — full schema, bun:sqlite, zero deps
- `src/watchdog.ts` — idle/finish detection ✅
- `src/spawner.ts` — Bun.spawn() wrapper + AgentRegistry ✅
- `src/test-runner.ts` — delta detection + scoped tests + error parsing ✅
- `src/correction-writer.ts` — TestResult → correction_cycles ✅
- `src/corrector.ts` — reads errors, builds brief, calls spawner ✅
- `src/loop.ts` — orchestrates up to 3 cycles ✅
- 26 tests passing, 91 expects

Four fixes pending before first real loop run:
1. `src/test-runner.ts` — detectPytestBin() for venv pytest path
2. `src/loop.ts` — write CLAUDE.md before spawn, log agent output
3. `src/spawner.ts` — prepend .venv/bin to PATH if exists
4. Verify: bun test (38 pass) + real loop run on engram repo

---

## The Loop — How It Works

```
Task arrives
    ↓
Spawn agent in git worktree
Engram injects brief via CLAUDE.md (history + blast radius scoped files)
    ↓
Agent works
OpenClaw streams every event to events.jsonl
Engram captures artifacts to sessions.db via hooks
    ↓
Watchdog detects AGENT_FINISHED (60s idle or terminal event)
    ↓
Test runner fires on delta files (Axon blast radius scopes this)
    ↓
Tests pass → Checkpoint written (git SHA + artifact snapshot)
Tests fail → Error captured → correction_cycles row written
    ↓
Corrector builds correction brief from:
  - What failed (structured error)
  - Prior correction attempts on same files
  - Checkpoint state
  - Blast radius (Axon)
Brief written to worktree CLAUDE.md
New agent spawned (same worktree)
    ↓
Repeat up to 3 cycles
On limit → escalate to human via Slack
    ↓
On clean pass → deploy to staging (Milestone 2)
PostHog metrics → auto-merge or rollback (Milestone 3)
```

**Inter-agent memory mechanism:**
sessions.db = persistent store (shared file, language-agnostic)
CLAUDE.md = the envelope (context delivered to next agent at startup)
Each correction cycle costs less tokens and knows more.

---

## sessions.db Schema

Existing (Engram):
- `sessions` — one row per agent session
- `artifacts` — files touched per session
- `tool_calls` — every tool call with args/results

New (added tonight):
- `worktrees` — id, session_id, branch_name, base_branch, status, task_description, created_at, resolved_at
- `checkpoints` — id, worktree_id, session_id, git_sha, test_results JSON, artifact_snapshot JSON, created_at, label
- `correction_cycles` — id, worktree_id, cycle_number, trigger_error, error_context JSON, checkpoint_id, agent_session_id, outcome, duration_seconds, created_at

---

## The Moat

Not the code. The code can be copied in a weekend.

The moat is sessions.db after 6 months on your codebase:
- handlers.ts rewritten 75 times across 23 sessions
- Christmas Eve disaster: 426 messages, 76 errors, 0 writes — pattern recognizable at message 50
- 38% of sessions produce zero file writes
- Co-change clusters: validators.ts always changes with handlers.ts

This data doesn't exist anywhere else. It's specific to your architecture, your failures, your patterns. A competitor starting from scratch has to wait months to accumulate what you already have.

It compounds. It's yours. It can't be replicated.

---

## Token Cost Reduction Strategy (80% target)

Layer 1 — Task-scoped brief injection (~40% savings, Milestone 1)
Before spawning: Axon blast radius → only inject history for affected files
Instead of 50 files of context: 5 files

Layer 2 — Local model for correction cycles (~25% savings, Milestone 2)
Initial agent: Claude API (complex reasoning)
Correction agents: Qwen2.5-Coder or DeepSeek-R1 on Mac Mini (mechanical fixes)
Pay API costs for first agent only

Layer 3 — Aggressive prompt caching (~10% savings, Milestone 1)
Static context (codebase structure, clusters) = cached system prompt (10% of normal price)
Dynamic context (current error, checkpoint) = user message

Layer 4 — Progressive context per cycle (~5% savings, Milestone 2)
Cycle 1: full brief
Cycle 2: abbreviated + what cycle 1 tried
Cycle 3: error delta only

Combined: ~80% reduction vs no optimization

Pitch line: "Loopwright doesn't just make your agents smarter. It makes them 5x cheaper to run."

---

## Experiment Results

### Experiment 001 — Cold vs Engram brief
55% faster (17.2 min → 7.6 min)
Exploration: 53% → 25%
Proven on same task, same codebase

### Experiment 003 — NL Search MCP (ran tonight)
Task: "What are the exact commands to launch Cursor and Codex headlessly?"

| Metric | Control (no Engram) | Treatment (with Engram) |
|--------|--------------------|-----------------------|
| Duration | 60s | 34s (-43%) |
| Tool calls | 4 | 6 |
| Accuracy | 3/5 | 5/5 |
| Source | Web docs (generic) | Prior sessions (project-specific) |
| Project flags? | No | Yes (exact --trust, --workspace, --full-auto) |

**The real result:** Both agents found commands. Only Session B found the exact flags from your last successful run. Web search gives documentation. Engram gives what you actually did.

Bug found and fixed live: NoneType sort bug in mcp_server.py line 95.

Demo page built: `engram-demo.html` — dark, animated bars, tool call trace, verdict section.
Needs: video embedded + install command + deploy to GitHub Pages.

---

## Competitive Landscape

**Chad Piatek** (claude-code-memory.tiiny.site)
- Built conversation memory: SQLite + FTS5, localhost:8025, UserPromptSubmit hook
- Response to outreach: "very cool, watcha been cooking on?" — warm
- His layer: what was said. Your layer: what was built.
- Send demo URL as soon as install works

**Sungman Cho** (NoMoreAISlop)
- Team AI productivity dashboard: token counts, who built what, weekly activity
- Problem: developers don't want to share data with employer
- Business model: pay for quality reports, not subscription
- Lost co-founder, going to US to network
- You committed: share case studies as you build
- His data + your data = same JSONL files, different questions

**Igor Sakac** (Defkt, Portugal)
- "Eliminating the Quality Tax for Series A-B startups"
- Playwright/Temporal QA automation, CI/CD integration
- Ex-Avid Pro Tools, Relay Payments (fintech)
- LinkedIn connection note drafted: ready to send

**Vladimir Adamić** (Kopai, Serbia)
- Local OpenTelemetry backend + AI-friendly CLI
- Closes observability loop for instrumentation, not correction
- Kopai CLI = Loopwright's Milestone 2 MCP error observation tool
- Serbian founder, same philosophy, most natural conversation in the space

**Youseff** (Noodlbox)
- Codebase knowledge graph, MCP integration
- Response to outreach: "Exciting 👌🏼 yes I am curious. Less specialisation more horizontal end to end"
- That's Loopwright's thesis stated back to you

**Agentfield** (agentfield.ai)
- "Kubernetes for AI agents" — founded by PhDs, acquired company (Agnostiq → DataRobot)
- DID identity, cross-agent RPC, auto-generated APIs, SWE-AF autonomous engineering fleet
- Their fleet is generic infrastructure. Yours compounds on your codebase.
- They validate the market. You go deeper on the thing they can't do.

**Proliferate** (YC-backed)
- Cloud sandboxes, proactive triggers, audit trails
- Reactive single-agent execution. No correction loop. Expensive cloud compute.
- Your worktree approach: lighter, local, compounds.

**Composio**
- $29M raised, 1000+ tool integrations, MCP connectors
- Integration layer, not memory layer
- Use their GitHub/Linear/Slack connectors for Milestone 3 triggers
- Dependency, not competitor

---

## Sustainability Model

**Open source core** — Engram, OpenClaw, loop primitives. Free. Distribution strategy.

**Team tier** — Shared sessions.db across dev team. Christmas Eve disaster teaches every agent on the team. Monthly per-team subscription.

**Self-hosted enterprise** — Docker compose, annual license. Code never leaves their network. Fintech, healthcare, regulated industries. Largest budgets, least competition, most aligned with your background.

**Intelligence layer** — Reports, architectural risk scores, agent benchmarks. Sungman's model. People pay for insight, not infrastructure.

**Churning means losing your history.** Nobody churns from something that's been accumulating their institutional memory for 6 months. That's the retention mechanic.

---

## Business Model Options

1. Usage-based: charge per successful merge
2. Self-hosted license: Docker compose, annual, runs in their infrastructure
3. Hybrid: free local SQLite forever, pay for team sync + shared dashboards

Recommendation: self-hosted first. Regulated companies (fintech, healthcare) can't send data outside walls. That's your background. That's your buyer.

---

## Immediate Next Steps (ordered)

1. Fix Engram installation bugs (pip install engram && engram install on fresh machine)
2. Embed video in engram-demo.html, add install command, deploy to GitHub Pages
3. Send Chad: demo URL + "same hook pattern, artifact history instead of conversations"
4. Codex runs four Loopwright fixes
5. First real loop run on engram repo — watch dashboard, observe, fix what breaks
6. Write Case Study #5: first autonomous correction cycle
7. Connect with Vladimir (Kopai) — most natural conversation, Milestone 2 dependency
8. Send Igor connection note (already drafted)

---

## Content Ready to Publish Now

1. Experiment post — 55% faster graphic, split comparison. Ready today.
2. Headless agent case study — "The agent didn't know. Engram did." Ready today.

Content waiting for build:
3. Live recording — after NL search MCP polished
4. Christmas Eve post — after correction loop runs
5. Vision post — after first autonomous task ships

---

## Key Phrases That Landed

"Your agents remember what they built."
"Web search gives documentation. Engram gives what you actually did."
"Stop letting your agents burn tokens in circles."
"The loop is the moat. The features are just how the loop expresses its intelligence."
"Loopwright doesn't just make your agents smarter. It makes them 5x cheaper to run."
"Built by three agents in parallel. Bug found live. Fixed in the same session."

---

## Ecosystem Map — Who Builds What

| Player | Layer | Relationship |
|--------|-------|-------------|
| Engram | Memory — what agents did | Yours |
| OpenClaw | Observability — watching agents live | Yours |
| Loopwright | Orchestration — closing the loop | Yours |
| Chad Piatek | Conversation memory | Complementary — different data |
| Sungman (NoMoreAISlop) | Team productivity metrics | Complementary — different questions |
| Vladimir (Kopai) | Observability instrumentation | Dependency — Milestone 2 MCP tool |
| Igor (Defkt) | QA infrastructure, CI/CD | Customer channel — his clients need this |
| Agentfield | Kubernetes for agents — generic infra | Validates market, different buyer |
| Proliferate | Cloud execution, reactive | Competitor — cloud vs your local-first |
| Axon | Static codebase analysis, blast radius | Dependency — already used in loop |
| Composio | Tool integrations, MCP connectors | Dependency — use for Milestone 3 triggers |
| Youseff (Noodlbox) | Codebase knowledge graph | Complementary — horizontal end to end |
| Evolver (Imbue) | Evolutionary code/prompt optimization | Future integration — their mutation loop + your scoring memory |

**Evolver note (filed 2026-03-01):**
Imbue open-sourced Evolver — LLM-driven evolutionary optimizer for code and prompts.
Mutation → scoring → survival. Hits 95% on ARC-AGI-2 benchmarks.
Compatible, not competitor. Their loop needs a scoring function.
Loopwright's sessions.db is that scoring function for production codebases.
Combination: Evolver generates candidates, Loopwright's history tells it which survive your architecture.
Contact when: Loopwright has working correction loop + real sessions.db data from external users.

---

## What Was Philosophically Settled Tonight

**On coding being solved:** Not a threat. When coding is automated, the hard problem becomes trust, accountability, and knowing what agents built. That's exactly what this stack is.

**On the next frontier:** Judgment. What to build, why, for whom, whether it should exist. Requires skin in the game. Can't be automated.

**On competing with Agentfield, Proliferate, etc.:** Don't outspend or outhire. Outspecialize. Their fleet is generic. Your loop is specific to your codebase's history. Go deeper on the thing they can't do.

**On open source:** Not the threat. The whole space builds open source first. That's distribution, not business model. The moat is sessions.db, not the code.

**On physical work / change of direction:** Finish what you committed to. Clarity about what comes after can wait until the loop is running and you've shown it to real users.

---

## How to Start Next Session

Paste this:

> "Continue Loopwright build. Full context in SESSION_CONTEXT_TRANSFER.md in outputs.
> Tonight's state: Experiment 003 done (NL search MCP working, 5/5 vs 3/5 accuracy,
> 43% faster), engram-demo.html built and ready to deploy, Phase 3 complete (26 tests).
> Four fixes pending in Loopwright before first real loop run.
> Token optimization strategy designed (80% reduction path).
> Start with: what's broken in engram install right now?"

---

*This document captures the complete context. sessions.db captures the rest.*
