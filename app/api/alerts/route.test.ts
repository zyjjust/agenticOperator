import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/server/clients/ws', () => ({
  wsClient: { fetchRuns: vi.fn() },
  WsClientError: class extends Error {},
}));
vi.mock('@/server/clients/em', () => ({
  emClient: { fetchDLQ: vi.fn() },
  EmClientError: class extends Error {},
}));

import { GET } from './route';
import { wsClient } from '@/server/clients/ws';
import { emClient } from '@/server/clients/em';

describe('GET /api/alerts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('synthesizes alerts from timed_out runs and dlq entries', async () => {
    (wsClient.fetchRuns as any).mockResolvedValue({
      runs: [
        {
          id: 'r1',
          triggerEvent: 'X',
          status: 'timed_out',
          startedAt: '2026-01-01',
          lastActivityAt: '2026-01-01',
          suspendedReason: 'sla',
        },
      ],
      total: 1,
    });
    (emClient.fetchDLQ as any).mockResolvedValue({
      items: [{ id: 'd1', eventName: 'Y', reason: 'parse error', createdAt: '2026-01-01' }],
      total: 1,
    });
    const res = await GET(new Request('http://x/api/alerts'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.alerts.find((a: any) => a.category === 'sla')).toBeTruthy();
    expect(j.alerts.find((a: any) => a.category === 'dlq')).toBeTruthy();
  });

  it('partial when both upstreams down', async () => {
    (wsClient.fetchRuns as any).mockRejectedValue(new Error('down'));
    (emClient.fetchDLQ as any).mockRejectedValue(new Error('down'));
    const res = await GET(new Request('http://x/api/alerts'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.alerts).toEqual([]);
    expect(j.meta.partial).toEqual(expect.arrayContaining(['ws', 'em']));
  });
});
