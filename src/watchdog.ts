import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

type LoggerLike = Pick<Console, "log" | "warn" | "error">;

type RawEvent = Record<string, unknown> & {
  event_type?: string;
  type?: string;
  session_id?: string;
  sessionId?: string;
  timestamp?: string;
  ts?: string;
};

export interface WatchdogOptions {
  eventsPath: string;
  idleThresholdMs?: number;
  pollIntervalMs?: number;
  logger?: LoggerLike;
}

export interface WatchdogState {
  sessions: Map<string, number>;
  idleEmitted: Set<string>;
  finishedEmitted: Set<string>;
}

const DEFAULT_IDLE_THRESHOLD_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const TERMINAL_EVENT_TYPES = new Set([
  "session_end",
  "agent_finished",
  "AGENT_FINISHED",
  "agent_complete",
  "agent_completed",
]);

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function pickEventType(event: RawEvent): string | undefined {
  return asString(event.event_type) ?? asString(event.type);
}

function pickSessionId(event: RawEvent): string | undefined {
  return asString(event.session_id) ?? asString(event.sessionId);
}

function pickTimestamp(event: RawEvent): string | undefined {
  return asString(event.timestamp) ?? asString(event.ts);
}

function safeParseTimestampMs(timestamp: string): number | undefined {
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? ms : undefined;
}

function appendJsonl(eventsPath: string, event: Record<string, unknown>): void {
  mkdirSync(dirname(eventsPath), { recursive: true });
  appendFileSync(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
}

export class Watchdog {
  readonly eventsPath: string;
  readonly idleThresholdMs: number;
  readonly pollIntervalMs: number;

  private readonly logger: LoggerLike;
  private readonly sessions = new Map<string, number>();
  private readonly idleEmitted = new Set<string>();
  private readonly finishedEmitted = new Set<string>();
  private offsetBytes = 0;
  private remainder = "";
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  private pendingPoll = false;

  constructor(options: WatchdogOptions) {
    this.eventsPath = options.eventsPath;
    this.idleThresholdMs = options.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.logger = options.logger ?? console;
  }

  start(): this {
    if (this.timer) return this;
    void this.pollOnce();
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, this.pollIntervalMs);
    return this;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  getState(): WatchdogState {
    return {
      sessions: new Map(this.sessions),
      idleEmitted: new Set(this.idleEmitted),
      finishedEmitted: new Set(this.finishedEmitted),
    };
  }

  async pollOnce(): Promise<void> {
    if (this.polling) {
      this.pendingPoll = true;
      return;
    }

    this.polling = true;
    try {
      await this.processNewEvents();
      this.emitIdleEventsIfNeeded();
    } finally {
      this.polling = false;
      if (this.pendingPoll) {
        this.pendingPoll = false;
        queueMicrotask(() => {
          void this.pollOnce();
        });
      }
    }
  }

  private async processNewEvents(): Promise<void> {
    if (!existsSync(this.eventsPath)) {
      this.offsetBytes = 0;
      this.remainder = "";
      return;
    }

    try {
      const buffer = Buffer.from(await Bun.file(this.eventsPath).arrayBuffer());
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
      this.logger.error("[watchdog] failed reading events file", error);
    }
  }

  private ingestLine(line: string): void {
    let event: RawEvent;
    try {
      event = JSON.parse(line) as RawEvent;
    } catch (error) {
      this.logger.warn("[watchdog] malformed JSONL line skipped", { line, error });
      return;
    }

    const sessionId = pickSessionId(event);
    const timestamp = pickTimestamp(event);
    if (!sessionId || !timestamp) return;

    const eventMs = safeParseTimestampMs(timestamp);
    if (eventMs !== undefined) {
      this.sessions.set(sessionId, eventMs);
    }

    const eventType = pickEventType(event);
    if (eventType && eventType !== "AGENT_IDLE") {
      this.idleEmitted.delete(sessionId);
    }

    if (!eventType) return;
    if (!TERMINAL_EVENT_TYPES.has(eventType)) return;
    if (this.finishedEmitted.has(sessionId)) return;

    this.finishedEmitted.add(sessionId);
    appendJsonl(this.eventsPath, {
      event_type: "AGENT_FINISHED",
      session_id: sessionId,
      timestamp: new Date().toISOString(),
      reason: eventType === "session_end" ? "session_end" : eventType,
    });
  }

  private emitIdleEventsIfNeeded(): void {
    const now = Date.now();
    for (const [sessionId, lastSeenMs] of this.sessions.entries()) {
      if (this.finishedEmitted.has(sessionId)) continue;
      if (this.idleEmitted.has(sessionId)) continue;

      const idleDurationMs = now - lastSeenMs;
      if (idleDurationMs <= this.idleThresholdMs) continue;

      this.idleEmitted.add(sessionId);
      appendJsonl(this.eventsPath, {
        event_type: "AGENT_IDLE",
        session_id: sessionId,
        timestamp: new Date(now).toISOString(),
        idle_since: new Date(lastSeenMs).toISOString(),
        idle_duration_ms: idleDurationMs,
      });
    }
  }
}

export function startWatchdog(options: WatchdogOptions): Watchdog {
  return new Watchdog(options).start();
}
