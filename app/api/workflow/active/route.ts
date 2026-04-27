// /api/workflow/active — list AgentActivity rows from the last 5 minutes
// for the workflow page banner.

import { NextResponse } from "next/server";
import { prisma } from "@/server/db";

export async function GET(): Promise<Response> {
  const cutoff = new Date(Date.now() - 5 * 60 * 1000);
  try {
    const rows = await prisma.agentActivity.findMany({
      where: { createdAt: { gte: cutoff } },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: {
        agentName: true,
        type: true,
        narrative: true,
        createdAt: true,
      },
    });
    return NextResponse.json({
      rows: rows.map((r) => ({
        agentName: r.agentName,
        type: r.type,
        narrative: r.narrative,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  } catch (e) {
    return NextResponse.json(
      { error: "INTERNAL", message: (e as Error).message, rows: [] },
      { status: 500 },
    );
  }
}
