# Day 5 Plan — 2026-03-03

## Pre-work: Wire Up Engram Auto-Sync Hook

Engram already has auto-sync built (PR #3, commit `b20ad4b`, merged to `main`).
Just needs to be installed:

```bash
cd ~/Desktop/development/engram
git checkout main
engram hooks install --auto-brief
```

This adds a `SessionStart` hook that runs `engram install --quiet` + `engram brief --slim`
before each session. Every session starts with all previous sessions indexed.

**Note:** Engram has 6 stashes to manage:
- stash@{0}: pre-codex-loop: vector_search (feat/semantic-search)
- stash@{1}: pre-codex-loop: dirty brief changes (feat/semantic-search)
- stash@{2}: stash remaining brief changes (main)
- stash@{3}: stash uncommitted structured-brief work (feat/semantic-search)
- stash@{4}: fts5-sanitize-fix (main)
- stash@{5}: WIP on day2-claude

---

## Prompt 1 — Loopwright: Three fixes in loop.ts

Paste into Claude Code in the Loopwright repo.

```
Three focused fixes in loop.ts. Do them in order. Run bun test after each.

Fix 1 — Atomic prompt:
The agent confabulates when the prompt is too long. Before spawning,
truncate the task to the first concrete action only. Max 50 words,
one action verb (add/edit/delete/move). Put the full task in CLAUDE.md
under "# Full Task" section. Put the atomic instruction as the spawn prompt.

Fix 2 — Pre-approve engram permissions:
Before spawning, write .claude/settings.json into the worktree:
{
  "permissions": {
    "allow": [
      "Bash(engram search*)",
      "Bash(engram brief*)",
      "Bash(pytest*)",
      "Bash(bun test*)"
    ]
  }
}
This prevents headless agents from hanging on permission prompts.

Fix 3 — Measurement tracking:
Write this header into CLAUDE.md before spawn:

  TASK_ID: {uuid}
  STARTED_AT: {timestamp}
  METRIC: tool_calls / files_changed / tests_passed
  TASK: {atomic instruction}

  ## Record when done:
  - tool_calls_made:
  - files_changed:
  - tests_passed:
  - tests_failed:
  - unexpected_behaviors:

After agent exits: read CLAUDE.md, extract the "Record when done" section,
write it to correction_cycles.agent_context in the DB.

Verify: bun test (38 tests pass). Then run one loop on engram repo:

bun run src/loop.ts "Add docstring to format_cycle_summary in correction_brief.py" \
  ~/Desktop/development/engram sessions.db main

Success: dashboard shows full sequence, CLAUDE.md has filled-in measurements,
correction_cycles.agent_context has the data.
```

---

## Prompt 2 — Engram: Natural search trigger

Paste into Claude Code in the Engram repo OR add to global CLAUDE.md.

```
Add a natural language trigger pattern to Engram's UserPromptSubmit hook.

When the user says any of these phrases:
- "we already figured this out"
- "we did this before"
- "we solved this"
- "how did we do X"
- "what was the command for"
- "find how we"

The hook should automatically run engram_search with the key nouns
from the phrase and inject the top 3 results into the context
before the agent responds.

Implementation:
1. In the UserPromptSubmit hook, check if the user message matches
   any trigger pattern (simple substring match, no regex needed)
2. If match: extract nouns (split on spaces, filter stopwords,
   take words >4 chars)
3. Run: engram search "{nouns joined by space}" --limit 3
4. Prepend results to additionalContext as:
   "--- Engram: Prior sessions on this topic ---\n{results}\n---"

Test: say "we already figured out how to run headless agents"
Expected: hook fires, surfaces session 107fbbe6, injects cursor-agent command.

Success: the phrase triggers search without manually typing engram search.
```

---

## After Both Fixes Run

Run the loop once with measurement tracking enabled.
The CLAUDE.md will have filled-in metrics.
That's Case Study #5 — first measured autonomous correction cycle.

Screenshot the dashboard sequence + the filled CLAUDE.md.
That's the content for Thursday's post.

---

## Pending: Codex Loop Test

Runner script is ready at `run-structured-brief.ts`:
- Task: Add `session_count(project=None)` to SessionDB + test
- Agent: codex (fixed spawner commands in commit `e3e6feb`)
- Engram must be on `main` with clean working dir

## Pending: Case Studies

Two case studies to write (need data-backed proof):
- `engram/docs/experiments/006-natural-engram-search-mid-task.md`
- `engram/docs/experiments/007-web-plus-engram-combined-search.md`

The sessions will be indexed after `engram hooks install --auto-brief` is active.
Run `engram search "codex cursor agent"` and `engram search "graph RAG knowledge"`
to find the proof data from tonight's session.
