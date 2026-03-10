/**
 * Worktree Template Cache
 *
 * Pre-builds worktree templates with deps installed for fast spinup.
 * Templates share .git objects and node_modules/venv via symlinks.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, readlinkSync, statSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

// ──── Types ────

export interface WorktreeCacheOptions {
  repoPath: string;
  baseBranch?: string;
  cacheDir?: string;
  poolSize?: number;           // how many templates to pre-warm
  installDeps?: boolean;       // run bun install / pip install
  logger?: Pick<Console, "log" | "warn" | "error">;
}

export interface CachedTemplate {
  id: string;
  path: string;
  baseSHA: string;
  createdAt: number;
  inUse: boolean;
}

export interface WorktreeCacheState {
  templates: CachedTemplate[];
  available: number;
  stale: number;
}

// ──── Helpers ────

async function runCommand(cwd: string, cmd: string[]): Promise<{ exit_code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  const [exit_code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exit_code, stdout, stderr };
}

async function getHeadSHA(repoPath: string): Promise<string> {
  const result = await runCommand(repoPath, ["git", "rev-parse", "HEAD"]);
  if (result.exit_code !== 0) throw new Error(`git rev-parse HEAD failed: ${result.stderr}`);
  return result.stdout.trim();
}

// ──── WorktreeCache ────

export class WorktreeCache {
  private readonly repoPath: string;
  private readonly baseBranch: string;
  private readonly cacheDir: string;
  private readonly poolSize: number;
  private readonly installDeps: boolean;
  private readonly logger: Pick<Console, "log" | "warn" | "error">;

  private readonly templates = new Map<string, CachedTemplate>();
  private currentBaseSHA: string = "";

  constructor(options: WorktreeCacheOptions) {
    this.repoPath = resolve(options.repoPath);
    this.baseBranch = options.baseBranch ?? "main";
    this.cacheDir = options.cacheDir ?? join(this.repoPath, ".loopwright", "cache");
    this.poolSize = options.poolSize ?? 3;
    this.installDeps = options.installDeps !== false;
    this.logger = options.logger ?? console;
  }

  async prewarm(): Promise<void> {
    this.currentBaseSHA = await getHeadSHA(this.repoPath);
    mkdirSync(this.cacheDir, { recursive: true });

    this.logger.log(`[cache] pre-warming ${this.poolSize} templates (SHA: ${this.currentBaseSHA.slice(0, 8)})`);

    const promises: Promise<void>[] = [];
    for (let i = 0; i < this.poolSize; i++) {
      promises.push(this.buildTemplate());
    }
    await Promise.all(promises);

    this.logger.log(`[cache] ${this.templates.size} templates ready`);
  }

  async acquire(): Promise<{ worktreePath: string; branchName: string }> {
    // Check for staleness
    const currentSHA = await getHeadSHA(this.repoPath);
    if (currentSHA !== this.currentBaseSHA) {
      this.logger.log("[cache] base SHA changed, invalidating stale templates");
      await this.invalidate();
      this.currentBaseSHA = currentSHA;
    }

    // Find an available (not in-use) template
    let template: CachedTemplate | undefined;
    for (const t of this.templates.values()) {
      if (!t.inUse && t.baseSHA === this.currentBaseSHA) {
        template = t;
        break;
      }
    }

    if (!template) {
      // No cached templates available, build one fresh
      this.logger.log("[cache] no available templates, building fresh");
      await this.buildTemplate();
      for (const t of this.templates.values()) {
        if (!t.inUse) {
          template = t;
          break;
        }
      }
    }

    if (!template) {
      throw new Error("Failed to acquire worktree from cache");
    }

    // Clone from template — use UUID suffix to avoid branch name collisions
    const timestamp = Date.now();
    const uid = randomUUID().slice(0, 6);
    const branchName = `loopwright-cached-${timestamp}-${uid}`;
    const targetPath = join(this.repoPath, ".loopwright", "pool", `cached-${timestamp}-${uid}`);

    await this.cloneFromTemplate(template, targetPath, branchName);
    template.inUse = true;

    // Replenish in background if running low
    const available = this.countAvailable();
    if (available <= 1) {
      this.buildTemplate().catch(err => {
        this.logger.warn(`[cache] background rebuild failed: ${err}`);
      });
    }

    return { worktreePath: targetPath, branchName };
  }

  async release(worktreePath: string): Promise<void> {
    // Find and mark template as available
    for (const t of this.templates.values()) {
      if (t.inUse) {
        // We can't easily map worktreePath back to template, so just mark the first in-use one
        // as available (templates are reusable after clone)
        t.inUse = false;
        break;
      }
    }

    // Remove the cloned worktree
    try {
      const result = await runCommand(this.repoPath, ["git", "worktree", "remove", worktreePath, "--force"]);
      if (result.exit_code !== 0) {
        this.logger.warn(`[cache] worktree removal failed: ${result.stderr}`);
      }
    } catch (err) {
      this.logger.warn(`[cache] release cleanup failed: ${err}`);
    }
  }

  async invalidate(): Promise<void> {
    // Mark stale templates for rebuild — remove those not in use
    const toRemove: string[] = [];
    for (const [id, t] of this.templates) {
      if (!t.inUse) {
        toRemove.push(id);
      }
    }
    for (const id of toRemove) {
      const t = this.templates.get(id)!;
      await this.removeTemplate(t);
      this.templates.delete(id);
    }
  }

  async cleanup(): Promise<void> {
    for (const [id, t] of this.templates) {
      await this.removeTemplate(t);
    }
    this.templates.clear();

    try {
      rmSync(this.cacheDir, { recursive: true, force: true });
    } catch {}
  }

  getState(): WorktreeCacheState {
    const templates = [...this.templates.values()];
    return {
      templates: templates.map(t => ({ ...t })),
      available: templates.filter(t => !t.inUse && t.baseSHA === this.currentBaseSHA).length,
      stale: templates.filter(t => t.baseSHA !== this.currentBaseSHA).length,
    };
  }

  // ──── Internal ────

  private async buildTemplate(): Promise<void> {
    const id = randomUUID().slice(0, 8);
    const templatePath = join(this.cacheDir, id);
    const branchName = `loopwright-template-${id}`;

    mkdirSync(templatePath, { recursive: true });

    // Create worktree
    const result = await runCommand(this.repoPath, [
      "git", "worktree", "add", templatePath, "-b", branchName, this.baseBranch,
    ]);
    if (result.exit_code !== 0) {
      throw new Error(`Failed to create template worktree: ${result.stderr}`);
    }

    // Install dependencies
    if (this.installDeps) {
      // Bun deps
      if (existsSync(join(templatePath, "package.json"))) {
        this.logger.log(`[cache] installing bun deps for template ${id}`);
        await runCommand(templatePath, ["bun", "install"]);
      }

      // Python deps
      if (existsSync(join(templatePath, "pyproject.toml")) || existsSync(join(templatePath, "setup.py"))) {
        this.logger.log(`[cache] creating venv for template ${id}`);
        const venvResult = await runCommand(templatePath, ["python3", "-m", "venv", ".venv"]);
        if (venvResult.exit_code === 0) {
          const pip = join(templatePath, ".venv", "bin", "pip");
          if (existsSync(join(templatePath, "pyproject.toml"))) {
            await runCommand(templatePath, [pip, "install", "-e", "."]);
          }
        }
      }
    }

    // Write .claude/settings.json
    const { writePermissionsFile } = await import("./loop.ts");
    writePermissionsFile(templatePath);

    const baseSHA = await getHeadSHA(this.repoPath);

    this.templates.set(id, {
      id,
      path: templatePath,
      baseSHA,
      createdAt: Date.now(),
      inUse: false,
    });
  }

  private async cloneFromTemplate(template: CachedTemplate, targetPath: string, branchName: string): Promise<void> {
    mkdirSync(join(targetPath, ".."), { recursive: true });

    // Create a fresh worktree — shares .git objects with the repo
    const result = await runCommand(this.repoPath, [
      "git", "worktree", "add", targetPath, "-b", branchName, template.baseSHA,
    ]);
    if (result.exit_code !== 0) {
      throw new Error(`Failed to clone from template: ${result.stderr}`);
    }

    // Symlink node_modules from template (if exists)
    const templateNodeModules = join(template.path, "node_modules");
    const targetNodeModules = join(targetPath, "node_modules");
    if (existsSync(templateNodeModules) && !existsSync(targetNodeModules)) {
      try {
        symlinkSync(templateNodeModules, targetNodeModules, "dir");
      } catch {
        this.logger.warn("[cache] node_modules symlink failed, deps will be missing");
      }
    }

    // Symlink .venv from template (if exists)
    const templateVenv = join(template.path, ".venv");
    const targetVenv = join(targetPath, ".venv");
    if (existsSync(templateVenv) && !existsSync(targetVenv)) {
      try {
        symlinkSync(templateVenv, targetVenv, "dir");
      } catch {
        this.logger.warn("[cache] .venv symlink failed, deps will be missing");
      }
    }

    // Copy .claude/settings.json
    const templateSettings = join(template.path, ".claude", "settings.json");
    const targetClaudeDir = join(targetPath, ".claude");
    if (existsSync(templateSettings)) {
      mkdirSync(targetClaudeDir, { recursive: true });
      const content = await Bun.file(templateSettings).text();
      await Bun.write(join(targetClaudeDir, "settings.json"), content);
    }
  }

  private async removeTemplate(template: CachedTemplate): Promise<void> {
    try {
      await runCommand(this.repoPath, ["git", "worktree", "remove", template.path, "--force"]);
    } catch {
      // best effort
    }
  }

  private countAvailable(): number {
    let count = 0;
    for (const t of this.templates.values()) {
      if (!t.inUse && t.baseSHA === this.currentBaseSHA) count++;
    }
    return count;
  }
}

export function createWorktreeCache(options: WorktreeCacheOptions): WorktreeCache {
  return new WorktreeCache(options);
}
