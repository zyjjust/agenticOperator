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

  try {
    const where: Record<string, unknown> = {};
    if (status && status.length) where.status = { in: status };
    if (since && !isNaN(since.getTime())) where.startedAt = { gte: since };

    const [items, total] = await Promise.all([
      prisma.workflowRun.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        take: limit,
      }),
      prisma.workflowRun.count({ where }),
    ]);

    const runs: RunSummary[] = items.map((r) => ({
      id: r.id,
      triggerEvent: r.triggerEvent,
      triggerData: parseTriggerData(r.triggerData),
      status: normalizeRunStatus(r.status),
      startedAt: r.startedAt.toISOString(),
      lastActivityAt: r.lastActivityAt.toISOString(),
      completedAt: r.completedAt ? r.completedAt.toISOString() : null,
      agentCount: 0,
      pendingHumanTasks: 0,
      suspendedReason: r.suspendedReason ?? null,
    }));

    const body: RunsResponse = {
      runs,
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
