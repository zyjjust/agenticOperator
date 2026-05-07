// Defensive JSON-Schema → Zod converter.
//
// Used by the registry when EventDefinition rows from Neo4j carry a
// schemas_by_version map. We DON'T know the exact shape Neo4j chose
// (could be a strict JSON Schema draft-07, could be a hand-written
// `{ type, properties, required }`, could be a permissive `{}`).
//
// Rules:
//   - If we recognize the shape, build a precise Zod validator.
//   - If we don't, return a permissive `z.record(z.unknown())` — i.e. accept
//     any object. Logging happens at the call site so ops can see which
//     events fell back.
//   - Never throw. The registry treats this as best-effort.

import { z } from "zod";

export type ConvertResult = {
  schema: z.ZodType;
  /** Set when we couldn't honor the input. UI shows this as a warning. */
  fallback: boolean;
  reason?: string;
};

/**
 * Convert a single JSON-Schema-shaped object to a Zod validator.
 * Supports the subset that real-world event payloads use: object, string,
 * number, boolean, null, array, enum, oneOf-as-union, optional via
 * `required`. Falls back permissively for unsupported keywords.
 */
export function convert(input: unknown): ConvertResult {
  if (input == null) {
    return { schema: z.unknown(), fallback: true, reason: "schema is null" };
  }
  if (typeof input !== "object") {
    return { schema: z.unknown(), fallback: true, reason: `schema is ${typeof input}, expected object` };
  }

  try {
    const z1 = walk(input as Record<string, unknown>);
    return { schema: z1, fallback: false };
  } catch (e) {
    return {
      schema: z.record(z.string(), z.unknown()),
      fallback: true,
      reason: `convert error: ${(e as Error).message}`,
    };
  }
}

function walk(node: Record<string, unknown>): z.ZodType {
  // Composition keywords first.
  if (Array.isArray(node.oneOf)) {
    const variants = (node.oneOf as unknown[]).map(asObject).map(walk);
    if (variants.length === 0) return z.unknown();
    return z.union(variants as [z.ZodType, z.ZodType, ...z.ZodType[]]);
  }
  if (Array.isArray(node.anyOf)) {
    const variants = (node.anyOf as unknown[]).map(asObject).map(walk);
    if (variants.length === 0) return z.unknown();
    return z.union(variants as [z.ZodType, z.ZodType, ...z.ZodType[]]);
  }

  if (Array.isArray(node.enum)) {
    const values = (node.enum as unknown[]).filter((v) => v != null);
    if (values.length === 0) return z.unknown();
    if (values.every((v) => typeof v === "string")) {
      const list = values as string[];
      return list.length === 1 ? z.literal(list[0]) : z.enum(list as [string, ...string[]]);
    }
    if (values.length === 1) {
      return z.literal(values[0] as string | number | boolean);
    }
    const literals = values.map((v) => z.literal(v as string | number | boolean)) as unknown as [
      z.ZodType,
      z.ZodType,
      ...z.ZodType[],
    ];
    return z.union(literals);
  }

  // Type-driven branch.
  const t = node.type;
  if (Array.isArray(t)) {
    // type: ["string", "null"] etc.
    const variants = (t as string[]).map((tt) => walk({ ...node, type: tt }));
    return z.union(variants as [z.ZodType, z.ZodType, ...z.ZodType[]]);
  }

  switch (t) {
    case "string": {
      let s: z.ZodString = z.string();
      if (typeof node.minLength === "number") s = s.min(node.minLength);
      if (typeof node.maxLength === "number") s = s.max(node.maxLength);
      if (typeof node.pattern === "string") {
        try {
          s = s.regex(new RegExp(node.pattern));
        } catch {
          // bad regex — drop the constraint, keep string-ness
        }
      }
      return s;
    }
    case "number":
    case "integer": {
      let n: z.ZodNumber = z.number();
      if (t === "integer") n = n.int();
      if (typeof node.minimum === "number") n = n.min(node.minimum);
      if (typeof node.maximum === "number") n = n.max(node.maximum);
      return n;
    }
    case "boolean":
      return z.boolean();
    case "null":
      return z.null();
    case "array": {
      const itemsRaw = (node as { items?: unknown }).items;
      if (Array.isArray(itemsRaw)) {
        // Tuple form — z.tuple
        const items = itemsRaw.map(asObject).map(walk);
        return z.tuple(items as [z.ZodType, ...z.ZodType[]]);
      }
      const item = itemsRaw ? walk(asObject(itemsRaw)) : z.unknown();
      let arr = z.array(item);
      if (typeof node.minItems === "number") arr = arr.min(node.minItems);
      if (typeof node.maxItems === "number") arr = arr.max(node.maxItems);
      return arr;
    }
    case "object":
    case undefined: {
      // No type or explicit object — both treated as object.
      const props = isPlainObject(node.properties) ? (node.properties as Record<string, unknown>) : null;
      if (!props) {
        // No properties listed → permissive object.
        return z.record(z.string(), z.unknown());
      }
      const required = Array.isArray(node.required)
        ? new Set((node.required as unknown[]).filter((r) => typeof r === "string") as string[])
        : new Set<string>();
      const shape: Record<string, z.ZodType> = {};
      for (const [key, value] of Object.entries(props)) {
        const inner = walk(asObject(value));
        shape[key] = required.has(key) ? inner : inner.optional();
      }
      // additionalProperties default true → passthrough
      const additional = (node as { additionalProperties?: unknown }).additionalProperties;
      const obj = z.object(shape);
      return additional === false ? obj.strict() : obj.passthrough();
    }
    default:
      // Unknown type string — permissive.
      return z.unknown();
  }
}

function asObject(v: unknown): Record<string, unknown> {
  if (isPlainObject(v)) return v as Record<string, unknown>;
  return {};
}
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
