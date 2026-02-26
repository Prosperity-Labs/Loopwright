import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  detectChangedFiles,
  parseBunTestErrors,
  parsePytestErrors,
  runTests,
} from "../src/test-runner.ts";
import { cleanupDir, createTempGitRepo, runCmdOrThrow } from "./test-utils.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) cleanupDir(tempDirs.pop()!);
});

async function initBunTestRepo(): Promise<string> {
  const repo = await createTempGitRepo();
  tempDirs.push(repo);

  writeFileSync(join(repo, "bunfig.toml"), "[test]\n", "utf8");
  writeFileSync(
    join(repo, "sum.test.ts"),
    `import { expect, test } from "bun:test";\n\ntest("sum", () => {\n  expect(1 + 1).toBe(2);\n});\n`,
    "utf8",
  );
  await runCmdOrThrow(repo, ["git", "add", "bunfig.toml", "sum.test.ts"]);
  await runCmdOrThrow(repo, ["git", "commit", "-m", "add bun test"]);
  return repo;
}

test("detectChangedFiles returns list of changed files from git diff", async () => {
  const repo = await createTempGitRepo();
  tempDirs.push(repo);

  writeFileSync(join(repo, "feature.ts"), "export const x = 1;\n", "utf8");
  await runCmdOrThrow(repo, ["git", "checkout", "-b", "feature"]);
  await runCmdOrThrow(repo, ["git", "add", "feature.ts"]);
  await runCmdOrThrow(repo, ["git", "commit", "-m", "feat"]);
  writeFileSync(join(repo, "README.md"), "# changed\n", "utf8");

  const files = await detectChangedFiles(repo, "main");
  expect(files).toContain("feature.ts");
  expect(files).toContain("README.md");
});

test("runTests with a passing test returns passed true and no errors", async () => {
  const repo = await initBunTestRepo();
  writeFileSync(join(repo, "sum.test.ts"), `import { expect, test } from "bun:test";\n\ntest("sum", () => {\n  expect(2 + 2).toBe(4);\n});\n`, "utf8");

  const result = await runTests({ worktreePath: repo, timeout: 30_000 });
  expect(result.passed).toBe(true);
  expect(result.exit_code).toBe(0);
  expect(result.errors).toEqual([]);
  expect(result.changed_files).toContain("sum.test.ts");
  expect(result.test_command).toContain("bun test");
});

test("runTests with a failing test returns structured errors", async () => {
  const repo = await initBunTestRepo();
  writeFileSync(
    join(repo, "sum.test.ts"),
    `import { expect, test } from "bun:test";\n\ntest("sum", () => {\n  expect(2 + 2).toBe(5);\n});\n`,
    "utf8",
  );

  const result = await runTests({ worktreePath: repo, timeout: 30_000 });
  expect(result.passed).toBe(false);
  expect(result.exit_code).not.toBe(0);
  expect(result.errors.length).toBeGreaterThan(0);
  expect(result.errors[0]?.file).toContain("sum.test.ts");
});

test("Bun error output is parsed correctly", () => {
  const errors = parseBunTestErrors(
    "error: expect(received).toBe(expected)\n  at /tmp/foo.test.ts:42:5",
    "",
  );
  expect(errors).toEqual([
    {
      file: "/tmp/foo.test.ts",
      line: 42,
      type: "AssertionError",
      message: "expect(received).toBe(expected)",
    },
  ]);
});

test("Pytest error output is parsed correctly", () => {
  const errors = parsePytestErrors(
    "FAILED tests/test_foo.py::test_bar - TypeError: bad value",
    "",
  );
  expect(errors).toEqual([
    {
      file: "tests/test_foo.py",
      line: null,
      type: "TypeError",
      message: "bad value",
    },
  ]);
});
