import { describe, it, expect, vi } from 'vitest';

vi.mock('@/server/clients/ws', () => ({
  wsClient: {
    openActivityStream: vi.fn(async () => {
      const enc = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(
              enc.encode(
                'event: activity\ndata: {"id":"a1","runId":"r1","nodeId":"4","type":"event_emitted","narrative":"JD_GENERATED","metadata":{"eventName":"JD_GENERATED"},"createdAt":"2026-01-01"}\n\n',
              ),
            );
            c.enqueue(
              enc.encode(
                'event: activity\ndata: {"id":"a2","runId":"r1","nodeId":"4","type":"event_emitted","narrative":"OTHER","metadata":{"eventName":"OTHER"},"createdAt":"2026-01-01"}\n\n',
              ),
            );
            c.close();
          },
        }),
      );
    }),
  },
  WsClientError: class extends Error {},
}));

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

describe('GET /api/events/[name]/stream', () => {
  it('only forwards events whose metadata.eventName matches', async () => {
    const res = await GET(
      new Request('http://x/api/events/JD_GENERATED/stream'),
      { params: Promise.resolve({ name: 'JD_GENERATED' }) },
    );
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await readAll(res.body!);
    expect(text).toContain('JD_GENERATED');
    expect(text).not.toContain('"eventName":"OTHER"');
  });
});
