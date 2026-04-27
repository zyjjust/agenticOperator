import { NextResponse } from 'next/server';
import { emClient } from '@/server/clients/em';
import { EVENT_CATALOG } from '@/lib/events-catalog';
import type { EventsResponse, EventContract, EventKind, ApiMeta } from '@/lib/api/types';
import type { Stage } from '@/lib/agent-mapping';

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const stageFilter = url.searchParams.get('stage')?.split(',');
  const kindFilter = url.searchParams.get('kind')?.split(',');
  const q = url.searchParams.get('q');

  const partial: ApiMeta['partial'] = [];
  let events: EventContract[];

  try {
    const emRes = await emClient.fetchEvents();
    events = (emRes.items as any[]).map(toContract);
  } catch {
    // EM down → fall back to local catalog so /events page still works
    partial.push('em');
    events = EVENT_CATALOG.map((e) => ({
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
    }));
  }

  if (stageFilter) events = events.filter((e) => stageFilter.includes(e.stage));
  if (kindFilter) events = events.filter((e) => kindFilter.includes(e.kind));
  if (q) {
    const ql = q.toLowerCase();
    events = events.filter(
      (e) =>
        e.name.toLowerCase().includes(ql) ||
        e.desc.toLowerCase().includes(ql),
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

function toContract(e: any): EventContract {
  return {
    name: e.name,
    stage: e.stage as Stage,
    kind: (e.kind ?? 'domain') as EventKind,
    desc: e.desc ?? '',
    publishers: e.publishers ?? [],
    subscribers: e.subscribers ?? [],
    emits: e.emits ?? [],
    schema: e.schema ?? null,
    schemaVersion: e.schemaVersion ?? 0,
    rateLastHour: e.rate ?? 0,
    errorRateLastHour: e.err ?? 0,
  };
}
