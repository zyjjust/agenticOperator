// /api/runs/:id/activity
//
// Returns the merged activity log for a workflow run. Two sources:
//   1. AgentActivity rows (primary) — agents are expected to write these
//      when they do anything semantically interesting (start step, tool
//      call, decision, anomaly, complete step, error).
//   2. WorkflowStep rows with status=failed and no matching activity —
//      synthesized into log entries so a failed step is never invisible
//      even if the agent forgot to narrate it.
//
// Output is ordered by timestamp ASC (run timeline). Pagination by
// `before` cursor (ISO timestamp) for "load older" if needed.

import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import {
  normalizeKind,
  type ActivityResponse,
  type LogEntry,
} from "@/lib/api/activity-types";
import { byShort } from "@/lib/agent-mapping";

type RouteCtx = { params: Promise<{ id: string }> };

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

export async function GET(req: Request, ctx: RouteCtx): Promise<Response> {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const limit = clamp(
    Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT),
    10,
    MAX_LIMIT,
  );
  const since = url.searchParams.get("since"); // ISO — only newer than this
  const kind = url.searchParams.get("kind"); // optional comma list to filter

  // Confirm the run exists — 404 quickly so the UI knows it's a bad id
  // rather than just empty data.
  const run = await prisma.workflowRun.findUnique({ where: { id } });
  if (!run) {
    return NextResponse.json(
      { error: "NOT_FOUND", message: `run ${id} not found` },
      { status: 404 },
    );
  }

  const where: Record<string, unknown> = { runId: id };
  if (since) {
    const t = new Date(since);
    if (!isNaN(t.getTime())) where.createdAt = { gt: t };
  }

  // Fetch a generous batch — we'll filter by kind / dedupe in-process.
  // limit*2 is a heuristic so post-filter we still have enough rows.
  const [activities, failedSteps] = await Promise.all([
    prisma.agentActivity.findMany({
      where,
      orderBy: { createdAt: "asc" },
      take: limit * 2,
    }),
    prisma.workflowStep.findMany({
      where: { runId: id, status: "failed" },
      orderBy: { startedAt: "asc" },
    }),
  ]);

  const entries: LogEntry[] = [];

  for (const a of activities) {
    entries.push({
      id: a.id,
      ts: a.createdAt.toISOString(),
      agent: a.agentName || resolveAgentFromNodeId(a.nodeId),
      kind: normalizeKind(a.type),
      message: a.narrative,
      metadata: parseJson(a.metadata),
      runId: a.runId,
      synthetic: false,
    });
  }

  // Synthesize a failure log for any failed step that doesn't already have
  // a matching error/step.failed AgentActivity row (within ±2s window).
  for (const s of failedSteps) {
    const ts = s.completedAt ?? s.startedAt;
    const matched = entries.some(
      (e) =>
        (e.kind === "step.failed" || e.kind === "error") &&
        e.agent === resolveAgentFromNodeId(s.nodeId) &&
        Math.abs(new Date(e.ts).getTime() - ts.getTime()) < 2_000,
    );
    if (matched) continue;
    entries.push({
      id: `synth-${s.id}`,
      ts: ts.toISOString(),
      agent: resolveAgentFromNodeId(s.nodeId),
      kind: "step.failed",
      message: s.error || `step ${s.stepName} failed`,
      metadata: { stepName: s.stepName, durationMs: s.durationMs },
      runId: id,
      stepId: s.id,
      synthetic: true,
    });
  }

  entries.sort((a, b) => a.ts.localeCompare(b.ts));

  // Optional kind filter (comma list).
  let filtered = entries;
  if (kind) {
    const allowed = new Set(kind.split(",").map((s) => s.trim()));
    filtered = entries.filter((e) => allowed.has(e.kind));
  }

  const trimmed = filtered.slice(-limit);
  const nextCursor =
    filtered.length > limit && trimmed[0]
      ? new Date(new Date(trimmed[0].ts).getTime() - 1).toISOString()
      : null;

  const body: ActivityResponse = {
    entries: trimmed,
    nextCursor,
    total: filtered.length,
    fetchedAt: new Date().toISOString(),
  };
  return NextResponse.json(body);
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function parseJson(s: string | null): Record<string, unknown> | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// nodeId may be a WS-flavored short id (e.g. "1-1") or already a proper short
// (e.g. "ReqSync"). Try both.
function resolveAgentFromNodeId(nodeId: string): string {
  if (!nodeId) return "system";
  if (byShort(nodeId)) return nodeId;
  // Could try byWsId too, but agentName on AgentActivity is usually right
  // already. Default to nodeId so the UI shows something rather than blank.
  return nodeId;
}
