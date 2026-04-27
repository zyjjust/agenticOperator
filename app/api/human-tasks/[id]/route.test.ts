import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/server/clients/ws', () => {
  class WsClientError extends Error {
    constructor(public status: number, msg: string) {
      super(msg);
      this.name = 'WsClientError';
    }
  }
  return {
    wsClient: {
      fetchHumanTask: vi.fn(),
      resolveHumanTask: vi.fn(),
    },
    WsClientError,
  };
});

import { GET, POST } from './route';
import { wsClient, WsClientError } from '@/server/clients/ws';

describe('GET /api/human-tasks/[id]', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns task detail', async () => {
    (wsClient.fetchHumanTask as any).mockResolvedValue({
      id: 't1',
      runId: 'r1',
      nodeId: '5',
      title: 'JD review',
      status: 'pending',
      payload: {},
      aiOpinion: null,
      assignee: null,
      deadline: null,
      createdAt: '2026-01-01',
      chatbotSessionId: null,
    });
    const res = await GET(new Request('http://x/api/human-tasks/t1'), {
      params: Promise.resolve({ id: 't1' }),
    });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.agentShort).toBe('JDReviewer');
    expect(j.hasChatbotSession).toBe(false);
  });

  it('404 when task missing', async () => {
    (wsClient.fetchHumanTask as any).mockRejectedValue(new WsClientError(404, 'Not Found'));
    const res = await GET(new Request('http://x/api/human-tasks/missing'), {
      params: Promise.resolve({ id: 'missing' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/human-tasks/[id]', () => {
  beforeEach(() => vi.clearAllMocks());

  it('approve forwards body and returns updated task', async () => {
    (wsClient.resolveHumanTask as any).mockResolvedValue({
      task: {
        id: 't1',
        runId: 'r1',
        nodeId: '5',
        title: 'JD review',
        status: 'approved',
        payload: {},
        aiOpinion: null,
        assignee: null,
        deadline: null,
        createdAt: '2026-01-01',
        chatbotSessionId: null,
      },
      emittedEvents: ['JD_APPROVED'],
    });
    const res = await POST(
      new Request('http://x/api/human-tasks/t1', {
        method: 'POST',
        body: JSON.stringify({ action: 'approve', comment: 'lgtm' }),
        headers: { 'Content-Type': 'application/json' },
      }),
      { params: Promise.resolve({ id: 't1' }) },
    );
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.task.status).toBe('approved');
    expect(j.emittedEvents).toEqual(['JD_APPROVED']);
  });

  it('409 when task already resolved (stale)', async () => {
    (wsClient.resolveHumanTask as any).mockRejectedValue(new WsClientError(409, 'already resolved'));
    const res = await POST(
      new Request('http://x/api/human-tasks/t1', {
        method: 'POST',
        body: JSON.stringify({ action: 'approve' }),
      }),
      { params: Promise.resolve({ id: 't1' }) },
    );
    expect(res.status).toBe(409);
  });

  it('400 when body missing action', async () => {
    const res = await POST(
      new Request('http://x/api/human-tasks/t1', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ id: 't1' }) },
    );
    expect(res.status).toBe(400);
  });
});
