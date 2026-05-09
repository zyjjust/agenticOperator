// AgentLogger — the unified write surface for AgentActivity rows.
//
// Problem we're solving: every agent today hand-writes
//   await prisma.agentActivity.create({
//     data: {
//       nodeId: AGENT_ID, agentName: AGENT_NAME, type: "...",
//       narrative: "...", metadata: JSON.stringify({...}),
//     },
//   });
// That's 7 lines, easy to forget a field, and silently breaks if metadata
// can't be serialized. Most agents skip it entirely → /workflow Inspector
// and /live Logs Tab end up empty.
//
// This module gives every agent a 1-line API:
//   const log = createAgentLogger({ agent: "createJD", nodeId: "4" });
//   await log.event("event_received", `narrative…`, { metadata });
//   await log.done(`JD generated · ${ms}ms`, { jdId });
//   await log.anomaly(`BOSS API 429`, { retry: true });
//
// Logging never throws — a DB write failure just goes to console.warn so
// it doesn't crash the agent. That's the right tradeoff: missing log
// lines are recoverable, crashed runs aren't.

import { prisma } from "./db";

export type AgentLogContext = {
  /** Agent short name (e.g. "createJD"). Used as agentName + fallback nodeId. */
  agent: string;
  /** Legacy WS short id (e.g. "4"). Falls back to `agent` when absent. */
  nodeId?: string;
  /** Bind the logger to a specific WorkflowRun. */
  runId?: string | null;
};

// Type strings written into AgentActivity.type. Aligned with
// lib/api/activity-types.ts → normalizeKind() so the UI groups them
// consistently. Adding new types is fine; normalizeKind defaults to "info".
export type AgentLogType =
  | "event_received"
  | "event_emitted"
  | "agent_start"
  | "agent_complete"
  | "agent_error"
  | "tool"
  | "decision"
  | "anomaly"
  | "hitl"
  | "step.started"
  | "step.completed"
  | "step.failed"
  | "step.retrying"
  | "info";

export type AgentLogger = {
  /** Generic write — when none of the convenience methods quite fit. */
  log(
    type: AgentLogType | string,
    narrative: string,
    metadata?: Record<string, unknown>,
  ): Promise<void>;

  /** Inbound event — agent received it and is about to process. */
  event(
    type: "event_received" | "event_emitted",
    narrative: string,
    metadata?: Record<string, unknown>,
  ): Promise<void>;

  /** Tool / external system call (LLM, HTTP, DB). */
  tool(narrative: string, metadata?: Record<string, unknown>): Promise<void>;

  /** Important branching decision (with optional confidence). */
  decision(narrative: string, metadata?: Record<string, unknown>): Promise<void>;

  /** Recoverable anomaly (rate limit, transient error, low confidence). */
  anomaly(narrative: string, metadata?: Record<string, unknown>): Promise<void>;

  /** Unrecoverable error (after retries exhausted). */
  error(narrative: string, metadata?: Record<string, unknown>): Promise<void>;

  /** Human-in-the-loop pending. */
  hitl(narrative: string, metadata?: Record<string, unknown>): Promise<void>;

  /** Agent finished its work successfully. */
  done(narrative: string, metadata?: Record<string, unknown>): Promise<void>;

  /** Returns a child logger with extra context merged in. */
  child(extra: Partial<AgentLogContext>): AgentLogger;

  /** Read-only view of the bound context. */
  readonly ctx: Readonly<AgentLogContext>;
};

/** Errors should never escape — agents shouldn't crash because logging failed. */
async function safeWrite(
  ctx: AgentLogContext,
  type: string,
  narrative: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    await prisma.agentActivity.create({
      data: {
        runId: ctx.runId ?? null,
        nodeId: ctx.nodeId ?? ctx.agent,
        agentName: ctx.agent,
        type,
        narrative,
        metadata: metadata ? safeStringify(metadata) : null,
      },
    });
  } catch (e) {
    // Still surface the failure — silently swallowing it would hide a
    // schema/connection bug. console.warn is fine; the agent run keeps going.
    // eslint-disable-next-line no-console
    console.warn(
      `[agentLogger:${ctx.agent}] failed to persist activity (${type}): ${(e as Error).message}`,
    );
  }
}

function safeStringify(v: Record<string, unknown>): string {
  try {
    return JSON.stringify(v);
  } catch {
    // Circular ref / non-serializable. Fall back to a best-effort string so
    // the row still has *something* in metadata for debugging.
    try {
      const seen = new WeakSet();
      return JSON.stringify(v, (_k, val) => {
        if (val && typeof val === "object") {
          if (seen.has(val)) return "[circular]";
          seen.add(val);
        }
        return val;
      });
    } catch {
      return JSON.stringify({ _unserializable: true });
    }
  }
}

export function createAgentLogger(ctx: AgentLogContext): AgentLogger {
  const bound: AgentLogContext = { ...ctx };

  const logger: AgentLogger = {
    ctx: bound,
    log: (type, narrative, metadata) => safeWrite(bound, type, narrative, metadata),
    event: (type, narrative, metadata) => safeWrite(bound, type, narrative, metadata),
    tool: (narrative, metadata) => safeWrite(bound, "tool", narrative, metadata),
    decision: (narrative, metadata) => safeWrite(bound, "decision", narrative, metadata),
    anomaly: (narrative, metadata) => safeWrite(bound, "anomaly", narrative, metadata),
    error: (narrative, metadata) => safeWrite(bound, "agent_error", narrative, metadata),
    hitl: (narrative, metadata) => safeWrite(bound, "hitl", narrative, metadata),
    done: (narrative, metadata) => safeWrite(bound, "agent_complete", narrative, metadata),
    child: (extra) => createAgentLogger({ ...bound, ...extra }),
  };
  return logger;
}

/**
 * Minimal interface that `chatComplete` and other instrumentation hooks
 * accept. AgentLogger satisfies this naturally; tests can stub it.
 */
export type LoggerLike = {
  tool(narrative: string, metadata?: Record<string, unknown>): Promise<void>;
  anomaly(narrative: string, metadata?: Record<string, unknown>): Promise<void>;
};
