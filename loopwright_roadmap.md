# Loopwright

**Autonomous CI/CD with Self-Correcting Agents**

*Product Roadmap & Vision — February 2026*

---

## Vision

Loopwright is a self-correcting autonomous CI/CD system. Instead of running static pipelines that fail and wait for a human, Loopwright runs agents that write, test, observe their own failures, checkpoint, and try again — until the code ships or escalates to a human.

The mental model: git worktrees as isolated sandboxes, LangGraph-style checkpointing for rollback, progressive testing from delta to full system, and A/B validation against real users before merge.

It is not a tool that helps developers move faster. It is infrastructure that ships features autonomously.

## The Problem

Current CI/CD pipelines are deterministic and passive. They run tests, find failures, and stop. A human must interpret the failure, fix the code, and push again. Every failure is a context switch.

AI agents change this equation — but today's agent tooling has no feedback loop. An agent writes code, tests fail, and the session ends. The agent has no memory of what it tried. The next session starts cold.

The result is the Christmas Eve problem: an agent burns 426 messages, hits 76 errors, produces zero output, and nobody knows until after. That is money wasted and trust lost.

## The Loop

Loopwright implements a closed feedback cycle:

| Phase | Description |
|-------|-------------|
| **1. Task** | Agent receives ticket/feature request. Axon provides blast radius before first write. Engram injects session history — what failed here before. |
| **2. Build** | Agent works in isolated git worktree. No risk to main branch. OpenClaw tracks every file touch and tool call in real time. |
| **3. Test** | Delta tests run first (only what changed). Then integration tests against a replica of main. Fast feedback, low noise. |
| **4. Observe** | If tests fail: capture full error context via MCP — browser console, MySQL logs, AWS CloudWatch. Agent sees exactly what broke. |
| **5. Checkpoint** | LangGraph-style checkpoint saved at last known good state. If correction fails, rollback is instant. No lost work. |
| **6. Correct** | New agent spawned with failure context injected. It knows what was tried, what broke, what the blast radius is. Self-corrects. |
| **7. Validate** | On pass: deploy to staging. A/B test against real users. PostHog/analytics MCP reads behavior metrics. |
| **8. Ship** | If metrics hold: merge to main automatically. If metrics drop: rollback to checkpoint, escalate to human. |

## Differentiation

### vs Proliferate

- Proliferate runs agents in their cloud sandboxes. Loopwright runs in git worktrees on your own infrastructure.
- Proliferate is reactive: Sentry fires, agent responds. Loopwright is a full loop: agent writes, tests, corrects, ships.
- Proliferate has no self-correction. If the agent fails, it fails. Loopwright checkpoints and retries with failure context.
- Loopwright has no cloud compute cost. Worktrees are free. You run on your own hardware.

### vs GitHub Actions

- Actions is static and deterministic. It runs the same pipeline every time. Loopwright adapts based on what broke.
- Actions requires a human to interpret failures and push fixes. Loopwright closes the loop autonomously.
- Actions has no agent memory. Loopwright knows what failed in previous runs and avoids repeating it.

### vs Factory.ai Droids

- Factory works on tickets — single agent, single task. Loopwright is infrastructure — continuous loop across all tasks.
- Factory has no checkpoint/rollback system. Loopwright can roll back to any prior good state instantly.
- Factory has no progressive testing layer. Loopwright tests delta first, then system, then validates with real users.

## Technical Stack

Loopwright is built on components that already exist:

| Component | Role |
|-----------|------|
| **Git Worktrees** | Isolated execution environments. Zero infrastructure. Native git, runs locally. |
| **Engram (sessions.db)** | Session history and failure memory. Agent knows what failed before it writes a line. |
| **OpenClaw** | Live cross-agent tracking. Which files each agent touched, in real time. |
| **Axon (MCP)** | Blast radius before any change. Static codebase intelligence informs the agent's risk surface. |
| **Bun** | The orchestration runtime. Event loop handles N concurrent agents natively via `spawn()`. `better-sqlite3` reads sessions.db synchronously. Same JS ecosystem as OpenClaw. |
| **LangGraph** | Checkpoint and rollback. Every correction cycle has a recoverable prior state. |
| **MCP Tools** | Error observation layer. Browser console, MySQL, AWS logs — agent sees what actually broke. |
| **PostHog MCP** | A/B validation. Agent reads real user behavior metrics before approving merge. |

