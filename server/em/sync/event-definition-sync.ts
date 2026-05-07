// Event definition sync worker — pulls EventDefinition nodes from Neo4j
// and upserts into AO's local SQLite cache. Read-only: AO never writes
// back to Neo4j (EM Editor is out of scope per AO-INT-P3 Q1).
//
// Behavior when off-VPN: probe() fails → tick() logs once + records the
// error to EmSystemStatus.neo4jLastError → next tick retries. Boot does
// not block. Local fallback (lib/events-catalog.ts hardcoded 28 events)
// continues serving /events.

import { createHash } from "node:crypto";
import { prisma } from "../../db";
import {
  openSession,
  probe,
  Neo4jUnconfiguredError,
} from "../clients/neo4j";
import { invalidateCache as invalidateRegistryCache } from "../registry";

export type SyncResult = {
  upserted: number;
  skipped: number;
  /** New event names — present locally for the first time this sync. */
  added: number;
  /** Names whose contentHash differed → row updated + lastChangedAt advanced. */
  updated: number;
  /** Names that were locally cached but missing from this sync run → marked retiredAt. */
  retired: number;
  /** Names where the row carries is_breaking_change=true. */
  breakingChange: number;
  /** Detail listing — small enough to ship in the response for ops introspection. */
  changedNames?: string[];
  retiredNames?: string[];
  breakingNames?: string[];
  error?: string;
};

type Neo4jEventField = {
  name: string;
  type: string;
  required: boolean;
  position: number;
  target_object: string | null;
};

type Neo4jEventMutation = {
  target_object: string;
  mutation_type: string;
  impacted_properties: string[] | null;
  position: number;
};

type Neo4jEventRow = {
  name: string;
  description: string | null;
  status: string | null;
  payload: string | null;
  source_action: string | null;
  is_breaking_change: boolean;
  updated_at: string | null;
  source_file: string | null;
  fields: Neo4jEventField[];
  mutations: Neo4jEventMutation[];
  publishers: string[];
  subscribers: string[];
};

/**
 * Cypher for the RAAS shared Neo4j (introspected via /api/em/sync-now?debug=1):
 *
 *   (:Event {name, description, payload, source_action, status, ...})
 *   (:Event)-[:HAS_FIELD]->(:EventField {name, type, required, position, target_object})
 *   (:Event)-[:HAS_MUTATION]->(:EventMutation {target_object, mutation_type,
 *                                              impacted_properties[], position})
 *
 * We only pull PUBLISHED events. Publishers / subscribers are derived from
 * EMITS / TRIGGERS edges if present (allmeta-ontology uses them between
 * Action ↔ Event); when missing the arrays are empty.
 */
const CYPHER_PULL_DEFINITIONS = `
  MATCH (e:Event)
  WHERE coalesce(e.status, 'PUBLISHED') = 'PUBLISHED'
  OPTIONAL MATCH (e)-[:HAS_FIELD]->(f:EventField)
  WITH e, collect(DISTINCT { name: f.name, type: f.type, required: coalesce(f.required, false), position: coalesce(f.position, 0), target_object: f.target_object }) AS fields
  OPTIONAL MATCH (e)-[:HAS_MUTATION]->(m:EventMutation)
  WITH e, fields, collect(DISTINCT { target_object: m.target_object, mutation_type: m.mutation_type, impacted_properties: m.impacted_properties, position: coalesce(m.position, 0) }) AS mutations
  OPTIONAL MATCH (publisher)-[:EMITS]->(e)
  WITH e, fields, mutations, collect(DISTINCT publisher.name) AS publishers
  OPTIONAL MATCH (e)-[:TRIGGERS]->(subscriber)
  WITH e, fields, mutations, publishers, collect(DISTINCT subscriber.name) AS subscribers
  RETURN
    e.name              AS name,
    e.description       AS description,
    e.status            AS status,
    e.payload           AS payload,
    e.source_action     AS source_action,
    coalesce(e.is_breaking_change, false) AS is_breaking_change,
    e.updatedAt         AS updated_at,
    e.source_file       AS source_file,
    fields,
    mutations,
    [x IN publishers WHERE x IS NOT NULL] AS publishers,
    [x IN subscribers WHERE x IS NOT NULL] AS subscribers
`;

