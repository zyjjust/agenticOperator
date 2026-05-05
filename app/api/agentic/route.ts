// /api/agentic — read or flip the agentic-mode toggle.
//
// GET  /api/agentic        → { enabled, updatedAt, updatedBy?, reason? }
// POST /api/agentic        body: { enabled: boolean, updatedBy?, reason? }
//                          → returns the new state
//
// Curl:
//   curl http://localhost:3002/api/agentic
//   curl -X POST http://localhost:3002/api/agentic \
//        -H 'Content-Type: application/json' \
//        -d '{"enabled":true,"updatedBy":"steven","reason":"start E2E"}'

import { NextResponse } from "next/server";
import { getAgenticState, setAgenticState } from "@/server/agentic-state";

export async function GET(): Promise<Response> {
  const state = await getAgenticState();
  return NextResponse.json(state);
}

export async function POST(req: Request): Promise<Response> {
  let body: { enabled?: unknown; updatedBy?: unknown; reason?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "BAD_REQUEST", message: "JSON body required: {enabled: boolean}" },
      { status: 400 },
    );
  }
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json(
      { error: "BAD_REQUEST", message: "field `enabled` must be a boolean" },
      { status: 400 },
    );
  }
  const next = await setAgenticState({
    enabled: body.enabled,
    updatedBy: typeof body.updatedBy === "string" ? body.updatedBy : undefined,
    reason: typeof body.reason === "string" ? body.reason : undefined,
  });
  return NextResponse.json(next);
}
