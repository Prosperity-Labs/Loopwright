import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface ToolCallRowInput {
  session_id: string;
  tool_name: string;
  args_json?: JsonValue;
  result_json?: JsonValue;
  status?: string | null;
  timestamp?: string;
  raw_event_json?: JsonValue;
}

export interface ArtifactRowInput {
  session_id?: string | null;
  worktree_id?: number | string | null;
  file_path: string;
  event_type?: string;
  content?: string | null;
  metadata_json?: JsonValue;
  timestamp?: string;
  raw_event_json?: JsonValue;
}

export interface SessionUpsertInput {
  session_id: string;
  filepath?: string;
  project?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  message_count?: number;
  file_size_bytes?: number;
}

export interface WorktreeUpsertInput {
  id?: number;
  session_id?: string | null;
  branch_name: string;
  base_branch?: string;
  status?: "active" | "passed" | "failed" | "escalated" | "merged";
  task_description?: string | null;
  created_at?: string;
  resolved_at?: string | null;
}

export interface CheckpointInsertInput {
  worktree_id: number;
  session_id?: string | null;
  git_sha: string;
  test_results?: JsonValue;
  artifact_snapshot?: JsonValue;
  graph_delta?: JsonValue;
  created_at?: string;
  label?: string | null;
}

export interface CheckpointRow {
  id: number;
  worktree_id: number;
  session_id: string | null;
  git_sha: string | null;
  test_results: string | null;
  artifact_snapshot: string | null;
  graph_delta: string | null;
  created_at: string;
  label: string | null;
}

export interface WorktreeRow {
  id: number;
  session_id: string | null;
  branch_name: string;
  base_branch: string;
  status: "active" | "passed" | "failed" | "escalated" | "merged";
  task_description: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface ArtifactRow {
  id: number;
  session_id: string | null;
  worktree_id: string | null;
  file_path: string;
  event_type: string;
  content: string | null;
  metadata_json: string | null;
  timestamp: string;
  raw_event_json: string | null;
}

export interface ComparisonInsertInput {
  worktree_a_id: number;
  worktree_b_id: number;
  json_report: JsonValue;
  markdown_report: string;
  created_at?: string;
}

export interface ComparisonRow {
  id: number;
  worktree_a_id: number;
  worktree_b_id: number;
  json_report: string;
  markdown_report: string;
  created_at: string;
}

const SCHEMA_SQL = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  filepath TEXT NOT NULL DEFAULT '',
  project TEXT,
  message_count INTEGER DEFAULT 0,
  file_size_bytes INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  args_json TEXT,
  result_json TEXT,
  status TEXT,
  timestamp TEXT NOT NULL,
  raw_event_json TEXT,
  FOREIGN KEY(session_id) REFERENCES sessions(session_id)
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_session_id ON tool_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_timestamp ON tool_calls(timestamp);

CREATE TABLE IF NOT EXISTS artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  worktree_id TEXT,
  file_path TEXT NOT NULL,
  event_type TEXT NOT NULL DEFAULT 'file_write',
  content TEXT,
  metadata_json TEXT,
  timestamp TEXT NOT NULL,
  raw_event_json TEXT,
  FOREIGN KEY(session_id) REFERENCES sessions(session_id)
);

