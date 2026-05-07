// POST /api/em/publish — dev / ops endpoint to fire a test event through
// the EM library.
//
// Body shape:
//   {
//     "name": "RESUME_DOWNLOADED",
//     "data": { ...envelope... },
//     "source": "manual-test",        // optional, default "manual-test"
//     "externalEventId": "abc-123",   // optional
//     "causedBy": { "eventId":"...", "name":"..." }  // optional
//   }
//
// Response: PublishResult — { accepted: true, eventId, schemaVersionUsed }
//   or       { accepted: false, reason: "schema|filter|duplicate|em_degraded|no_schema", details }
//
// Auth: NONE — only safe in dev. Production must gate this behind a key
// or remove it.

import { NextResponse } from "next/server";
import { em } from "@/server/em";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "BAD_REQUEST", message: "request body must be valid JSON" },
      { status: 400 },
    );
  }

  if (typeof body?.name !== "string" || body.name.length === 0) {
    return NextResponse.json(
      { error: "BAD_REQUEST", message: "name (string) is required", field: "name" },
      { status: 400 },
    );
  }
  if (body?.data === undefined) {
    return NextResponse.json(
      { error: "BAD_REQUEST", message: "data is required", field: "data" },
      { status: 400 },
    );
  }

  const result = await em.publish(body.name, body.data, {
    source: typeof body.source === "string" ? body.source : "manual-test",
    externalEventId:
      typeof body.externalEventId === "string" ? body.externalEventId : undefined,
    causedBy:
      body.causedBy && typeof body.causedBy.eventId === "string" && typeof body.causedBy.name === "string"
        ? { eventId: body.causedBy.eventId, name: body.causedBy.name }
        : undefined,
    traceId: typeof body.traceId === "string" ? body.traceId : undefined,
  });

  return NextResponse.json(result);
}
