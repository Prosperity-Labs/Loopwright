import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface SpawnAgentOptions {
  worktreePath: string;
  prompt: string;
  agentType?: "claude" | "cursor" | "codex";
  /** Model override for the spawned agent. Accepts aliases ("sonnet", "opus", "o3") or full model IDs. */
  model?: string;
  dbPath: string;
  eventsPath: string;
  sessionId?: string;
  worktreeId?: number;
  env?: Record<string, string>;
  commandOverride?: string[];
}

export interface SpawnedAgent {
  agentId: string;
  sessionId: string;
  worktreeId: number | undefined;
  process: ReturnType<typeof Bun.spawn>;
  startedAt: string;
  agentType: string;
  worktreePath: string;
  prompt: string;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6);
}

function buildCommand(agentType: NonNullable<SpawnAgentOptions["agentType"]>, prompt: string, model?: string): string[] {
  switch (agentType) {
    case "cursor":
      return ["cursor", "--cli", prompt];
    case "codex":
      return ["codex", prompt];
    case "claude":
    default: {
      const cmd = ["claude", "--dangerously-skip-permissions", "--print", "--max-turns", "50"];
      if (model) cmd.push("--model", model);
      cmd.push(prompt);
      return cmd;
    }
  }
}

function appendEvent(eventsPath: string, event: Record<string, unknown>): void {
  mkdirSync(dirname(eventsPath), { recursive: true });
  appendFileSync(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
}

export class AgentRegistry {
  private readonly agents = new Map<string, SpawnedAgent>();

  register(agent: SpawnedAgent): void {
    this.agents.set(agent.agentId, agent);
  }

  unregister(agentId: string): void {
    this.agents.delete(agentId);
  }

  get(agentId: string): SpawnedAgent | undefined {
    return this.agents.get(agentId);
  }

  list(): SpawnedAgent[] {
    return [...this.agents.values()];
  }

  clear(): void {
    this.agents.clear();
  }
}

export const registry = new AgentRegistry();

export async function spawnAgent(options: SpawnAgentOptions): Promise<SpawnedAgent> {
  const agentType = options.agentType ?? "claude";
  const agentId = `agent-${agentType}-${Date.now()}-${randomSuffix()}`;
  const sessionId = options.sessionId ?? `session-${agentId}`;
  const startedAt = new Date().toISOString();
  const cmd = options.commandOverride ?? buildCommand(agentType, options.prompt, options.model);

  const env: Record<string, string> = {
    ...(process.env as Record<string, string | undefined>),
    ...(options.env ?? {}),
    LOOPWRIGHT_SESSION_ID: sessionId,
  } as Record<string, string>;

  if (options.worktreeId !== undefined) {
    env.LOOPWRIGHT_WORKTREE_ID = String(options.worktreeId);
  }

  const proc = Bun.spawn({
    cmd,
    cwd: options.worktreePath,
    stdout: "pipe",
    stderr: "pipe",
    env,
  });

  const spawned: SpawnedAgent = {
    agentId,
    sessionId,
    worktreeId: options.worktreeId,
    process: proc,
    startedAt,
    agentType,
    worktreePath: options.worktreePath,
    prompt: options.prompt,
  };

  registry.register(spawned);

  appendEvent(options.eventsPath, {
    event_type: "AGENT_STARTED",
    session_id: sessionId,
    agent_id: agentId,
    agent_type: agentType,
    model: options.model ?? null,
    worktree_path: options.worktreePath,
    worktree_id: options.worktreeId,
    db_path: options.dbPath,
    timestamp: startedAt,
  });

  proc.exited
    .then(() => {
      registry.unregister(agentId);
    })
    .catch(() => {
      registry.unregister(agentId);
    });

  return spawned;
}
