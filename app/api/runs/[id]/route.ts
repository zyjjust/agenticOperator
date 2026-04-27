import { NextResponse } from 'next/server';
import { wsClient, WsClientError } from '@/server/clients/ws';
import {
  normalizeRunStatus,
  InvalidStatusError,
} from '@/server/normalize/status';

type RouteCtx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: RouteCtx): Promise<Response> {
  const { id } = await ctx.params;
  try {
    const r = await wsClient.fetchRun(id);
    if (!r) {
      return NextResponse.json(
        { error: 'NOT_FOUND', message: `run ${id} not found` },
        { status: 404 },
      );
    }
    const body = {
      id: r.id,
      triggerEvent: r.triggerEvent,
      triggerData: parseTriggerData(r.triggerData),
      status: normalizeRunStatus(r.status),
      startedAt: r.startedAt,
      lastActivityAt: r.lastActivityAt,
      completedAt: r.completedAt ?? null,
      agentCount: 0,
      pendingHumanTasks: 0,
      suspendedReason: r.suspendedReason ?? null,
      meta: { generatedAt: new Date().toISOString() },
    };
    return NextResponse.json(body);
  } catch (e) {
    if (e instanceof WsClientError && e.status === 404) {
      return NextResponse.json(
        { error: 'NOT_FOUND', message: `run ${id} not found` },
        { status: 404 },
      );
    }
    if ((e as Error)?.name === 'WsClientError') {
      const we = e as WsClientError;
      if (we.status === 404) {
        return NextResponse.json(
          { error: 'NOT_FOUND', message: `run ${id} not found` },
          { status: 404 },
        );
      }
      return NextResponse.json(
        { error: 'UPSTREAM_DOWN', message: `WS unreachable: ${we.message}` },
        { status: 502 },
      );
    }
    if (e instanceof InvalidStatusError) {
      return NextResponse.json(
        { error: 'PROTOCOL', message: e.message },
        { status: 502 },
      );
    }
    throw e;
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
