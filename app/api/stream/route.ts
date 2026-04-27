import { wsClient } from '@/server/clients/ws';
import { createParser, type EventSourceMessage } from 'eventsource-parser';
import { shortFromWs, UnknownAgentError } from '@/server/normalize/agents';

export const dynamic = 'force-dynamic';

const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * SSE multiplexer.
 *
 * Subscribes to WS /api/activity/stream once on the server, parses events,
 * filters by query (runId, agent, type), and re-emits to the browser.
 * Sends `heartbeat` every 15s so disconnected proxies/browsers can detect
 * dead connections and reconnect via lib/api/sse.ts useSSE hook.
 */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const filterRunId = url.searchParams.get('runId');
  const filterAgent = url.searchParams.get('agent');
  const filterTypes = url.searchParams.get('type')?.split(',');

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

          if (filterRunId && parsed.runId !== filterRunId) return;

          if (filterAgent) {
            let short: string | undefined;
            if (parsed.agentName) {
              short = parsed.agentName;
            } else if (parsed.nodeId) {
              try {
                short = shortFromWs(parsed.nodeId);
              } catch (e) {
                if (e instanceof UnknownAgentError) return;
                throw e;
              }
            }
            if (short !== filterAgent) return;
          }

          if (filterTypes && !filterTypes.includes(parsed.type)) return;

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
          /* controller already closed */
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
          /* already closed */
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
