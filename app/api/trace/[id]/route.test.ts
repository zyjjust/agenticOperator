import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/server/clients/ws', () => ({
  wsClient: { fetchRun: vi.fn(), fetchSteps: vi.fn(), fetchActivityFeed: vi.fn() },
  WsClientError: class extends Error {},
}));
vi.mock('@/server/clients/em', () => ({
  emClient: { fetchAuditLog: vi.fn(), fetchDLQ: vi.fn() },
  EmClientError: class extends Error {},
}));

import { GET } from './route';
import { wsClient } from '@/server/clients/ws';
import { emClient } from '@/server/clients/em';

describe('GET /api/trace/[id]', () => {
  beforeEach(() => vi.clearAllMocks());

  it('aggregates ws + em data into unified timeline', async () => {
    (wsClient.fetchRun as any).mockResolvedValue({
      id: 'r1',
      triggerEvent: 'X',
      triggerData: '{}',
      status: 'running',
      startedAt: '2026-01-01T00:00:00Z',
      lastActivityAt: '2026-01-01T00:01:00Z',
    });
    (wsClient.fetchSteps as any).mockResolvedValue({ steps: [] });
    (wsClient.fetchActivityFeed as any).mockResolvedValue({ items: [], total: 0 });
    (emClient.fetchAuditLog as any).mockResolvedValue({
      items: [{ id: 'a1', eventName: 'X', traceId: 'r1', payloadDigest: 'd', createdAt: '2026-01-01T00:00:30Z' }],
      total: 1,
    });
    (emClient.fetchDLQ as any).mockResolvedValue({ items: [], total: 0 });

    const res = await GET(new Request('http://x/api/trace/r1'), {
      params: Promise.resolve({ id: 'r1' }),
    });
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ws).not.toBeNull();
    expect(j.em).not.toBeNull();
    expect(j.unifiedTimeline.length).toBeGreaterThan(0);
  });

  it('returns partial on WS down, EM up', async () => {
    (wsClient.fetchRun as any).mockRejectedValue(new Error('down'));
    (wsClient.fetchSteps as any).mockRejectedValue(new Error('down'));
    (wsClient.fetchActivityFeed as any).mockRejectedValue(new Error('down'));
    (emClient.fetchAuditLog as any).mockResolvedValue({ items: [], total: 0 });
    (emClient.fetchDLQ as any).mockResolvedValue({ items: [], total: 0 });
    const res = await GET(new Request('http://x/api/trace/r1'), {
      params: Promise.resolve({ id: 'r1' }),
    });
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.meta.partial).toContain('ws');
    expect(j.ws).toBeNull();
    expect(j.em).not.toBeNull();
  });
});
