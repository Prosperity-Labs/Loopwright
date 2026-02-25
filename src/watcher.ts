import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export interface WorktreeWatcherOptions {
  worktreePath: string;
  eventsPath: string;
  worktreeId: string | number;
  logger?: Pick<Console, "warn" | "error" | "log">;
}

const IGNORED_DIRS = new Set([".git", "node_modules", "__pycache__"]);

function isIgnoredPath(root: string, targetPath: string): boolean {
  const rel = relative(root, targetPath);
  if (!rel || rel === "") return false;
  const parts = rel.split(sep).filter(Boolean);
  return parts.some((part) => IGNORED_DIRS.has(part));
}

function safeStat(path: string): ReturnType<typeof statSync> | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

export class WorktreeWatcher {
  private readonly root: string;
  private readonly eventsPath: string;
  private readonly worktreeId: string | number;
  private readonly logger: Pick<Console, "warn" | "error" | "log">;
  private readonly watchers = new Map<string, FSWatcher>();
  private recursiveWatcher?: FSWatcher;
  private closed = false;

  constructor(options: WorktreeWatcherOptions) {
    this.root = resolve(options.worktreePath);
    this.eventsPath = resolve(options.eventsPath);
    this.worktreeId = options.worktreeId;
    this.logger = options.logger ?? console;
    mkdirSync(dirname(this.eventsPath), { recursive: true });
  }

  start(): void {
    try {
      this.recursiveWatcher = watch(this.root, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        const fullPath = resolve(this.root, filename.toString());
        this.handleFsEvent(fullPath, eventType);
      });
      return;
    } catch {
      this.watchDirectoryTree(this.root);
    }
  }

  close(): void {
    this.closed = true;
    this.recursiveWatcher?.close();
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }

  private watchDirectoryTree(dir: string): void {
    if (this.closed || this.watchers.has(dir) || isIgnoredPath(this.root, dir)) return;
    const stat = safeStat(dir);
    if (!stat?.isDirectory()) return;

    const watcher = watch(dir, (eventType, filename) => {
      const fullPath = filename ? join(dir, filename.toString()) : dir;
      this.handleFsEvent(fullPath, eventType);

      const fsStat = safeStat(fullPath);
      if (eventType === "rename" && fsStat?.isDirectory() && !isIgnoredPath(this.root, fullPath)) {
        this.watchDirectoryTree(fullPath);
      }
    });
    this.watchers.set(dir, watcher);

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (IGNORED_DIRS.has(entry.name)) continue;
      this.watchDirectoryTree(join(dir, entry.name));
    }
  }

  private handleFsEvent(fullPath: string, eventType: string): void {
    if (this.closed) return;
    if (fullPath === this.eventsPath) return;
    if (isIgnoredPath(this.root, fullPath)) return;

    const event = {
      timestamp: new Date().toISOString(),
      event_type: "file_write",
      file_path: fullPath,
      change_type: eventType,
      worktree_id: this.worktreeId,
    };

    try {
      appendFileSync(this.eventsPath, `${JSON.stringify(event)}\n`, "utf8");
    } catch (error) {
      this.logger.error("[watcher] failed to append event", error);
    }
  }
}

export function startWorktreeWatcher(options: WorktreeWatcherOptions): WorktreeWatcher {
  if (!existsSync(options.worktreePath)) {
    throw new Error(`Worktree path does not exist: ${options.worktreePath}`);
  }
  const watcher = new WorktreeWatcher(options);
  watcher.start();
  return watcher;
}

if (import.meta.main) {
  const worktreePath = Bun.argv[2];
  if (!worktreePath) {
    console.error("Usage: bun run src/watcher.ts <worktreePath> [eventsPath] [worktreeId]");
    process.exit(1);
  }

  const eventsPath = Bun.argv[3] ?? "events.jsonl";
  const worktreeId = Bun.argv[4] ?? "default";
  const watcher = startWorktreeWatcher({ worktreePath, eventsPath, worktreeId });
  console.log(`[watcher] monitoring ${worktreePath} -> ${eventsPath}`);

  const shutdown = () => {
    watcher.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
