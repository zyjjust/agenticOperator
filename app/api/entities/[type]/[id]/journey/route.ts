// /api/entities/:type/:id/journey
//
// Returns the cross-run journey for a single entity (JobRequisition /
// JobPosting / Candidate). Joins:
//   - WorkflowRun.triggerData    (entry-point references)
//   - AgentActivity.metadata     (step boundaries + emit events + tools)
//   - EventInstance.payloadSummary (cross-run event lifecycle)
//
// Read-only: extractor walks JSON in-process, does NOT modify any payload.
// Strategy: the design doc's "path A" — scan recent rows, filter in JS,
// good enough until we cross ~50k runs. See
// docs/workflow-inspector-enhancement-design.md §3.4.

import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { isEntityType, type EntityType } from '@/lib/entity-types';
import { extractEntityRefs, hasEntityRef } from '@/lib/entity-extractor';

type RouteCtx = { params: Promise<{ type: string; id: string }> };

const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 365;
const RUN_SCAN_LIMIT = 1000;
const ACTIVITY_PER_RUN_LIMIT = 500;
const EVENT_INSTANCE_LIMIT = 500;

export type JourneyRunSummary = {
  id: string;
  triggerEvent: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  lastActivityAt: string;
  durationMs: number | null;
};

export type JourneyActivity = {
  id: string;
  runId: string | null;
  ts: string;
  agent: string;          // canonical short
  nodeId: string;
  type: string;            // raw type string (event_emitted / step.completed / tool / ...)
  narrative: string;
  metadata: unknown;       // already JSON-parsed, may be null
  /** entity refs found in metadata (lets the UI highlight the relevant pieces). */
  entityRefs: Array<{ type: EntityType; id: string }>;
};

export type JourneyEvent = {
  id: string;
  name: string;
  source: string;
  status: string;
  ts: string;
  causedByEventId: string | null;
  causedByName: string | null;
  payloadSummary: unknown;
};

export type JourneyAgentRollup = {
  short: string;
  activityCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  errorCount: number;
  eventEmittedCount: number;
};

export type JourneyResponse = {
  entity: { type: EntityType; id: string };
  window: { days: number; sinceMs: number };
  runs: JourneyRunSummary[];
  activities: JourneyActivity[];
  events: JourneyEvent[];
  agentSummary: JourneyAgentRollup[];
  meta: {
    runScanCount: number;
    activityScanCount: number;
    eventScanCount: number;
    truncated: boolean;
    generatedAt: string;
  };
};

