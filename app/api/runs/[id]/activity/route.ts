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
import { byShort, byWsId } from "@/lib/agent-mapping";
import { ensureWorkflowRun } from "@/server/agent-logger";

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

// ── POST: external-runtime ingest ──────────────────────────────────
//
// Lets a separate process (e.g. resume-parser-agent on port 3020, or any
// future external service) push activity rows into AO-main's DB without
// importing Prisma. Cross-process logging contract:
//
//   POST /api/runs/{runId}/activity
//   { triggerEvent: "REQUIREMENT_LOGGED",
//     triggerData: { client, jdId },          // optional
//     entries: [
//       { agent: "JDGenerator",  // OR nodeId — we resolve canonical
//         nodeId: "4",
//         type: "tool",         // or step.started / decision / anomaly / ...
//         narrative: "LLM.generateJD · 4218 tokens · 1840ms",
//         metadata: { model: "...", durationMs: 1840, totalTokens: 4218 }
//       },
//       ...
//     ]
//   }
//
// Returns: { runId, written: <count>, agentNamesNormalized: { in: out } }
//
// Side effect: ensures the WorkflowRun row exists (upsert by id) so the
// caller doesn't need to coordinate run lifecycle from outside.

type IngestEntry = {
  agent?: string;
  nodeId?: string;
  type?: string;
  narrative?: string;
  metadata?: Record<string, unknown> | null;
  /** Optional client-side timestamp (ISO). Defaults to server now. */
  ts?: string;
};

type IngestBody = {
  triggerEvent?: string;
  triggerData?: { client?: string; jdId?: string } | Record<string, unknown>;
  entries: IngestEntry[];
};

export async function POST(req: Request, ctx: RouteCtx): Promise<Response> {
  const { id: runId } = await ctx.params;
  if (!runId) {
    return NextResponse.json(
      { error: "BAD_REQUEST", message: "missing run id" },
      { status: 400 },
    );
  }

  let body: IngestBody;
  try {
    body = (await req.json()) as IngestBody;
  } catch (e) {
    return NextResponse.json(
      { error: "BAD_REQUEST", message: `invalid JSON: ${(e as Error).message}` },
      { status: 400 },
    );
  }

  if (!Array.isArray(body.entries) || body.entries.length === 0) {
    return NextResponse.json(
      { error: "BAD_REQUEST", message: "entries[] required (non-empty)" },
      { status: 400 },
    );
  }
  if (body.entries.length > 200) {
    return NextResponse.json(
      { error: "BAD_REQUEST", message: "max 200 entries per call" },
      { status: 400 },
    );
  }

  // Ensure the WorkflowRun row exists. If trigger info missing, infer
  // sensible defaults — we'd rather create an under-described run than
  // drop the activity.
  await ensureWorkflowRun({
    runId,
    triggerEvent: body.triggerEvent ?? "external",
    triggerData: body.triggerData ?? {},
  });

  const namesNormalized: Record<string, string> = {};
  const writes: Array<Promise<unknown>> = [];

  for (const e of body.entries) {
    if (!e.type || !e.narrative) continue; // silently skip malformed
    const nodeId = e.nodeId ?? e.agent ?? "system";
    const requestedAgent = e.agent ?? nodeId;
    // Resolve canonical short via byWsId(nodeId) so all consumers use
    // the registry name. Fallback: caller-supplied agent.
    const canonical = (nodeId && byWsId(nodeId)?.short) ?? requestedAgent;
    if (canonical !== requestedAgent) {
      namesNormalized[requestedAgent] = canonical;
    }
    writes.push(
      prisma.agentActivity.create({
        data: {
          runId,
          nodeId,
          agentName: canonical,
          type: e.type,
          narrative: e.narrative,
          metadata: e.metadata ? JSON.stringify(e.metadata) : null,
          // createdAt defaults to now() — Prisma schema's @default(now()).
          // We deliberately don't honor a client-side `ts` to avoid
          // skewed timelines from misconfigured clients.
        },
      }),
    );
  }

  const results = await Promise.allSettled(writes);
  const written = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.length - written;

  return NextResponse.json({
    runId,
    written,
    failed,
    agentNamesNormalized: namesNormalized,
    fetchedAt: new Date().toISOString(),
  });
}
