import { NextResponse } from 'next/server';
import { wsClient, WsClientError } from '@/server/clients/ws';
import { shortFromWs, UnknownAgentError } from '@/server/normalize/agents';
import type {
  HumanTaskDetail,
  HumanTaskActionResult,
} from '@/lib/api/types';

type RouteCtx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: RouteCtx): Promise<Response> {
  const { id } = await ctx.params;
  try {
    const t = await wsClient.fetchHumanTask(id);
    if (!t) {
      return NextResponse.json(
        { error: 'NOT_FOUND', message: `human task ${id} not found` },
        { status: 404 },
      );
    }
    return NextResponse.json(toDetail(t, id));
  } catch (e) {
    return mapWsError(e, id);
  }
}

export async function POST(req: Request, ctx: RouteCtx): Promise<Response> {
  const { id } = await ctx.params;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'BAD_REQUEST', message: 'request body must be JSON' },
      { status: 400 },
    );
  }

  const action = body?.action;
  if (action !== 'approve' && action !== 'reject' && action !== 'escalate') {
    return NextResponse.json(
      {
        error: 'BAD_REQUEST',
        message: 'action must be approve | reject | escalate',
        field: 'action',
      },
      { status: 400 },
    );
  }
  if (action === 'reject' && !body.reason) {
    return NextResponse.json(
      { error: 'BAD_REQUEST', message: 'reject requires reason', field: 'reason' },
      { status: 400 },
    );
  }
  if (action === 'escalate' && !body.targetClient) {
    return NextResponse.json(
      {
        error: 'BAD_REQUEST',
        message: 'escalate requires targetClient',
        field: 'targetClient',
      },
      { status: 400 },
    );
  }

  try {
    const wsRes = await wsClient.resolveHumanTask(id, body);
    const result: HumanTaskActionResult = {
      task: toDetail(wsRes.task, id),
      emittedEvents: wsRes.emittedEvents ?? [],
      newChildSession: wsRes.newChildSession,
      meta: { generatedAt: new Date().toISOString() },
    };
    return NextResponse.json(result);
  } catch (e) {
    return mapWsError(e, id);
  }
}

function toDetail(t: any, fallbackId: string): HumanTaskDetail {
  let agentShort = 'unknown';
  try {
    agentShort = shortFromWs(t.nodeId);
  } catch (e) {
    if (!(e instanceof UnknownAgentError)) throw e;
  }
  return {
    id: t.id ?? fallbackId,
    runId: t.runId,
    nodeId: t.nodeId,
    agentShort,
    title: t.title ?? `${agentShort} pending`,
    assignee: t.assignee ?? null,
    deadline: t.deadline ?? null,
    createdAt: t.createdAt,
    status: t.status ?? 'pending',
    payload: t.payload ?? null,
    aiOpinion: t.aiOpinion ?? null,
    hasChatbotSession: !!t.chatbotSessionId,
    chatbotSessionId: t.chatbotSessionId ?? null,
  };
}

function mapWsError(e: unknown, id: string): Response {
  if (e instanceof WsClientError || (e as Error)?.name === 'WsClientError') {
    const we = e as WsClientError;
    if (we.status === 404) {
      return NextResponse.json(
        { error: 'NOT_FOUND', message: `human task ${id} not found` },
        { status: 404 },
      );
    }
    if (we.status === 409) {
      return NextResponse.json(
        { error: 'BAD_REQUEST', message: `stale: ${we.message}` },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: 'UPSTREAM_DOWN', message: `WS unreachable: ${we.message}` },
      { status: 502 },
    );
  }
  throw e;
}
