// GET /api/audit — recent AuditLog rows.
// Filters: ?eventName=...&traceId=...&source=...&limit=N
// AuditLog is populated by the EM library (em.publish writes one row per
// publish per source). Today the table may be empty (em.publish library
// not yet shipped); we still return a well-formed response with meta.empty=true
// so the UI can render the right empty state.

import { NextResponse } from "next/server";
import { prisma } from "@/server/db";

export const dynamic = "force-dynamic";

export type AuditLogRow = {
  id: string;
  eventName: string;
  traceId: string;
  payloadDigest: string;
  source: string;
  createdAt: string;
};

export type AuditResponse = {
  rows: AuditLogRow[];
  total: number;
  meta: {
    empty: boolean;
    generatedAt: string;
  };
};

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const eventName = url.searchParams.get("eventName") ?? undefined;
  const traceId = url.searchParams.get("traceId") ?? undefined;
  const source = url.searchParams.get("source") ?? undefined;
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 500);

  const where: Record<string, unknown> = {};
  if (eventName) where.eventName = eventName;
  if (traceId) where.traceId = traceId;
  if (source) where.source = source;

  let rows: AuditLogRow[] = [];
  let total = 0;
  try {
    const [items, count] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        select: {
          id: true,
          eventName: true,
          traceId: true,
          payloadDigest: true,
          source: true,
          createdAt: true,
        },
      }),
      prisma.auditLog.count({ where }),
    ]);
    rows = items.map((r) => ({
      id: r.id,
      eventName: r.eventName,
      traceId: r.traceId,
      payloadDigest: r.payloadDigest,
      source: r.source,
      createdAt: r.createdAt.toISOString(),
    }));
    total = count;
  } catch {
    // DB unavailable — return empty so UI renders its empty state.
  }

  const body: AuditResponse = {
    rows,
    total,
    meta: { empty: rows.length === 0, generatedAt: new Date().toISOString() },
  };
  return NextResponse.json(body);
}
