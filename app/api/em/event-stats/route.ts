// GET /api/em/event-stats?name=EVENT_NAME
//
// Per-event aggregates over EventInstance. Used by /events to replace the
// mock counters that were sitting on RegistryRow / EventDetailHeader /
// TabOverview's "下游" card.
//
// Cheap because EventInstance has (name, ts) and (status) indexes.

import { NextResponse } from "next/server";
import { prisma } from "@/server/db";

export const dynamic = "force-dynamic";

export type EventStats = {
  name: string;
  rateLastHour: number;
  rate24h: number;
  acceptedCount24h: number;
  rejectedSchemaCount24h: number;
  rejectedFilterCount24h: number;
  duplicateCount24h: number;
  errCount24h: number;
  errRate24h: number;
  /** Aggregate of downstream emits grouped by event name, last 24h. */
  downstreamEmits24h: Array<{ name: string; count: number }>;
  generatedAt: string;
};

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const name = url.searchParams.get("name");
  // Bulk mode: ?names=A,B,C → returns a map { A: {rate24h,...}, B: ..., C: ... }.
  // Used by RegistryRow so we don't fan out N requests for the registry list.
  const namesParam = url.searchParams.get("names");
  if (namesParam) {
    const names = namesParam.split(",").map((s) => s.trim()).filter(Boolean);
    return await getBulk(names);
  }
  if (!name) {
    return NextResponse.json(
      { error: "BAD_REQUEST", message: "name (string) or names (csv) is required", field: "name" },
      { status: 400 },
    );
  }

  const now = Date.now();
  const since1h = new Date(now - 60 * 60 * 1000);
  const since24h = new Date(now - 24 * 60 * 60 * 1000);

  try {
    const [
      rateLastHour,
      rate24h,
      acceptedCount24h,
      rejectedSchemaCount24h,
      rejectedFilterCount24h,
      duplicateCount24h,
      downstreamRaw,
    ] = await Promise.all([
      prisma.eventInstance.count({ where: { name, ts: { gte: since1h } } }),
      prisma.eventInstance.count({ where: { name, ts: { gte: since24h } } }),
      prisma.eventInstance.count({ where: { name, status: "accepted", ts: { gte: since24h } } }),
      prisma.eventInstance.count({ where: { name, status: "rejected_schema", ts: { gte: since24h } } }),
      prisma.eventInstance.count({ where: { name, status: "rejected_filter", ts: { gte: since24h } } }),
      prisma.eventInstance.count({ where: { name, status: "duplicate", ts: { gte: since24h } } }),
      // Group children by name. Prisma supports groupBy with `where`.
      prisma.eventInstance.groupBy({
        by: ["name"],
        where: { causedByName: name, ts: { gte: since24h } },
        _count: { _all: true },
      }),
    ]);

    const errCount24h = rejectedSchemaCount24h + rejectedFilterCount24h;
    const errRate24h = rate24h > 0 ? errCount24h / rate24h : 0;

    const downstreamEmits24h = downstreamRaw
      .map((g) => ({ name: g.name, count: g._count._all }))
      .sort((a, b) => b.count - a.count);

    const body: EventStats = {
      name,
      rateLastHour,
      rate24h,
      acceptedCount24h,
      rejectedSchemaCount24h,
      rejectedFilterCount24h,
      duplicateCount24h,
      errCount24h,
      errRate24h,
      downstreamEmits24h,
      generatedAt: new Date().toISOString(),
    };
    return NextResponse.json(body);
  } catch (err) {
    // Stale Prisma client / migration not applied — surface as zero stats
    // rather than 500ing so the UI doesn't blank out.
    return NextResponse.json(
      {
        name,
        rateLastHour: 0,
        rate24h: 0,
        acceptedCount24h: 0,
        rejectedSchemaCount24h: 0,
        rejectedFilterCount24h: 0,
        duplicateCount24h: 0,
        errCount24h: 0,
        errRate24h: 0,
        downstreamEmits24h: [],
        generatedAt: new Date().toISOString(),
        _error: (err as Error).message,
      },
      { status: 200 },
    );
  }
}

export type EventStatsCompact = {
  rate24h: number;
  rateLastHour: number;
  errCount24h: number;
};

export type EventStatsBulkResponse = {
  stats: Record<string, EventStatsCompact>;
  generatedAt: string;
};

async function getBulk(names: string[]): Promise<Response> {
  if (names.length === 0) {
    return NextResponse.json({ stats: {}, generatedAt: new Date().toISOString() });
  }
  const now = Date.now();
  const since1h = new Date(now - 60 * 60 * 1000);
  const since24h = new Date(now - 24 * 60 * 60 * 1000);
  const stats: Record<string, EventStatsCompact> = {};
  for (const n of names) stats[n] = { rate24h: 0, rateLastHour: 0, errCount24h: 0 };

  try {
    // Two grouped queries cover everything we need:
    //   1. group by (name, status) over 24h  → rate24h + errCount24h
    //   2. group by name over 1h             → rateLastHour
    const [grp24h, grp1h] = await Promise.all([
      prisma.eventInstance.groupBy({
        by: ["name", "status"],
        where: { name: { in: names }, ts: { gte: since24h } },
        _count: { _all: true },
      }),
      prisma.eventInstance.groupBy({
        by: ["name"],
        where: { name: { in: names }, ts: { gte: since1h } },
        _count: { _all: true },
      }),
    ]);

    for (const row of grp24h) {
      const s = stats[row.name];
      if (!s) continue;
      s.rate24h += row._count._all;
      if (row.status === "rejected_schema" || row.status === "rejected_filter") {
        s.errCount24h += row._count._all;
      }
    }
    for (const row of grp1h) {
      const s = stats[row.name];
      if (!s) continue;
      s.rateLastHour = row._count._all;
    }
    return NextResponse.json({ stats, generatedAt: new Date().toISOString() });
  } catch (err) {
    return NextResponse.json(
      { stats, generatedAt: new Date().toISOString(), _error: (err as Error).message },
      { status: 200 },
    );
  }
}
