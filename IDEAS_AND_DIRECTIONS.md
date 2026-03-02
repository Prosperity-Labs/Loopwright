# Ideas, Directions & Captured Thinking
*Running document — add to this, never delete*

---

## RAG Workflow Optimization — Product Idea ⭐⭐⭐

**The idea:**
Identify recurring agent workflows → test them → store optimized versions → instruct model to use optimized version in future.

**How Engram enables this:**
sessions.db already captures every workflow pattern. The identification step is already done — Engram sees which sequences of tool calls succeed vs fail, which file patterns recur, which task types always take the same shape.

The missing pieces:
1. Workflow extraction: cluster sessions by task type and tool call sequence
2. Optimization: A/B test variants (already have the A/B infrastructure)
3. Storage: optimized workflow → sessions.db as a "verified pattern"
4. Injection: before agent starts on a task, Engram recognizes the task type and injects the optimized workflow pattern into the brief

**Why it's elegant:**
Simple loop. Identify → test → store → instruct. No fine-tuning. No model changes. Pure prompt/context engineering that compounds over time on your specific workflows.

**The product frame:**
"Workflow memory. Your agents don't just remember what they built — they remember the best way to build it."

**Tags:** #business #idea #direction
**Repos:** Engram (identification + storage) + Loopwright (injection at spawn time)
**Milestone:** Post Milestone 1 — build after first loop runs

---

## OpenClaw + Engram Combined Product Direction

**The question:** Are these two separate products or one?

**Current answer:** Three products sharing one SQLite file.
- Engram = memory (what happened)
- OpenClaw = observation (watching it happen)
- Loopwright = orchestration (making it happen correctly)

**The combined pitch:**
"One file. Three interfaces. Your codebase's complete institutional memory."

**Tags:** #business #idea #direction

---

## Content Ideas — Claude's Recommendations

Seven article ideas. Every one is field reports, not speculation. That's the differentiator.

### 1. "I Ran 200+ AI Agent Sessions. Here's What I Found in the Data."
Engram indexes all of it. Nobody else has this dataset.
- Which tasks succeed vs fail?
- Where do agents waste tokens?
- Distribution of tool calls
- The 38% burn session finding
- The Christmas Eve disaster pattern
Original research nobody else can write right now.

### 2. "The $2,400/month Solo Dev Running 6 Products From Belgrade"
The real economics story.
- How you route Opus vs Haiku vs local models
- Actual monthly AI spend
- How you compete with funded teams running lean from Serbia
- Mac Studio grant math
People are desperate for honest numbers.

### 3. "21,000 Nodes: What Happens When You Turn Every Work Session Into a Knowledge Graph"
Not how to build it — what changes when you live inside one.
- Do you make better decisions?
- Can you find things faster?
- Has it changed how you think?
Personal transformation story with technical backbone.

### 4. "From 5 Days to 30 Minutes: What Construction Companies Don't Know About AI"
Best sales asset disguised as content.
Specific, measurable, boring-industry transformation.
The post that lands enterprise clients.

### 5. "Agents Don't Need to Be Smart. They Need to Be Correct."
The deposit verification insight.
Using agents for continuous correctness checking, not task automation.
Contrarian take in a space full of "look how smart my agent is" content.
SQL query → agent loop → dashboard pattern. Reusable across every industry.

### 6. "I Built the Coordination Layer Before the Agents"
The OpenClaw thesis.
Everyone's building agents. Nobody's building the thing that keeps them from colliding.
"Great management" framing.
The one that gets quoted.

### 7. "The Agent Didn't Know. Engram Did."
The headless agent case study.
34 seconds. Exact flags from last successful run.
Web search gives documentation. Engram gives what you actually did.

**The thread connecting all of them:**
You're not theorizing. You're running the experiment on yourself, daily, with real data.
Most AI content is speculation. Yours is field reports.

---

## Positioning Statement (Working Version)

"Use a persistent AI agent to extract insights from your work, research what's possible, build things, and push into increasingly fundamental layers — from software, to infrastructure, to hardware."

This is the north star direction. Not just "AI coding tool." A system that compounds intelligence across every layer of building — from the code itself up through architecture, infrastructure, and eventually hardware.

The Loopwright stack is the software layer of this.
OpenClaw is the observability layer.
Engram is the memory that makes it all compound.

---

## Replay Engine — Claude's Optimism

Filed for reference: Claude (previous session) was optimistic about the replay engine's potential beyond just "watch the movie again."

The untapped value in replay:
- Automated metrics extraction from replayed sessions
- Cross-run comparison: diff two correction cycles side by side
- Pattern detection: which replay sequences predict success vs failure
- Training data: replayed sessions as labeled examples for workflow optimization (connects to RAG idea above)

The replay data is already there in events.jsonl. The question is what to do with it beyond visualization.

**Milestone 3 territory** — but worth designing now so the event schema captures what replay analysis will need.

---

## Filing Instructions

When you find a new idea, player, or direction:
1. Add it to this document with date and tags
2. Add players to the Ecosystem Map in SESSION_CONTEXT_TRANSFER.md
3. Add content ideas to content_ideas.md with priority
4. If it affects the build: add to loopwright_roadmap_v2.docx

Tags to use:
- #business — revenue or market opportunity
- #idea — product feature or direction
- #direction — strategic positioning
- #content — article or post idea
- #contact — person to reach out to
- #dependency — tool or product to integrate
- #risk — something that could go wrong

---

*Last updated: March 2026*
*Never delete from this document — add and date instead*
