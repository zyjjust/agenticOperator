// Walks a JSON value (event payload, AgentActivity.metadata, step
// input/output) looking for entity references. Used by the journey API
// to cross-reference an entity ID against runs / activity / events
// without requiring a normalized RunEntity table.
//
// We do NOT modify any payload format — extraction is read-only.
// Entity IDs are recognized via two channels:
//   1. RAAS canonical envelope: { entity_type, entity_id }
//   2. Named keys on any object in the tree (job_requisition_id, etc.)

import { ENTITY_TYPES, isEntityType, type EntityType } from './entity-types';

type Lookup = { type: EntityType; keys: readonly string[] };

const LOOKUPS: readonly Lookup[] = [
  {
    type: 'JobRequisition',
    keys: ['job_requisition_id', 'requisition_id', 'requirement_id', 'jrid'],
  },
  {
    type: 'JobPosting',
    keys: ['job_posting_id', 'jd_id', 'posting_id'],
  },
  {
    type: 'Candidate',
    keys: ['candidate_id', 'resume_id'],
  },
];

/** Map: key name → entity type. O(1) lookup during walk. */
const KEY_TO_TYPE: ReadonlyMap<string, EntityType> = new Map(
  LOOKUPS.flatMap((l) => l.keys.map((k) => [k, l.type] as const)),
);

export type EntityRef = { type: EntityType; id: string };

const DEFAULT_MAX_DEPTH = 10;

/**
 * Extract every entity reference found in the given JSON value.
 * Strings are NOT auto-parsed here; callers that have a JSON string
 * (e.g. from AgentActivity.metadata) should JSON.parse it first.
 *
 * Walks objects + arrays recursively up to `maxDepth`. Dedupes results.
 */
export function extractEntityRefs(
  json: unknown,
  maxDepth: number = DEFAULT_MAX_DEPTH,
): EntityRef[] {
  if (!json || typeof json !== 'object') return [];
  const seen = new Set<string>();
  const out: EntityRef[] = [];
  const push = (type: EntityType, id: string): void => {
    const trimmed = id.trim();
    if (!trimmed) return;
    const k = `${type}:${trimmed}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ type, id: trimmed });
  };
  walk(json, 0, maxDepth, push);
  return out;
}

function walk(
  node: unknown,
  depth: number,
  maxDepth: number,
  push: (t: EntityType, id: string) => void,
): void {
  if (depth > maxDepth) return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, depth + 1, maxDepth, push);
    return;
  }
  if (!node || typeof node !== 'object') return;

  const obj = node as Record<string, unknown>;

  // Channel 1: RAAS canonical envelope. entity_type + entity_id at the same level.
  const et = obj.entity_type;
  const ei = obj.entity_id;
  if (typeof et === 'string' && typeof ei === 'string' && isEntityType(et)) {
    push(et, ei);
  }

  // Channel 2: named keys.
  for (const [key, val] of Object.entries(obj)) {
    if (typeof val === 'string') {
      const t = KEY_TO_TYPE.get(key);
      if (t) push(t, val);
    } else if (val && typeof val === 'object') {
      walk(val, depth + 1, maxDepth, push);
    }
    // numbers / booleans / null — skip
  }
}

/**
 * Cheap predicate for "does this payload reference (type, id)".
 * Auto-parses JSON strings (so callers can pass AgentActivity.metadata
 * directly without `safeJson`). Short-circuits — does not collect
 * all refs, just answers the yes/no.
 */
export function hasEntityRef(
  json: unknown,
  type: EntityType,
  id: string,
): boolean {
  let parsed: unknown = json;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return false;
    }
  }
  if (!parsed || typeof parsed !== 'object') return false;
  // Reuse extractor for correctness; ID space is bounded so allocation is fine.
  return extractEntityRefs(parsed).some((r) => r.type === type && r.id === id);
}

/** Convenience: list all entity types we recognize. */
export const RECOGNIZED_TYPES: readonly EntityType[] = ENTITY_TYPES;