export async function syncEventDefinitions(): Promise<SyncResult> {
  const empty = (error?: string): SyncResult => ({
    upserted: 0, skipped: 0, added: 0, updated: 0, retired: 0, breakingChange: 0,
    ...(error ? { error } : {}),
  });

  // Fast-fail when offline / unconfigured — write status row, don't throw.
  const probeResult = await probe();
  if (!probeResult.ok) {
    await recordError(probeResult.error);
    return empty(probeResult.error);
  }

  let session;
  try {
    session = openSession();
  } catch (err) {
    if (err instanceof Neo4jUnconfiguredError) {
      await recordError(err.message);
      return empty(err.message);
    }
    throw err;
  }

  try {
    // 1. Snapshot current Neo4j-sourced names + content hashes BEFORE upsert.
    //    Used at the end to (a) detect retires, (b) mark `lastChangedAt` only
    //    when content actually differs.
    const existingRows = await prisma.eventDefinition.findMany({
      where: { source: "neo4j" },
      select: { name: true, contentHash: true, retiredAt: true },
    });
    const existingByName = new Map(existingRows.map((r) => [r.name, r] as const));

    const result = await session.run(CYPHER_PULL_DEFINITIONS);
    const now = new Date();
    let upserted = 0;
    let skipped = 0;
    let added = 0;
    let updated = 0;
    let breakingChange = 0;
    const seenNames = new Set<string>();
    const changedNames: string[] = [];
    const breakingNames: string[] = [];

    for (const record of result.records) {
      const row: Neo4jEventRow = {
        name: record.get("name"),
        description: record.get("description"),
        status: record.get("status"),
        payload: record.get("payload"),
        source_action: record.get("source_action"),
        is_breaking_change: !!record.get("is_breaking_change"),
        updated_at: record.get("updated_at"),
        source_file: record.get("source_file"),
        fields: (record.get("fields") ?? []).filter(
          (f: Neo4jEventField) => f && f.name,
        ),
        mutations: (record.get("mutations") ?? []).filter(
          (m: Neo4jEventMutation) => m && m.target_object,
        ),
        publishers: record.get("publishers") ?? [],
        subscribers: record.get("subscribers") ?? [],
      };

      if (!row.name) {
        skipped++;
        continue;
      }

      // Neo4j stores the full event schema as a JSON string in `e.payload`
      // rather than as `HAS_FIELD`/`HAS_MUTATION` graph edges.  When the
      // graph-edge collect comes back empty (the common case), fall back to
      // parsing the payload JSON directly.
      if (row.fields.length === 0 && row.payload) {
        try {
          const parsed = JSON.parse(row.payload) as Record<string, unknown>;
          if (Array.isArray(parsed.event_data)) {
            row.fields = (parsed.event_data as Record<string, unknown>[])
              .filter((f) => f && f.name)
              .map((f, i) => ({
                name: String(f.name),
                type: String(f.type ?? "String"),
                required: Boolean(f.required ?? false),
                position: Number(f.position ?? i),
                target_object: f.target_object != null ? String(f.target_object) : null,
              }));
          }
          if (Array.isArray(parsed.state_mutations) && row.mutations.length === 0) {
            row.mutations = (parsed.state_mutations as Record<string, unknown>[])
              .filter((m) => m && m.target_object)
              .map((m, i) => ({
                target_object: String(m.target_object),
                mutation_type: String(m.mutation_type ?? "UPDATE"),
                impacted_properties: Array.isArray(m.impacted_properties)
                  ? (m.impacted_properties as string[])
                  : null,
                position: Number(m.position ?? i),
              }));
          }
          if (!row.source_action && typeof parsed.source_action === "string") {
            row.source_action = parsed.source_action;
          }
        } catch {
          // payload isn't valid JSON — leave fields/mutations empty
        }
      }

      seenNames.add(row.name);

      // Build a JSON Schema from the EventField list. This is what the
      // registry will convert to Zod via json-schema-to-zod.ts.
      const jsonSchema = buildJsonSchemaFromFields(row.fields);
      const schemasByVersion = { "1.0": jsonSchema };
      const activeVersions = ["1.0"];

      // Synthesize subscribers + mutations metadata too. Subscribers fall back
      // to mutation target_objects when no TRIGGERS edges exist (the most
      // useful proxy: "this event affects these business entities").
      const subscribers = row.subscribers.length > 0
        ? row.subscribers
        : Array.from(new Set(row.mutations.map((m) => m.target_object).filter(Boolean)));
      const publishers = row.publishers.length > 0
        ? row.publishers
        : row.source_action
          ? [`action:${row.source_action}`]
          : [];

      // Stash the raw RAAS-shape lists in extraJson so the UI can render
      // a rich Payload tab (field name + RAAS type + required + target_object)
      // without losing fidelity to JSON Schema's lossy conversion.
      const extraJsonObj = {
        sourceAction: row.source_action ?? null,
        sourceFile: row.source_file ?? null,
        upstreamUpdatedAt: row.updated_at ?? null,
        fields: row.fields
          .slice()
          .sort((a, b) => a.position - b.position)
          .map((f) => ({
            name: f.name,
            type: f.type,
            required: f.required,
            position: f.position,
            targetObject: f.target_object ?? null,
          })),
        mutations: row.mutations
          .slice()
          .sort((a, b) => a.position - b.position)
          .map((m) => ({
            targetObject: m.target_object,
            mutationType: m.mutation_type,
            impactedProperties: m.impacted_properties ?? [],
          })),
      };
      const extraJson = JSON.stringify(extraJsonObj);

      // Compute a stable content hash. If this matches the previously-stored
      // hash, the row didn't actually change and we don't bump lastChangedAt.
      // Order-stable: hash inputs in a fixed key order.
      const hashInput = JSON.stringify({
        d: row.description ?? "",
        s: row.status ?? "ACTIVE",
        p: jsonSchema,
        e: extraJsonObj,
        pubs: publishers.slice().sort(),
        subs: subscribers.slice().sort(),
        breaking: row.is_breaking_change,
      });
      const contentHash = createHash("sha256").update(hashInput).digest("hex");

      const prior = existingByName.get(row.name);
      const isAdd = !prior;
      const isChange = !!prior && prior.contentHash !== contentHash;
      // If content actually changed, advance lastChangedAt; if breaking, also count.
      if (isAdd) added++;
      if (isChange) {
        updated++;
        changedNames.push(row.name);
      }
      if (row.is_breaking_change) {
        breakingChange++;
        breakingNames.push(row.name);
      }

      await prisma.eventDefinition.upsert({
        where: { name: row.name },
        create: {
          name: row.name,
          description: row.description ?? "",
          payload: JSON.stringify(jsonSchema),
          extraJson,
          status: row.status ?? "ACTIVE",
          version: "1.0",
          activeVersionsJson: JSON.stringify(activeVersions),
          schemasByVersionJson: JSON.stringify(schemasByVersion),
          publishersJson: jsonOrNull(publishers),
          subscribersJson: jsonOrNull(subscribers),
          source: "neo4j",
          syncedAt: now,
          // First time we've seen this row → its "first change" is right now.
          contentHash,
          lastChangedAt: now,
          isBreakingChange: row.is_breaking_change,
          // Resurrect any row we previously retired (Allmeta added it back).
          retiredAt: null,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        },
        update: {
          description: row.description ?? "",
          payload: JSON.stringify(jsonSchema),
          extraJson,
          status: row.status ?? "ACTIVE",
          activeVersionsJson: JSON.stringify(activeVersions),
          schemasByVersionJson: JSON.stringify(schemasByVersion),
          publishersJson: jsonOrNull(publishers),
          subscribersJson: jsonOrNull(subscribers),
          source: "neo4j",
          syncedAt: now,
          contentHash,
          // Only advance lastChangedAt when the row really changed.
          ...(isChange ? { lastChangedAt: now } : {}),
          isBreakingChange: row.is_breaking_change,
          retiredAt: null,
          updatedAt: now.toISOString(),
        },
      });
      upserted++;
    }

    // 2. Detect retires. Anything we had before that didn't show up this run
    //    AND isn't already marked retired gets retiredAt = now. We do NOT
    //    delete — keep history for auditing + so a re-add can resurrect.
    const retiredNames: string[] = [];
    let retired = 0;
    for (const prior of existingRows) {
      if (seenNames.has(prior.name)) continue;
      if (prior.retiredAt) continue; // already retired earlier
      retired++;
      retiredNames.push(prior.name);
      await prisma.eventDefinition.update({
        where: { name: prior.name },
        data: { retiredAt: now },
      });
    }

    await recordSuccess(upserted);
    return {
      upserted,
      skipped,
      added,
      updated,
      retired,
      breakingChange,
      ...(changedNames.length ? { changedNames } : {}),
      ...(retiredNames.length ? { retiredNames } : {}),
      ...(breakingNames.length ? { breakingNames } : {}),
    };
  } catch (err) {
    const msg = (err as Error).message;
    await recordError(msg);
    return empty(msg);
  } finally {
    if (session) await session.close();
  }
}

