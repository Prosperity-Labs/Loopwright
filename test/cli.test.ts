import { expect, test } from "bun:test";
import { parseCliArgs } from "../src/cli.ts";

test("parseCliArgs parses ab command", () => {
  const parsed = parseCliArgs([
    "ab",
    "--prompt",
    "fix the login validation",
    "--repo",
    "/tmp/repo",
    "--db",
    "/tmp/sessions.db",
    "--base-branch",
    "develop",
    "--cleanup",
  ]);

  expect(parsed).toEqual({
    kind: "ab",
    prompt: "fix the login validation",
    repo: "/tmp/repo",
    db: "/tmp/sessions.db",
    base_branch: "develop",
    cleanup: true,
  });
});

test("parseCliArgs parses compare command", () => {
  const parsed = parseCliArgs([
    "compare",
    "--worktree-a",
    "11",
    "--worktree-b",
    "12",
    "--repo",
    "/tmp/repo",
  ]);

  expect(parsed.kind).toBe("compare");
  if (parsed.kind !== "compare") return;
  expect(parsed.worktree_a_id).toBe(11);
  expect(parsed.worktree_b_id).toBe(12);
  expect(parsed.repo).toBe("/tmp/repo");
});

test("parseCliArgs throws when required args are missing", () => {
  expect(() => parseCliArgs(["ab", "--repo", "/tmp/repo"])).toThrow();
});
