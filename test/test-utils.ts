import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanupDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

export async function runCmd(cwd: string, cmd: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
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
  return { exitCode, stdout, stderr };
}

export async function runCmdOrThrow(cwd: string, cmd: string[]): Promise<string> {
  const result = await runCmd(cwd, cmd);
  if (result.exitCode !== 0) {
    throw new Error(`Command failed: ${cmd.join(" ")}\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

export async function createTempGitRepo(): Promise<string> {
  const repoPath = makeTempDir("loopwright-repo-");
  await runCmdOrThrow(repoPath, ["git", "init"]);
  await runCmdOrThrow(repoPath, ["git", "checkout", "-b", "main"]);
  await runCmdOrThrow(repoPath, ["git", "config", "user.email", "test@example.com"]);
  await runCmdOrThrow(repoPath, ["git", "config", "user.name", "Loopwright Test"]);
  writeFileSync(join(repoPath, "README.md"), "# temp repo\n", "utf8");
  await runCmdOrThrow(repoPath, ["git", "add", "README.md"]);
  await runCmdOrThrow(repoPath, ["git", "commit", "-m", "init"]);
  return repoPath;
}

export async function createBranchCommit(repoPath: string, branch: string, fileName: string, content: string): Promise<void> {
  await runCmdOrThrow(repoPath, ["git", "checkout", "main"]);
  await runCmdOrThrow(repoPath, ["git", "checkout", "-B", branch]);
  writeFileSync(join(repoPath, fileName), content, "utf8");
  await runCmdOrThrow(repoPath, ["git", "add", fileName]);
  await runCmdOrThrow(repoPath, ["git", "commit", "-m", `update ${branch}`]);
}
