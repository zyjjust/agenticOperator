import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchJson } from './client';

describe('fetchJson', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));

  it('returns parsed JSON on 200', async () => {
    (fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ a: 1 }),
    });
    const out = await fetchJson<{ a: number }>('/api/runs');
    expect(out.a).toBe(1);
  });

  it('throws structured ApiError on 4xx with JSON body', async () => {
    (fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: async () => ({ error: 'BAD_REQUEST', message: 'x', field: 'y' }),
    });
    await expect(fetchJson('/api/runs')).rejects.toMatchObject({
      error: 'BAD_REQUEST',
      field: 'y',
    });
  });

  it('throws fallback ApiError on 4xx without JSON body', async () => {
    (fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal',
      json: async () => {
        throw new Error('not json');
      },
    });
    await expect(fetchJson('/api/runs')).rejects.toMatchObject({
      error: 'INTERNAL',
      message: 'Internal',
    });
  });
});
