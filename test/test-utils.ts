import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function createBunTestRepo(kind: "pass" | "fail"): Promise<string> {
  const repo = await createTempGitRepo();

  writeFileSync(join(repo, "bunfig.toml"), "[test]\n", "utf8");
  writeFileSync(
    join(repo, "math.test.ts"),
    kind === "pass"
      ? `import { expect, test } from "bun:test";\n\ntest("math", () => {\n  expect(1 + 1).toBe(2);\n});\n`
      : `import { expect, test } from "bun:test";\n\ntest("math", () => {\n  expect(1 + 1).toBe(3);\n});\n`,
    "utf8",
  );

  await runCmdOrThrow(repo, ["git", "add", "bunfig.toml", "math.test.ts"]);
  await runCmdOrThrow(repo, ["git", "commit", "-m", `add ${kind} test`]);
  return repo;
}

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

/** Create a test repo with a SQLite database file for snapshot testing */
export async function createBunTestRepoWithDB(kind: "pass" | "fail"): Promise<string> {
  const repo = await createBunTestRepo(kind);

  // Add a SQLite database file
  const { Database } = await import("bun:sqlite");
  const dbPath = join(repo, "app.db");
  const db = new Database(dbPath);
  db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)");
  db.exec("INSERT INTO items (name) VALUES ('test-item')");
  db.close();

  await runCmdOrThrow(repo, ["git", "add", "app.db"]);
  await runCmdOrThrow(repo, ["git", "commit", "-m", "add app database"]);

  return repo;
}

/** Create a test repo with multiple test files for pool testing */
export async function createPoolTestRepo(kind: "pass" | "fail" = "pass"): Promise<string> {
  const repo = await createTempGitRepo();

  writeFileSync(join(repo, "bunfig.toml"), "[test]\n", "utf8");
  const assertion = kind === "pass" ? "toBe(2)" : "toBe(3)";
  writeFileSync(
    join(repo, "math.test.ts"),
    `import { expect, test } from "bun:test";\n\ntest("math", () => {\n  expect(1 + 1).${assertion};\n});\n`,
    "utf8",
  );
  writeFileSync(
    join(repo, "string.test.ts"),
    `import { expect, test } from "bun:test";\n\ntest("string", () => {\n  expect("hello".length).${kind === "pass" ? "toBe(5)" : "toBe(4)"};\n});\n`,
    "utf8",
  );

  await runCmdOrThrow(repo, ["git", "add", "."]);
  await runCmdOrThrow(repo, ["git", "commit", "-m", `add ${kind} tests`]);
  return repo;
}
