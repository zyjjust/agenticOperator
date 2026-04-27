import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/server/clients/ws', () => ({
  wsClient: {
    fetchMessages: vi.fn(),
    postMessage: vi.fn(),
  },
  WsClientError: class extends Error {
    constructor(public status: number, msg: string) {
      super(msg);
      this.name = 'WsClientError';
    }
  },
}));

import { GET, POST } from './route';
import { wsClient } from '@/server/clients/ws';

describe('GET /api/human-tasks/[id]/messages', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns sessionId + messages', async () => {
    (wsClient.fetchMessages as any).mockResolvedValue({
      sessionId: 'cs1',
      messages: [
        { role: 'assistant', content: 'hi', timestamp: '2026-01-01' },
      ],
    });
    const res = await GET(new Request('http://x/api/human-tasks/t1/messages'), {
      params: Promise.resolve({ id: 't1' }),
    });
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.sessionId).toBe('cs1');
    expect(j.messages).toHaveLength(1);
  });
});

describe('POST /api/human-tasks/[id]/messages', () => {
  beforeEach(() => vi.clearAllMocks());

  it('posts content, returns updated payload', async () => {
    (wsClient.postMessage as any).mockResolvedValue({
      sessionId: 'cs1',
      messages: [
        { role: 'user', content: 'qq', timestamp: '2026-01-01' },
        { role: 'assistant', content: 'aa', timestamp: '2026-01-01' },
      ],
    });
    const res = await POST(
      new Request('http://x/api/human-tasks/t1/messages', {
        method: 'POST',
        body: JSON.stringify({ content: 'qq' }),
      }),
      { params: Promise.resolve({ id: 't1' }) },
    );
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.messages).toHaveLength(2);
  });

  it('400 when content missing', async () => {
    const res = await POST(
      new Request('http://x/api/human-tasks/t1/messages', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ id: 't1' }) },
    );
    expect(res.status).toBe(400);
  });
});
