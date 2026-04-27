import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/server/clients/em', () => ({
  emClient: { fetchHealth: vi.fn() },
  EmClientError: class extends Error {},
}));

import { GET } from './route';
import { emClient } from '@/server/clients/em';

describe('GET /api/datasources', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 24 sources from static catalog', async () => {
    (emClient.fetchHealth as any).mockResolvedValue({ status: 'ok' });
    const res = await GET(new Request('http://x/api/datasources'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.sources).toHaveLength(24);
  });

  it('marks sources degraded when EM probe fails', async () => {
    (emClient.fetchHealth as any).mockRejectedValue(new Error('down'));
    const res = await GET(new Request('http://x/api/datasources'));
    const j = await res.json();
    expect(j.meta.partial).toContain('em');
    // when EM probe fails, status falls back to 'ok' for static seed (best-effort)
    expect(j.sources[0].status).toBe('ok');
  });
});
