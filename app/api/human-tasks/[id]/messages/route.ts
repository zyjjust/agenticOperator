import { NextResponse } from 'next/server';
import { wsClient, WsClientError } from '@/server/clients/ws';
import type { MessagesResponse, Message } from '@/lib/api/types';

type RouteCtx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: RouteCtx): Promise<Response> {
  const { id } = await ctx.params;
  try {
    const res = await wsClient.fetchMessages(id);
    const body: MessagesResponse = {
      sessionId: res.sessionId ?? null,
      messages: toMessages(res.messages),
      meta: { generatedAt: new Date().toISOString() },
    };
    return NextResponse.json(body);
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

  if (!body?.content || typeof body.content !== 'string') {
    return NextResponse.json(
      {
        error: 'BAD_REQUEST',
        message: 'content (string) required',
        field: 'content',
      },
      { status: 400 },
    );
  }

  try {
    const res = await wsClient.postMessage(id, body.content);
    const out: MessagesResponse = {
      sessionId: res.sessionId ?? null,
      messages: toMessages(res.messages),
      meta: { generatedAt: new Date().toISOString() },
    };
    return NextResponse.json(out);
  } catch (e) {
    return mapWsError(e, id);
  }
}

function toMessages(arr: unknown): Message[] {
  if (!Array.isArray(arr)) return [];
  return arr.map((m: any) => ({
    role: (m.role ?? 'system') as Message['role'],
    content: String(m.content ?? ''),
    timestamp: String(m.timestamp ?? new Date().toISOString()),
  }));
}

function mapWsError(e: unknown, id: string): Response {
  if (e instanceof WsClientError || (e as Error)?.name === 'WsClientError') {
    const we = e as WsClientError;
    if (we.status === 404) {
      return NextResponse.json(
        { error: 'NOT_FOUND', message: `task ${id} or session not found` },
        { status: 404 },
      );
    }
    if (we.status === 410) {
      // Session expired
      return NextResponse.json(
        { error: 'BAD_REQUEST', message: 'session expired' },
        { status: 410 },
      );
    }
    return NextResponse.json(
      { error: 'UPSTREAM_DOWN', message: `WS unreachable: ${we.message}` },
      { status: 502 },
    );
  }
  throw e;
}