function jsonOrNull(v: unknown): string | null {
  if (v == null) return null;
  if (Array.isArray(v) && v.length === 0) return null;
  return JSON.stringify(v);
}

// Convert RAAS EventField[] (each {name, type, required, target_object}) to
// JSON Schema 2020-12-ish. The type vocabulary is RAAS's own — we map the
// common cases to JSON Schema primitives and fall back to permissive `{}`.
//
// Examples: "String" → {"type":"string"};  "List<String>" → array of strings;
// "Boolean" → boolean; "Job_Requisition" (business object) → permissive object.
function buildJsonSchemaFromFields(
  fields: Neo4jEventField[],
): { type: "object"; properties: Record<string, unknown>; required?: string[]; description?: string } {
  if (fields.length === 0) {
    // No declared fields → just a permissive object so events still validate.
    return { type: "object", properties: {} };
  }
  const sorted = [...fields].sort((a, b) => a.position - b.position);
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const f of sorted) {
    properties[f.name] = mapType(f.type);
    if (f.required) required.push(f.name);
  }
  return required.length > 0
    ? { type: "object", properties, required }
    : { type: "object", properties };
}

function mapType(raasType: string): Record<string, unknown> {
  if (!raasType) return {};
  const t = raasType.trim();

  // List<X>
  const listMatch = t.match(/^List<(.+)>$/i);
  if (listMatch) {
    return { type: "array", items: mapType(listMatch[1]) };
  }
  // Map<K,V>
  if (/^Map<.+>$/i.test(t)) {
    return { type: "object" };
  }

  switch (t.toLowerCase()) {
    case "string":
    case "text":
      return { type: "string" };
    case "integer":
    case "int":
    case "long":
      return { type: "integer" };
    case "number":
    case "float":
    case "double":
    case "decimal":
      return { type: "number" };
    case "boolean":
    case "bool":
      return { type: "boolean" };
    case "date":
    case "datetime":
    case "timestamp":
      return { type: "string" };
    case "uuid":
    case "id":
      return { type: "string" };
    case "object":
    case "json":
      return { type: "object" };
    default:
      // Business-object names like "Job_Requisition" — describe as a
      // permissive object so RAAS payloads carrying nested entities pass.
      return { type: "object" };
  }
}

