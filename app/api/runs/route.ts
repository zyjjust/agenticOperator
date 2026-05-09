import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import {
  normalizeRunStatus,
  InvalidStatusError,
} from '@/server/normalize/status';
import type { RunsResponse, RunSummary } from '@/lib/api/types';

// P3 chunk 4 (partial): switched from wsClient (HTTP to sidecar 5175) to
// in-process prisma queries against data/ao.db. Response shape unchanged.
// Sidecar still owns the writers; data/ao.db is hydrated by
// `prisma/seed-from-sidecars.ts` until P3 chunk 2 ports the agents
// in-process.

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const status = url.searchParams.get('status')?.split(',');
  const limitParam = Number(url.searchParams.get('limit') ?? 10);
  const limit = Number.isFinite(limitParam) ? Math.min(50, Math.max(1, limitParam)) : 10;
  const sinceParam = url.searchParams.get('since');
  const since = sinceParam ? new Date(sinceParam) : undefined;
  // New filters (added 2026-05-09): the /live left rail wires these as
  // chips so ops can carve "runs that touched JDGenerator AND failed AND
  // are still pending HITL". All optional; absence means no filter.
  const agentParam = url.searchParams.get('agent');
  const agents = agentParam
    ? agentParam.split(',').map((s) => s.trim()).filter(Boolean)
    : null;
  const hasError = url.searchParams.get('hasError') === '1';
  const hasHitl = url.searchParams.get('hasHitl') === '1';

  try {
    const where: Record<string, unknown> = {};
    if (status && status.length) where.status = { in: status };
    if (since && !isNaN(since.getTime())) where.startedAt = { gte: since };
    if (agents && agents.length) {
      // "run touched any of these agents" — at least one AgentActivity row
      // with agentName in the list.
      where.activities = { some: { agentName: { in: agents } } };
    }
    if (hasError) {
      // "run had any failed step" — defining "errored" by step status, not
      // run status, so a run that recovered after a failed step still
      // surfaces here.
      where.steps = { some: { status: 'failed' } };
    }
    // hasHitl is computed below from the HumanTask table — Prisma's
    // WorkflowRun doesn't have a relation declared for HumanTask in the
    // schema yet, so we filter post-fetch.

    // Fetch a wider slice when hasHitl is set so that post-filter we still
    // have ~limit rows. 3x is a reasonable heuristic for typical HITL rates.
    const fetchLimit = hasHitl ? Math.min(150, limit * 3) : limit;

    const [items, total] = await Promise.all([
      prisma.workflowRun.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        take: fetchLimit,
      }),
      prisma.workflowRun.count({ where }),
    ]);

    // Resolve pending HITL counts in one batch query rather than N+1.
    // Defensive: in tests / partial mocks `prisma.humanTask` may be
    // undefined. Falling through to zero counts is fine — the UI just
    // won't badge HITL until the real schema is in place.
    const runIds = items.map((r) => r.id);
    const pendingByRun = new Map<string, number>();
    if (runIds.length > 0 && prisma.humanTask) {
      try {
        const groups = await prisma.humanTask.groupBy({
          by: ['runId'],
          where: { runId: { in: runIds }, status: 'pending' },
          _count: { _all: true },
        });
        for (const g of groups) {
          if (g.runId) pendingByRun.set(g.runId, g._count._all);
        }
      } catch {
        // Schema mismatch / mock without humanTask — skip silently.
      }
    }

    let runs: RunSummary[] = items.map((r) => ({
      id: r.id,
      triggerEvent: r.triggerEvent,
      triggerData: parseTriggerData(r.triggerData),
      status: normalizeRunStatus(r.status),
      startedAt: r.startedAt.toISOString(),
      lastActivityAt: r.lastActivityAt.toISOString(),
      completedAt: r.completedAt ? r.completedAt.toISOString() : null,
      agentCount: 0,
      pendingHumanTasks: pendingByRun.get(r.id) ?? 0,
      suspendedReason: r.suspendedReason ?? null,
    }));

    if (hasHitl) {
      runs = runs.filter((r) => r.pendingHumanTasks > 0);
    }

    runs = runs.slice(0, limit);

    const body: RunsResponse = {
      runs,
      // total counts the unfiltered (or where-filtered) set; hasHitl is
      // post-filter so we don't try to recompute total under it. Fine for
      // the UI which uses total as a "more data than shown" hint.
      total,
      meta: { generatedAt: new Date().toISOString() },
    };
    return NextResponse.json(body);
  } catch (e) {
    if (e instanceof InvalidStatusError) {
      return NextResponse.json(
        { error: 'PROTOCOL', message: e.message },
        { status: 502 },
      );
    }
    return NextResponse.json(
      { error: 'INTERNAL', message: (e as Error).message },
      { status: 500 },
    );
  }
}

function parseTriggerData(s: unknown): { client: string; jdId: string } {
  try {
    const o =
      typeof s === 'string'
        ? (JSON.parse(s) as Record<string, unknown>)
        : (s as Record<string, unknown> | null) ?? {};
    return {
      client: (o.client as string) ?? '—',
      jdId: ((o.jdId ?? o.requisition_id) as string) ?? '—',
    };
  } catch {
    return { client: '—', jdId: '—' };
  }
}
