import { NextResponse } from 'next/server';
import { wsClient, WsClientError } from '@/server/clients/ws';
import {
  normalizeRunStatus,
  InvalidStatusError,
} from '@/server/normalize/status';
import type { RunsResponse, RunSummary } from '@/lib/api/types';

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const status = url.searchParams.get('status')?.split(',');
  const limitParam = Number(url.searchParams.get('limit') ?? 10);
  const limit = Number.isFinite(limitParam) ? Math.min(50, Math.max(1, limitParam)) : 10;
  const since = url.searchParams.get('since') ?? undefined;

  try {
    const wsRes = await wsClient.fetchRuns({ status, limit, since });
    const runs: RunSummary[] = wsRes.runs.map((r: any) => ({
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
    }));
    const body: RunsResponse = {
      runs,
      total: wsRes.total,
      meta: { generatedAt: new Date().toISOString() },
    };
    return NextResponse.json(body);
  } catch (e) {
    if (e instanceof WsClientError) return upstreamDown('WS', e.message);
    if (e instanceof InvalidStatusError) return upstreamProtocol(e.message);
    if ((e as Error)?.name === 'WsClientError') return upstreamDown('WS', (e as Error).message);
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

function upstreamDown(svc: string, msg: string) {
  return NextResponse.json(
    { error: 'UPSTREAM_DOWN', message: `${svc} unreachable: ${msg}` },
    { status: 502 },
  );
}

function upstreamProtocol(msg: string) {
  return NextResponse.json(
    { error: 'PROTOCOL', message: msg },
    { status: 502 },
  );
}
