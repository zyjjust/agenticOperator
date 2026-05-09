// /api/inngest-events/:id/runs
//
// Proxy to Inngest dev's `/v1/events/{event_id}/runs` — the canonical way
// to ask "which Inngest function runs were spawned by this event, and
// what's their status?". The /events fullscreen log modal uses it to show
// completion lifecycle inline alongside the raw event.
//
// Empty data array = event was accepted by the bus but no function was
// triggered (or none have been recorded yet — runs appear after Inngest
// records them, which can lag the event by ~1s).

import { NextResponse } from "next/server";

const LOCAL_INNGEST = process.env.INNGEST_LOCAL_URL ?? "http://localhost:8288";

export type EventRunRow = {
  run_id: string;
  function_id?: string;
  status: string; // Running / Completed / Failed / Cancelled / etc.
  run_started_at?: string;
  ended_at?: string | null;
  output?: unknown;
  event_id?: string;
};

export type EventRunsResponse = {
  runs: EventRunRow[];
  fetchedAt: string;
  error: string | null;
};

type RouteCtx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: RouteCtx): Promise<Response> {
  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json(
      { error: "BAD_REQUEST", message: "missing event id" },
      { status: 400 },
    );
  }
  try {
    const upstream = `${LOCAL_INNGEST}/v1/events/${encodeURIComponent(id)}/runs`;
    const r = await fetch(upstream, {
      signal: AbortSignal.timeout(8_000),
      cache: "no-store",
    });
    if (!r.ok) {
      const body: EventRunsResponse = {
        runs: [],
        fetchedAt: new Date().toISOString(),
        error: `${r.status} ${r.statusText}`,
      };
      return NextResponse.json(body);
    }
    const j = (await r.json()) as { data?: EventRunRow[] };
    const body: EventRunsResponse = {
      runs: j.data ?? [],
      fetchedAt: new Date().toISOString(),
      error: null,
    };
    return NextResponse.json(body);
  } catch (e) {
    return NextResponse.json(
      {
        runs: [],
        fetchedAt: new Date().toISOString(),
        error: (e as Error).message,
      },
      { status: 200 },
    );
  }
}
