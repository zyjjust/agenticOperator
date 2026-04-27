import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/server/clients/ws', () => ({
  wsClient: { fetchRuns: vi.fn() },
  WsClientError: class extends Error {},
}));

import { GET } from './route';
import { wsClient } from '@/server/clients/ws';

describe('GET /api/runs', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns runs from WS, normalizes status', async () => {
    (wsClient.fetchRuns as any).mockResolvedValue({
      runs: [
        {
          id: 'r1',
          triggerEvent: 'X',
          triggerData: '{}',
          status: 'running',
          startedAt: '2026-01-01',
          lastActivityAt: '2026-01-01',
          completedAt: null,
          suspendedReason: null,
        },
      ],
      total: 1,
    });
    const res = await GET(new Request('http://x/api/runs?limit=10'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.runs[0].status).toBe('running');
    expect(j.total).toBe(1);
  });

  it('502 when run carries invalid status enum (legacy mock value)', async () => {
    (wsClient.fetchRuns as any).mockResolvedValue({
      runs: [{ id: 'r1', triggerEvent: 'X', status: 'review', startedAt: '', lastActivityAt: '' }],
      total: 1,
    });
    const res = await GET(new Request('http://x/api/runs'));
    const j = await res.json();
    expect(res.status).toBe(502);
    expect(j.error).toBe('PROTOCOL');
  });

  it('502 when WS unreachable', async () => {
    (wsClient.fetchRuns as any).mockRejectedValue(
      Object.assign(new Error('down'), { name: 'WsClientError', status: 0 }),
    );
    const res = await GET(new Request('http://x/api/runs'));
    expect(res.status).toBe(502);
  });

  it('parses triggerData JSON string into client/jdId object', async () => {
    (wsClient.fetchRuns as any).mockResolvedValue({
      runs: [
        {
          id: 'r1',
          triggerEvent: 'REQUIREMENT_SYNCED',
          triggerData: JSON.stringify({ client: 'ABC', requisition_id: 'JD-1' }),
          status: 'completed',
          startedAt: '2026-01-01',
          lastActivityAt: '2026-01-01',
        },
      ],
      total: 1,
    });
    const res = await GET(new Request('http://x/api/runs'));
    const j = await res.json();
    expect(j.runs[0].triggerData).toEqual({ client: 'ABC', jdId: 'JD-1' });
  });
});
