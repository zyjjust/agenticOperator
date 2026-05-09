// Shared activity-log types used by /api/runs/[id]/activity and
// /api/agents/[short]/activity. Both endpoints return rows of the same
// shape so the LogStream UI component can render either source without
// branching.
//
// Activity is "semantic logging" — agents emit AgentActivity rows when
// something interesting happens (step state transition, tool call,
// decision, anomaly). We do NOT capture stdout/stderr; that's noise.

export type LogKind =
  | "step.started"
  | "step.completed"
  | "step.failed"
  | "step.retrying"
  | "narrative"
  | "tool"
  | "decision"
  | "anomaly"
  | "error"
  | "hitl"
  | "info";

export type LogEntry = {
  id: string;
  /** ISO timestamp. */
  ts: string;
  /** Agent short name (e.g. "JDGenerator"). May be "system" for synthesized rows. */
  agent: string;
  kind: LogKind;
  /** Human-readable line. */
  message: string;
  /** Optional structured metadata (parsed JSON when stored as string). */
  metadata?: Record<string, unknown> | null;
  /** Run id (always present for per-agent endpoint where rows span runs). */
  runId: string | null;
  /** Workflow step id when this row was synthesized from a step row. */
  stepId?: string | null;
  /** When emitted from a synthesized step row (failure / state transition). */
  synthetic?: boolean;
};

export type ActivityResponse = {
  entries: LogEntry[];
  /** Cursor for "load older" — null when at the head of available data. */
  nextCursor: string | null;
  /** Total rows in the underlying table for the filter (may be undefined for cheap-path queries). */
  total?: number;
  fetchedAt: string;
};

/** Map an AgentActivity.type string to a LogKind. Tolerant of legacy values. */
export function normalizeKind(type: string | null | undefined): LogKind {
  if (!type) return "info";
  const t = type.toLowerCase();
  if (t.includes("started") || t === "step_started") return "step.started";
  if (t.includes("completed") || t === "step_completed") return "step.completed";
  if (t.includes("failed") || t === "step_failed" || t === "fail") return "step.failed";
  if (t === "retrying" || t === "retry") return "step.retrying";
  if (t === "tool" || t === "tool_call") return "tool";
  if (t === "decision") return "decision";
  if (t === "anomaly" || t === "warn" || t === "warning") return "anomaly";
  if (t === "error" || t === "err") return "error";
  if (t === "hitl" || t === "human") return "hitl";
  if (t === "narrative" || t === "log") return "narrative";
  return "info";
}