CREATE INDEX IF NOT EXISTS idx_artifacts_session_id ON artifacts(session_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_worktree_id ON artifacts(worktree_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_file_path ON artifacts(file_path);

CREATE TABLE IF NOT EXISTS worktrees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT REFERENCES sessions(session_id),
  branch_name TEXT NOT NULL,
  base_branch TEXT NOT NULL DEFAULT 'main',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active','passed','failed','escalated','merged')),
  task_description TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worktree_id INTEGER NOT NULL REFERENCES worktrees(id),
  session_id TEXT REFERENCES sessions(session_id),
  git_sha TEXT,
  test_results TEXT,
  artifact_snapshot TEXT,
  graph_delta TEXT,
  created_at TEXT NOT NULL,
  label TEXT
);

CREATE INDEX IF NOT EXISTS idx_checkpoints_worktree ON checkpoints(worktree_id);

CREATE TABLE IF NOT EXISTS comparisons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worktree_a_id INTEGER NOT NULL REFERENCES worktrees(id),
  worktree_b_id INTEGER NOT NULL REFERENCES worktrees(id),
  json_report TEXT NOT NULL,
  markdown_report TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_comparisons_pair ON comparisons(worktree_a_id, worktree_b_id, created_at);
`;

function isoNow(): string {
  return new Date().toISOString();
}

function toJson(value: JsonValue | undefined): string | null {
  if (value === undefined) return null;
  return JSON.stringify(value);
}

export class LoopwrightDB {
  readonly sqlite: Database;

  private readonly upsertSessionStmt;
  private readonly upsertSessionTimestampsStmt;
  private readonly insertToolCallStmt;
  private readonly insertArtifactStmt;
  private readonly insertWorktreeStmt;
  private readonly upsertWorktreeByIdStmt;
  private readonly updateWorktreeStatusStmt;
  private readonly insertCheckpointStmt;
  private readonly getCheckpointByIdStmt;
  private readonly listCheckpointsStmt;
  private readonly getWorktreeByIdStmt;
  private readonly listArtifactsByWorktreeStmt;
  private readonly insertComparisonStmt;
  private readonly getLatestComparisonForPairStmt;

  constructor(public readonly dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.sqlite = new Database(dbPath);
    this.sqlite.exec(SCHEMA_SQL);

    this.upsertSessionStmt = this.sqlite.prepare(`
      INSERT INTO sessions (session_id, filepath, project, message_count, file_size_bytes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        filepath = COALESCE(NULLIF(excluded.filepath, ''), sessions.filepath),
        project = COALESCE(excluded.project, sessions.project),
        created_at = COALESCE(sessions.created_at, excluded.created_at),
        updated_at = COALESCE(excluded.updated_at, sessions.updated_at)
    `);

    this.upsertSessionTimestampsStmt = this.sqlite.prepare(`
      UPDATE sessions
      SET created_at = COALESCE(created_at, ?),
          updated_at = COALESCE(?, updated_at)
      WHERE session_id = ?
    `);

    this.insertToolCallStmt = this.sqlite.prepare(`
      INSERT INTO tool_calls (session_id, tool_name, args_json, result_json, status, timestamp, raw_event_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    this.insertArtifactStmt = this.sqlite.prepare(`
      INSERT INTO artifacts (session_id, worktree_id, file_path, event_type, content, metadata_json, timestamp, raw_event_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.insertWorktreeStmt = this.sqlite.prepare(`
      INSERT INTO worktrees (session_id, branch_name, base_branch, status, task_description, created_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    this.upsertWorktreeByIdStmt = this.sqlite.prepare(`
      INSERT INTO worktrees (id, session_id, branch_name, base_branch, status, task_description, created_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        session_id = excluded.session_id,
        branch_name = excluded.branch_name,
        base_branch = excluded.base_branch,
        status = excluded.status,
        task_description = excluded.task_description,
        created_at = excluded.created_at,
        resolved_at = excluded.resolved_at
    `);

    this.updateWorktreeStatusStmt = this.sqlite.prepare(`
      UPDATE worktrees
      SET status = ?,
          resolved_at = CASE WHEN ? IS NULL THEN resolved_at ELSE ? END
      WHERE id = ?
    `);

    this.insertCheckpointStmt = this.sqlite.prepare(`
      INSERT INTO checkpoints (worktree_id, session_id, git_sha, test_results, artifact_snapshot, graph_delta, created_at, label)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.getCheckpointByIdStmt = this.sqlite.prepare(`
      SELECT id, worktree_id, session_id, git_sha, test_results, artifact_snapshot, graph_delta, created_at, label
      FROM checkpoints WHERE id = ?
    `);

    this.listCheckpointsStmt = this.sqlite.prepare(`
      SELECT id, worktree_id, session_id, git_sha, test_results, artifact_snapshot, graph_delta, created_at, label
      FROM checkpoints WHERE worktree_id = ? ORDER BY created_at ASC, id ASC
    `);

    this.getWorktreeByIdStmt = this.sqlite.prepare(`
      SELECT id, session_id, branch_name, base_branch, status, task_description, created_at, resolved_at
      FROM worktrees WHERE id = ?
    `);

    this.listArtifactsByWorktreeStmt = this.sqlite.prepare(`
      SELECT id, session_id, worktree_id, file_path, event_type, content, metadata_json, timestamp, raw_event_json
      FROM artifacts
      WHERE worktree_id = ?
      ORDER BY timestamp ASC, id ASC
    `);

    this.insertComparisonStmt = this.sqlite.prepare(`
      INSERT INTO comparisons (worktree_a_id, worktree_b_id, json_report, markdown_report, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    this.getLatestComparisonForPairStmt = this.sqlite.prepare(`
      SELECT id, worktree_a_id, worktree_b_id, json_report, markdown_report, created_at
      FROM comparisons
      WHERE (worktree_a_id = ? AND worktree_b_id = ?) OR (worktree_a_id = ? AND worktree_b_id = ?)
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `);
  }

  close(): void {
    this.sqlite.close();
  }

  ensureSession(input: SessionUpsertInput): void {
    this.upsertSessionStmt.run(
      input.session_id,
      input.filepath ?? "",
      input.project ?? null,
      input.message_count ?? 0,
      input.file_size_bytes ?? 0,
      input.created_at ?? null,
      input.updated_at ?? null,
    );
  }

  markSessionStart(sessionId: string, timestamp = isoNow(), extras?: Partial<SessionUpsertInput>): void {
    this.ensureSession({
      session_id: sessionId,
      filepath: extras?.filepath ?? "",
      project: extras?.project ?? null,
      created_at: timestamp,
      updated_at: timestamp,
    });
  }

  markSessionEnd(sessionId: string, timestamp = isoNow()): void {
    this.ensureSession({ session_id: sessionId, updated_at: timestamp });
    this.upsertSessionTimestampsStmt.run(timestamp, timestamp, sessionId);
  }

  insertToolCall(input: ToolCallRowInput): number {
    const ts = input.timestamp ?? isoNow();
    this.ensureSession({ session_id: input.session_id, updated_at: ts });
    const result = this.insertToolCallStmt.run(
      input.session_id,
      input.tool_name,
      toJson(input.args_json),
      toJson(input.result_json),
      input.status ?? null,
      ts,
      toJson(input.raw_event_json),
    );
    return Number(result.lastInsertRowid);
  }

  insertArtifact(input: ArtifactRowInput): number {
    const ts = input.timestamp ?? isoNow();
    if (input.session_id) {
      this.ensureSession({ session_id: input.session_id, updated_at: ts });
    }
    const result = this.insertArtifactStmt.run(
      input.session_id ?? null,
      input.worktree_id ?? null,
      input.file_path,
      input.event_type ?? "file_write",
      input.content ?? null,
      toJson(input.metadata_json),
      ts,
      toJson(input.raw_event_json),
    );
    return Number(result.lastInsertRowid);
  }

  upsertWorktree(input: WorktreeUpsertInput): number {
    if (input.session_id) {
      this.ensureSession({ session_id: input.session_id });
    }

    const row = {
      id: input.id,
      session_id: input.session_id ?? null,
      branch_name: input.branch_name,
      base_branch: input.base_branch ?? "main",
      status: input.status ?? "active",
      task_description: input.task_description ?? null,
      created_at: input.created_at ?? isoNow(),
      resolved_at: input.resolved_at ?? null,
    };

    if (typeof row.id === "number") {
      this.upsertWorktreeByIdStmt.run(
        row.id,
        row.session_id,
        row.branch_name,
        row.base_branch,
        row.status,
        row.task_description,
        row.created_at,
        row.resolved_at,
      );
      return row.id;
    }

    const result = this.insertWorktreeStmt.run(
      row.session_id,
      row.branch_name,
      row.base_branch,
      row.status,
      row.task_description,
      row.created_at,
      row.resolved_at,
    );
    return Number(result.lastInsertRowid);
  }

  updateWorktreeStatus(id: number, status: WorktreeUpsertInput["status"], resolvedAt: string | null = null): void {
    this.updateWorktreeStatusStmt.run(status, resolvedAt, resolvedAt, id);
  }

  insertCheckpoint(input: CheckpointInsertInput): number {
    const result = this.insertCheckpointStmt.run(
      input.worktree_id,
      input.session_id ?? null,
      input.git_sha,
      toJson(input.test_results),
      toJson(input.artifact_snapshot),
      toJson(input.graph_delta),
      input.created_at ?? isoNow(),
      input.label ?? null,
    );
    return Number(result.lastInsertRowid);
  }

  getCheckpointById(id: number): CheckpointRow | undefined {
    return this.getCheckpointByIdStmt.get(id) as CheckpointRow | undefined;
  }

  listCheckpoints(worktreeId: number): CheckpointRow[] {
    return this.listCheckpointsStmt.all(worktreeId) as CheckpointRow[];
  }

  getWorktreeById(id: number): WorktreeRow | undefined {
    return this.getWorktreeByIdStmt.get(id) as WorktreeRow | undefined;
  }

  listArtifactsByWorktree(worktreeId: number | string): ArtifactRow[] {
    return this.listArtifactsByWorktreeStmt.all(String(worktreeId)) as ArtifactRow[];
  }

  insertComparison(input: ComparisonInsertInput): number {
    const result = this.insertComparisonStmt.run(
      input.worktree_a_id,
      input.worktree_b_id,
      JSON.stringify(input.json_report),
      input.markdown_report,
      input.created_at ?? isoNow(),
    );
    return Number(result.lastInsertRowid);
  }

  getLatestComparisonForPair(worktreeAId: number, worktreeBId: number): ComparisonRow | undefined {
    return this.getLatestComparisonForPairStmt.get(
      worktreeAId,
      worktreeBId,
      worktreeBId,
      worktreeAId,
    ) as ComparisonRow | undefined;
  }
}

export function openLoopwrightDb(dbPath: string): LoopwrightDB {
  return new LoopwrightDB(dbPath);
}
