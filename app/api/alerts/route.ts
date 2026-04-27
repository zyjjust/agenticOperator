import { NextResponse } from 'next/server';
import { wsClient } from '@/server/clients/ws';
import { emClient } from '@/server/clients/em';
import type { AlertsResponse, Alert, ApiMeta } from '@/lib/api/types';

export async function GET(_req: Request): Promise<Response> {
  const partial: ApiMeta['partial'] = [];
  const alerts: Alert[] = [];

  // SLA breach alerts: timed_out runs from WS sweeper
  try {
    const wsRes = await wsClient.fetchRuns({
      status: ['timed_out'],
      limit: 50,
    });
    for (const r of wsRes.runs as any[]) {
      alerts.push({
        id: `sla-${r.id}`,
        category: 'sla',
        severity: 'high',
        title: `Run ${r.id} timed out`,
        affected: r.triggerEvent,
        triggeredAt: r.lastActivityAt ?? r.startedAt,
        acked: false,
        ackedBy: null,
      });
    }
  } catch {
    partial.push('ws');
  }

  // DLQ alerts from EM
  try {
    const emRes = await emClient.fetchDLQ({ limit: 50 });
    for (const d of emRes.items as any[]) {
      alerts.push({
        id: `dlq-${d.id}`,
        category: 'dlq',
        severity: 'medium',
        title: `${d.eventName} → DLQ`,
        affected: d.eventName,
        triggeredAt: d.createdAt ?? d.created_at ?? new Date().toISOString(),
        acked: false,
        ackedBy: null,
      });
    }
  } catch {
    partial.push('em');
  }

  const body: AlertsResponse = {
    alerts,
    meta: {
      partial: partial.length ? partial : undefined,
      generatedAt: new Date().toISOString(),
    },
  };
  return NextResponse.json(body);
}
