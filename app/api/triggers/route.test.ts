import { describe, it, expect } from 'vitest';
import { GET } from './route';

describe('GET /api/triggers', () => {
  it('returns 3 trigger kinds (cron + webhook + upstream)', async () => {
    const res = await GET(new Request('http://x/api/triggers'));
    const j = await res.json();
    expect(res.status).toBe(200);
    const kinds = new Set(j.triggers.map((t: any) => t.kind));
    expect(kinds.has('cron')).toBe(true);
    expect(kinds.has('webhook')).toBe(true);
    expect(kinds.has('upstream')).toBe(true);
  });

  it('filters by kind=cron', async () => {
    const res = await GET(new Request('http://x/api/triggers?kind=cron'));
    const j = await res.json();
    for (const t of j.triggers) {
      expect(t.kind).toBe('cron');
    }
    expect(j.triggers.length).toBeGreaterThan(0);
  });

  it('upstream entries derived from AGENT_MAP have non-empty emits', async () => {
    const res = await GET(new Request('http://x/api/triggers?kind=upstream'));
    const j = await res.json();
    expect(j.triggers.length).toBeGreaterThan(0);
    for (const t of j.triggers) {
      expect(t.kind).toBe('upstream');
      expect(t.upstreamEvent).toBeTruthy();
    }
  });
});
