# Loopwright — Business Potential

> Extracted from session context documents, February 2026

---

## The Moat

Not the code. The code can be copied in a weekend.

The moat is sessions.db after 6 months on your codebase:
- handlers.ts rewritten 75 times across 23 sessions
- Christmas Eve disaster: 426 messages, 76 errors, 0 writes — pattern recognizable at message 50
- 38% of sessions produce zero file writes
- Co-change clusters: validators.ts always changes with handlers.ts

This data doesn't exist anywhere else. It's specific to your architecture, your failures, your patterns. A competitor starting from scratch has to wait months to accumulate what you already have.

**It compounds. It's yours. It can't be replicated.**

**Churning means losing your history.** Nobody churns from something that's been accumulating their institutional memory for 6 months. That's the retention mechanic.

---

## ARR Scenarios — Enterprise Value

The self-improving loop is the long-term vision. But the **immediate** sellable product is the observability layer alone:

| Use Case | ARR Range | What They Buy |
|----------|-----------|---------------|
| Security | $50-200K/yr | Sensitive file access detection |
| Accountability | $30-100K/yr | Session-to-commit forensic linking |
| Compliance | $50-150K/yr | SOC2/EU AI Act audit trail |
| Risk | $20-50K/yr | Pre-merge blast radius assessment |

The replay/learning loop is the **moat** — what makes this defensible long-term.
But observability is the **wedge** — what gets you in the door today.

---

## Token Cost Reduction Strategy (80% target)

### Layer 1 — Task-scoped brief injection (~40% savings, Milestone 1)
Before spawning: Axon blast radius → only inject history for affected files.
Instead of 50 files of context: 5 files.

### Layer 2 — Local model for correction cycles (~25% savings, Milestone 2)
Initial agent: Claude API (complex reasoning).
Correction agents: Qwen2.5-Coder or DeepSeek-R1 on Mac Mini (mechanical fixes).
Pay API costs for first agent only.

### Layer 3 — Aggressive prompt caching (~10% savings, Milestone 1)
Static context (codebase structure, clusters) = cached system prompt (10% of normal price).
Dynamic context (current error, checkpoint) = user message.

### Layer 4 — Progressive context per cycle (~5% savings, Milestone 2)
- Cycle 1: full brief
- Cycle 2: abbreviated + what cycle 1 tried
- Cycle 3: error delta only

### Combined Savings Estimate

| Scenario | Token cost vs baseline |
|----------|----------------------|
| No optimization | 100% |
| Layer 1 + 3 (Milestone 1) | ~50% |
| All four layers (Milestone 2) | ~20% |
| With local model for corrections | ~15-20% |

**Pitch line:** "Loopwright doesn't just make your agents smarter. It makes them 5x cheaper to run."

---

## Sustainability Model

**Open source core** — Engram, OpenClaw, loop primitives. Free. Distribution strategy.

**Team tier** — Shared sessions.db across dev team. Christmas Eve disaster teaches every agent on the team. Monthly per-team subscription.

**Self-hosted enterprise** — Docker compose, annual license. Code never leaves their network. Fintech, healthcare, regulated industries. Largest budgets, least competition, most aligned with your background.

**Intelligence layer** — Reports, architectural risk scores, agent benchmarks. Sungman's model. People pay for insight, not infrastructure.

---

## Business Model Options

1. **Usage-based:** charge per successful merge
2. **Self-hosted license:** Docker compose, annual, runs in their infrastructure
3. **Hybrid:** free local SQLite forever, pay for team sync + shared dashboards

**Recommendation:** self-hosted first. Regulated companies (fintech, healthcare) can't send data outside walls. That's your background. That's your buyer.

---

## Competitive Landscape

| Layer | Crowdedness | Key Players | Our position |
|-------|------------|-------------|-------------|
| LLM conversation tracing | Very crowded | Braintrust $80M, Arize $62M, LangSmith $45M | Not competing here |
| AI governance/compliance | Moderate | Zenity, Credo AI, Arthur AI | Adjacent — our audit trail feeds their frameworks |
| Agent workflow observability | Nearly empty | AgentOps (small), InfiniteWatch ($4M, customer-facing agents) | Different focus — they monitor customer-facing AI, we monitor coding agents |
| Agent simulation/replay | LangGraph only | LangGraph time-travel (LangChain-locked) | We're framework-agnostic (Claude/Codex/Cursor) |
| Cloud agent sandboxes | Emerging | Proliferate (YC), Devin (cloud) | We're local-first — different philosophy |
| **Local coding agent audit trails** | **Empty** | **Nobody** | **This is us** |
| **Self-improving from local history** | **Empty** | **Devin does it cloud-side** | **This is the moat** |

---

## Key Pitch Phrases

- "Your agents remember what they built."
- "Web search gives documentation. Engram gives what you actually did."
- "Stop letting your agents burn tokens in circles."
- "The loop is the moat. The features are just how the loop expresses its intelligence."
- "Loopwright doesn't just make your agents smarter. It makes them 5x cheaper to run."
- "Built by three agents in parallel. Bug found live. Fixed in the same session."

---

## The One Sentence That Explains Everything

*"Your agents remember what they built — and the longer they run, the smarter they get."*

---

*Extracted from SESSION_CONTEXT_TRANSFER.md and SESSION_HANDOFF.md — February 2026*
