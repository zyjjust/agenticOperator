import { describe, it, expect, vi, beforeEach } from 'vitest';
import { emClient, EmClientError } from './em';

describe('emClient', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));

  it('GET /api/manager/events returns parsed list', async () => {
    (fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ items: [{ name: 'X' }], total: 1 }),
    });
    const out = await emClient.fetchEvents({ stage: ['jd'] });
    expect(out.total).toBe(1);
  });

  it('throws EmClientError on 5xx', async () => {
    (fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
    });
    await expect(emClient.fetchHealth()).rejects.toThrow(EmClientError);
  });

  it('throws EmClientError on network error', async () => {
    (fetch as any).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(emClient.fetchHealth()).rejects.toThrow(EmClientError);
  });
});
