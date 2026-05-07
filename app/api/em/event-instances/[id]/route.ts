// GET /api/em/event-instances/:id
// Single instance + immediate causality (parent + first-level children).
// Foundation for the future /events/:name/instances/:id trail page.

import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import type { EventInstanceRow } from "../route";

export const dynamic = "force-dynamic";

export type EventInstanceDetail = EventInstanceRow & {
  parent: EventInstanceRow | null;
  children: EventInstanceRow[];
};

type RouteCtx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: RouteCtx): Promise<Response> {
  const { id } = await ctx.params;
  try {
    const row = await prisma.eventInstance.findUnique({ where: { id } });
    if (!row) {
      return NextResponse.json(
        { error: "NOT_FOUND", message: `event instance ${id} not found` },
        { status: 404 },
      );
    }
    const [parent, children] = await Promise.all([
      row.causedByEventId
        ? prisma.eventInstance.findUnique({ where: { id: row.causedByEventId } })
        : Promise.resolve(null),
      prisma.eventInstance.findMany({
        where: { causedByEventId: id },
        orderBy: { ts: "asc" },
        take: 50,
      }),
    ]);
    const body: EventInstanceDetail = {
      ...toRow(row),
      parent: parent ? toRow(parent) : null,
      children: children.map(toRow),
    };
    return NextResponse.json(body);
  } catch (err) {
    return NextResponse.json(
      { error: "INTERNAL", message: (err as Error).message },
      { status: 500 },
    );
  }
}

function toRow(r: any): EventInstanceRow {
  return {
    id: r.id,
    externalEventId: r.externalEventId,
    name: r.name,
    source: r.source,
    status: r.status,
    rejectionType: r.rejectionType,
    rejectionReason: r.rejectionReason,
    schemaErrors: r.schemaErrors ? safeParse(r.schemaErrors) : null,
    schemaVersionUsed: r.schemaVersionUsed,
    triedVersions: r.triedVersions ? safeParseArray(r.triedVersions) : null,
    causedByEventId: r.causedByEventId,
    causedByName: r.causedByName,
    payloadSummary: r.payloadSummary,
    ts: r.ts.toISOString(),
  };
}
function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
function safeParseArray(s: string): string[] | null {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}
