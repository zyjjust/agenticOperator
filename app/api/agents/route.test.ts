import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/server/clients/ws', () => ({
  wsClient: {
    fetchRuns: vi.fn(),
    fetchActivityFeed: vi.fn(),
  },
  WsClientError: class extends Error {},
}));

import { GET } from './route';
import { wsClient } from '@/server/clients/ws';

describe('GET /api/agents', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 22 agents with merged static + dynamic data', async () => {
    (wsClient.fetchRuns as any).mockResolvedValue({ runs: [], total: 0 });
    (wsClient.fetchActivityFeed as any).mockResolvedValue({ items: [], total: 0 });
    const res = await GET(new Request('http://x/api/agents'));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.agents).toHaveLength(22);
    const matcher = json.agents.find((a: any) => a.short === 'Matcher');
    expect(matcher.wsId).toBe('10');
    expect(matcher.displayName).toBe('display_matcher');
  });

  it('on WS error: returns 200 with meta.partial=["ws"]', async () => {
    (wsClient.fetchRuns as any).mockRejectedValue(new Error('down'));
    (wsClient.fetchActivityFeed as any).mockRejectedValue(new Error('down'));
    const res = await GET(new Request('http://x/api/agents'));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.meta.partial).toEqual(['ws']);
    expect(json.agents[0].p50Ms).toBeNull();
    expect(json.agents[0].lastActivityAt).toBeNull();
  });
});
