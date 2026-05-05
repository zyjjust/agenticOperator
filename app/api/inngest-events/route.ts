// /api/inngest-events — proxy to local Inngest dev server's /v1/events API.
// Used by:
//   - /events page firehose tab (live stream of all events flowing
//     through the local bus, including RESUME_DOWNLOADED bridged from RAAS)
//   - /api/events/[name]/stream as the source for filtered SSE
//
// Optional ?name=EVENT_NAME filter, ?limit (default 30, max 100).

import { NextResponse } from "next/server";

const LOCAL_INNGEST = process.env.INNGEST_LOCAL_URL ?? "http://localhost:8288";
const RAAS_INNGEST = process.env.RAAS_INNGEST_URL ?? "";

type InngestEvent = {
  id: string;
  internal_id?: string;
  name: string;
  data: unknown;
  ts?: number;
  received_at?: string;
};

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const nameFilter = url.searchParams.get("name");
  const limitParam = Number(url.searchParams.get("limit") ?? 30);
  const limit = Math.min(100, Math.max(1, Number.isFinite(limitParam) ? limitParam : 30));
  const includeShared = url.searchParams.get("includeShared") === "1";

  const sources: Array<{ label: string; url: string }> = [
    { label: "local", url: LOCAL_INNGEST },
  ];
  if (includeShared && RAAS_INNGEST) {
    sources.push({ label: "shared", url: RAAS_INNGEST });
  }

  const all: Array<InngestEvent & { _source: string }> = [];
  const errors: Array<{ source: string; message: string }> = [];

  for (const s of sources) {
    try {
      // Pass nameFilter UPSTREAM so Inngest dev returns the right slice.
      // Filtering client-side after a small `limit` fetch is broken — if
      // the most-recent `limit` events don't include the filtered name,
      // we'd return empty/sparse results even when matching events exist.
      // Inngest dev /v1/events accepts ?name= (NOT event_name) for
      // server-side filtering. Verified empirically against the dev
      // server build shipped with inngest-cli.
      const upstreamUrl = new URL(`${s.url}/v1/events`);
      upstreamUrl.searchParams.set("limit", String(limit));
      if (nameFilter) upstreamUrl.searchParams.set("name", nameFilter);
      const r = await fetch(upstreamUrl, { signal: AbortSignal.timeout(8_000) });
      if (!r.ok) {
        errors.push({ source: s.label, message: `${r.status} ${r.statusText}` });
        continue;
      }
      const body = (await r.json()) as { data?: InngestEvent[] };
      for (const e of body.data ?? []) {
        all.push({ ...e, _source: s.label });
      }
    } catch (e) {
      errors.push({ source: s.label, message: (e as Error).message });
    }
  }

  // Sort newest first by id (ULIDs sort chronologically)
  all.sort((a, b) => (b.id > a.id ? 1 : -1));

  return NextResponse.json({
    events: all.slice(0, limit),
    sources: sources.map((s) => s.label),
    errors,
    fetchedAt: new Date().toISOString(),
  });
}
