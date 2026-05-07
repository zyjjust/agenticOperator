// @ao/em — public barrel.
//
// Internal callers (raas-bridge, agents emit, /api/em/publish dev endpoint):
//   import { em } from "@/server/em";
//   await em.publish(name, data, opts);
//
// When packages/em workspace is set up later (spec v2 §4.3), this file
// becomes the SDK entry point. The shape stays the same — callers don't
// have to change imports.

import { publish } from "./publish";
import { validate } from "./validate";
import { resolve, listAllNames, invalidateCache } from "./registry";
import * as degradedMode from "./degraded-mode";
import { emitRejection, EVENT_REJECTED_NAME } from "./rejection";

export const em = {
  publish,
  validate,
  /** Manually flush the registry cache (used by /api/em/sync-now after a sync). */
  invalidateCache,
  /** UI helpers. */
  registry: {
    resolve,
    listAllNames,
  },
  /** Health introspection — feed for /api/em/health. */
  health: {
    getState: degradedMode.getState,
    isDegraded: degradedMode.isDegraded,
    recoverIfPossible: degradedMode.recoverIfPossible,
  },
  /** Internal — exposed so the rejection emitter can be tested in isolation. */
  _internal: {
    emitRejection,
    EVENT_REJECTED_NAME,
  },
};

export type { PublishOpts, PublishResult } from "./publish";
export type { ValidateResult } from "./validate";
export type { ResolvedRegistration, TryParseResult } from "./registry";
