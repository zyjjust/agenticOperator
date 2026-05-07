// GET /api/em/event-instances
//
// Generic list endpoint over the EventInstance table.
// Drives the DLQ / Rejected / Instances / Causality sub-tabs on /events.
//
// Query params:
//   status     "accepted" | "rejected_schema" | "rejected_filter" | "duplicate" | "meta_rejection" | "em_degraded"
//   statusIn   comma-separated list, takes priority over status
//   name       event name exact match
//   source     publisher source exact match
//   externalEventId    lookup by upstream id (returns 0 or 1 row)
//   causedByEventId    lookup direct children in the causality graph
//   q          substring match on name OR external_event_id (case-insensitive on lowered)
//   limit      default 100, max 500
//   cursor     pagination cursor (last seen id, descending by ts)

import { NextResponse } from "next/server";
import { prisma } from "@/server/db";

export const dynamic = "force-dynamic";

export type EventInstanceRow = {
  id: string;
  externalEventId: string | null;
  name: string;
  source: string;
  status: string;
  rejectionType: string | null;
  rejectionReason: string | null;
  schemaErrors: unknown | null;
  schemaVersionUsed: string | null;
  triedVersions: string[] | null;
  causedByEventId: string | null;
  causedByName: string | null;
  payloadSummary: string | null;
  ts: string;
};

export type EventInstancesResponse = {
  rows: EventInstanceRow[];
  total: number;
  nextCursor: string | null;
  meta: { generatedAt: string };
};

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const status = url.searchParams.get("status") ?? undefined;
  const statusInRaw = url.searchParams.get("statusIn");
  const name = url.searchParams.get("name") ?? undefined;
  const source = url.searchParams.get("source") ?? undefined;
  const externalEventId = url.searchParams.get("externalEventId") ?? undefined;
  const causedByEventId = url.searchParams.get("causedByEventId") ?? undefined;
  const q = url.searchParams.get("q")?.trim() ?? "";
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 100), 1), 500);
  const cursor = url.searchParams.get("cursor") ?? undefined;

  const where: Record<string, unknown> = {};
  if (statusInRaw) {
    where.status = { in: statusInRaw.split(",").map((s) => s.trim()).filter(Boolean) };
  } else if (status) {
    where.status = status;
  }
  if (name) where.name = name;
  if (source) where.source = source;
  if (externalEventId) where.externalEventId = externalEventId;
  if (causedByEventId) where.causedByEventId = causedByEventId;
  if (q) {
    // SQLite doesn't support `mode: 'insensitive'`; the columns are stored
    // mixed-case but event names are conventionally UPPER_SNAKE so we match
    // raw on `name`, and case-sensitively on externalEventId.
    where.OR = [
      { name: { contains: q.toUpperCase() } },
      { externalEventId: { contains: q } },
    ];
  }

  let rows: EventInstanceRow[] = [];
  let total = 0;
  try {
    const [items, count] = await Promise.all([
      prisma.eventInstance.findMany({
        where,
        orderBy: [{ ts: "desc" }, { id: "desc" }],
        take: limit + 1, // +1 to detect more
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }),
      prisma.eventInstance.count({ where }),
    ]);
    const hasMore = items.length > limit;
    const sliced = hasMore ? items.slice(0, limit) : items;
    rows = sliced.map(toRow);
    total = count;
    const nextCursor = hasMore ? sliced[sliced.length - 1]!.id : null;
    const body: EventInstancesResponse = {
      rows,
      total,
      nextCursor,
      meta: { generatedAt: new Date().toISOString() },
    };
    return NextResponse.json(body);
  } catch (err) {
    return NextResponse.json(
      {
        error: "INTERNAL",
        message: (err as Error).message,
      },
      { status: 500 },
    );
  }
}

function toRow(r: {
  id: string;
  externalEventId: string | null;
  name: string;
  source: string;
  status: string;
  rejectionType: string | null;
  rejectionReason: string | null;
  schemaErrors: string | null;
  schemaVersionUsed: string | null;
  triedVersions: string | null;
  causedByEventId: string | null;
  causedByName: string | null;
  payloadSummary: string | null;
  ts: Date;
}): EventInstanceRow {
  return {
    id: r.id,
    externalEventId: r.externalEventId,
    name: r.name,
    source: r.source,
    status: r.status,
    rejectionType: r.rejectionType,
    rejectionReason: r.rejectionReason,
    schemaErrors: parseJson(r.schemaErrors),
    schemaVersionUsed: r.schemaVersionUsed,
    triedVersions: parseJsonArray(r.triedVersions),
    causedByEventId: r.causedByEventId,
    causedByName: r.causedByName,
    payloadSummary: r.payloadSummary,
    ts: r.ts.toISOString(),
  };
}

function parseJson(s: string | null): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
function parseJsonArray(s: string | null): string[] | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}
