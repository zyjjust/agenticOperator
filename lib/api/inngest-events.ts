"use client";
import * as React from "react";

export type InngestEventRow = {
  id: string;
  internal_id?: string;
  name: string;
  data: unknown;
  ts?: number;
  received_at?: string;
  _source?: string;
};

export type InngestEventsResponse = {
  events: InngestEventRow[];
  sources: string[];
  errors: Array<{ source: string; message: string }>;
  fetchedAt: string;
};

export type UseInngestEventsResult = {
  events: InngestEventRow[];
  error: string | null;
  lastFetchAt: Date | null;
  connected: boolean;
  sources: string[];
};

export type UseInngestEventsOptions = {
  paused?: boolean;
  intervalMs?: number;
  limit?: number;
  includeShared?: boolean;
  name?: string;
};

/**
 * Polls /api/inngest-events on a fixed interval and returns the latest
 * batch of Inngest events flowing through the local dev server (and
 * optionally the shared RAAS bus). Newest first.
 *
 * The /events page uses this for both the live-stream sidebar and the
 * KPI bar (events·1m, Inngest connection status).
 */
export function useInngestEvents(opts: UseInngestEventsOptions = {}): UseInngestEventsResult {
  const {
    paused = false,
    intervalMs = 2000,
    limit = 100,
    includeShared = false,
    name,
  } = opts;

  const [events, setEvents] = React.useState<InngestEventRow[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [lastFetchAt, setLastFetchAt] = React.useState<Date | null>(null);
  const [sources, setSources] = React.useState<string[]>([]);

  React.useEffect(() => {
    if (paused) return;
    let cancelled = false;

    const tick = async () => {
      try {
        const params = new URLSearchParams({ limit: String(limit) });
        if (name) params.set("name", name);
        if (includeShared) params.set("includeShared", "1");
        const r = await fetch(`/api/inngest-events?${params.toString()}`);
        if (cancelled) return;
        if (!r.ok) {
          setError(`${r.status} ${r.statusText}`);
          return;
        }
        const j = (await r.json()) as InngestEventsResponse;
        if (cancelled) return;
        setError(
          j.errors?.length
            ? j.errors.map((e) => `${e.source}: ${e.message}`).join("; ")
            : null,
        );
        setEvents(j.events ?? []);
        setSources(j.sources ?? []);
        setLastFetchAt(new Date());
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    };

    tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [paused, intervalMs, limit, includeShared, name]);

  return {
    events,
    error,
    lastFetchAt,
    connected: error == null && lastFetchAt != null,
    sources,
  };
}
