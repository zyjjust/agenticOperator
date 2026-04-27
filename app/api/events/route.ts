import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { EVENT_CATALOG } from '@/lib/events-catalog';
import type { EventsResponse, EventContract, EventKind, ApiMeta } from '@/lib/api/types';
import type { Stage } from '@/lib/agent-mapping';

// P3 chunk 4: prisma reads from EventDefinition (mapped to "events" table).
// Falls back to lib/events-catalog.ts when DB has no rows seeded yet so
// the page never goes blank.
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const stageFilter = url.searchParams.get('stage')?.split(',');
  const kindFilter = url.searchParams.get('kind')?.split(',');
  const q = url.searchParams.get('q');

  const partial: ApiMeta['partial'] = [];
  let events: EventContract[];

  try {
    const rows = await prisma.eventDefinition.findMany({
      where: { status: 'ACTIVE' },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    if (rows.length === 0) {
      // No data seeded yet — fall back to catalog so demo never blanks.
      partial.push('em');
      events = EVENT_CATALOG.map(toFromCatalog);
    } else {
      events = rows.map((r) => ({
        name: r.name,
        stage: 'system' as Stage, // EventDefinition doesn't have explicit stage; default
        kind: 'domain' as EventKind,
        desc: r.description,
        publishers: [],
        subscribers: [],
        emits: [],
        schema: safeParseJson(r.payload),
        schemaVersion: parseFloat(r.version) || 1,
        rateLastHour: 0,
        errorRateLastHour: 0,
      }));
    }
  } catch {
    partial.push('em');
    events = EVENT_CATALOG.map(toFromCatalog);
  }

  if (stageFilter) events = events.filter((e) => stageFilter.includes(e.stage));
  if (kindFilter) events = events.filter((e) => kindFilter.includes(e.kind));
  if (q) {
    const ql = q.toLowerCase();
    events = events.filter(
      (e) => e.name.toLowerCase().includes(ql) || e.desc.toLowerCase().includes(ql),
    );
  }

  const body: EventsResponse = {
    events,
    meta: {
      partial: partial.length ? partial : undefined,
      generatedAt: new Date().toISOString(),
    },
  };
  return NextResponse.json(body);
}

function toFromCatalog(e: (typeof EVENT_CATALOG)[number]): EventContract {
  return {
    name: e.name,
    stage: e.stage as Stage,
    kind: e.kind as EventKind,
    desc: e.desc,
    publishers: e.publishers,
    subscribers: e.subscribers,
    emits: e.emits,
    schema: null,
    schemaVersion: 0,
    rateLastHour: e.rate,
    errorRateLastHour: e.err,
  };
}

function safeParseJson(s: string): object | null {
  try {
    const o = JSON.parse(s);
    return typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
}
