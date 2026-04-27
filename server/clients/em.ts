/**
 * EM sidecar HTTP client (server-only).
 *
 * Only fetches **runtime/audit/gateway** resources (Q1 decision: no Editor
 * migration). Imported by app/api/* Route Handlers; replaced in P3.
 */

const BASE = process.env.EM_BASE_URL ?? 'http://localhost:8000';
const TIMEOUT_MS = 5000;

export class EmClientError extends Error {
  constructor(
    public status: number,
    message: string,
    public override cause?: Error,
  ) {
    super(`EM upstream error (${status}): ${message}`);
    this.name = 'EmClientError';
  }
}

type Query = Record<string, string | number | string[] | undefined | null>;

async function get<T>(path: string, query?: Query): Promise<T> {
  const url = new URL(BASE + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) url.searchParams.set(k, v.join(','));
      else url.searchParams.set(k, String(v));
    }
  }
  const sig = AbortSignal.timeout(TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url.toString(), { signal: sig });
  } catch (e) {
    throw new EmClientError(0, (e as Error).message, e as Error);
  }
  if (!res.ok) {
    throw new EmClientError(res.status, res.statusText);
  }
  return res.json() as Promise<T>;
}

export const emClient = {
  base: BASE,

  fetchEvents(q?: { stage?: string[]; q?: string }) {
    return get<{ items: any[]; total: number }>('/api/manager/events', q);
  },

  fetchAuditLog(q?: { eventName?: string; limit?: number }) {
    return get<{ items: any[]; total: number }>('/api/manager/audit', q);
  },

  fetchDLQ(q?: { eventName?: string; limit?: number }) {
    return get<{ items: any[]; total: number }>('/api/manager/dlq', q);
  },

  fetchHealth() {
    return get<{ status: string }>('/api/manager/health');
  },
};
