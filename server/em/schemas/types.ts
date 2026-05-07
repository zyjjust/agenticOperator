// Schema-version data structures.
//
// Multi-version is a hard requirement (spec v2 §11.4): publishers (RAAS) ship
// rolling upgrades; AO must accept v1 and v2 at the same time, normalize to
// the latest internal shape, and let consumers see one canonical layout.

import type { z } from "zod";

/** A single registered version of an event. */
export type EventSchemaVersion<T = unknown> = {
  /** SemVer-ish; MAJOR.MINOR. Compared as strings; latest first in array. */
  version: string;
  /** Zod schema. The validator runs `safeParse(data)` against this. */
  schema: z.ZodType<T>;
  /**
   * Optional normalizer. When the parser matches this version, the parsed
   * data is fed through the normalizer to upgrade it to the latest shape
   * before being persisted + sent to Inngest. Latest version usually has
   * no normalizer (already canonical).
   */
  normalize?: (data: T) => unknown;
};

/** Full registration for one event name. */
export type EventSchemaRegistration = {
  name: string;
  /** Versions in DESCENDING order (latest at index 0). */
  versions: EventSchemaVersion[];
  /** Free text shown in /events registry. */
  description: string;
  /** Default publishers/subscribers when Neo4j hasn't sent these yet. */
  publishers?: string[];
  subscribers?: string[];
};
