/**
 * v4 entry point — slim public ABI for the canonical generate-prompt flow.
 *
 * Exposes only the surfaces consumers and the dev preview need:
 *   - `generatePrompt` (async)
 *   - `fillRuntimeInput` (sync, pure)
 *   - hierarchical placeholders + sentinel
 *   - runtime-input types
 *
 * The v4-1/2/3 strategy router and the LLM-driven transform pipeline
 * (runtime / enrich / transform / verify / llm-client / cache) are NOT
 * re-exported here. If you need them, import from the corresponding modules
 * directly and ship them alongside.
 */

export { generatePrompt, type GeneratePromptOptions } from "./generate-prompt";
export { fillRuntimeInput } from "./fill-runtime-input";
export { RUNTIME_INPUT_PLACEHOLDER } from "./assemble";
export {
  PLACEHOLDER_CLIENT,
  PLACEHOLDER_JOB,
  PLACEHOLDER_RESUME,
  MATCH_RESUME_HIERARCHY_SENTINEL,
  isMatchResumeAction,
} from "./placeholders";
export {
  isMatchResumeRuntimeInput,
  type RuntimeClient,
  type RuntimeJob,
  type RuntimeResume,
  type MatchResumeRuntimeInput,
  type RuntimeInputV4,
} from "./runtime-input.types";

export type {
  ActionObjectV4,
  ActionObjectMetaV4,
  EnrichedAction,
  ValidationReport,
  PromptStrategy,
} from "./types";
