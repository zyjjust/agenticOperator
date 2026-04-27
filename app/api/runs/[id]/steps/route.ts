import { NextResponse } from 'next/server';
import { wsClient, WsClientError } from '@/server/clients/ws';
import {
  normalizeStepStatus,
  InvalidStatusError,
} from '@/server/normalize/status';
import { shortFromWs, UnknownAgentError } from '@/server/normalize/agents';
import type { StepsResponse, StepDetail } from '@/lib/api/types';

const PAYLOAD_TRUNC_BYTES = 4096;

type RouteCtx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: RouteCtx): Promise<Response> {
  const { id: runId } = await ctx.params;
  try {
    const wsRes = await wsClient.fetchSteps(runId);
    const steps: StepDetail[] = [];
    for (const s of wsRes.steps as any[]) {
      let agentShort: string;
      try {
        agentShort = shortFromWs(s.nodeId);
      } catch (e) {
        // Unknown nodeId means a step from an agent we don't have in the map.
        // Skip rather than 502 so a single drift doesn't break the whole feed.
        if (e instanceof UnknownAgentError) continue;
        throw e;
      }
      steps.push({
        id: s.id,
        nodeId: s.nodeId,
        agentShort,
        status: normalizeStepStatus(s.status),
        startedAt: s.startedAt,
        completedAt: s.completedAt ?? null,
        durationMs: s.durationMs ?? null,
        input: truncateForUi(s.input),
        output: truncateForUi(s.output),
        error: s.error ?? null,
      });
    }
    const body: StepsResponse = {
      steps,
      meta: { generatedAt: new Date().toISOString() },
    };
    return NextResponse.json(body);
  } catch (e) {
    if (e instanceof WsClientError || (e as Error)?.name === 'WsClientError') {
      return NextResponse.json(
        { error: 'UPSTREAM_DOWN', message: (e as Error).message },
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

function truncateForUi(value: unknown): unknown {
  if (value == null) return null;
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (s.length <= PAYLOAD_TRUNC_BYTES) return value;
  return { _truncated: true, sample: s.slice(0, PAYLOAD_TRUNC_BYTES) };
}
