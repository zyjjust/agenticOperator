// /api/agents/:short/activity
//
// Cross-run activity log filtered by agentName. Used by /workflow Inspector
// to show "what has JDGenerator been doing lately, across runs". Different
// from /api/runs/:id/activity which is timeline of ONE run; here we want
// the most recent N narrative lines this agent emitted, regardless of run.

import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import { byShort } from "@/lib/agent-mapping";
import { byShortFunction } from "@/lib/agent-functions";
import {
  normalizeKind,
  type ActivityResponse,
  type LogEntry,
} from "@/lib/api/activity-types";

type RouteCtx = { params: Promise<{ short: string }> };

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export async function GET(req: Request, ctx: RouteCtx): Promise<Response> {
  const { short } = await ctx.params;
  if (!byShort(short) && !byShortFunction(short)) {
    return NextResponse.json(
      { error: "NOT_FOUND", message: `agent ${short} not registered` },
      { status: 404 },
    );
  }

  const url = new URL(req.url);
  const limit = clamp(
    Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT),
    10,
    MAX_LIMIT,
  );
  const kind = url.searchParams.get("kind");
  const before = url.searchParams.get("before"); // ISO cursor — fetch older than this

  const where: Record<string, unknown> = { agentName: short };
  if (before) {
    const t = new Date(before);
    if (!isNaN(t.getTime())) where.createdAt = { lt: t };
  }

  const rows = await prisma.agentActivity.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit + 1, // peek one extra to know if more rows exist
  });

  const truncated = rows.length > limit;
  const view = truncated ? rows.slice(0, limit) : rows;

  let entries: LogEntry[] = view.map((a) => ({
    id: a.id,
    ts: a.createdAt.toISOString(),
    agent: short,
    kind: normalizeKind(a.type),
    message: a.narrative,
    metadata: parseJson(a.metadata),
    runId: a.runId,
    synthetic: false,
  }));

  if (kind) {
    const allowed = new Set(kind.split(",").map((s) => s.trim()));
    entries = entries.filter((e) => allowed.has(e.kind));
  }

  const nextCursor = truncated && view.length > 0
    ? view[view.length - 1].createdAt.toISOString()
    : null;

  const body: ActivityResponse = {
    entries,
    nextCursor,
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
