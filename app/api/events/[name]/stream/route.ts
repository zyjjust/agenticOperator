import { wsClient } from '@/server/clients/ws';
import { createParser, type EventSourceMessage } from 'eventsource-parser';

export const dynamic = 'force-dynamic';

const HEARTBEAT_INTERVAL_MS = 15_000;

type RouteCtx = { params: Promise<{ name: string }> };

/**
 * Per-event SSE stream — same shape as /api/stream but filtered to one
 * event name. Used by /events Firehose tab.
 */
export async function GET(_req: Request, ctx: RouteCtx): Promise<Response> {
  const { name: eventName } = await ctx.params;

  let upstream: Response;
  try {
    upstream = await wsClient.openActivityStream();
  } catch (e) {
    return new Response(
      `event: error\ndata: ${JSON.stringify({ message: (e as Error).message })}\n\n`,
      {
        status: 502,
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
        },
      },
    );
  }

  if (!upstream.body) {
    return new Response('upstream has no body', { status: 502 });
  }

  const upstreamBody = upstream.body;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const parser = createParser({
        onEvent: (ev: EventSourceMessage) => {
          if (ev.event && ev.event !== 'activity') return;
          let parsed: any;
          try {
            parsed = JSON.parse(ev.data);
          } catch {
            return;
          }
          // Match event name from metadata or narrative substring (best-effort).
          const metaName = parsed?.metadata?.eventName;
          if (metaName && metaName !== eventName) return;
          if (!metaName && !String(parsed.narrative ?? '').includes(eventName)) return;

          controller.enqueue(
            enc.encode(`event: activity\ndata: ${JSON.stringify(parsed)}\n\n`),
          );
        },
      });

      const reader = upstreamBody.getReader();
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(
            enc.encode(
              `event: heartbeat\ndata: {"t":"${new Date().toISOString()}"}\n\n`,
            ),
          );
        } catch {
          /* closed */
        }
      }, HEARTBEAT_INTERVAL_MS);

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          parser.feed(dec.decode(value));
        }
      } catch (e) {
        controller.enqueue(
          enc.encode(
            `event: error\ndata: ${JSON.stringify({ message: (e as Error).message })}\n\n`,
          ),
        );
      } finally {
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* closed */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
