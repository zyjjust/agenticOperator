// POST /api/em/sync-now — manually trigger Neo4j → EventDefinition sync.
// Useful: (1) after just connecting to VPN to populate the cache without
// waiting for the 5-minute interval, (2) ops debugging a sync failure.
//
// On success we also bust the registry cache so subsequent em.publish calls
// pick up the new schemas immediately (otherwise the 30s in-memory TTL
// would delay them).
//
// Query: POST /api/em/sync-now?debug=1
//   Adds an _introspect block to the response listing all node labels,
//   relationship types, and a property-key sample for any label that
//   smells like an event definition. Use this to diagnose "upserted: 0"
//   — it almost always means the cypher is looking for the wrong label.
//
// Returns the same shape as the boot-time sync. Off-VPN this returns
// { error: "..." } and updates EmSystemStatus.neo4jLastError.

import { NextResponse } from "next/server";
import { syncEventDefinitions } from "@/server/em/sync/event-definition-sync";
import { em } from "@/server/em";
import { openSession, probe } from "@/server/em/clients/neo4j";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const debug = url.searchParams.get("debug") === "1";

  const result = await syncEventDefinitions();
  if (!result.error && result.upserted > 0) {
    em.invalidateCache();
  }

  if (debug) {
    const introspect = await safeIntrospect();
    return NextResponse.json({ ...result, _introspect: introspect });
  }
  return NextResponse.json(result);
}

async function safeIntrospect(): Promise<unknown> {
  const reach = await probe();
  if (!reach.ok) return { unreachable: reach.error };

  const session = openSession();
  try {
    // Labels in DB
    const labelsRes = await session.run(`CALL db.labels() YIELD label RETURN label ORDER BY label`);
    const labels = labelsRes.records.map((r) => r.get("label") as string);

    // Relationship types in DB
    const relsRes = await session.run(
      `CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType ORDER BY relationshipType`,
    );
    const relationshipTypes = relsRes.records.map((r) => r.get("relationshipType") as string);

    // For any label whose name contains "Event" or "event", grab a sample
    // node + its property keys. This is what tells us how to rewrite the
    // sync cypher.
    const eventyLabels = labels.filter((l) => /event/i.test(l));
    const samples: Array<{ label: string; count: number; sample: Record<string, unknown> | null; keys: string[] }> = [];
    for (const label of eventyLabels) {
      // Counts
      const countRes = await session.run(`MATCH (n:\`${label}\`) RETURN count(n) AS c`);
      const count = numFromNeo(countRes.records[0]?.get("c"));

      // One sample
      const sampleRes = await session.run(`MATCH (n:\`${label}\`) RETURN n LIMIT 1`);
      const sample = sampleRes.records[0]?.get("n")?.properties ?? null;

      // Distinct property keys
      const keysRes = await session.run(
        `MATCH (n:\`${label}\`) UNWIND keys(n) AS k RETURN DISTINCT k ORDER BY k`,
      );
      const keys = keysRes.records.map((r) => r.get("k") as string);

      samples.push({ label, count, sample, keys });
    }

    return {
      labels,
      relationshipTypes,
      eventyLabels,
      samples,
    };
  } catch (err) {
    return { error: (err as Error).message };
  } finally {
    await session.close();
  }
}

function numFromNeo(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "object" && v !== null && "low" in (v as Record<string, unknown>)) {
    return Number((v as { low: number }).low);
  }
  return Number(v);
}