export async function GET(req: Request, ctx: RouteCtx): Promise<Response> {
  const { type, id } = await ctx.params;
  if (!isEntityType(type)) {
    return NextResponse.json(
      { error: 'BAD_TYPE', message: `entity type must be one of JobRequisition / JobPosting / Candidate (got: ${type})` },
      { status: 400 },
    );
  }

  const url = new URL(req.url);
  const days = clamp(
    Number.parseInt(url.searchParams.get('days') ?? '', 10) || DEFAULT_WINDOW_DAYS,
    1,
    MAX_WINDOW_DAYS,
  );
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  // ── 1. Scan runs whose triggerData references the entity ──────────
  const allRuns = await prisma.workflowRun.findMany({
    where: { startedAt: { gte: since } },
    orderBy: { startedAt: 'desc' },
    take: RUN_SCAN_LIMIT,
  });
  const runMatchingByTrigger = new Set<string>();
  for (const r of allRuns) {
    if (hasEntityRef(r.triggerData, type, id)) runMatchingByTrigger.add(r.id);
  }

  // ── 2. Scan activity rows whose metadata references the entity ────
  // This is the "emit events / internal step events" capture — every
  // event_emitted / step.* / tool row has its full payload digest in
  // metadata. We scan these directly so we catch fan-out runs that
  // weren't entered with this entity but did mention it during work.
  const allActivities = await prisma.agentActivity.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: 'asc' },
    take: RUN_SCAN_LIMIT * 10,
  });
  const runMatchingByActivity = new Set<string>();
  const activityHits: typeof allActivities = [];
  for (const a of allActivities) {
    if (!a.metadata) continue;
    if (hasEntityRef(a.metadata, type, id)) {
      activityHits.push(a);
      if (a.runId) runMatchingByActivity.add(a.runId);
    }
  }

  const allMatchingRunIds = new Set<string>([
    ...runMatchingByTrigger,
    ...runMatchingByActivity,
  ]);

  // ── 3. For each matching run, fetch FULL activity timeline ────────
  // Don't just keep activityHits — we want the entire run's story
  // around the moment this entity was touched (e.g. a setup step that
  // didn't itself reference the entity but built the context).
  const fullActivities = allMatchingRunIds.size > 0
    ? await prisma.agentActivity.findMany({
        where: { runId: { in: Array.from(allMatchingRunIds) } },
        orderBy: { createdAt: 'asc' },
        take: ACTIVITY_PER_RUN_LIMIT * Math.max(1, allMatchingRunIds.size),
      })
    : [];

  // ── 4. EventInstance scan (cross-run event lifecycle) ─────────────
  const allEvents = await prisma.eventInstance.findMany({
    where: { ts: { gte: since } },
    orderBy: { ts: 'desc' },
    take: EVENT_INSTANCE_LIMIT,
  });
  const eventHits = allEvents.filter((e) =>
    e.payloadSummary ? hasEntityRef(e.payloadSummary, type, id) : false,
  );

  // ── 5. Shape ────────────────────────────────────────────────────
  const runSummaries: JourneyRunSummary[] = allRuns
    .filter((r) => allMatchingRunIds.has(r.id))
    .map((r) => ({
      id: r.id,
      triggerEvent: r.triggerEvent,
      status: r.status,
      startedAt: r.startedAt.toISOString(),
      completedAt: r.completedAt?.toISOString() ?? null,
      lastActivityAt: r.lastActivityAt.toISOString(),
      durationMs: r.completedAt
        ? r.completedAt.getTime() - r.startedAt.getTime()
        : null,
    }))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  const activities: JourneyActivity[] = fullActivities.map((a) => {
    const metaParsed = parseJson(a.metadata);
    return {
      id: a.id,
      runId: a.runId,
      ts: a.createdAt.toISOString(),
      agent: a.agentName,
      nodeId: a.nodeId,
      type: a.type,
      narrative: a.narrative,
      metadata: metaParsed,
      entityRefs: metaParsed ? extractEntityRefs(metaParsed) : [],
    };
  });

  const events: JourneyEvent[] = eventHits.map((e) => ({
    id: e.id,
    name: e.name,
    source: e.source,
    status: e.status,
    ts: e.ts.toISOString(),
    causedByEventId: e.causedByEventId,
    causedByName: e.causedByName,
    payloadSummary: parseJson(e.payloadSummary),
  }));

  // Per-agent rollup. Counts on the FULL run timeline (so it reflects
  // actual workload, not just rows that mentioned this entity).
  const rollupMap = new Map<string, {
    activityCount: number;
    firstSeenAtMs: number;
    lastSeenAtMs: number;
    errorCount: number;
    eventEmittedCount: number;
  }>();
  for (const a of fullActivities) {
    const k = a.agentName;
    let r = rollupMap.get(k);
    const tsMs = a.createdAt.getTime();
    if (!r) {
      r = {
        activityCount: 0,
        firstSeenAtMs: tsMs,
        lastSeenAtMs: tsMs,
        errorCount: 0,
        eventEmittedCount: 0,
      };
      rollupMap.set(k, r);
    }
    r.activityCount += 1;
    if (tsMs < r.firstSeenAtMs) r.firstSeenAtMs = tsMs;
    if (tsMs > r.lastSeenAtMs) r.lastSeenAtMs = tsMs;
    if (a.type === 'agent_error' || a.type === 'step.failed') r.errorCount += 1;
    if (a.type === 'event_emitted') r.eventEmittedCount += 1;
  }
  const agentSummary: JourneyAgentRollup[] = Array.from(rollupMap.entries())
    .map(([short, r]) => ({
      short,
      activityCount: r.activityCount,
      firstSeenAt: new Date(r.firstSeenAtMs).toISOString(),
      lastSeenAt: new Date(r.lastSeenAtMs).toISOString(),
      errorCount: r.errorCount,
      eventEmittedCount: r.eventEmittedCount,
    }))
    .sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt));

  const truncated =
    allRuns.length === RUN_SCAN_LIMIT ||
    allActivities.length === RUN_SCAN_LIMIT * 10 ||
    allEvents.length === EVENT_INSTANCE_LIMIT;

  const body: JourneyResponse = {
    entity: { type, id },
    window: { days, sinceMs: since.getTime() },
    runs: runSummaries,
    activities,
    events,
    agentSummary,
    meta: {
      runScanCount: allRuns.length,
      activityScanCount: allActivities.length,
      eventScanCount: allEvents.length,
      truncated,
      generatedAt: new Date().toISOString(),
    },
  };
  return NextResponse.json(body);
}

function parseJson(s: string | null | undefined): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
