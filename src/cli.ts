import { join } from "node:path";
import { compareWorktrees } from "./ab-compare.ts";
import { cleanupABRunWorktrees, runABTest } from "./ab-runner.ts";

type CliCommand =
  | {
      kind: "ab";
      prompt: string;
      repo: string;
      db: string;
      base_branch: string;
      cleanup: boolean;
    }
  | {
      kind: "compare";
      worktree_a_id: number;
      worktree_b_id: number;
      repo: string;
      db: string;
    };

function readOption(args: string[], key: string): string | undefined {
  const index = args.indexOf(key);
  if (index === -1) return undefined;
  return args[index + 1];
}

function hasFlag(args: string[], key: string): boolean {
  return args.includes(key);
}

function requireValue(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing required option: ${name}`);
  return value;
}

export function parseCliArgs(argv: string[]): CliCommand {
  const [command, ...args] = argv;
  const cwd = process.cwd();
  const defaultDb = join(cwd, "sessions.db");

  if (command === "ab") {
    return {
      kind: "ab",
      prompt: requireValue(readOption(args, "--prompt"), "--prompt"),
      repo: readOption(args, "--repo") ?? cwd,
      db: readOption(args, "--db") ?? defaultDb,
      base_branch: readOption(args, "--base-branch") ?? "main",
      cleanup: hasFlag(args, "--cleanup"),
    };
  }

  if (command === "compare") {
    return {
      kind: "compare",
      worktree_a_id: Number(requireValue(readOption(args, "--worktree-a"), "--worktree-a")),
      worktree_b_id: Number(requireValue(readOption(args, "--worktree-b"), "--worktree-b")),
      repo: readOption(args, "--repo") ?? cwd,
      db: readOption(args, "--db") ?? defaultDb,
    };
  }

  throw new Error("Usage: bun run src/cli.ts <ab|compare> ...");
}

export async function runCli(argv: string[]): Promise<void> {
  const parsed = parseCliArgs(argv);

  if (parsed.kind === "ab") {
    const result = await runABTest({
      task_prompt: parsed.prompt,
      base_branch: parsed.base_branch,
      repo_path: parsed.repo,
      db_path: parsed.db,
    });
    console.log(JSON.stringify(result, null, 2));
    if (parsed.cleanup) {
      await cleanupABRunWorktrees(result);
    }
    return;
  }

  const comparison = await compareWorktrees({
    worktree_a_id: parsed.worktree_a_id,
    worktree_b_id: parsed.worktree_b_id,
    repo_path: parsed.repo,
    db_path: parsed.db,
  });
  console.log(comparison.markdown);
  console.log(JSON.stringify(comparison.json, null, 2));
}

if (import.meta.main) {
  try {
    await runCli(Bun.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
