# Loopwright — Ideas & Directions

> Ecosystem map, product ideas, and strategic thinking. Compiled from session context and synthesis documents, February 2026.

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

### Evolver Note (filed 2026-03-01)

Imbue open-sourced Evolver — LLM-driven evolutionary optimizer for code and prompts. Mutation → scoring → survival. Hits 95% on ARC-AGI-2 benchmarks. Compatible, not competitor. Their loop needs a scoring function. Loopwright's sessions.db is that scoring function for production codebases. Combination: Evolver generates candidates, Loopwright's history tells it which survive your architecture.

**Contact when:** Loopwright has working correction loop + real sessions.db data from external users.

---

## The Vision — Self-Improving Coding Agents

We kept building pieces without seeing they form a whole:

- **OpenClaw** records what each agent did across worktrees. That's **state**.
- **Engram** tracks which changes produced working code vs burn sessions. That's **outcome**.
- **Replay** lets you fork at a decision point and try a different path. That's **simulation**.

Put those three together: an agent that looks at its own history, identifies decision points where sessions went wrong, simulates alternative paths, runs them autonomously in isolated worktrees, and learns which strategies work on your specific codebase.

**That's not just observability. That's a coding agent that gets smarter from its own failures. Continuously. On your codebase specifically.**

---

## The Loop That Connects Everything

```
                    ┌──────────────────────────────┐
                    │                              │
    ┌───────────────▼───────────────┐              │
    │  RECORD (OpenClaw + Engram)   │              │
    │  Agent runs, artifacts logged │              │
    └───────────────┬───────────────┘              │
                    │                              │
    ┌───────────────▼───────────────┐              │
    │  ANALYZE (Engram)             │              │
    │  Outcome: success or burn?    │              │
    │  Detect: error cascades,      │              │
    │  danger zones, stuck loops    │              │
    └───────────────┬───────────────┘              │
                    │                              │
    ┌───────────────▼───────────────┐              │
    │  IDENTIFY (New)               │              │
    │  Find decision fork points    │              │
    │  "At seq 50, agent chose to   │              │
    │   grep logs instead of        │              │
    │   reading the Lambda code"    │              │
    └───────────────┬───────────────┘              │
                    │                              │
    ┌───────────────▼───────────────┐              │
    │  SIMULATE (Replay Engine)     │              │
    │  Fork at decision point       │              │
    │  Try alternative path         │              │
    │  Run in isolated worktree     │              │
    └───────────────┬───────────────┘              │
                    │                              │
    ┌───────────────▼───────────────┐              │
    │  LEARN (New)                  │              │
    │  Compare outcomes             │              │
    │  Store: "on this codebase,    │              │
    │  when you see X, do Y"        │              │
    │  Inject into next session     │              │
    └───────────────┘───────────────┘              │
                    │                              │
                    └──────────────────────────────┘
                         (next session starts)
```

---

## Product Ideas & Directions

### Immediate: Observability Wedge
The self-improving loop is the long-term vision. But the immediate sellable product is the observability layer alone — security, accountability, compliance, risk assessment.

### Near-term: Trigger Layer
Should OpenClaw react to Sentry/Linear/GitHub events to auto-spawn agents in worktrees? User feedback or tickets coming in → agent spins up in a worktree → proposes a solution → you review it.

### Medium-term: Evolver Integration
Evolver generates candidates, Loopwright's history tells it which survive your architecture. Evolutionary optimization meets institutional memory.

### Long-term: Team Intelligence
Shared sessions.db across dev team. One team member's Christmas Eve disaster teaches every agent on the team. Reports, architectural risk scores, agent benchmarks.

---

## Competitive Analysis — Who Has What

| Competitor | What they have | Overlap with us | What they're missing |
|-----------|---------------|----------------|---------------------|
| **LangGraph** | Time-travel: checkpoint-based state replay, fork/branch at decision points | Direct overlap with Simulation layer | Only works for LangChain-based agents. No file-change tracking. No cross-session learning. |
| **Devin** | Session memory, learns from failures, recalls context | Partial overlap with Outcome + Learning | Closed ecosystem. Cloud-only. No local worktree execution. No audit trail for compliance. |
| **Proliferate** | Cloud sandboxes, reactive execution from Sentry/Linear triggers | Execution overlap | Cloud sandboxes, not local worktrees. No session history analysis. No replay. |
| **Langfuse** | LLM traces, Claude Code integration | Traces conversations | Only traces what the LLM *said*, not what files changed. No simulation, no learning loop. |
| **Braintrust** ($80M) | LLM evaluation, tracing, scoring | Observability overlap | No file-change tracking, no replay, no coding-agent-specific features. |
| **AgentOps** | Agent monitoring, session replay | Monitoring overlap | No file-change tracking at artifact level, no fork/simulate. |
| **Claude-mem / chad** | AI-curated observations, vector search | History overlap | No execution, no simulation, no file-level audit. |
| **Noodlbox** | Codebase knowledge graph (static) | Understanding overlap | No runtime behavior data, no session tracking. |

### What's Actually Unique

The claim "nobody has all four pieces" needs qualification:
- **LangGraph has simulation** (time-travel/forking) — but only for LangChain agents, not Claude Code/Codex/Cursor
- **Devin has learning** (session memory, failure recall) — but it's a closed cloud product, not an observability tool
- **Nobody has file-level artifact extraction** from local coding agent sessions (16,303 artifacts from real JSONL)
- **Nobody has local worktree-based parallel agent execution** with a live dashboard tracking what each one does

### The Actual Gap

**Coding agent audit trails for local development** — the intersection of:
1. Deterministic file-change tracking (not just LLM traces)
2. Multi-agent coordination visibility (which agent touched what)
3. Compliance-grade audit trail (SOC2, EU AI Act)
4. Works with ANY coding agent (Claude Code, Codex, Cursor — not locked to one framework)

---

## People in the Ecosystem

| Person | What to send | When |
|--------|-------------|------|
| Chad Piatek | Demo URL + one-liner | After install fixed + deployed |
| Vladimir (Kopai) | "Serbian founder, same space, Kopai CLI is Milestone 2's MCP error tool" | This week |
| Igor Sakac (Defkt) | LinkedIn connection note (already drafted) | This week |
| Sungman | Case Study #5 when first loop runs | After Milestone 1 |

---

## Key Decisions Still Open

1. **Open source or closed?** — OSS gets adoption, closed captures value
2. **CLI-first or SaaS-first?** — CLI is built, SaaS needs infra
3. **Solo developer tool or team tool?** — Solo works today, team needs auth/RBAC
4. **Observability-first or replay-first?** — Observability sells now, replay is the moat
5. **LinkedIn validation before building more?** — Yes, per DIRECTION.md
6. **Trigger layer** — Should OpenClaw react to Sentry/Linear/GitHub events to auto-spawn agents in worktrees?

---

## What Was Philosophically Settled

**On coding being solved:** Not a threat. When coding is automated, the hard problem becomes trust, accountability, and knowing what agents built. That's exactly what this stack is.

**On the next frontier:** Judgment. What to build, why, for whom, whether it should exist. Requires skin in the game. Can't be automated.

**On competing with Agentfield, Proliferate, etc.:** Don't outspend or outhire. Outspecialize. Their fleet is generic. Your loop is specific to your codebase's history. Go deeper on the thing they can't do.

**On open source:** Not the threat. The whole space builds open source first. That's distribution, not business model. The moat is sessions.db, not the code.

---

*Compiled from SYNTHESIS.md and SESSION_CONTEXT_TRANSFER.md — February 2026*
