// /api/agents/:short/recent-entities
//
// Lists the most-recent entities (JobRequisition / JobPosting / Candidate)
// touched by this agent. Source: AgentActivity rows for the given agent,
// JSON-walked for entity refs, deduped, sorted by last-seen time.
//
// Used by:
//   - Inspector "最近实例" panel (RecentEntitiesPanel)
//   - F1 Agent chatbot tool `recent_entities_by_agent`

import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { byShort } from '@/lib/agent-mapping';
import { extractEntityRefs } from '@/lib/entity-extractor';
import {
  ENTITY_LABELS,
  isEntityType,
  type EntityType,
} from '@/lib/entity-types';

type RouteCtx = { params: Promise<{ short: string }> };

export type RecentEntity = {
  type: EntityType;
  typeLabel: string;
  id: string;
  lastSeenAt: string;
  activityCount: number;
  /** Best-effort display name pulled from a recent activity row. */
  displayName: string | null;
};

export type RecentEntitiesResponse = {
  agent: string;
  windowHours: number;
  entities: RecentEntity[];
  scanned: number;
};

const DEFAULT_WINDOW_HOURS = 168; // 7d
const MAX_WINDOW_HOURS = 720;     // 30d
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 50;
const SCAN_LIMIT = 1000;

const TITLE_KEYS = [
  'posting_title',
  'client_job_title',
  'title',
  'display_name',
  'candidate_name',
];

export async function GET(req: Request, ctx: RouteCtx): Promise<Response> {
  const { short } = await ctx.params;
  if (!byShort(short)) {
    return NextResponse.json(
      { error: 'NOT_FOUND', message: `agent ${short} not in AGENT_MAP` },
      { status: 404 },
    );
  }
  const url = new URL(req.url);
  const hours = clamp(
    Number.parseInt(url.searchParams.get('hours') ?? '', 10) || DEFAULT_WINDOW_HOURS,
    1,
    MAX_WINDOW_HOURS,
  );
  const limit = clamp(
    Number.parseInt(url.searchParams.get('limit') ?? '', 10) || DEFAULT_LIMIT,
    1,
    MAX_LIMIT,
  );
  const filterType = url.searchParams.get('type');
  const onlyType: EntityType | null =
    filterType && isEntityType(filterType) ? filterType : null;

  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const recent = await prisma.agentActivity.findMany({
    where: {
      agentName: short,
      createdAt: { gte: since },
      metadata: { not: null },
    },
    orderBy: { createdAt: 'desc' },
    take: SCAN_LIMIT,
  });

  // ── Aggregate ──────────────────────────────────────────────────────
  type Bucket = {
    type: EntityType;
    id: string;
    lastSeenAtMs: number;
    activityCount: number;
    displayName: string | null;
  };
  const bucket = new Map<string, Bucket>();

  for (const a of recent) {
    const meta = parseJson(a.metadata);
    if (!meta) continue;
    const refs = extractEntityRefs(meta);
    if (refs.length === 0) continue;
    const ts = a.createdAt.getTime();
    const title = findTitle(meta);

    for (const ref of refs) {
      if (onlyType && ref.type !== onlyType) continue;
      const k = `${ref.type}:${ref.id}`;
      let b = bucket.get(k);
      if (!b) {
        b = {
          type: ref.type,
          id: ref.id,
          lastSeenAtMs: ts,
          activityCount: 0,
          displayName: null,
        };
        bucket.set(k, b);
      }
      b.activityCount += 1;
      if (ts > b.lastSeenAtMs) b.lastSeenAtMs = ts;
      if (!b.displayName && title) b.displayName = title;
    }
  }

  const entities: RecentEntity[] = Array.from(bucket.values())
    .sort((a, b) => b.lastSeenAtMs - a.lastSeenAtMs)
    .slice(0, limit)
    .map((b) => ({
      type: b.type,
      typeLabel: ENTITY_LABELS[b.type],
      id: b.id,
      lastSeenAt: new Date(b.lastSeenAtMs).toISOString(),
      activityCount: b.activityCount,
      displayName: b.displayName,
    }));

  const body: RecentEntitiesResponse = {
    agent: short,
    windowHours: hours,
    entities,
    scanned: recent.length,
  };
  return NextResponse.json(body);
}

function parseJson(s: unknown): unknown {
  if (typeof s !== 'string') return s;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function findTitle(node: unknown, depth = 0): string | null {
  if (depth > 6 || !node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const r = findTitle(item, depth + 1);
      if (r) return r;
    }
    return null;
  }
  const obj = node as Record<string, unknown>;
  for (const k of TITLE_KEYS) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 120);
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const r = findTitle(v, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
