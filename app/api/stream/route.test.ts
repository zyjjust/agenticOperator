import { describe, it, expect, vi } from 'vitest';

vi.mock('@/server/clients/ws', () => {
  return {
    wsClient: {
      openActivityStream: vi.fn(async () => {
        const enc = new TextEncoder();
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(
                enc.encode(
                  'event: activity\ndata: {"id":"a1","runId":"r1","nodeId":"10","type":"decision","narrative":"x","createdAt":"2026-01-01"}\n\n',
                ),
              );
              c.enqueue(
                enc.encode(
                  'event: activity\ndata: {"id":"a2","runId":"r2","nodeId":"4","type":"tool","narrative":"y","createdAt":"2026-01-01"}\n\n',
                ),
              );
              c.close();
            },
          }),
        );
      }),
    },
    WsClientError: class extends Error {},
  };
});

import { GET } from './route';

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    out += dec.decode(value);
  }
  return out;
}

describe('GET /api/stream', () => {
  it('forwards events filtered by runId', async () => {
    const res = await GET(new Request('http://x/api/stream?runId=r1'));
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await readAll(res.body!);
    expect(text).toContain('"runId":"r1"');
    expect(text).not.toContain('"runId":"r2"');
  });

  it('forwards all when no filter', async () => {
    const res = await GET(new Request('http://x/api/stream'));
    const text = await readAll(res.body!);
    expect(text).toContain('"runId":"r1"');
    expect(text).toContain('"runId":"r2"');
  });

  it('filters by type CSV', async () => {
    const res = await GET(new Request('http://x/api/stream?type=tool'));
    const text = await readAll(res.body!);
    expect(text).toContain('"type":"tool"');
    expect(text).not.toContain('"type":"decision"');
  });
});
