import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/server/clients/em', () => ({
  emClient: { fetchEvents: vi.fn() },
  EmClientError: class extends Error {},
}));

import { GET } from './route';
import { emClient } from '@/server/clients/em';

describe('GET /api/events', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns events from EM', async () => {
    (emClient.fetchEvents as any).mockResolvedValue({
      items: [
        {
          name: 'JD_GENERATED',
          stage: 'jd',
          kind: 'domain',
          desc: 'd',
          publishers: ['JDGenerator'],
          subscribers: ['JDReviewer'],
        },
      ],
      total: 1,
    });
    const res = await GET(new Request('http://x/api/events'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.events).toHaveLength(1);
    expect(j.events[0].name).toBe('JD_GENERATED');
  });

  it('on EM error: returns 200 + meta.partial=["em"] using fallback catalog', async () => {
    (emClient.fetchEvents as any).mockRejectedValue(new Error('down'));
    const res = await GET(new Request('http://x/api/events'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.meta.partial).toEqual(['em']);
    expect(Array.isArray(j.events)).toBe(true);
    expect(j.events.length).toBeGreaterThan(0); // catalog fallback
  });
});
