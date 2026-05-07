import { NextResponse } from 'next/server';
import { wsClient } from '@/server/clients/ws';
import { emClient } from '@/server/clients/em';
import { prisma } from '@/server/db';
import type { AlertsResponse, Alert, ApiMeta } from '@/lib/api/types';

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const categoryFilter = url.searchParams.get('category')?.split(',');
  const affectedFilter = url.searchParams.get('affected');

  const partial: ApiMeta['partial'] = [];
  const alerts: Alert[] = [];

  // SLA breach alerts: timed_out runs from WS sweeper.
  // Skip the round-trip when category filter explicitly excludes 'sla'.
  if (!categoryFilter || categoryFilter.includes('sla')) {
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
  }

  // DLQ alerts from EM
  if (!categoryFilter || categoryFilter.includes('dlq')) {
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
  }

  // EM degraded-mode alerts. EmSystemStatus is updated by server/em/* whenever
  // the library hits an error path (Neo4j unreachable, schema lookup fails,
  // etc.). Surfacing here so /alerts page becomes a single pane for system
  // health regardless of category, per spec v2 §12.3.
  if (!categoryFilter || categoryFilter.includes('infra')) {
    try {
      const status = await prisma.emSystemStatus.findUnique({
        where: { id: 'singleton' },
      });
      if (status) {
        // EM library itself in degraded state.
        if (status.state === 'degraded' || status.state === 'down') {
          alerts.push({
            id: `em-${status.state}`,
            category: 'infra',
            severity: status.state === 'down' ? 'critical' : 'high',
            title: status.state === 'down'
              ? 'Event Manager 不可用'
              : 'Event Manager 降级运行',
            affected: 'event-manager',
            triggeredAt:
              status.degradedSince?.toISOString() ??
              status.lastErrorAt?.toISOString() ??
              new Date().toISOString(),
            acked: false,
            ackedBy: null,
          });
        }
        // Neo4j sync failure surfaces independently — EM may still publish
        // OK while the schema cache is stale.
        if (status.neo4jLastError) {
          alerts.push({
            id: 'em-neo4j-sync',
            category: 'infra',
            severity: 'medium',
            title: `Neo4j 同步失败：${truncate(status.neo4jLastError, 80)}`,
            affected: 'neo4j-sync',
            triggeredAt:
              status.lastErrorAt?.toISOString() ?? new Date().toISOString(),
            acked: false,
            ackedBy: null,
          });
        }
      }
    } catch {
      // EmSystemStatus table missing or unreachable — silently skip rather
      // than blowing up the alerts feed.
    }
  }

  // Filter by affected (event name / agent / run id) on the synthesized list.
  const filtered = affectedFilter
    ? alerts.filter((a) => a.affected === affectedFilter)
    : alerts;

  const body: AlertsResponse = {
    alerts: filtered,
    meta: {
      partial: partial.length ? partial : undefined,
      generatedAt: new Date().toISOString(),
    },
  };
  return NextResponse.json(body);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
