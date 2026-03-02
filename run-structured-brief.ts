import { runLoop } from "./src/loop.ts";

const ENGRAM_REPO = "/home/prosperitylabs/Desktop/development/engram";
const ENGRAM_DB = "/home/prosperitylabs/.config/engram/sessions.db";
const LOOPWRIGHT_DB = "/home/prosperitylabs/Desktop/development/Loopwright/sessions.db";

// First concrete action only — focusPrompt will extract this.
// The full context goes in the system prompt (project brief).
const TASK_PROMPT = `Add a function _session_intent(db, project) to engram/brief.py that queries the first user message from the 3 most recent sessions. Then update generate_brief() markdown output to replace "## Overview" with "## Intent" using the new function. Update tests/test_brief.py to assert "## Intent" header.`;

const result = await runLoop({
  repoPath: ENGRAM_REPO,
  dbPath: LOOPWRIGHT_DB,
  engramDbPath: ENGRAM_DB,
  engramPath: ENGRAM_REPO,
  project: "-home-prosperitylabs-Desktop-development-engram",
  taskPrompt: TASK_PROMPT,
  baseBranch: "main",
  maxCycles: 3,
  // model: "sonnet",  // Sonnet describes changes as text instead of editing — use default (Opus)
});

console.log("\n" + "=".repeat(60));
console.log(`Loop finished: ${result.status}`);
console.log(`Cycles: ${result.totalCycles} | Duration: ${(result.duration_ms / 1000).toFixed(1)}s`);
console.log(`Worktree: ${result.worktreePath}`);
console.log(`Branch: ${result.branchName}`);
if (result.finalCheckpoint) {
  console.log(`Checkpoint: ${result.finalCheckpoint.git_sha}`);
}
for (const cycle of result.cycles) {
  const label = cycle.action === "initial" ? "Initial" : `Correction ${cycle.cycleNumber}`;
  const errors = cycle.testResult.errors.length;
  console.log(`  ${label}: ${cycle.passed ? "PASS" : "FAIL"} (${errors} errors, ${(cycle.duration_ms / 1000).toFixed(1)}s)`);
}
console.log("=".repeat(60));

process.exit(result.status === "passed" ? 0 : 1);
