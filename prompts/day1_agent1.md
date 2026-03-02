You are working on Loopwright, an autonomous CI/CD system with self-correcting agents.

YOUR TASK: Extend sessions.db with 3 new tables and set up git hooks for worktree monitoring.

CONTEXT:
- Engram's sessions.db is at: (find it in the engram repo)
- Schema is managed in engram/session_db.py
- Existing tables: sessions, artifacts, tool_calls
- You need to ADD (not replace) three new tables

NEW TABLES TO ADD:

1. worktrees
   - id INTEGER PRIMARY KEY
   - session_id TEXT (FK to sessions)
   - branch_name TEXT
   - base_branch TEXT (usually 'main')
   - status TEXT (active | passed | failed | escalated | merged)
   - task_description TEXT
   - created_at TIMESTAMP
   - resolved_at TIMESTAMP (null until terminal state)

2. checkpoints
   - id INTEGER PRIMARY KEY
   - worktree_id INTEGER (FK to worktrees)
   - session_id TEXT (FK to sessions)
   - git_sha TEXT (commit hash at checkpoint time)
   - test_results JSON
   - artifact_snapshot JSON (files written up to this point)
   - graph_delta JSON (Noodlbox impact analysis: changed symbols, impacted callers, affected communities, disrupted processes)
   - created_at TIMESTAMP
   - label TEXT (optional, e.g. 'after auth fix')

3. correction_cycles
   - id INTEGER PRIMARY KEY
   - worktree_id INTEGER (FK to worktrees)
   - cycle_number INTEGER (1, 2, 3… up to max)
   - trigger_error TEXT
   - error_context JSON (browser logs, DB errors, AWS logs)
   - checkpoint_id INTEGER (FK to checkpoints — which checkpoint was base)
   - agent_session_id TEXT (the new agent session spawned)
   - outcome TEXT (passed | failed | escalated)
   - duration_seconds INTEGER
   - created_at TIMESTAMP

ALSO BUILD:
- A migration script that safely adds these tables to an existing sessions.db
- Git hook templates: post-commit hook that writes a checkpoint row to sessions.db (git_sha from HEAD, artifact_snapshot from git diff --name-only)
- Git hook template: pre-commit hook that captures the current diff as a snapshot
- Helper functions in Python: create_worktree(), create_checkpoint(), create_correction_cycle(), get_latest_checkpoint()
- Verify FTS indexing works on new tables
- Write tests that create a sessions.db, run migration, insert rows, query them back

DO NOT modify existing tables. Only add new ones.
The migration must be idempotent — safe to run multiple times.

When done, commit to the engram repo with a clear message about what was added.