import { NextResponse } from 'next/server';
import { AGENT_MAP } from '@/lib/agent-mapping';
import { displayKey } from '@/server/normalize/agents';
import { wsClient } from '@/server/clients/ws';
import type { AgentsResponse, AgentRow } from '@/lib/api/types';

export async function GET(_req: Request): Promise<Response> {
  const partial: ('ws' | 'em')[] = [];
  let activityByAgent: Record<string, any[]> = {};

  // P1: cross-cutting per-agent run aggregation requires WS run→step→nodeId joins
  // not exposed by the sidecar API. We surface basic activity counts and leave
  // p50/successRate/cost null until P3 (in-process Prisma joins).
  try {
    await wsClient.fetchRuns({
      limit: 1000,
      status: ['running', 'suspended', 'completed', 'failed'],
    });
  } catch {
    if (!partial.includes('ws')) partial.push('ws');
  }

  try {
    const feed = await wsClient.fetchActivityFeed({ limit: 1000 });
    activityByAgent = groupActivityByAgent(feed.items);
  } catch {
    if (!partial.includes('ws')) partial.push('ws');
  }

  const wsDown = partial.includes('ws');

  const agents: AgentRow[] = AGENT_MAP.map((a) => {
    const acts = activityByAgent[a.short] ?? [];
    return {
      short: a.short,
      wsId: a.wsId,
      displayName: displayKey(a.short),
      stage: a.stage,
      kind: a.kind,
      ownerTeam: a.ownerTeam,
      version: a.version,
      status: null,
      p50Ms: wsDown ? null : null, // P3 will compute
      runs24h: 0,
      successRate: null,
      costYuan: 0,
      lastActivityAt: wsDown ? null : (acts[0]?.createdAt ?? null),
      spark: Array(16).fill(0),
    };
  });

  const body: AgentsResponse = {
    agents,
    meta: {
      partial: partial.length ? partial : undefined,
      generatedAt: new Date().toISOString(),
    },
  };
  return NextResponse.json(body);
}

function groupActivityByAgent(items: any[]): Record<string, any[]> {
  const out: Record<string, any[]> = {};
  for (const it of items) {
    const k = (it.agentName as string) ?? 'unknown';
    (out[k] ||= []).push(it);
  }
  return out;
}
