// /api/activity/recent
//
// System-wide AgentActivity feed. Different from:
//   - /api/runs/:id/activity   — single run
//   - /api/agents/:short/activity — single agent across runs
// This one spans everything, ordered newest first. Used by /overview to
// surface a "recent anomalies" feed without forcing the user to dig into
// a specific run.
//
// Query params:
//   kind=anomaly,error,step.failed   (comma list, normalized via lib/api/activity-types)
//   since=2026-05-09T00:00:00Z       (ISO; OR ?windowMs=3600000 as a relative shortcut)
//   limit=50                          (default 50, max 200)
//   agent=JDGenerator,Matcher        (optional filter)

import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import {
  normalizeKind,
  type ActivityResponse,
  type LogEntry,
  type LogKind,
} from "@/lib/api/activity-types";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_WINDOW_MS = 60 * 60 * 1000; // 1h

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const kindParam = url.searchParams.get("kind");
  const sinceParam = url.searchParams.get("since");
  const windowMsParam = url.searchParams.get("windowMs");
  const agentParam = url.searchParams.get("agent");
  const limitParam = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(limitParam)
    ? Math.min(MAX_LIMIT, Math.max(1, limitParam))
    : DEFAULT_LIMIT;

  // since takes precedence; otherwise windowMs (default 1h).
  let since: Date;
  if (sinceParam) {
    const t = new Date(sinceParam);
    since = !isNaN(t.getTime()) ? t : new Date(Date.now() - DEFAULT_WINDOW_MS);
  } else {
    const w = Number(windowMsParam);
    since = new Date(
      Date.now() - (Number.isFinite(w) && w > 0 ? w : DEFAULT_WINDOW_MS),
    );
  }

  const allowedKinds: Set<LogKind> | null = kindParam
    ? new Set(
        kindParam
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((k) => normalizeKind(k)),
      )
    : null;

  const agents = agentParam
    ? agentParam.split(",").map((s) => s.trim()).filter(Boolean)
    : null;

  // Pull a generous slice and filter in JS — kind is stored as a free
  // string that we normalize, so a `where: { type: { in: [...] } }`
  // wouldn't catch e.g. legacy "step_failed" rows. limit*4 keeps the
  // slice useful after filtering.
  const where: Record<string, unknown> = { createdAt: { gte: since } };
  if (agents && agents.length) where.agentName = { in: agents };

  const rows = await prisma.agentActivity.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: Math.min(2000, limit * 4),
  });

  let entries: LogEntry[] = rows.map((a) => ({
    id: a.id,
    ts: a.createdAt.toISOString(),
    agent: a.agentName || a.nodeId || "system",
    kind: normalizeKind(a.type),
    message: a.narrative,
    metadata: parseJson(a.metadata),
    runId: a.runId,
    synthetic: false,
  }));

  if (allowedKinds) {
    entries = entries.filter((e) => allowedKinds.has(e.kind));
  }

  entries = entries.slice(0, limit);

  const body: ActivityResponse = {
    entries,
    nextCursor: null,
    total: entries.length,
    fetchedAt: new Date().toISOString(),
  };
  return NextResponse.json(body);
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
