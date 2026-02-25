# Loopwright — Sprint 1 Execution Plan

**Created:** 2026-02-24
**Status:** Planning
**Goal:** Build the orchestration layer that makes Loopwright autonomous — one week of focused building.

---

## Overview

Two Claude Code instances (Agent 1 with Engram, Agent 2 without) executing Sprint 1 (Revised) from the detailed roadmap. Each day has clear deliverables, dependency chains are sequential across days but parallel within each day.

---

## Phase 1: Schema Extension + Event Bridge (Day 1)
**Status:** Not Started
**Depends on:** Nothing — this is the foundation

### Agent 1 (with Engram) — Schema Migration
- [ ] Add `worktrees` table to sessions.db
- [ ] Add `checkpoints` table to sessions.db
- [ ] Add `correction_cycles` table to sessions.db
- [ ] Write migration script in Engram's `session_db.py`
- [ ] Verify Engram reads/writes correctly to new tables
- [ ] Test FTS indexing on new tables

### Agent 2 (without Engram) — Event Bridge
- [ ] Parse OpenClaw's `events.jsonl` format
- [ ] Build `events.jsonl` → sessions.db bridge script
- [ ] Wire OpenClaw events into Engram's database with indexing
- [ ] Verify events flow end-to-end: OpenClaw → JSONL → sessions.db

### Deliverable
- sessions.db extended with 3 new tables
- Event bridge flowing from OpenClaw → sessions.db
- Migration passes

---

## Phase 2: Scripted A/B Runner (Day 2)
**Status:** Not Started
**Depends on:** Phase 1 (schema + event bridge must work)

### Agent 1 — A/B Orchestration Logic
- [ ] Script to launch same prompt in two worktrees simultaneously
- [ ] Capture agent results into sessions.db (using new schema)
- [ ] Track worktree status (active → passed/failed)

### Agent 2 — A/B Comparison Output
- [ ] Structured diff/report generation from captured results
- [ ] Comparison metrics: files touched, errors hit, time taken
- [ ] Output format readable by both humans and future loop controller

### Deliverable
- Repeatable A/B runs
- Results stored in sessions.db
- No more eyeballing — automated comparison

---

## Phase 3: Test Runner Integration (Day 3)
**Status:** Not Started
**Depends on:** Phase 2 (A/B runner provides the execution context)

### Agent 1 — Test Runner + Error Parsing
- [ ] Detect agent idle from OpenClaw event stream
- [ ] Run tests scoped to delta files (changed files only)
- [ ] Parse pytest/jest stdout into structured errors
- [ ] Extract file:line, error type, message

### Agent 2 — correction_cycles Writer
- [ ] Take parsed errors from test runner
- [ ] Write structured rows to `correction_cycles` table
- [ ] Include: trigger_error, error_context JSON, cycle_number
- [ ] Verify data is queryable for correction spawner (Day 4)

### Deliverable
- Test results appear in correction_cycles with structured errors
- Agent idle detection working
- Delta test scoping functional

---

## Phase 4: Correction Spawner (Day 4)
**Status:** Not Started
**Depends on:** Phase 3 (needs structured errors in correction_cycles)

### Agent 1 — Correction Spawner Core
- [ ] Build `loopwright/corrector.ts`
- [ ] Read error from correction_cycles table
- [ ] Build injection brief: last checkpoint + error context + what was tried
- [ ] Launch new agent in same worktree with injection brief

### Agent 2 — Brief Injection Wiring
- [ ] Wire Engram's `brief.py` to inject context into worktree CLAUDE.md
- [ ] Include blast radius data in injection brief
- [ ] Test that spawned agent receives full correction context

### Deliverable
- `loopwright/corrector.ts` functional
- First correction cycle runs end to end
- Agent spawns with full error context

---

## Phase 5: Loop Controller + Real Task (Day 5)
**Status:** Not Started
**Depends on:** Phase 4 (correction spawner must work)

### Agent 1 — Loop Controller
- [ ] Build `loopwright/loop.ts`
- [ ] Orchestrate: spawn → test → checkpoint → correct → repeat (Bun event loop handles N agents concurrently)
- [ ] Max cycles config (default: 3)
- [ ] Write final status to sessions.db (passed/failed/escalated)
- [ ] Escalation path when max cycles exceeded

### Agent 2 — Real Task Validation
- [ ] Pick a small real task on monra-app
- [ ] Run it through the full loop end to end
- [ ] Observe and document what works, what breaks
- [ ] Record results for Sprint 1 retrospective

### Deliverable
- End-to-end loop on a real monra-app task
- Task completes autonomously OR escalates cleanly
- Sprint 1 complete

---

## Open Decisions (Resolve During Sprint)

| Decision | Current Leaning |
|----------|----------------|
| ~~Loop orchestrator language~~ | ✅ **Decided: Bun/TypeScript.** Event loop native. Matches OpenClaw. `better-sqlite3` for sessions.db. `spawn()` for parallel agents. |
| LangGraph vs custom checkpointing | Custom first in sessions.db |
| Max correction cycles default | 3, configurable per task type |
| Agent identity in worktrees | Same agent, different context injection |
| Test scope detection | Axon impact analysis for blast radius |
| Worktree cleanup | Keep 30 days, then archive + delete |

---

## Repos Involved

| Repo | Role | Path |
|------|------|------|
| **Engram** | Memory layer — sessions.db, briefs, artifacts | `/home/prosperitylabs/Desktop/development/engram` |
| **OpenClaw** | Observability — event store, dashboard, worktrees | (within monra.app or standalone) |
| **Loopwright** | Orchestration — new code lives here | `/home/prosperitylabs/Desktop/development/Loopwright` |
| **monra-app** | Test target — real task runs here on Day 5 | `/home/prosperitylabs/Desktop/development/monra.app` |
