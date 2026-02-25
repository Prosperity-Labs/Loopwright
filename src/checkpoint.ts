import { openLoopwrightDb } from "./db.ts";

export interface CreateCheckpointResult {
  checkpoint_id: number;
  git_sha: string;
  changed_files: string[];
}

async function runCommand(cwd: string, cmd: string[]): Promise<{ stdout: string; stderr: string }> {
  const proc = Bun.spawn({
    cmd,
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  if (exitCode !== 0) {
    throw new Error(`Command failed (${cmd.join(" ")}): ${stderr.trim() || stdout.trim()}`);
  }

  return { stdout, stderr };
}

function parseChangedFiles(porcelain: string): string[] {
  const files = new Set<string>();
  for (const rawLine of porcelain.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    const pathPart = line.slice(3);
    const renamedSplit = pathPart.split(" -> ");
    files.add((renamedSplit[1] ?? renamedSplit[0])!.trim());
  }
  return [...files].sort();
}

export async function create_checkpoint(
  worktree_path: string,
  worktree_id: number,
  db_path: string,
  repo_name: string,
): Promise<CreateCheckpointResult> {
  const [{ stdout: gitShaStdout }, { stdout: branchStdout }, { stdout: statusStdout }] = await Promise.all([
    runCommand(worktree_path, ["git", "rev-parse", "HEAD"]),
    runCommand(worktree_path, ["git", "rev-parse", "--abbrev-ref", "HEAD"]),
    runCommand(worktree_path, ["git", "status", "--porcelain=v1"]),
  ]);

  const git_sha = gitShaStdout.trim();
  const branch_name = branchStdout.trim() || "unknown";
  const changed_files = parseChangedFiles(statusStdout);

  const db = openLoopwrightDb(db_path);
  try {
    db.upsertWorktree({
      id: worktree_id,
      branch_name,
      task_description: repo_name,
    });

    const checkpoint_id = db.insertCheckpoint({
      worktree_id,
      git_sha,
      graph_delta: {
        repo_name,
        branch_name,
        changed_files,
        status_porcelain: statusStdout,
      },
    });

    return { checkpoint_id, git_sha, changed_files };
  } finally {
    db.close();
  }
}

export async function rollback_to_checkpoint(
  worktree_path: string,
  checkpoint_id: number,
  db_path: string,
): Promise<void> {
  const db = openLoopwrightDb(db_path);
  try {
    const checkpoint = db.getCheckpointById(checkpoint_id);
    if (!checkpoint) {
      throw new Error(`Checkpoint not found: ${checkpoint_id}`);
    }
    if (!checkpoint.git_sha) {
      throw new Error(`Checkpoint ${checkpoint_id} has no git_sha`);
    }

    await runCommand(worktree_path, ["git", "checkout", checkpoint.git_sha]);
  } finally {
    db.close();
  }
}

export function list_checkpoints(worktree_id: number, db_path: string) {
  const db = openLoopwrightDb(db_path);
  try {
    return db.listCheckpoints(worktree_id);
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const [command, ...rest] = Bun.argv.slice(2);

  if (command === "create") {
    const [worktreePath, worktreeId, dbPath, repoName] = rest;
    if (!worktreePath || !worktreeId || !dbPath || !repoName) {
      console.error("Usage: bun run src/checkpoint.ts create <worktreePath> <worktreeId> <dbPath> <repoName>");
      process.exit(1);
    }
    const result = await create_checkpoint(worktreePath, Number(worktreeId), dbPath, repoName);
    console.log(JSON.stringify(result, null, 2));
  } else if (command === "rollback") {
    const [worktreePath, checkpointId, dbPath] = rest;
    if (!worktreePath || !checkpointId || !dbPath) {
      console.error("Usage: bun run src/checkpoint.ts rollback <worktreePath> <checkpointId> <dbPath>");
      process.exit(1);
    }
    await rollback_to_checkpoint(worktreePath, Number(checkpointId), dbPath);
    console.log(`Rolled back to checkpoint ${checkpointId}`);
  } else if (command === "list") {
    const [worktreeId, dbPath] = rest;
    if (!worktreeId || !dbPath) {
      console.error("Usage: bun run src/checkpoint.ts list <worktreeId> <dbPath>");
      process.exit(1);
    }
    console.log(JSON.stringify(list_checkpoints(Number(worktreeId), dbPath), null, 2));
  } else {
    console.error("Usage: bun run src/checkpoint.ts <create|rollback|list> ...");
    process.exit(1);
  }
}
