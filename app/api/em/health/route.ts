// GET /api/em/health — Event Manager liveness probe.
// Returns connectivity status of Neo4j + last sync result + EM library state.
// UI uses this to render the AppBar EM dot and the /events SubHeader badge.

import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import { probe, getConfigSummary } from "@/server/em/clients/neo4j";
import { em } from "@/server/em";

export const dynamic = "force-dynamic";

export type EmHealthResponse = {
  state: "healthy" | "degraded" | "down" | "unconfigured";
  neo4j: {
    configured: boolean;
    uri?: string;
    database?: string;
    reachable: boolean;
    error?: string;
    lastSyncAt: string | null;
    lastError: string | null;
    lastUpserted: number;
  };
  em: {
    state: string;
    degradedSince: string | null;
    lastError: string | null;
    fallbackCount24h: number;
  };
  generatedAt: string;
};

export async function GET(): Promise<Response> {
  try {
    return await getHealth();
  } catch (err) {
    // Final safety net — UI keeps rendering with a state=down record.
    const fallback: EmHealthResponse = {
      state: "down",
      neo4j: {
        configured: false,
        reachable: false,
        error: `health route threw: ${(err as Error).message}`,
        lastSyncAt: null,
        lastError: null,
        lastUpserted: 0,
      },
      em: {
        state: "down",
        degradedSince: null,
        lastError: `health route threw: ${(err as Error).message}`,
        fallbackCount24h: 0,
      },
      generatedAt: new Date().toISOString(),
    };
    return NextResponse.json(fallback, { status: 200 });
  }
}

async function getHealth(): Promise<Response> {
  const cfg = getConfigSummary();
  const probeRes = await probe().catch((err) => ({
    ok: false as const,
    error: `probe threw: ${(err as Error).message}`,
  }));

  // Try to recover the in-process degraded flag if all dependencies look OK.
  if (probeRes.ok) await em.health.recoverIfPossible().catch(() => {/* swallow */});

  // Touch the singleton row so callers always get a defined `em` block.
  // If Prisma fails (stale client / migration not applied / DB locked) we
  // fall through to a synthesized record rather than 500ing — otherwise the
  // AppBar dot and /events SubHeader hard-fail and the whole UI looks broken.
  type StatusRow = {
    state: string;
    degradedSince: Date | null;
    lastError: string | null;
    fallbackCount24h: number;
    neo4jLastSyncAt: Date | null;
    neo4jLastError: string | null;
    neo4jUpsertedLast: number;
  };
  let status: StatusRow;
  let dbError: string | null = null;
  try {
    status = await prisma.emSystemStatus.upsert({
      where: { id: "singleton" },
      create: { id: "singleton" },
      update: {},
    });
  } catch (err) {
    dbError = (err as Error).message;
    status = {
      state: "down",
      degradedSince: null,
      lastError: dbError,
      fallbackCount24h: 0,
      neo4jLastSyncAt: null,
      neo4jLastError: null,
      neo4jUpsertedLast: 0,
    };
  }

  const neo4jBlock = {
    configured: cfg.configured,
    uri: cfg.uri,
    database: cfg.database,
    reachable: probeRes.ok,
    error: probeRes.ok ? undefined : probeRes.error,
    lastSyncAt: status.neo4jLastSyncAt?.toISOString() ?? null,
    lastError: status.neo4jLastError,
    lastUpserted: status.neo4jUpsertedLast,
  };

  const emBlock = {
    state: status.state,
    degradedSince: status.degradedSince?.toISOString() ?? null,
    lastError: status.lastError,
    fallbackCount24h: status.fallbackCount24h,
  };

  const overall: EmHealthResponse["state"] = !cfg.configured
    ? "unconfigured"
    : status.state === "down"
      ? "down"
      : status.state === "degraded" || !probeRes.ok
        ? "degraded"
        : "healthy";

  const body: EmHealthResponse = {
    state: overall,
    neo4j: neo4jBlock,
    em: emBlock,
    generatedAt: new Date().toISOString(),
  };
  return NextResponse.json(body);
}
