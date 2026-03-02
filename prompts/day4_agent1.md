You are working on Loopwright, an autonomous CI/CD system with self-correcting agents.

YOUR TASK: Build the correction brief generator — the intelligence that tells a new agent exactly what went wrong and what to try next.

CONTEXT:
- Day 3 delivered: idle detection, test runner, structured error capture in correction_cycles
- When tests fail, a correction_cycle row exists with error_context JSON
- A new agent needs to be spawned with full knowledge of: what was tried, what broke, what the blast radius is
- The brief is the single most important piece — it's what makes correction cycles actually work

BUILD:

1. engram/correction_brief.py — The correction brief generator
   - generate_correction_brief(correction_cycle_id, db_path):
     * Read the correction_cycle row: trigger_error, error_context, cycle_number
     * Read the checkpoint it's based on: git_sha, test_results, artifact_snapshot
     * Read the worktree: task_description, branch_name
     * Read prior correction cycles for this worktree (if cycle_number > 1): what was already tried
     * Query Engram's session history: has this file/error pattern appeared before?
     * Build the brief as structured markdown:

       ## Correction Cycle {N} for: {task_description}

       ### What Failed
       {trigger_error}

       ### Error Details
       {structured error: file, line, type, message, stack trace}

       ### What Was Already Tried
       {list of prior correction cycles and their outcomes}

       ### Checkpoint State
       Based on commit {git_sha}. Files modified since base: {list}

       ### Graph Delta (from Noodlbox)
       Changed symbols: {list of functions/classes modified}
       Impacted callers: {what calls those symbols — the causal chain}
       Affected communities: {which functional modules are disrupted}
       Disrupted processes: {which execution flows are broken}
       → "You changed {symbol}, which is called by {caller}, and {caller} broke because {error}"

       ### Historical Context (from Engram)
       {similar errors from past sessions, what fixed them}

       ### Constraints
       - Do NOT repeat: {list of approaches that already failed}
       - Max correction cycles remaining: {max - current}
       - If you cannot fix this, explain why so the human can take over

     * Return the brief as a string

   - inject_correction_brief(worktree_path, brief_content):
     * Write to worktree's CLAUDE.md (append, don't overwrite)
     * Also write to a dedicated .loopwright/correction_brief.md in the worktree
     * Record the injection in sessions.db

2. engram/history_query.py — Query past failures
   - find_similar_errors(file_path, error_type, db_path):
     * Search correction_cycles for similar trigger_error patterns
     * Use FTS if available, fallback to LIKE queries
     * Return: what fixed it last time, how many cycles it took
   - find_file_failure_history(file_path, db_path):
     * All correction cycles that touched this file
     * Frequency, common error types, average cycles to resolution
     * This is the "continuous intelligence" — the loop gets smarter over time

TESTING:
- Test brief generation with mock correction_cycle data
- Test history queries with multiple past correction cycles
- Test that the brief includes "do not repeat" constraints from prior cycles
- Test injection: brief appears in worktree CLAUDE.md

Commit to engram repo.