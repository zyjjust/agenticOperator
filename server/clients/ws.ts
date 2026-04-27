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

// snake_case → camelCase normalizer for WS responses.
function camelize<T = any>(obj: any): T {
  if (Array.isArray(obj)) return obj.map((x) => camelize(x)) as any;
  if (obj && typeof obj === 'object') {
    const out: any = {};
    for (const [k, v] of Object.entries(obj)) {
      const ck = k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      out[ck] = camelize(v);
    }
    return out;
  }
  return obj;
}

export const wsClient = {
  base: BASE,

  // WS responds with {count, items} where items have snake_case fields.
  // Translate to AO contract {runs, total} with camelCase fields.
  async fetchRuns(q: { status?: string[]; limit?: number; since?: string }) {
    const r = await get<{ count: number; items: any[] }>('/api/runs', q as Query);
    return { runs: camelize(r.items ?? []), total: r.count ?? (r.items?.length ?? 0) };
  },

  async fetchRun(id: string) {
    const r = await get<any>(`/api/runs/${encodeURIComponent(id)}`);
    return camelize(r);
  },

  // WS does NOT expose /api/runs/[id]/steps. Approximate with activity feed
  // filtered by runId and reshape entries that look like step lifecycle events.
  // P3 will replace with direct Prisma query.
  async fetchSteps(runId: string) {
    try {
      const r = await get<{ items: any[]; total: number }>('/api/activity/feed', {
        runId,
        limit: 200,
      } as Query);
      const stepLike = (r.items ?? [])
        .filter((a) => a.type === 'agent_start' || a.type === 'agent_complete' || a.type === 'agent_error')
        .map((a) => ({
          id: a.id,
          nodeId: a.nodeId,
          status:
            a.type === 'agent_start'
              ? 'running'
              : a.type === 'agent_complete'
                ? 'completed'
                : 'failed',
          startedAt: a.createdAt,
          completedAt: a.type !== 'agent_start' ? a.createdAt : null,
          durationMs: null,
          input: null,
          output: null,
          error: a.type === 'agent_error' ? a.narrative : null,
        }));
      return { steps: stepLike };
    } catch {
      return { steps: [] };
    }
  },

  fetchActivityFeed(q: { limit?: number; nodeId?: string; runId?: string }) {
    return get<{ items: any[]; total: number }>('/api/activity/feed', q as Query);
  },

  // WS responds with bare array (no envelope). Wrap to AO contract.
  async fetchHumanTasks(q: { status?: string }) {
    const r = await get<any[]>('/api/human-tasks', q as Query);
    const items = camelize<any[]>(Array.isArray(r) ? r : []);
    return { items, total: items.length };
  },

  async fetchHumanTask(id: string) {
    const r = await get<any>(`/api/human-tasks/${encodeURIComponent(id)}`);
    return camelize(r);
  },

  async resolveHumanTask(
    id: string,
    body: { action: 'approve' | 'reject' | 'escalate'; comment?: string; reason?: string; targetClient?: string },
  ): Promise<any> {
    const url = `${BASE}/api/human-tasks/${encodeURIComponent(id)}/resolve`;
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

  async fetchMessages(taskId: string) {
    const r = await get<any>(
      `/api/human-tasks/${encodeURIComponent(taskId)}/messages`,
    );
    return camelize(r);
  },

  async postMessage(taskId: string, content: string): Promise<any> {
    const url = `${BASE}/api/human-tasks/${encodeURIComponent(taskId)}/messages`;
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
