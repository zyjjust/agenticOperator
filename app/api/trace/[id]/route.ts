import { NextResponse } from 'next/server';
import { wsClient } from '@/server/clients/ws';
import { emClient } from '@/server/clients/em';
import { shortFromWs, UnknownAgentError } from '@/server/normalize/agents';
import {
  normalizeRunStatus,
  normalizeStepStatus,
} from '@/server/normalize/status';
import type {
  TraceResponse,
  TimelineEvent,
  ApiMeta,
} from '@/lib/api/types';

type RouteCtx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: RouteCtx): Promise<Response> {
  const { id: traceId } = await ctx.params;

  // Fetch WS + EM concurrently; either side can fail without sinking the response.
  const [wsRunRes, wsStepsRes, wsFeedRes, emAuditRes, emDlqRes] =
    await Promise.allSettled([
      wsClient.fetchRun(traceId),
      wsClient.fetchSteps(traceId),
      wsClient.fetchActivityFeed({ runId: traceId, limit: 200 }),
      emClient.fetchAuditLog({ eventName: undefined, limit: 200 }),
      emClient.fetchDLQ({ limit: 50 }),
    ]);

  const partial: ApiMeta['partial'] = [];

  let ws: TraceResponse['ws'] = null;
  if (
    wsRunRes.status === 'fulfilled' &&
    wsStepsRes.status === 'fulfilled' &&
    wsFeedRes.status === 'fulfilled'
  ) {
    const r = wsRunRes.value;
    const steps = (wsStepsRes.value.steps as any[])
      .map((s) => {
        try {
          return {
            id: s.id,
            nodeId: s.nodeId,
            agentShort: shortFromWs(s.nodeId),
            status: normalizeStepStatus(s.status),
            startedAt: s.startedAt,
            completedAt: s.completedAt ?? null,
            durationMs: s.durationMs ?? null,
            input: null,
            output: null,
            error: s.error ?? null,
          };
        } catch (e) {
          if (e instanceof UnknownAgentError) return null;
          throw e;
        }
      })
      .filter((x): x is NonNullable<typeof x> => x != null);

    const activities = (wsFeedRes.value.items as any[])
      .map((a) => {
        let agentShort = 'unknown';
        try {
          agentShort = a.agentName ?? shortFromWs(a.nodeId);
        } catch (e) {
          if (e instanceof UnknownAgentError) agentShort = 'unknown';
        }
        return {
          id: a.id,
          runId: a.runId ?? traceId,
          agentShort,
          type: a.type,
          narrative: a.narrative,
          metadata: a.metadata
            ? typeof a.metadata === 'string'
              ? JSON.parse(a.metadata)
              : a.metadata
            : null,
          createdAt: a.createdAt,
        };
      });

    ws = {
      run: {
        id: r.id,
        triggerEvent: r.triggerEvent,
        triggerData: { client: '—', jdId: '—' },
        status: normalizeRunStatus(r.status),
        startedAt: r.startedAt,
        lastActivityAt: r.lastActivityAt,
        completedAt: r.completedAt ?? null,
        agentCount: 0,
        pendingHumanTasks: 0,
        suspendedReason: r.suspendedReason ?? null,
      },
      steps,
      activities,
    };
  } else {
    partial.push('ws');
  }

  let em: TraceResponse['em'] = null;
  if (emAuditRes.status === 'fulfilled' && emDlqRes.status === 'fulfilled') {
    em = {
      auditEntries: (emAuditRes.value.items as any[]).map((a) => ({
        id: a.id,
        eventName: a.eventName ?? a.event_name,
        traceId: a.traceId ?? a.trace_id ?? traceId,
        payloadDigest: a.payloadDigest ?? a.payload_digest ?? '',
        createdAt: a.createdAt ?? a.created_at,
      })),
      dlqEntries: (emDlqRes.value.items as any[]).map((d) => ({
        id: d.id,
        eventName: d.eventName ?? d.event_name,
        reason: d.reason ?? '',
        payload: d.payload,
        createdAt: d.createdAt ?? d.created_at,
      })),
      dedupHits: 0,
    };
  } else {
    partial.push('em');
  }

  const unifiedTimeline = buildTimeline(ws, em);

  const body: TraceResponse = {
    traceId,
    ws,
    em,
    unifiedTimeline,
    meta: {
      partial: partial.length ? partial : undefined,
      generatedAt: new Date().toISOString(),
    },
  };
  return NextResponse.json(body);
}

function buildTimeline(
  ws: TraceResponse['ws'],
  em: TraceResponse['em'],
): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  if (ws) {
    for (const a of ws.activities) {
      out.push({
        ts: a.createdAt,
        source: 'ws',
        kind: a.type,
        detail: `${a.agentShort}: ${a.narrative}`,
      });
    }
  }
  if (em) {
    for (const a of em.auditEntries) {
      out.push({
        ts: a.createdAt,
        source: 'em',
        kind: 'audit',
        detail: a.eventName,
      });
    }
    for (const d of em.dlqEntries) {
      out.push({
        ts: d.createdAt,
        source: 'em',
        kind: 'dlq',
        detail: `${d.eventName}: ${d.reason}`,
      });
    }
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts));
}
