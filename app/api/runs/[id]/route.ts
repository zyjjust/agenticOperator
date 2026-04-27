import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import {
  normalizeRunStatus,
  InvalidStatusError,
} from '@/server/normalize/status';

// P3 chunk 4: switched from wsClient (HTTP to sidecar) to prisma against
// data/ao.db. Response shape unchanged.

type RouteCtx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: RouteCtx): Promise<Response> {
  const { id } = await ctx.params;
  try {
    const r = await prisma.workflowRun.findUnique({ where: { id } });
    if (!r) {
      return NextResponse.json(
        { error: 'NOT_FOUND', message: `run ${id} not found` },
        { status: 404 },
      );
    }
    return NextResponse.json({
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
      meta: { generatedAt: new Date().toISOString() },
    });
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
