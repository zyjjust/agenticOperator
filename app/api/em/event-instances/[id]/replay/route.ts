// POST /api/em/event-instances/:id/replay
//
// Re-publish a rejected EventInstance through em.publish. The original row
// stays in the table for audit; a fresh attempt produces a NEW row (so you
// can see both attempts in the trail). We pass emitRejectionOnFailure=false
// — the caller is acknowledging this is a deliberate replay; we don't want
// to double-NACK RAAS for the same payload.
//
// Today we replay the payload_summary, which is the parsed envelope. For
// schema-rejected events we don't have full original payload (Inngest does;
// we don't store it), so replay only makes sense if you've fixed the schema
// and want to see if a similar event would now pass. That is the typical
// debugging workflow.

import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import { em } from "@/server/em";

export const dynamic = "force-dynamic";

type RouteCtx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, ctx: RouteCtx): Promise<Response> {
  const { id } = await ctx.params;
  const row = await prisma.eventInstance.findUnique({ where: { id } });
  if (!row) {
    return NextResponse.json(
      { error: "NOT_FOUND", message: `event instance ${id} not found` },
      { status: 404 },
    );
  }
  if (!row.payloadSummary) {
    return NextResponse.json(
      {
        error: "BAD_REQUEST",
        message: "no payload to replay (event was rejected before persist)",
      },
      { status: 400 },
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(row.payloadSummary);
  } catch {
    return NextResponse.json(
      { error: "BAD_REQUEST", message: "stored payload is not valid JSON" },
      { status: 400 },
    );
  }

  const result = await em.publish(row.name, data, {
    source: `replay:${row.source}`,
    // intentionally omit externalEventId — we want a NEW EventInstance row,
    // not a duplicate-skip
    emitRejectionOnFailure: false,
  });
  return NextResponse.json({
    originalId: id,
    result,
  });
}
