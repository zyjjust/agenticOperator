import { NextResponse } from 'next/server';
import { wsClient } from '@/server/clients/ws';
import { shortFromWs, UnknownAgentError } from '@/server/normalize/agents';
import type { HumanTasksResponse, HumanTaskCard, ApiMeta } from '@/lib/api/types';

export async function GET(_req: Request): Promise<Response> {
  const partial: ApiMeta['partial'] = [];
  let recent: HumanTaskCard[] = [];
  let total = 0;
  let pendingCount = 0;

  try {
    const wsRes = await wsClient.fetchHumanTasks({ status: 'pending' });
    total = wsRes.total;
    pendingCount = wsRes.total;
    recent = (wsRes.items as any[]).slice(0, 10).map((t) => {
      let agentShort = 'unknown';
      try {
        agentShort = shortFromWs(t.nodeId);
      } catch (e) {
        if (!(e instanceof UnknownAgentError)) throw e;
      }
      return {
        id: t.id,
        runId: t.runId,
        nodeId: t.nodeId,
        agentShort,
        title: t.title ?? `${agentShort} pending`,
        assignee: t.assignee ?? null,
        deadline: t.deadline ?? null,
        createdAt: t.createdAt,
      };
    });
  } catch {
    partial.push('ws');
  }

  const body: HumanTasksResponse = {
    total,
    pendingCount,
    recent,
    meta: {
      partial: partial.length ? partial : undefined,
      generatedAt: new Date().toISOString(),
    },
  };
  return NextResponse.json(body);
}