async function recordSuccess(upserted: number): Promise<void> {
  await prisma.emSystemStatus
    .upsert({
      where: { id: "singleton" },
      create: {
        id: "singleton",
        neo4jLastSyncAt: new Date(),
        neo4jUpsertedLast: upserted,
        neo4jLastError: null,
      },
      update: {
        neo4jLastSyncAt: new Date(),
        neo4jUpsertedLast: upserted,
        neo4jLastError: null,
      },
    })
    .catch((err) => {
      // Don't throw if status table itself fails — just log.
      console.error("[em-sync] failed to record success:", err.message);
    });
}

async function recordError(error: string): Promise<void> {
  await prisma.emSystemStatus
    .upsert({
      where: { id: "singleton" },
      create: {
        id: "singleton",
        neo4jLastError: error,
        neo4jLastSyncAt: null,
        neo4jUpsertedLast: 0,
      },
      update: {
        neo4jLastError: error,
      },
    })
    .catch((err) => {
      console.error("[em-sync] failed to record error:", err.message);
    });
}

// ── Boot loop ──────────────────────────────────────────────────────────────

let _started = false;
let _intervalHandle: ReturnType<typeof setInterval> | null = null;

export function startEventDefinitionSync(): void {
  if (_started) return;
  if (process.env.NEO4J_SYNC_ENABLED !== "1") {
    console.log(
      "[em-sync] disabled (set NEO4J_SYNC_ENABLED=1 to enable Neo4j EventDefinition sync)",
    );
    return;
  }
  _started = true;
  const intervalMs = Number(process.env.NEO4J_SYNC_INTERVAL_MS ?? 300_000);
  console.log(
    `[em-sync] starting · interval=${intervalMs}ms · source=Neo4j EventDefinition`,
  );

  // Kick once at boot so cold start populates whatever it can.
  void runOnce();
  _intervalHandle = setInterval(runOnce, intervalMs);
}

export function stopEventDefinitionSync(): void {
  if (_intervalHandle) {
    clearInterval(_intervalHandle);
    _intervalHandle = null;
  }
  _started = false;
}

async function runOnce(): Promise<void> {
  try {
    const r = await syncEventDefinitions();
    if (r.error) {
      // Only log every Nth error to avoid log spam off-VPN.
      if (Math.random() < 0.2) {
        console.warn(`[em-sync] sync failed: ${r.error} (will retry)`);
      }
    } else if (r.upserted > 0) {
      console.log(
        `[em-sync] tick: upserted=${r.upserted} skipped=${r.skipped}`,
      );
      // Bust the registry cache so the new schemas are visible to the very
      // next em.publish call without waiting for the in-memory TTL.
      invalidateRegistryCache();
    }
  } catch (err) {
    console.error("[em-sync] unexpected:", (err as Error).message);
  }
}