## Milestones

### Milestone 1 — The Loop Exists Locally

**Target: 4 weeks.** This is the demo.

- Worktree → test → error capture → new agent with context — working end to end
- Engram stores checkpoint state in sessions.db alongside artifact history
- OpenClaw dashboard shows correction cycles live
- Runs on monra-app. Real failures, real corrections.
- No staging integration yet. No A/B testing. Just the self-correction cycle.

### Milestone 2 — Staging Integration

**Target: 8 weeks.** This is what enterprises see.

- Automatic deploy to staging on test pass
- Rollback to checkpoint on staging failure
- MCP tools for browser, MySQL, AWS logs wired into correction loop
- Max iteration limit — escalate to human after N failures
- Session forensics: full audit trail of every correction cycle

### Milestone 3 — Full CI/CD Replacement

**Target: 16 weeks.** This is the product.

- A/B testing on staging against real users
- PostHog MCP reads metrics — agent decides merge vs rollback
- Progressive rollout: delta → integration → staging → production
- Team dashboard: what is every agent doing right now, what shipped this week
- Self-hosted deployment package with license

## Business Model

### Pricing

**Usage-based on successful merges.** Not seats, not tokens — outcomes. An agent ran 4 correction cycles and shipped a feature? That is a billable event. Aligns incentives: charge only when it works.

**Self-hosted license for enterprises.** Docker compose deployment, annual license. Code never leaves their network. Compliance-friendly by design.

**Open source core** — the loop logic, the Engram data layer, the worktree orchestration. Paid for managed cloud deployment and enterprise support.

### Why It Is Sustainable

- No cloud compute cost. Runs on customer infrastructure. Margin is high.
- Outcome-based pricing means customers pay when they get value. Sales objection handled.
- Self-hosted model unlocks regulated industries — fintech, healthcare, government. Largest budgets, least competition.
- Open source distribution through developer community. No sales team needed to reach first 1,000 users.
- Engram's session data compounds over time. The longer a team runs it, the better the correction loop gets. Lock-in without lock-in.

## Relationship to Engram and OpenClaw

Loopwright is not a separate product from Engram and OpenClaw. It is what they are building toward.

| Product | Role in the stack |
|---------|-------------------|
| **Engram** | The memory layer. sessions.db stores artifact history, failure patterns, and checkpoint state. Loopwright reads from it before every correction cycle. |
| **OpenClaw** | The observability layer. Live cross-agent tracking, session replay, multi-worktree dashboard. Loopwright's control plane. |
| **Loopwright** | The execution layer. Built in Bun/TypeScript. Orchestrates the correction loop. Uses Engram's memory and OpenClaw's visibility to close the feedback cycle. The event loop *is* the loop controller. |

One SQLite file. Three interfaces. The file compounds over time and any tool can read it. File over app — the data is the product.

## Continuous Intelligence

The phrase that keeps coming up is *continuous intelligence*. Here is what it means precisely in this context:

- Every correction cycle adds a row to sessions.db. The next agent starts with that history.
- Failure patterns accumulate. After 10 correction cycles on `handlers.ts`, the agent knows to check the co-change cluster before touching it.
- The brief gets smarter over time — not from global training data but from your codebase specifically.
- Opt-in anonymous telemetry sends aggregated pattern signals: error rate distributions, correction cycle counts, session durations. No code, no content.

The intelligence is local first. Your codebase's failure history is yours. The loop gets smarter because of what it has seen on your code — not because of what happened on someone else's.

---

*Loopwright — February 2026*
