import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

export function cleanupDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

export async function waitFor(
  fn: () => void | Promise<void>,
  timeoutMs = 3000,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      await fn();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`waitFor timed out after ${timeoutMs}ms`);
}

export function runSync(cwd: string, cmd: string[]): string {
  const proc = Bun.spawnSync({
    cmd,
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = proc.stdout.toString();
  const stderr = proc.stderr.toString();
  if (proc.exitCode !== 0) {
    throw new Error(`Command failed (${cmd.join(" ")}): ${stderr || stdout}`);
  }

  return stdout;
}
