// Schema registry — single resolution path used by em.publish + em.validate.
//
// Resolution order (per "Neo4j is the source of truth" decision):
//   1. EventDefinition table (Neo4j-synced rows). When the row carries a
//      schemas_by_version map AND we can convert it to Zod, that becomes
//      the validator. Metadata (publishers / subscribers / description) is
//      always preferred from Neo4j when present.
//   2. server/em/schemas/builtin.ts (hardcoded Zod). Used as the fallback —
//      either no row, no convertible schema, or partial conversion. Builtin
//      versions also carry the `normalize()` upgrade helpers that Neo4j
//      schemas can't carry (functions can't be serialized).
//
// Conversion is defensive: see registry/json-schema-to-zod.ts. If a Neo4j
// schema is malformed or uses unsupported keywords, we fall back to builtin
// rather than rejecting events.

import type { z } from "zod";
import { prisma } from "../../db";
import {
  BUILTIN_SCHEMAS_BY_NAME,
  BUILTIN_SCHEMAS,
} from "../schemas/builtin";
import type {
  EventSchemaRegistration,
  EventSchemaVersion,
} from "../schemas/types";
import { convert as jsonSchemaToZod } from "./json-schema-to-zod";

export type ResolvedRegistration = EventSchemaRegistration & {
  /** Where the schema came from this resolution. */
  schemaSource: "neo4j" | "builtin" | "missing";
  /** Whether description / pub-sub came from Neo4j (vs builtin defaults). */
  metaSource: "neo4j" | "builtin" | "missing";
  /** Per-version: how we got each Zod validator. UI uses this to surface mixed sources. */
  versionSources?: Array<{ version: string; source: "neo4j" | "builtin"; fallbackReason?: string }>;
};

const _cache = new Map<string, { at: number; row: ResolvedRegistration | null }>();
const CACHE_TTL_MS = 30_000;

