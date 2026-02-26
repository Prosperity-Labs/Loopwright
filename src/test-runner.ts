import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";

export interface TestRunnerOptions {
  worktreePath: string;
  baseBranch?: string;
  testCommand?: string;
  timeout?: number;
}

export interface TestError {
  file: string;
  line: number | null;
  type: string;
  message: string;
}

export interface TestResult {
  passed: boolean;
  exit_code: number;
  test_command: string;
  changed_files: string[];
  errors: TestError[];
  stdout_tail: string;
  stderr_tail: string;
  duration_ms: number;
}

const DEFAULT_BASE_BRANCH = "main";
const DEFAULT_TIMEOUT_MS = 120_000;
const BUN_ERROR_RE = /at\s+(.+?):(\d+):\d+/;
const BUN_EXPECT_RE = /error:\s*(.+)/;
const PYTEST_FAIL_RE = /FAILED\s+(\S+?)::(\S+)\s*-\s*(\w+Error):\s*(.*)/g;
const PYTEST_E_LINE_RE = /^E\s+(\w+Error):\s*(.*)$/gm;

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function linesTail(text: string, maxLines = 50): string {
  const lines = text.split(/\r?\n/);
  return lines.slice(-maxLines).join("\n").trim();
}

async function runCommand(cwd: string, cmd: string[], timeoutMs: number): Promise<CommandResult> {
  const proc = Bun.spawn({
    cmd,
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      // no-op
    }
  }, timeoutMs);

  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    return {
      exitCode: timedOut ? (exitCode || 124) : exitCode,
      stdout,
      stderr,
      timedOut,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function splitCommand(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current)) {
      if (entry === ".git" || entry === "node_modules" || entry === ".venv" || entry === "__pycache__") continue;
      const full = join(current, entry);
      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        stack.push(full);
        continue;
      }
      out.push(full);
    }
  }
  return out;
}

