import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/server/clients/ws', () => ({
  wsClient: { fetchSteps: vi.fn() },
  WsClientError: class extends Error {
    constructor(public status: number, msg: string) {
      super(msg);
      this.name = 'WsClientError';
    }
  },
}));

import { GET } from './route';
import { wsClient } from '@/server/clients/ws';

describe('GET /api/runs/[id]/steps', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps nodeId to agentShort and normalizes status', async () => {
    (wsClient.fetchSteps as any).mockResolvedValue({
      steps: [
        {
          id: 's1',
          nodeId: '10',
          status: 'running',
          startedAt: '2026-01-01',
          completedAt: null,
          durationMs: null,
          input: null,
          output: null,
          error: null,
        },
      ],
    });
    const res = await GET(new Request('http://x/.../steps'), {
      params: Promise.resolve({ id: 'r1' }),
    });
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.steps[0].agentShort).toBe('Matcher');
    expect(j.steps[0].status).toBe('running');
  });

  it('truncates oversized input/output to 4KB', async () => {
    const huge = { data: 'x'.repeat(10_000) };
    (wsClient.fetchSteps as any).mockResolvedValue({
      steps: [
        {
          id: 's1',
          nodeId: '10',
          status: 'completed',
          startedAt: '2026-01-01',
          completedAt: '2026-01-01',
          durationMs: 100,
          input: huge,
          output: huge,
          error: null,
        },
      ],
    });
    const res = await GET(new Request('http://x/.../steps'), {
      params: Promise.resolve({ id: 'r1' }),
    });
    const j = await res.json();
    expect(JSON.stringify(j.steps[0].input).length).toBeLessThanOrEqual(4500);
    expect(JSON.stringify(j.steps[0].output).length).toBeLessThanOrEqual(4500);
  });

  it('skips steps with unknown nodeId rather than 502', async () => {
    (wsClient.fetchSteps as any).mockResolvedValue({
      steps: [
        {
          id: 's1',
          nodeId: '999', // unknown
          status: 'running',
          startedAt: '2026-01-01',
          completedAt: null,
          durationMs: null,
          input: null,
          output: null,
          error: null,
        },
      ],
    });
    const res = await GET(new Request('http://x/.../steps'), {
      params: Promise.resolve({ id: 'r1' }),
    });
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.steps).toHaveLength(0);
  });
});
