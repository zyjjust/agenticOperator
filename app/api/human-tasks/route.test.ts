import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/server/clients/ws', () => ({
  wsClient: { fetchHumanTasks: vi.fn() },
  WsClientError: class extends Error {},
}));

import { GET } from './route';
import { wsClient } from '@/server/clients/ws';

describe('GET /api/human-tasks', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns count + recent', async () => {
    (wsClient.fetchHumanTasks as any).mockResolvedValue({
      items: [
        {
          id: 't1',
          runId: 'r1',
          nodeId: '5',
          title: 'JD review',
          assignee: null,
          deadline: null,
          createdAt: '2026-01-01',
        },
      ],
      total: 1,
    });
    const res = await GET(new Request('http://x/api/human-tasks'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.total).toBe(1);
    expect(j.recent[0].agentShort).toBe('JDReviewer');
  });

  it('returns empty + meta.partial when WS down', async () => {
    (wsClient.fetchHumanTasks as any).mockRejectedValue(new Error('down'));
    const res = await GET(new Request('http://x/api/human-tasks'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.total).toBe(0);
    expect(j.meta.partial).toContain('ws');
  });
});