export async function resolve(name: string): Promise<ResolvedRegistration | null> {
  const cached = _cache.get(name);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.row;

  // 1. DB row — both metadata AND (if convertible) the schema itself.
  let dbMeta: Pick<
    EventSchemaRegistration,
    "description" | "publishers" | "subscribers"
  > | null = null;
  let dbVersions: EventSchemaVersion[] | null = null;
  const dbVersionSources: NonNullable<ResolvedRegistration["versionSources"]> = [];
  let dbSourceTag: ResolvedRegistration["metaSource"] = "missing";
  try {
    const row = await prisma.eventDefinition.findUnique({ where: { name } });
    if (row && row.source === "neo4j") {
      dbMeta = {
        description: row.description ?? "",
        publishers: parseJsonArray(row.publishersJson),
        subscribers: parseJsonArray(row.subscribersJson),
      };
      dbSourceTag = "neo4j";
      // Try to extract per-version schemas. Two possible storage shapes:
      //   schemasByVersionJson: { "1.0": <jsonSchema>, "2.0": <jsonSchema> }
      //   payload: <jsonSchema>  (single-version legacy column)
      const map = parseJsonObject(row.schemasByVersionJson);
      const versionsList = parseJsonArray(row.activeVersionsJson);
      if (map && Object.keys(map).length > 0) {
        const orderedVersions = (versionsList.length > 0 ? versionsList : Object.keys(map))
          .filter((v) => map[v] != null);
        for (const v of orderedVersions) {
          const r = jsonSchemaToZod(map[v]);
          dbVersionSources.push({
            version: v,
            source: "neo4j",
            fallbackReason: r.fallback ? r.reason : undefined,
          });
          dbVersions ??= [];
          dbVersions.push({ version: v, schema: r.schema });
        }
      } else if (row.payload && row.payload.length > 0 && row.payload !== "{}") {
        const single = parseJsonObject(row.payload);
        if (single) {
          const r = jsonSchemaToZod(single);
          dbVersions = [{ version: row.version || "1.0", schema: r.schema }];
          dbVersionSources.push({
            version: row.version || "1.0",
            source: "neo4j",
            fallbackReason: r.fallback ? r.reason : undefined,
          });
        }
      }
    }
  } catch {
    // DB down — fall through to builtin
  }

  // 2. Hardcoded Zod
  const builtin = BUILTIN_SCHEMAS_BY_NAME.get(name);

  // 3. Merge. Prefer DB schema when we have any successfully derived versions.
  let versions: EventSchemaVersion[] | null = null;
  let schemaSource: ResolvedRegistration["schemaSource"] = "missing";
  let versionSources = dbVersionSources;

  if (dbVersions && dbVersions.length > 0) {
    versions = dbVersions;
    schemaSource = "neo4j";
    // If builtin has the same versions with normalize() helpers, attach them.
    if (builtin) {
      const builtinByVer = new Map(
        builtin.versions.map((v) => [v.version, v.normalize] as const),
      );
      versions = versions.map((v) =>
        builtinByVer.get(v.version) ? { ...v, normalize: builtinByVer.get(v.version) } : v,
      );
    }
  } else if (builtin) {
    versions = builtin.versions;
    schemaSource = "builtin";
    versionSources = builtin.versions.map((v) => ({ version: v.version, source: "builtin" as const }));
  }

  if (!versions) {
    // No schema, no metadata → null
    if (!dbMeta) {
      _cache.set(name, { at: Date.now(), row: null });
      return null;
    }
    const result: ResolvedRegistration = {
      name,
      description: dbMeta.description,
      publishers: dbMeta.publishers,
      subscribers: dbMeta.subscribers,
      versions: [],
      schemaSource: "missing",
      metaSource: dbSourceTag,
    };
    _cache.set(name, { at: Date.now(), row: result });
    return result;
  }

  const merged: ResolvedRegistration = {
    name: builtin?.name ?? name,
    description: dbMeta?.description ?? builtin?.description ?? "",
    publishers: dbMeta?.publishers?.length
      ? dbMeta.publishers
      : builtin?.publishers,
    subscribers: dbMeta?.subscribers?.length
      ? dbMeta.subscribers
      : builtin?.subscribers,
    versions,
    schemaSource,
    metaSource: dbSourceTag === "missing" ? "builtin" : dbSourceTag,
    versionSources,
  };
  _cache.set(name, { at: Date.now(), row: merged });
  return merged;
}

/** Try to parse `data` against each version (latest first). */
export type TryParseResult<T = unknown> =
  | {
      ok: true;
      version: string;
      data: T;
      triedVersions: string[];
    }
  | {
      ok: false;
      issues: z.ZodIssue[];
      triedVersions: string[];
      error: "no_schema" | "all_versions_failed";
    };

export async function tryParse<T = unknown>(
  name: string,
  data: unknown,
): Promise<TryParseResult<T>> {
  const reg = await resolve(name);
  if (!reg || reg.versions.length === 0) {
    return {
      ok: false,
      issues: [],
      triedVersions: [],
      error: "no_schema",
    };
  }

  const tried: string[] = [];
  let lastIssues: z.ZodIssue[] = [];
  for (const v of reg.versions as EventSchemaVersion[]) {
    tried.push(v.version);
    const r = v.schema.safeParse(data);
    if (r.success) {
      const normalized = v.normalize ? v.normalize(r.data) : r.data;
      return {
        ok: true,
        version: v.version,
        data: normalized as T,
        triedVersions: tried,
      };
    }
    lastIssues = r.error.issues;
  }
  return {
    ok: false,
    issues: lastIssues,
    triedVersions: tried,
    error: "all_versions_failed",
  };
}

export function invalidateCache(name?: string): void {
  if (name) _cache.delete(name);
  else _cache.clear();
}

/** Returns every event we know about (builtin ∪ db). UI uses this. */
export function listAllNames(): string[] {
  return BUILTIN_SCHEMAS.map((r) => r.name);
}

function parseJsonArray(s: string | null): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function parseJsonObject(s: string | null): Record<string, unknown> | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
