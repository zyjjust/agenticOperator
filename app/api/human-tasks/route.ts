import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { shortFromWs, UnknownAgentError } from '@/server/normalize/agents';
import type { HumanTasksResponse, HumanTaskCard } from '@/lib/api/types';

// P3 chunk 4: prisma reads from HumanTask. Filtered to status=pending by default.
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const status = url.searchParams.get('status') ?? 'pending';

  try {
    const rows = await prisma.humanTask.findMany({
      where: { status },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    const recent: HumanTaskCard[] = rows.slice(0, 10).map((t) => {
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
        title: t.title,
        assignee: t.assignee ?? null,
        deadline: t.deadline ? t.deadline.toISOString() : null,
        createdAt: t.createdAt.toISOString(),
      };
    });
    const body: HumanTasksResponse = {
      total: rows.length,
      pendingCount: rows.length,
      recent,
      meta: { generatedAt: new Date().toISOString() },
    };
    return NextResponse.json(body);
  } catch (e) {
    return NextResponse.json(
      { error: 'INTERNAL', message: (e as Error).message },
      { status: 500 },
    );
  }
}
