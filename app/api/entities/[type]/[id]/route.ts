// /api/entities/:type/:id
//
// Lightweight summary for an entity — used by the entity page header
// and by Inspector's "recent instances" panel for display names. Does
// NOT do the full journey scan; relies on a small recent activity
// sample to recover a human-friendly title.

import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { isEntityType, ENTITY_LABELS, type EntityType } from '@/lib/entity-types';
import { hasEntityRef } from '@/lib/entity-extractor';

type RouteCtx = { params: Promise<{ type: string; id: string }> };

export type EntitySummaryResponse = {
  type: EntityType;
  typeLabel: string;
  id: string;
  displayName: string | null;
  runCount: number;
  lastSeenAt: string | null;
};

/** Title-ish fields we look for in metadata to surface a friendly name. */
const TITLE_KEYS = [
  'posting_title',
  'client_job_title',
  'title',
  'display_name',
  'candidate_name',
];

const RECENT_LIMIT = 200;
const SUMMARY_WINDOW_DAYS = 60;

export async function GET(_req: Request, ctx: RouteCtx): Promise<Response> {
  const { type, id } = await ctx.params;
  if (!isEntityType(type)) {
    return NextResponse.json(
      { error: 'BAD_TYPE', message: `unknown type ${type}` },
      { status: 400 },
    );
  }

  const since = new Date(Date.now() - SUMMARY_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  // Cheap scan: only the most-recent activities + their parsed metadata.
  const recent = await prisma.agentActivity.findMany({
    where: { createdAt: { gte: since }, metadata: { not: null } },
    orderBy: { createdAt: 'desc' },
    take: RECENT_LIMIT * 5,
  });

  const matches = recent.filter((a) => hasEntityRef(a.metadata, type, id));
  const runIds = new Set(matches.map((m) => m.runId).filter(Boolean) as string[]);

  let displayName: string | null = null;
  for (const a of matches) {
    const meta = parseJson(a.metadata);
    const found = findTitle(meta);
    if (found) {
      displayName = found;
      break;
    }
  }

  const lastSeenAt = matches[0]?.createdAt.toISOString() ?? null;

  const body: EntitySummaryResponse = {
    type,
    typeLabel: ENTITY_LABELS[type],
    id,
    displayName,
    runCount: runIds.size,
    lastSeenAt,
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
