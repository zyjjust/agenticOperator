import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { EVENT_CATALOG } from '@/lib/events-catalog';
import { em } from '@/server/em';
import type {
  EventsResponse,
  EventContract,
  EventsMeta,
  EventKind,
} from '@/lib/api/types';
import type { Stage } from '@/lib/agent-mapping';

// GET /api/events
//
// Provenance contract (per "Neo4j is the only source of truth" decision):
//
//   1. Primary path:  prisma.eventDefinition.findMany({ source: 'neo4j', retiredAt: null })
//      Neo4j sync worker (server/em/sync/event-definition-sync.ts) populates
//      this table every NEO4J_SYNC_INTERVAL_MS. AO never writes back.
//
//   2. Cold-start fallback: when NO neo4j rows exist (worker never succeeded
//      since cold boot — typically off-VPN), serve the hardcoded catalog so
//      the UI doesn't blank out. Each row is flagged source='hardcoded' and
//      meta.source='hardcoded' so the frontend can banner it loudly.
//
// We intentionally do NOT merge hardcoded entries with Neo4j ones in the
// happy path: if Neo4j drops a definition, it's gone — that's the point of
// having a single source of truth.
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const stageFilter = url.searchParams.get('stage')?.split(',');
  const kindFilter = url.searchParams.get('kind')?.split(',');
  const q = url.searchParams.get('q');
  const debugRaw = url.searchParams.get('debug') === 'raw';

  // Pull sync status — if sync ever succeeded we surface lastNeo4jSyncAt even
  // when the table is empty (which would mean Neo4j has zero EventDefinitions).
  const status = await prisma.emSystemStatus
    .findUnique({ where: { id: 'singleton' } })
    .catch(() => null);

  // Default: include retired rows so ops can see "this event used to exist"
  // — UI badges them differently. Pass ?includeRetired=0 to hide.
  const includeRetired = url.searchParams.get('includeRetired') !== '0';

  let neo4jEvents: EventContract[] = [];
  let neo4jRawRows: unknown[] = [];
  try {
    const rows = await prisma.eventDefinition.findMany({
      where: {
        source: 'neo4j',
        ...(includeRetired ? {} : { retiredAt: null }),
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    neo4jEvents = rows.map(rowToContract);
    if (debugRaw) neo4jRawRows = rows;
  } catch (err) {
    // DB itself failed — extremely rare. We fall through to hardcoded fallback.
    console.error('[api/events] DB query failed:', (err as Error).message);
  }

  // Enrich each row with the validator's actual provenance from the registry.
  // We resolve in parallel — registry has 30s in-memory cache so the cost is
  // a single batched DB read amortized across all rows.
  await Promise.all(
    neo4jEvents.map(async (e) => {
      try {
        const reg = await em.registry.resolve(e.name);
        if (reg) {
          e.schemaSource = reg.schemaSource;
          e.versionSources = reg.versionSources;
        }
      } catch {
        // Registry failure is non-fatal for this read endpoint.
      }
    }),
  );

  // Decide source: Neo4j-first, hardcoded only when Neo4j cache is empty.
  let events: EventContract[];
  let aggregateSource: EventsMeta['source'];
  let totalNeo4jRows = neo4jEvents.length;
  let totalHardcodedRows = 0;
  if (neo4jEvents.length > 0) {
    events = neo4jEvents;
    aggregateSource = 'neo4j';
  } else {
    events = EVENT_CATALOG.map(catalogToContract);
    totalHardcodedRows = events.length;
    aggregateSource = 'hardcoded';
  }

  // Apply filters after source resolution.
  if (stageFilter) events = events.filter((e) => stageFilter.includes(e.stage));
  if (kindFilter) events = events.filter((e) => kindFilter.includes(e.kind));
  if (q) {
    const ql = q.toLowerCase();
    events = events.filter(
      (e) => e.name.toLowerCase().includes(ql) || e.desc.toLowerCase().includes(ql),
    );
  }

  const meta: EventsMeta = {
    partial: aggregateSource === 'hardcoded' ? ['em'] : undefined,
    generatedAt: new Date().toISOString(),
    source: aggregateSource,
    lastNeo4jSyncAt: status?.neo4jLastSyncAt?.toISOString() ?? null,
    lastNeo4jError: status?.neo4jLastError ?? null,
    totalNeo4jRows,
    totalHardcodedRows,
  };

  if (debugRaw) {
    // Inspection-only payload for ops. Surfaces the raw EventDefinition rows
    // exactly as they came out of Prisma (decoded JSON) so we can see what
    // Neo4j actually pushed without spinning up Prisma Studio.
    return NextResponse.json({
      events,
      meta,
      _debug: {
        neo4jRawRows: neo4jRawRows.map((r: any) => ({
          ...r,
          activeVersionsJson: tryParse(r.activeVersionsJson),
          schemasByVersionJson: tryParse(r.schemasByVersionJson),
          publishersJson: tryParse(r.publishersJson),
          subscribersJson: tryParse(r.subscribersJson),
        })),
        emSystemStatus: status,
      },
    });
  }

  const body: EventsResponse = { events, meta };
  return NextResponse.json(body);
}

function tryParse(s: string | null | undefined): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function rowToContract(r: {
  name: string;
  description: string;
  payload: string;
  extraJson: string;
  version: string;
  source: string;
  syncedAt: Date | null;
  activeVersionsJson: string | null;
  publishersJson: string | null;
  subscribersJson: string | null;
  isBreakingChange?: boolean;
  lastChangedAt?: Date | null;
  retiredAt?: Date | null;
}): EventContract {
  const extra = parseJsonObject(r.extraJson) as
    | { sourceAction?: string | null; sourceFile?: string | null; fields?: EventContract['fields']; mutations?: EventContract['mutations'] }
    | null;
  return {
    name: r.name,
    // EventDefinition doesn't carry stage; UI groups by name prefix instead
    // when stage is missing. Default keeps the old behavior of "system".
    stage: 'system' as Stage,
    kind: 'domain' as EventKind,
    desc: r.description,
    publishers: parseJsonArray(r.publishersJson),
    subscribers: parseJsonArray(r.subscribersJson),
    emits: [],
    schema: parseJsonObject(r.payload),
    schemaVersion: parseFloat(r.version) || 1,
    rateLastHour: 0,
    errorRateLastHour: 0,
    source: (r.source as EventContract['source']) ?? 'manual',
    syncedAt: r.syncedAt?.toISOString() ?? null,
    activeVersions: parseJsonArray(r.activeVersionsJson),
    fields: extra?.fields ?? [],
    mutations: extra?.mutations ?? [],
    sourceAction: extra?.sourceAction ?? null,
    isBreakingChange: !!r.isBreakingChange,
    lastChangedAt: r.lastChangedAt?.toISOString() ?? null,
    retiredAt: r.retiredAt?.toISOString() ?? null,
    sourceFile: extra?.sourceFile ?? null,
  };
}

function catalogToContract(e: (typeof EVENT_CATALOG)[number]): EventContract {
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
    // Tag every fallback row so the UI can render a "本地兜底" badge.
    source: 'hardcoded',
    syncedAt: null,
    activeVersions: [],
  };
}

function parseJsonArray(s: string | null): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function parseJsonObject(s: string): object | null {
  try {
    const o = JSON.parse(s);
    return typeof o === 'object' && o !== null ? o : null;
  } catch {
    return null;
  }
}
