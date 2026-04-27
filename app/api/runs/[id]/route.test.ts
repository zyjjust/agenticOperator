import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/server/clients/ws', () => {
  class WsClientError extends Error {
    constructor(public status: number, msg: string) {
      super(msg);
      this.name = 'WsClientError';
    }
  }
  return {
    wsClient: { fetchRun: vi.fn() },
    WsClientError,
  };
});

import { GET } from './route';
import { wsClient, WsClientError } from '@/server/clients/ws';

describe('GET /api/runs/[id]', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns run detail when found', async () => {
    (wsClient.fetchRun as any).mockResolvedValue({
      id: 'r1',
      triggerEvent: 'X',
      triggerData: '{}',
      status: 'running',
      startedAt: '2026-01-01',
      lastActivityAt: '2026-01-01',
    });
    const res = await GET(new Request('http://x/api/runs/r1'), {
      params: Promise.resolve({ id: 'r1' }),
    });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.id).toBe('r1');
  });

  it('404 when WS returns 404', async () => {
    (wsClient.fetchRun as any).mockRejectedValue(new WsClientError(404, 'Not Found'));
    const res = await GET(new Request('http://x/api/runs/missing'), {
      params: Promise.resolve({ id: 'missing' }),
    });
    expect(res.status).toBe(404);
  });
});
