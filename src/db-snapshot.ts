/**
 * DB Snapshot / Isolation
 *
 * Captures SQLite database state before agent runs and restores on failure.
 * Each agent worktree gets isolated database state.
 */

import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, resolve, basename, relative } from "node:path";
import { Database } from "bun:sqlite";

// ──── Types ────

export interface SnapshotOptions {
  /** Path to the worktree or repo to scan for databases */
  repoPath: string;
  /** Directory to store snapshots. Default: .loopwright-snapshots/ next to repoPath */
  snapshotDir?: string;
  /** Specific database file paths. If not set, auto-discovers *.db, *.sqlite, *.sqlite3 */
  dbPaths?: string[];
  /** Optional label for this snapshot */
  label?: string;
}

export interface DBSnapshot {
  id: string;
  repoPath: string;
  snapshotDir: string;
  files: SnapshotFile[];
  createdAt: number;
  label?: string;
}

export interface SnapshotFile {
  originalPath: string;
  snapshotPath: string;
  sizeBytes: number;
}

// ──── Helpers ────

const DB_EXTENSIONS = new Set([".db", ".sqlite", ".sqlite3"]);

function findDatabaseFiles(repoPath: string): string[] {
  const found: string[] = [];

  function walk(dir: string, depth = 0): void {
    if (depth > 3) return; // don't recurse too deep
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        // Skip hidden dirs, node_modules, .venv, .git
        if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === ".venv") {
          continue;
        }
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath, depth + 1);
        } else if (entry.isFile()) {
          const ext = entry.name.slice(entry.name.lastIndexOf("."));
          if (DB_EXTENSIONS.has(ext)) {
            found.push(fullPath);
          }
        }
      }
    } catch {
      // permission error or similar
    }
  }

  walk(repoPath);
  return found;
}

function walCheckpoint(dbPath: string): void {
  try {
    const db = new Database(dbPath, { readonly: false });
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }
  } catch {
    // DB might be locked or not in WAL mode — best effort
  }
}

// ──── Public API ────

export async function createSnapshot(options: SnapshotOptions): Promise<DBSnapshot> {
  const repoPath = resolve(options.repoPath);
  const dbPaths = options.dbPaths ?? findDatabaseFiles(repoPath);

  if (dbPaths.length === 0) {
    // No databases found — return empty snapshot (no-op)
    return {
      id: `snap-${Date.now()}`,
      repoPath,
      snapshotDir: "",
      files: [],
      createdAt: Date.now(),
      label: options.label,
    };
  }

  const snapshotId = `snap-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const snapshotDir = options.snapshotDir ?? join(repoPath, ".loopwright-snapshots", snapshotId);
  mkdirSync(snapshotDir, { recursive: true });

  const files: SnapshotFile[] = [];

  for (const dbPath of dbPaths) {
    const resolvedDb = resolve(dbPath);

    if (!existsSync(resolvedDb)) continue;

    // Checkpoint WAL to ensure consistent state
    walCheckpoint(resolvedDb);

    // Copy database file
    const relName = relative(repoPath, resolvedDb).replace(/\//g, "__");
    const snapshotPath = join(snapshotDir, relName);

    const source = Bun.file(resolvedDb);
    const size = source.size;
    await Bun.write(snapshotPath, source);

    // Also copy WAL and SHM if they exist
    for (const suffix of ["-wal", "-shm"]) {
      const walPath = resolvedDb + suffix;
      if (existsSync(walPath)) {
        await Bun.write(snapshotPath + suffix, Bun.file(walPath));
      }
    }

    files.push({
      originalPath: resolvedDb,
      snapshotPath,
      sizeBytes: size,
    });
  }

  return {
    id: snapshotId,
    repoPath,
    snapshotDir,
    files,
    createdAt: Date.now(),
    label: options.label,
  };
}

export async function restoreSnapshot(snapshot: DBSnapshot, targetPath?: string): Promise<void> {
  if (snapshot.files.length === 0) return; // no-op for empty snapshots

  for (const file of snapshot.files) {
    const target = targetPath
      ? join(targetPath, relative(snapshot.repoPath, file.originalPath))
      : file.originalPath;

    if (!existsSync(file.snapshotPath)) continue;

    // Checkpoint WAL on target before overwriting
    if (existsSync(target)) {
      walCheckpoint(target);
    }

    // Restore from snapshot
    mkdirSync(join(target, ".."), { recursive: true });
    await Bun.write(target, Bun.file(file.snapshotPath));

    // Restore WAL and SHM
    for (const suffix of ["-wal", "-shm"]) {
      const snapshotWal = file.snapshotPath + suffix;
      const targetWal = target + suffix;
      if (existsSync(snapshotWal)) {
        await Bun.write(targetWal, Bun.file(snapshotWal));
      }
    }
  }
}

export async function discardSnapshot(snapshot: DBSnapshot): Promise<void> {
  if (!snapshot.snapshotDir) return;

  try {
    const { rmSync } = await import("node:fs");
    rmSync(snapshot.snapshotDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}
