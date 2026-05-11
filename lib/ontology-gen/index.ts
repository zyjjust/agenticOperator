/**
 * Public surface of `lib/ontology-gen/` — slim build.
 *
 * Exposes:
 *   - the typed error hierarchy (`OntologyGenError` + subclasses) for callers
 *     that want to discriminate auth / not-found / upstream / timeout / etc.
 *   - low-level `fetchAction` / `parseAction` for direct Ontology-API access
 *   - the public Action / ActionObject types
 *
 * The v3 codegen pipeline (`projectActionObject`, `emitActionObjectModule`,
 * `resolveActionObject`, `generateActionSnapshot`) is intentionally NOT
 * exported in this slim build — it lives in a separate codegen commit. The
 * canonical v4 prompt entry (`generatePrompt`, `fillRuntimeInput`) is
 * exported from `./v4`.
 */

export {
  ActionValidationError,
  OntologyAuthError,
  OntologyContractError,
  OntologyGenError,
  OntologyNotFoundError,
  OntologyRequestError,
  OntologyServerError,
  OntologyTimeoutError,
  OntologyUpstreamError,
} from "./errors";

export { fetchAction, parseAction } from "./fetch";

export type {
  Action,
  ActionDataChange,
  ActionInput,
  ActionNotification,
  ActionOutput,
  ActionRule,
  ActionSideEffects,
  ActionStep,
  ActionStepInput,
  ActionStepOutput,
} from "./types.public";
export type { FetchOptions } from "./types.internal";