function normalizePathList(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function detectFramework(worktreePath: string): "bun" | "pytest" | undefined {
  if (existsSync(join(worktreePath, "bunfig.toml"))) return "bun";

  const packageJsonPath = join(worktreePath, "package.json");
  if (existsSync(packageJsonPath)) {
    const text = readFileSync(packageJsonPath, "utf8");
    if (text.includes("bun:test") || text.includes("bun test")) return "bun";
  }

  if (existsSync(join(worktreePath, "pytest.ini"))) return "pytest";

  const pyprojectPath = join(worktreePath, "pyproject.toml");
  if (existsSync(pyprojectPath) && readFileSync(pyprojectPath, "utf8").includes("[tool.pytest")) {
    return "pytest";
  }

  const setupCfgPath = join(worktreePath, "setup.cfg");
  if (existsSync(setupCfgPath) && readFileSync(setupCfgPath, "utf8").includes("[tool:pytest]")) {
    return "pytest";
  }

  return undefined;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function collectBunScopedTests(worktreePath: string, changedFiles: string[]): string[] {
  const repoFiles = walkFiles(worktreePath).map((file) => relative(worktreePath, file));
  const repoSet = new Set(repoFiles);
  const matches: string[] = [];

  for (const file of changedFiles) {
    if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(file) && repoSet.has(file)) {
      matches.push(file);
      continue;
    }

    if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
    const stem = file.replace(/\.[cm]?[jt]sx?$/, "");
    for (const suffix of [".test.ts", ".spec.ts", ".test.tsx", ".spec.tsx", ".test.js", ".spec.js"]) {
      const candidate = `${stem}${suffix}`;
      if (repoSet.has(candidate)) matches.push(candidate);
    }
  }

  return uniqueStrings(matches);
}

function collectPytestScopedTests(worktreePath: string, changedFiles: string[]): string[] {
  const repoFiles = walkFiles(worktreePath).map((file) => relative(worktreePath, file));
  const repoSet = new Set(repoFiles);
  const matches: string[] = [];

  for (const file of changedFiles) {
    const base = basename(file);
    if (/^test_.+\.py$/.test(base) && repoSet.has(file)) {
      matches.push(file);
      continue;
    }
    if (!file.endsWith(".py")) continue;

    const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
    const stem = base.replace(/\.py$/, "");
    const candidateNames = [`test_${stem}.py`, `${stem}_test.py`];
    for (const name of candidateNames) {
      const sameDir = dir ? `${dir}/${name}` : name;
      if (repoSet.has(sameDir)) matches.push(sameDir);
      const testsDir = `tests/${name}`;
      if (repoSet.has(testsDir)) matches.push(testsDir);
    }
  }

  return uniqueStrings(matches);
}

export function parseBunTestErrors(stdout: string, stderr: string): TestError[] {
  const text = `${stdout}\n${stderr}`;
  const lines = text.split(/\r?\n/);
  const errors: TestError[] = [];
  let pendingMessage: string | undefined;

  for (const line of lines) {
    const expectMatch = line.match(BUN_EXPECT_RE);
    if (expectMatch) {
      pendingMessage = expectMatch[1]?.trim();
      continue;
    }

    const atMatch = line.match(BUN_ERROR_RE);
    if (atMatch) {
      errors.push({
        file: atMatch[1],
        line: Number(atMatch[2]),
        type: pendingMessage?.includes("expect(") ? "AssertionError" : "TestError",
        message: pendingMessage ?? "Test failure",
      });
      pendingMessage = undefined;
    }
  }

  return errors;
}

export function parsePytestErrors(stdout: string, stderr: string): TestError[] {
  const text = `${stdout}\n${stderr}`;
  const errors: TestError[] = [];

  for (const match of text.matchAll(PYTEST_FAIL_RE)) {
    errors.push({
      file: match[1],
      line: null,
      type: match[3],
      message: match[4],
    });
  }

  if (errors.length > 0) return errors;

  for (const match of text.matchAll(PYTEST_E_LINE_RE)) {
    errors.push({
      file: "unknown",
      line: null,
      type: match[1],
      message: match[2],
    });
  }

  return errors;
}

export async function detectChangedFiles(worktreePath: string, baseBranch = DEFAULT_BASE_BRANCH): Promise<string[]> {
  const [branchDiff, unstagedDiff] = await Promise.all([
    runCommand(worktreePath, ["git", "diff", "--name-only", `${baseBranch}...HEAD`], 15_000),
    runCommand(worktreePath, ["git", "diff", "--name-only"], 15_000),
  ]);

  return uniqueStrings([
    ...normalizePathList(branchDiff.stdout),
    ...normalizePathList(unstagedDiff.stdout),
  ]);
}

export async function runTests(options: TestRunnerOptions): Promise<TestResult> {
  const startedAt = performance.now();
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const changedFiles = await detectChangedFiles(options.worktreePath, options.baseBranch ?? DEFAULT_BASE_BRANCH);

  const framework = detectFramework(options.worktreePath);
  let commandText = options.testCommand?.trim();

  if (!commandText) {
    if (framework === "bun") {
      commandText = "bun test";
    } else if (framework === "pytest") {
      commandText = "pytest";
    } else {
      throw new Error("Unable to auto-detect test framework and no testCommand was provided");
    }
  }

  const scopedTargets =
    commandText.startsWith("bun test")
      ? collectBunScopedTests(options.worktreePath, changedFiles)
      : commandText.startsWith("pytest")
        ? collectPytestScopedTests(options.worktreePath, changedFiles)
        : [];

  const cmd = [...splitCommand(commandText), ...scopedTargets];
  const exec = await runCommand(options.worktreePath, cmd, timeout);
  const stderrWithTimeout = exec.timedOut ? `${exec.stderr}\nTimed out after ${timeout}ms`.trim() : exec.stderr;

  let errors: TestError[] = [];
  if (commandText.startsWith("bun test")) {
    errors = parseBunTestErrors(exec.stdout, stderrWithTimeout);
  } else if (commandText.startsWith("pytest")) {
    errors = parsePytestErrors(exec.stdout, stderrWithTimeout);
  }

  if (errors.length === 0 && exec.exitCode !== 0 && exec.timedOut) {
    errors = [{
      file: "unknown",
      line: null,
      type: "TimeoutError",
      message: `Tests timed out after ${timeout}ms`,
    }];
  }

  return {
    passed: exec.exitCode === 0,
    exit_code: exec.exitCode,
    test_command: cmd.join(" "),
    changed_files: changedFiles,
    errors,
    stdout_tail: linesTail(exec.stdout),
    stderr_tail: linesTail(stderrWithTimeout),
    duration_ms: Math.round(performance.now() - startedAt),
  };
}
