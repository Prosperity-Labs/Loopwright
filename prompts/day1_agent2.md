You are working on Loopwright, an autonomous CI/CD system with self-correcting agents.

YOUR TASK: Build the events.jsonl → sessions.db bridge in Bun/TypeScript, plus a file watcher for worktree monitoring.

CONTEXT:
- OpenClaw writes agent events to events.jsonl (one JSON object per line)
- Engram's sessions.db stores session history and artifacts
- We need a bridge that reads events.jsonl and writes relevant data into sessions.db
- This is the first Bun/TypeScript code in the Loopwright repo

PROJECT SETUP:
- Working directory: /home/prosperitylabs/Desktop/development/Loopwright
- Already initialized with bun init — package.json and tsconfig.json exist
- IMPORTANT: Use `bun:sqlite` (built-in) instead of `better-sqlite3`. Remove better-sqlite3 from package.json.
- src/db.ts already exists but uses better-sqlite3 — migrate it to use `import { Database } from "bun:sqlite"` instead
- TypeScript strict mode

BUILD:

1. src/bridge.ts — The event bridge
   - Watch events.jsonl using Bun's file watcher (fs.watch or Bun.file)
   - Parse each new line as JSON
   - Route events to the correct sessions.db table:
     * tool_call events → tool_calls table
     * file_write events → artifacts table
     * session_start/end events → sessions table
   - Use bun:sqlite (built-in) for synchronous SQLite writes
   - Handle the case where events.jsonl doesn't exist yet (wait for it)
   - Handle malformed JSON lines gracefully (log and skip)

2. src/watcher.ts — Worktree file watcher
   - Accept a worktree path as argument
   - Use fs.watch (recursive) to detect file changes in the worktree
   - On file change: write an event to events.jsonl with:
     * timestamp
     * event_type: "file_change"
     * file_path (relative to worktree root)
     * change_type: "created" | "modified" | "deleted"
     * worktree_id (from config or arg)
   - Ignore .git directory, node_modules, __pycache__
   - This is the real-time monitoring layer — every file touch is recorded

3. src/checkpoint.ts — Custom checkpoint manager (no LangGraph)
   - create_checkpoint(worktree_path, worktree_id, db_path, repo_name):
     * Get current git SHA: Bun.spawn(['git', 'rev-parse', 'HEAD'])
     * Get changed files: Bun.spawn(['git', 'diff', '--name-only', 'HEAD~1'])
     * Get graph delta: call Noodlbox noodlbox_detect_impact(repository=repo_name) to capture:
       - changed_symbols: which functions/classes were modified
       - impacted_callers: what calls those symbols (the blast radius)
       - affected_communities: which functional modules are disrupted
       - disrupted_processes: which execution flows are broken
     * Store graph_delta as JSON in the checkpoint row
     * Write checkpoint row to sessions.db checkpoints table
     * Return checkpoint_id
   - rollback_to_checkpoint(worktree_path, checkpoint_id, db_path):
     * Read checkpoint row, get git_sha
     * Bun.spawn(['git', 'checkout', sha]) in the worktree
     * Update worktree status in sessions.db
     * Return success/failure
   - list_checkpoints(worktree_id, db_path):
     * Query checkpoints table, return ordered list

4. src/db.ts — Database helper (ALREADY EXISTS — needs migration from better-sqlite3 to bun:sqlite)
   - Open sessions.db with `import { Database } from "bun:sqlite"` (built-in, no npm package needed)
   - Prepared statements for common operations
   - Type-safe wrappers for each table
   - The existing file has all the schema, interfaces, and methods — just swap the import and adapt the API

TESTING:
- Create a test that: starts the bridge, writes a fake event to events.jsonl, verifies it appears in sessions.db
- Create a test that: creates a checkpoint, verifies the row, rolls back, verifies git state
- Create a test that: starts the watcher on a temp directory, creates a file, verifies the event was emitted

When done, commit to the Loopwright repo. This is the foundation of the orchestration layer.
