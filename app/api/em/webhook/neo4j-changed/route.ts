// POST /api/em/webhook/neo4j-changed
//
// Webhook for Allmeta Ontology pipeline (or any actor) to notify AO that
// Neo4j EventDefinition data has changed and an immediate sync should be
// kicked. Saves us the 5-minute polling latency between an Allmeta import
// finishing and AO showing the new contracts.
//
// Body shape: optional, ignored today. Future:
//   {
//     "trigger": "import_complete" | "manual",
//     "sourceFile": "events_v0_1_036.json",
//     "changedNames": ["RESUME_PROCESSED", ...]   // hint, we still re-sync all
//   }
//
// Auth: NONE in dev. Production must:
//   1. Require an HMAC signature header (RAAS shared secret)
//   2. Rate-limit per-IP (one sync per 30s) to avoid stampedes
//   3. Add to allowlist for the RAAS pipeline egress IP

import { NextResponse } from "next/server";
import { syncEventDefinitions } from "@/server/em/sync/event-definition-sync";
import { em } from "@/server/em";

export const dynamic = "force-dynamic";

// Per-process throttle: at most one sync per 5 seconds. A misbehaving caller
// firing 100x/sec collapses to a normal cadence rather than DoS-ing Neo4j.
let _lastRunAt = 0;
const MIN_INTERVAL_MS = 5_000;

export async function POST(req: Request): Promise<Response> {
  const now = Date.now();
  const sinceLast = now - _lastRunAt;
  if (sinceLast < MIN_INTERVAL_MS) {
    return NextResponse.json(
      {
        skipped: true,
        reason: "throttled",
        retryAfterMs: MIN_INTERVAL_MS - sinceLast,
      },
      { status: 429 },
    );
  }
  _lastRunAt = now;

  // Read body for telemetry but don't act on it (we always re-sync everything).
  let payload: unknown = null;
  try {
    payload = await req.json();
  } catch {
    // empty body is fine
  }

  const result = await syncEventDefinitions();
  if (!result.error && result.upserted > 0) {
    em.invalidateCache();
  }
  return NextResponse.json({ ...result, _receivedHint: payload });
}
