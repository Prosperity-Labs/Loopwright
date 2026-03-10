/**
 * Parallel Agent Pool
 *
 * Runs N concurrent agents via a priority task queue.
 * Each worker gets its own git worktree and calls runLoop() directly.
 */

import { mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { runLoop, type LoopOptions, type LoopResult } from "./loop.ts";
import { removeWorktree } from "./ab-runner.ts";
import { registry } from "./spawner.ts";
import { WorktreeCache } from "./worktree-cache.ts";
import { createSnapshot, discardSnapshot, restoreSnapshot, type DBSnapshot } from "./db-snapshot.ts";

// ──── Types ────

export type TaskStatus = "queued" | "running" | "passed" | "failed" | "escalated" | "cancelled";
export type WorkerStatus = "idle" | "running" | "stopped";
export type PoolStatus = "idle" | "running" | "draining" | "stopped";

export interface PoolTask {
  id: string;
  prompt: string;
  priority: number;           // higher = sooner
  status: TaskStatus;
  result?: LoopResult;
  error?: string;
  workerId?: string;
  worktreePath?: string;
  branchName?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

export interface WorkerState {
  id: string;
  status: WorkerStatus;
  currentTaskId?: string;
  completedTasks: number;
}

export interface PoolState {
  status: PoolStatus;
  workers: WorkerState[];
  tasks: PoolTask[];
  completedCount: number;
  failedCount: number;
  cancelledCount: number;
}

export interface PoolResult {
  tasks: PoolTask[];
  totalDuration_ms: number;
}

export interface PoolOptions {
  repoPath: string;
  dbPath: string;
  baseBranch?: string;
  concurrency?: number;
  agentType?: "claude" | "cursor" | "codex";
  model?: string;
  agentTimeoutMs?: number;
  loopTimeoutMs?: number;
  maxCycles?: number;
  engramDbPath?: string;
  engramPath?: string;
  project?: string;
  enableCache?: boolean;
  enableDBSnapshot?: boolean;
  logger?: Pick<Console, "log" | "warn" | "error">;
}

// ──── Worktree helpers ────

async function runCommand(cwd: string, cmd: string[]): Promise<{ exit_code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  const [exit_code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exit_code, stdout, stderr };
}

async function createGitWorktree(repoPath: string, worktreePath: string, branchName: string, baseBranch: string): Promise<void> {
  mkdirSync(dirname(worktreePath), { recursive: true });
  const result = await runCommand(repoPath, ["git", "worktree", "add", worktreePath, "-b", branchName, baseBranch]);
  if (result.exit_code !== 0) {
    throw new Error(`Failed to create worktree ${worktreePath}: ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

async function autoCommitWorktree(worktreePath: string, logger: Pick<Console, "log" | "warn">): Promise<boolean> {
  const status = await runCommand(worktreePath, ["git", "status", "--porcelain"]);
  if (!status.stdout.trim()) return false;
  const addResult = await runCommand(worktreePath, ["git", "add", "-A"]);
  if (addResult.exit_code !== 0) return false;
  const commitResult = await runCommand(worktreePath, [
    "git", "commit", "-m", "loopwright: auto-save agent work before cleanup",
  ]);
  if (commitResult.exit_code !== 0) return false;
  logger.log("[pool] auto-committed agent work");
  return true;
}

// ──── Priority Queue ────

class TaskQueue {
  private tasks: PoolTask[] = [];

  enqueue(task: PoolTask): void {
    this.tasks.push(task);
    // Sort: higher priority first, then FIFO by createdAt
    this.tasks.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.createdAt - b.createdAt;
    });
  }

  dequeue(): PoolTask | undefined {
    const idx = this.tasks.findIndex(t => t.status === "queued");
    if (idx === -1) return undefined;
    return this.tasks[idx];
  }

  cancelAll(): PoolTask[] {
    const cancelled: PoolTask[] = [];
    for (const t of this.tasks) {
      if (t.status === "queued") {
        t.status = "cancelled";
        t.completedAt = Date.now();
        cancelled.push(t);
      }
    }
    return cancelled;
  }

  getAll(): PoolTask[] {
    return [...this.tasks];
  }

  get length(): number {
    return this.tasks.filter(t => t.status === "queued").length;
  }
}

// ──── AgentPool ────

export class AgentPool extends EventTarget {
  private readonly repoPath: string;
  private readonly dbPath: string;
  private readonly baseBranch: string;
  private readonly concurrency: number;
  private readonly logger: Pick<Console, "log" | "warn" | "error">;
  private readonly opts: PoolOptions;

  private readonly queue = new TaskQueue();
  private readonly allTasks = new Map<string, PoolTask>();
  private readonly workers: WorkerState[] = [];
  private readonly workerPromises: Promise<void>[] = [];
  private cache: WorktreeCache | null = null;

  private _status: PoolStatus = "idle";
  private _completedCount = 0;
  private _failedCount = 0;
  private _cancelledCount = 0;
  private _startTime = 0;

  // Per-task resolve callbacks for waitForTask()
  private readonly taskResolvers = new Map<string, Array<(task: PoolTask) => void>>();

  constructor(options: PoolOptions) {
    super();
    this.repoPath = resolve(options.repoPath);
    this.dbPath = resolve(options.dbPath);
    this.baseBranch = options.baseBranch ?? "main";
    this.concurrency = Math.min(Math.max(options.concurrency ?? 3, 1), 8);
    this.logger = options.logger ?? console;
    this.opts = options;
  }

  addTask(prompt: string, opts?: { priority?: number }): string {
    if (this._status === "stopped" || this._status === "draining") {
      throw new Error(`Cannot add tasks: pool is ${this._status}`);
    }

    const id = `task-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const task: PoolTask = {
      id,
      prompt,
      priority: opts?.priority ?? 0,
      status: "queued",
      createdAt: Date.now(),
    };

    this.allTasks.set(id, task);
    this.queue.enqueue(task);
    this.emit("task-queued", { taskId: id, prompt });
    return id;
  }

  async start(): Promise<void> {
    if (this._status !== "idle") {
      throw new Error(`Cannot start: pool is ${this._status}`);
    }

    this._status = "running";
    this._startTime = performance.now();
    this.emit("pool-state", { status: this._status });

    // Initialize worktree cache if enabled
    if (this.opts.enableCache) {
      this.cache = new WorktreeCache({
        repoPath: this.repoPath,
        baseBranch: this.baseBranch,
        poolSize: this.concurrency,
        logger: this.logger,
      });
      await this.cache.prewarm();
    }

    // Spawn N worker coroutines
    for (let i = 0; i < this.concurrency; i++) {
      const worker: WorkerState = {
        id: `worker-${i}`,
        status: "idle",
        completedTasks: 0,
      };
      this.workers.push(worker);
      this.workerPromises.push(this.runWorker(worker));
    }
  }

  async waitForTask(taskId: string): Promise<PoolTask> {
    const task = this.allTasks.get(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    if (task.status !== "queued" && task.status !== "running") return task;

    return new Promise<PoolTask>((resolve) => {
      const resolvers = this.taskResolvers.get(taskId) ?? [];
      resolvers.push(resolve);
      this.taskResolvers.set(taskId, resolvers);
    });
  }

  cancelTask(taskId: string): boolean {
    const task = this.allTasks.get(taskId);
    if (!task) return false;
    if (task.status === "queued") {
      task.status = "cancelled";
      task.completedAt = Date.now();
      this._cancelledCount++;
      this.resolveTask(task);
      return true;
    }
    if (task.status === "running" && task.workerId) {
      // Kill the agent running this task
      for (const agent of registry.list()) {
        if (task.worktreePath && agent.worktreePath === task.worktreePath) {
          try { agent.process.kill(); } catch {}
        }
      }
      // Task status will be set by the worker when it catches the kill
      return true;
    }
    return false;
  }

  async drain(): Promise<PoolResult> {
    this._status = "draining";
    this.emit("pool-state", { status: this._status });

    // Cancel all queued tasks
    const cancelled = this.queue.cancelAll();
    this._cancelledCount += cancelled.length;
    for (const t of cancelled) {
      this.resolveTask(t);
    }

    // Wait for active workers to finish
    await Promise.allSettled(this.workerPromises);

    // Cleanup cache
    if (this.cache) {
      try { await this.cache.cleanup(); } catch {}
      this.cache = null;
    }

    this._status = "stopped";
    this.emit("pool-state", { status: this._status });

    return {
      tasks: [...this.allTasks.values()],
      totalDuration_ms: Math.round(performance.now() - this._startTime),
    };
  }

  async stop(): Promise<PoolResult> {
    this._status = "stopped";
    this.emit("pool-state", { status: this._status });

    // Cancel queued
    const cancelled = this.queue.cancelAll();
    this._cancelledCount += cancelled.length;
    for (const t of cancelled) {
      this.resolveTask(t);
    }

    // Kill all running agents
    await registry.killAll();

    // Wait for workers
    await Promise.allSettled(this.workerPromises);

    // Cleanup cache
    if (this.cache) {
      try { await this.cache.cleanup(); } catch {}
      this.cache = null;
    }

    return {
      tasks: [...this.allTasks.values()],
      totalDuration_ms: Math.round(performance.now() - this._startTime),
    };
  }

  getState(): Readonly<PoolState> {
    // Return tasks in queue order (priority DESC, then FIFO)
    const tasks = [...this.allTasks.values()].sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.createdAt - b.createdAt;
    });
    return {
      status: this._status,
      workers: this.workers.map(w => ({ ...w })),
      tasks,
      completedCount: this._completedCount,
      failedCount: this._failedCount,
      cancelledCount: this._cancelledCount,
    };
  }

  // ──── Internal ────

  private async runWorker(worker: WorkerState): Promise<void> {
    while (this._status === "running" || (this._status === "draining" && this.hasRunningTasks())) {
      const task = this.queue.dequeue();
      if (!task) {
        // No tasks in queue — if draining, we're done; else wait a bit
        if (this._status === "draining") break;
        this.emit("worker-idle", { workerId: worker.id });
        await Bun.sleep(50);
        continue;
      }

      worker.status = "running";
      worker.currentTaskId = task.id;
      task.status = "running";
      task.workerId = worker.id;
      task.startedAt = Date.now();

      const timestamp = Date.now();
      const branchName = `loopwright-pool-${timestamp}-${worker.id}`;
      const worktreePath = join(this.repoPath, ".loopwright", "pool", `${worker.id}-${timestamp}`);
      task.worktreePath = worktreePath;
      task.branchName = branchName;

      this.emit("task-started", { taskId: task.id, workerId: worker.id });
      this.logger.log(`[pool] ${worker.id}: starting task ${task.id}`);

      let usedCache = false;
      let snapshot: DBSnapshot | undefined;

      try {
        // Create worktree — from cache or fresh
        if (this.cache) {
          try {
            const cached = await this.cache.acquire();
            // Override paths with cached ones
            task.worktreePath = cached.worktreePath;
            task.branchName = cached.branchName;
            usedCache = true;
          } catch (err) {
            this.logger.warn(`[pool] cache acquire failed, falling back to fresh worktree: ${err}`);
          }
        }

        const effectiveWorktreePath = task.worktreePath!;
        const effectiveBranch = task.branchName!;

        if (!usedCache) {
          await createGitWorktree(this.repoPath, effectiveWorktreePath, effectiveBranch, this.baseBranch);
        }

        // Snapshot databases if enabled
        if (this.opts.enableDBSnapshot) {
          try {
            snapshot = await createSnapshot({ repoPath: effectiveWorktreePath });
          } catch (err) {
            this.logger.warn(`[pool] DB snapshot failed: ${err}`);
          }
        }

        const loopOptions: LoopOptions = {
          repoPath: this.repoPath,
          dbPath: this.dbPath,
          baseBranch: this.baseBranch,
          taskPrompt: task.prompt,
          agentType: this.opts.agentType,
          model: this.opts.model,
          agentTimeoutMs: this.opts.agentTimeoutMs,
          loopTimeoutMs: this.opts.loopTimeoutMs,
          maxCycles: this.opts.maxCycles,
          engramDbPath: this.opts.engramDbPath,
          engramPath: this.opts.engramPath,
          project: this.opts.project,
          logger: this.logger,
          worktreePath: effectiveWorktreePath,
          worktreeBranch: effectiveBranch,
          cleanupWorktree: false, // pool manages cleanup
        };

        const result = await runLoop(loopOptions);
        task.result = result;
        task.status = result.status === "passed" ? "passed" : result.status === "escalated" ? "escalated" : "failed";

        if (task.status === "passed") this._completedCount++;
        else this._failedCount++;

        // On success: discard snapshot
        if (snapshot) {
          await discardSnapshot(snapshot);
          snapshot = undefined;
        }
      } catch (err) {
        task.status = "failed";
        task.error = err instanceof Error ? err.message : String(err);
        this._failedCount++;
        this.logger.error(`[pool] ${worker.id}: task ${task.id} error: ${task.error}`);

        // On failure: restore snapshot
        if (snapshot) {
          try {
            await restoreSnapshot(snapshot, task.worktreePath);
          } catch {}
          await discardSnapshot(snapshot);
          snapshot = undefined;
        }
      } finally {
        task.completedAt = Date.now();
        const effectiveWorktreePath = task.worktreePath!;

        // Auto-commit + cleanup worktree
        try {
          await autoCommitWorktree(effectiveWorktreePath, this.logger);
        } catch {}

        if (usedCache && this.cache) {
          try {
            await this.cache.release(effectiveWorktreePath);
          } catch {}
        } else {
          try {
            await removeWorktree(this.repoPath, effectiveWorktreePath);
          } catch (err) {
            this.logger.warn(`[pool] worktree cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        worker.status = "idle";
        worker.currentTaskId = undefined;
        worker.completedTasks++;

        this.emit("task-completed", {
          taskId: task.id,
          workerId: worker.id,
          status: task.status,
        });
        this.resolveTask(task);

        this.logger.log(`[pool] ${worker.id}: task ${task.id} → ${task.status}`);
      }
    }

    worker.status = "stopped";
  }

  private hasRunningTasks(): boolean {
    for (const t of this.allTasks.values()) {
      if (t.status === "running") return true;
    }
    return false;
  }

  private resolveTask(task: PoolTask): void {
    const resolvers = this.taskResolvers.get(task.id);
    if (resolvers) {
      for (const resolve of resolvers) resolve(task);
      this.taskResolvers.delete(task.id);
    }
  }

  private emit(eventName: string, detail: Record<string, unknown>): void {
    this.dispatchEvent(new CustomEvent(eventName, { detail }));
  }
}
