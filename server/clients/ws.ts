/**
 * WS sidecar HTTP+SSE client (server-only).
 *
 * Imported by app/api/* Route Handlers in P1. Replaced in P3 by direct
 * imports from server/ws/* modules (no HTTP).
 */

const BASE = process.env.WS_BASE_URL ?? 'http://localhost:5175';
const TIMEOUT_MS = 5000;

export class WsClientError extends Error {
  constructor(
    public status: number,
    message: string,
    public override cause?: Error,
  ) {
    super(`WS upstream error (${status}): ${message}`);
    this.name = 'WsClientError';
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
    throw new WsClientError(0, (e as Error).message, e as Error);
  }
  if (!res.ok) {
    throw new WsClientError(res.status, res.statusText);
  }
  return res.json() as Promise<T>;
}

export const wsClient = {
  base: BASE,

  fetchRuns(q: { status?: string[]; limit?: number; since?: string }) {
    return get<{ runs: any[]; total: number }>('/api/runs', q as Query);
  },

  fetchRun(id: string) {
    return get<any>(`/api/runs/${encodeURIComponent(id)}`);
  },

  fetchSteps(runId: string) {
    return get<{ steps: any[] }>(
      `/api/runs/${encodeURIComponent(runId)}/steps`,
    );
  },

  fetchActivityFeed(q: { limit?: number; nodeId?: string; runId?: string }) {
    return get<{ items: any[]; total: number }>('/api/activity/feed', q as Query);
  },

  fetchHumanTasks(q: { status?: string }) {
    return get<{ items: any[]; total: number }>('/api/human-task', q as Query);
  },

  fetchHumanTask(id: string) {
    return get<any>(`/api/human-task/${encodeURIComponent(id)}`);
  },

  async resolveHumanTask(
    id: string,
    body: { action: 'approve' | 'reject' | 'escalate'; comment?: string; reason?: string; targetClient?: string },
  ): Promise<any> {
    const url = `${BASE}/api/human-task/${encodeURIComponent(id)}/resolve`;
    const sig = AbortSignal.timeout(TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: sig,
      });
    } catch (e) {
      throw new WsClientError(0, (e as Error).message, e as Error);
    }
    if (!res.ok) {
      throw new WsClientError(res.status, res.statusText);
    }
    return res.json();
  },

  fetchMessages(taskId: string) {
    return get<any>(`/api/human-task/${encodeURIComponent(taskId)}/messages`);
  },

  async postMessage(taskId: string, content: string): Promise<any> {
    const url = `${BASE}/api/human-task/${encodeURIComponent(taskId)}/messages`;
    const sig = AbortSignal.timeout(TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
        signal: sig,
      });
    } catch (e) {
      throw new WsClientError(0, (e as Error).message, e as Error);
    }
    if (!res.ok) throw new WsClientError(res.status, res.statusText);
    return res.json();
  },

  fetchHealth() {
    return get<{ status: string; uptime: number }>('/api/health');
  },

  // SSE — returns a Response for streaming; consumed by /api/stream multiplexer.
  async openActivityStream(): Promise<Response> {
    return fetch(`${BASE}/api/activity/stream`);
  },
};
