// /api/agents/health
//
// Returns a real-time health snapshot for every known agent, aggregated
// from AgentActivity rows in the last `window` ms (default 5min).
//
// Replaces the hardcoded `running / review / degraded` markers on the
// /workflow canvas with values that actually reflect what each agent has
// been doing: how many steps completed vs failed, how many tool/decision
// rows, error rate, whether it's currently inside an unfinished step.

import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import { AGENT_MAP } from "@/lib/agent-mapping";
import { normalizeKind } from "@/lib/api/activity-types";

export type AgentHealthStatus =
  | "idle" // no activity in window
  | "running" // currently inside a step (started without matching completed)
  | "healthy" // recent activity, no errors
  | "degraded" // some errors / anomalies but mostly OK
  | "failed"; // dominant failures in window

export type AgentHealth = {
  short: string;
  status: AgentHealthStatus;
  /** ISO timestamp of the most recent AgentActivity row in the window. */
  lastActivityAt: string | null;
  windowMs: number;
  counts: {
    started: number;
    completed: number;
    failed: number;
    error: number;
    anomaly: number;
    tool: number;
    decision: number;
  };
  /** errors / (started + completed + failed + error + tool). 0 when no samples. */
  errorRate: number;
  /** True when at least one started step in the window has no matching completed. */
  hasRunningStep: boolean;
};

export type AgentsHealthResponse = {
  agents: AgentHealth[];
  windowMs: number;
  generatedAt: string;
};

const DEFAULT_WINDOW_MS = 5 * 60 * 1000;
const MIN_WINDOW_MS = 60 * 1000;
const MAX_WINDOW_MS = 60 * 60 * 1000;

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const windowParam = Number(url.searchParams.get("window") ?? DEFAULT_WINDOW_MS);
  const windowMs = clamp(
    Number.isFinite(windowParam) ? windowParam : DEFAULT_WINDOW_MS,
    MIN_WINDOW_MS,
    MAX_WINDOW_MS,
  );
  const since = new Date(Date.now() - windowMs);

  // One query, sorted desc so we naturally pick the latest row per agent.
  // Cap at 5000 — at 22 agents emitting maybe 5 rows per step, this covers
  // a few hundred concurrent runs comfortably; pathological churn caps
  // gracefully.
  const rows = await prisma.agentActivity.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    take: 5000,
  });

  // Group by agentName.
  const byAgent = new Map<string, typeof rows>();
  for (const r of rows) {
    const name = r.agentName || r.nodeId || "system";
    let arr = byAgent.get(name);
    if (!arr) {
      arr = [];
      byAgent.set(name, arr);
    }
    arr.push(r);
  }

  // Cover all known agents (idle if absent) PLUS any unknown name that
  // showed up in activity (so drifted-from-registry agents still surface).
  const known = new Set(AGENT_MAP.map((a) => a.short));
  const allNames = new Set<string>([...known, ...byAgent.keys()]);

  const agents: AgentHealth[] = [];
  for (const name of allNames) {
    const arr = byAgent.get(name) ?? [];
    agents.push(computeHealth(name, arr, windowMs));
  }

  // Order: failed > degraded > running > healthy > idle, then alpha within.
  const order: Record<AgentHealthStatus, number> = {
    failed: 0,
    degraded: 1,
    running: 2,
    healthy: 3,
    idle: 4,
  };
  agents.sort((a, b) =>
    order[a.status] !== order[b.status]
      ? order[a.status] - order[b.status]
      : a.short.localeCompare(b.short),
  );

  const body: AgentsHealthResponse = {
    agents,
    windowMs,
    generatedAt: new Date().toISOString(),
  };
  return NextResponse.json(body);
}

type ActivityRowLike = {
  type: string | null;
  metadata: string | null;
  createdAt: Date;
};

function computeHealth(
  short: string,
  rows: ActivityRowLike[],
  windowMs: number,
): AgentHealth {
  const counts = {
    started: 0,
    completed: 0,
    failed: 0,
    error: 0,
    anomaly: 0,
    tool: 0,
    decision: 0,
  };
  let lastActivityAt: Date | null = null;
  // Track step started/completed by step name to detect "still running".
  // Falls back to count comparison when step name isn't in metadata.
  const startedSteps = new Set<string>();
  const completedSteps = new Set<string>();

  for (const r of rows) {
    if (!lastActivityAt) lastActivityAt = r.createdAt;
    const kind = normalizeKind(r.type);
    const stepName = extractStepName(r.metadata);

    switch (kind) {
      case "step.started":
        counts.started++;
        if (stepName) startedSteps.add(stepName);
        break;
      case "step.completed":
        counts.completed++;
        if (stepName) completedSteps.add(stepName);
        break;
      case "step.failed":
        counts.failed++;
        break;
      case "error":
        counts.error++;
        break;
      case "anomaly":
        counts.anomaly++;
        break;
      case "tool":
        counts.tool++;
        break;
      case "decision":
        counts.decision++;
        break;
      default:
        // step.retrying / hitl / narrative / info — not counted toward
        // health math but still part of the window.
        break;
    }
  }

  const samples =
    counts.started + counts.completed + counts.failed + counts.error + counts.tool;
  const errorCount = counts.failed + counts.error;
  const errorRate = samples > 0 ? errorCount / samples : 0;

  // "Running" = there's at least one started step we haven't seen completed.
  // Falls back to (started > completed) count when step names absent.
  const hasRunningStep =
    startedSteps.size > 0 || counts.started > 0
      ? Array.from(startedSteps).some((s) => !completedSteps.has(s)) ||
        counts.started > counts.completed
      : false;

  const status = pickStatus({
    rowCount: rows.length,
    errorCount,
    errorRate,
    anomalies: counts.anomaly,
    hasRunningStep,
  });

  return {
    short,
    status,
    lastActivityAt: lastActivityAt?.toISOString() ?? null,
    windowMs,
    counts,
    errorRate,
    hasRunningStep,
  };
}

function pickStatus(args: {
  rowCount: number;
  errorCount: number;
  errorRate: number;
  anomalies: number;
  hasRunningStep: boolean;
}): AgentHealthStatus {
  if (args.rowCount === 0) return "idle";
  // Strong failure signal: 2+ errors OR error-dominant rate.
  if (args.errorCount >= 2 || args.errorRate > 0.3) return "failed";
  // Soft failure signal: any error or repeated anomalies.
  if (args.errorCount > 0 || args.errorRate > 0.1 || args.anomalies >= 2)
    return "degraded";
  if (args.hasRunningStep) return "running";
  return "healthy";
}

function extractStepName(meta: string | null): string | undefined {
  if (!meta) return undefined;
  try {
    const m = JSON.parse(meta) as Record<string, unknown>;
    const v = m.step ?? m.stepName;
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
