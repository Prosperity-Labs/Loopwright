import { existsSync, mkdirSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { openLoopwrightDb, type JsonValue } from "./db.ts";

type LoggerLike = Pick<Console, "log" | "warn" | "error">;

type BridgeEvent = Record<string, unknown> & {
  event_type?: string;
  type?: string;
  timestamp?: string;
};

export interface EventBridgeOptions {
  eventsPath: string;
  dbPath: string;
  logger?: LoggerLike;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asJsonValue(value: unknown): JsonValue | undefined {
  return value as JsonValue | undefined;
}

function pickSessionId(event: BridgeEvent): string | undefined {
  return (
    asString(event.session_id) ??
    asString(asObject(event.session)?.id) ??
    asString(event.sessionId)
  );
}

function pickEventType(event: BridgeEvent): string | undefined {
  return asString(event.event_type) ?? asString(event.type);
}

function pickTimestamp(event: BridgeEvent): string | undefined {
  return asString(event.timestamp) ?? asString(event.ts);
}

export class EventBridge {
  readonly eventsPath: string;
  readonly dbPath: string;
  private readonly logger: LoggerLike;
  private readonly db;

  private dirWatcher?: FSWatcher;
  private fileWatcher?: FSWatcher;
  private offsetBytes = 0;
  private remainder = "";
  private flushTimer?: Timer;
  private processing = false;
  private pendingFlush = false;

  constructor(options: EventBridgeOptions) {
    this.eventsPath = options.eventsPath;
    this.dbPath = options.dbPath;
    this.logger = options.logger ?? console;
    mkdirSync(dirname(this.eventsPath), { recursive: true });
    this.db = openLoopwrightDb(this.dbPath);
  }

  async start(): Promise<void> {
    this.watchParentDirectory();
    this.attachFileWatcherIfPresent();
    await this.processAvailableLines();
  }

  close(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.dirWatcher?.close();
    this.fileWatcher?.close();
    this.db.close();
  }

  async processAvailableLines(): Promise<void> {
    if (this.processing) {
      this.pendingFlush = true;
      return;
    }

    this.processing = true;
    try {
      if (!existsSync(this.eventsPath)) {
        this.offsetBytes = 0;
        this.remainder = "";
        return;
      }

      const file = Bun.file(this.eventsPath);
      const buffer = Buffer.from(await file.arrayBuffer());

      if (buffer.byteLength < this.offsetBytes) {
        this.offsetBytes = 0;
        this.remainder = "";
      }

      const chunk = buffer.subarray(this.offsetBytes).toString("utf8");
      this.offsetBytes = buffer.byteLength;

      if (!chunk && !this.remainder) return;

      const combined = this.remainder + chunk;
      const lines = combined.split(/\r?\n/);
      this.remainder = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        this.ingestLine(line);
      }
    } catch (error) {
      this.logger.error("[bridge] failed to process events.jsonl", error);
    } finally {
      this.processing = false;
      if (this.pendingFlush) {
        this.pendingFlush = false;
        queueMicrotask(() => {
          void this.processAvailableLines();
        });
      }
    }
  }

  private watchParentDirectory(): void {
    const parent = dirname(this.eventsPath);
    this.dirWatcher = watch(parent, (_eventType, filename) => {
      if (!filename) return;
      if (filename.toString() !== basename(this.eventsPath)) return;
      if (!existsSync(this.eventsPath)) {
        this.fileWatcher?.close();
        this.fileWatcher = undefined;
      }
      this.attachFileWatcherIfPresent();
      this.scheduleFlush();
    });
  }

  private attachFileWatcherIfPresent(): void {
    if (this.fileWatcher && !existsSync(this.eventsPath)) {
      this.fileWatcher.close();
      this.fileWatcher = undefined;
    }
    if (this.fileWatcher || !existsSync(this.eventsPath)) return;
    this.fileWatcher = watch(this.eventsPath, () => {
      this.scheduleFlush();
    });
  }

  private scheduleFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.processAvailableLines();
    }, 25);
  }

  private ingestLine(line: string): void {
    let parsed: BridgeEvent;
    try {
      parsed = JSON.parse(line) as BridgeEvent;
    } catch (error) {
      this.logger.warn("[bridge] malformed JSONL line skipped", { line, error });
      return;
    }

    const eventType = pickEventType(parsed);
    if (!eventType) {
      this.logger.warn("[bridge] event missing event_type/type, skipping", parsed);
      return;
    }

    const timestamp = pickTimestamp(parsed);
    const sessionId = pickSessionId(parsed);

    switch (eventType) {
      case "session_start":
        if (!sessionId) {
          this.logger.warn("[bridge] session_start missing session_id", parsed);
          return;
        }
        this.db.markSessionStart(sessionId, timestamp, {
          filepath: asString(parsed.filepath) ?? asString(parsed.path),
          project: asString(parsed.project),
        });
        return;

      case "session_end":
        if (!sessionId) {
          this.logger.warn("[bridge] session_end missing session_id", parsed);
          return;
        }
        this.db.markSessionEnd(sessionId, timestamp);
        return;

      case "tool_call": {
        if (!sessionId) {
          this.logger.warn("[bridge] tool_call missing session_id", parsed);
          return;
        }
        const tool = asObject(parsed.tool);
        this.db.insertToolCall({
          session_id: sessionId,
          tool_name: asString(parsed.tool_name) ?? asString(tool?.name) ?? asString(parsed.name) ?? "unknown",
          args_json: asJsonValue(parsed.args ?? tool?.args),
          result_json: asJsonValue(parsed.result ?? parsed.output),
          status: asString(parsed.status) ?? null,
          timestamp,
          raw_event_json: asJsonValue(parsed),
        });
        return;
      }

      case "file_write":
      case "worktree_file_change":
      case "file_change": {
        const filePath =
          asString(parsed.file_path) ??
          asString(parsed.path) ??
          asString(asObject(parsed.file)?.path);
        if (!filePath) {
          this.logger.warn("[bridge] file event missing file_path", parsed);
          return;
        }
        this.db.insertArtifact({
          session_id: sessionId ?? null,
          worktree_id:
            (typeof parsed.worktree_id === "string" || typeof parsed.worktree_id === "number"
              ? parsed.worktree_id
              : null),
          file_path: filePath,
          event_type: eventType,
          content: asString(parsed.content) ?? null,
          metadata_json: asJsonValue({
            change_type: asString(parsed.change_type),
            ...(asObject(parsed.metadata) ?? {}),
          }),
          timestamp,
          raw_event_json: asJsonValue(parsed),
        });
        return;
      }

      default:
        return;
    }
  }
}

export async function startEventBridge(options: EventBridgeOptions): Promise<EventBridge> {
  const bridge = new EventBridge(options);
  await bridge.start();
  return bridge;
}

if (import.meta.main) {
  const eventsPath = Bun.argv[2] ?? "events.jsonl";
  const dbPath = Bun.argv[3] ?? "sessions.db";

  const bridge = await startEventBridge({ eventsPath, dbPath });
  console.log(`[bridge] watching ${eventsPath} -> ${dbPath}`);

  const shutdown = () => {
    bridge.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
