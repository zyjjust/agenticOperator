import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/server/db', () => ({
  prisma: {
    workflowRun: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
  },
}));

import { GET } from './route';
import { prisma } from '@/server/db';

describe('GET /api/runs (P3 prisma)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns runs from prisma, normalizes status', async () => {
    (prisma.workflowRun.findMany as any).mockResolvedValue([
      {
        id: 'r1',
        triggerEvent: 'X',
        triggerData: '{}',
        status: 'running',
        startedAt: new Date('2026-01-01T00:00:00Z'),
        lastActivityAt: new Date('2026-01-01T00:00:00Z'),
        completedAt: null,
        suspendedReason: null,
      },
    ]);
    (prisma.workflowRun.count as any).mockResolvedValue(1);
    const res = await GET(new Request('http://x/api/runs?limit=10'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.runs[0].status).toBe('running');
    expect(j.total).toBe(1);
  });

  it('502 when row carries invalid status enum', async () => {
    (prisma.workflowRun.findMany as any).mockResolvedValue([
      {
        id: 'r1',
        triggerEvent: 'X',
        triggerData: '{}',
        status: 'review', // legacy mock value
        startedAt: new Date(),
        lastActivityAt: new Date(),
        completedAt: null,
        suspendedReason: null,
      },
    ]);
    (prisma.workflowRun.count as any).mockResolvedValue(1);
    const res = await GET(new Request('http://x/api/runs'));
    const j = await res.json();
    expect(res.status).toBe(502);
    expect(j.error).toBe('PROTOCOL');
  });

  it('500 when prisma query fails', async () => {
    (prisma.workflowRun.findMany as any).mockRejectedValue(new Error('db down'));
    const res = await GET(new Request('http://x/api/runs'));
    expect(res.status).toBe(500);
  });

  it('parses triggerData JSON string', async () => {
    (prisma.workflowRun.findMany as any).mockResolvedValue([
      {
        id: 'r1',
        triggerEvent: 'REQUIREMENT_SYNCED',
        triggerData: JSON.stringify({ client: 'ABC', requisition_id: 'JD-1' }),
        status: 'completed',
        startedAt: new Date(),
        lastActivityAt: new Date(),
        completedAt: null,
        suspendedReason: null,
      },
    ]);
    (prisma.workflowRun.count as any).mockResolvedValue(1);
    const res = await GET(new Request('http://x/api/runs'));
    const j = await res.json();
    expect(j.runs[0].triggerData).toEqual({ client: 'ABC', jdId: 'JD-1' });
  });
});
