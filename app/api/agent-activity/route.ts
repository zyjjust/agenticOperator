// Lightweight activity feed for the demo page.
//
// Returns the most-recent AgentActivity rows for one agent name from
// data/ao.db (in-process prisma). Used by /agent-demo to render the
// live log without needing SSE wiring.
//
// Curl:
//   curl http://localhost:3002/api/agent-activity?agent=SampleResumeParser
//   curl http://localhost:3002/api/agent-activity?agent=SampleResumeParser&limit=20

import { NextResponse } from "next/server";
import { prisma } from "@/server/db";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const agent = url.searchParams.get("agent");
  const limitParam = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(limitParam)
    ? Math.min(MAX_LIMIT, Math.max(1, limitParam))
    : DEFAULT_LIMIT;

  if (!agent) {
    return NextResponse.json(
      { error: "BAD_REQUEST", message: "agent query param required", field: "agent" },
      { status: 400 },
    );
  }

  try {
    const rows = await prisma.agentActivity.findMany({
      where: { agentName: agent },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return NextResponse.json({
      agent,
      rows: rows.map((r) => ({
        id: r.id,
        type: r.type,
        narrative: r.narrative,
        metadata: r.metadata ? safeParse(r.metadata) : null,
        createdAt: r.createdAt.toISOString(),
      })),
      count: rows.length,
      meta: { generatedAt: new Date().toISOString() },
    });
  } catch (e) {
    return NextResponse.json(
      { error: "INTERNAL", message: (e as Error).message },
      { status: 500 },
    );
  }
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
