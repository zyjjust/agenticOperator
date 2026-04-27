import { describe, it, expect, vi, beforeEach } from 'vitest';
import { wsClient, WsClientError } from './ws';

describe('wsClient', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('GET /api/runs forwards query params and reshapes {count,items}→{runs,total}', async () => {
    (fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ count: 1, items: [{ id: 'r1', status: 'running', trigger_event: 'X', started_at: 't' }] }),
    });
    const out = await wsClient.fetchRuns({ status: ['running'], limit: 5 });
    expect(out.total).toBe(1);
    expect(out.runs[0]).toMatchObject({ id: 'r1', triggerEvent: 'X', startedAt: 't' });
    const calledUrl = (fetch as any).mock.calls[0][0];
    expect(calledUrl).toContain('status=running');
    expect(calledUrl).toContain('limit=5');
  });

  it('throws WsClientError on 5xx', async () => {
    (fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
    });
    await expect(wsClient.fetchRuns({ limit: 1 })).rejects.toThrow(WsClientError);
  });

  it('throws WsClientError on network error', async () => {
    (fetch as any).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(wsClient.fetchRuns({ limit: 1 })).rejects.toThrow(WsClientError);
  });

  it('joins array params with commas', async () => {
    (fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ runs: [], total: 0 }),
    });
    await wsClient.fetchRuns({ status: ['running', 'suspended'], limit: 1 });
    const url = (fetch as any).mock.calls[0][0];
    expect(url).toContain('status=running%2Csuspended');
  });
});
