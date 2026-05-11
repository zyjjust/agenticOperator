/**
 * Runtime input types for the canonical v4 entry (`generatePrompt` / `fillRuntimeInput`).
 *
 * Separation of concerns: kept apart from `types.ts` (which holds internal v4
 * codegen types like EnrichedAction, RuleInstruction, etc.). The runtime input
 * shapes here are part of the **consumer ABI** — they're mirrored into
 * `generated/v4/action-object-v4.types.ts` for zero-lib-dep consumption.
 *
 * Design notes (see plan + GENERATE-PROMPT-USER-GUIDE.md for rationale):
 *   - `kind: "matchResume"` is an explicit discriminator. Future actions get
 *     their own `kind` to avoid structural collisions with generic Record.
 *   - TS field names are camelCase. The renderer maps to the prompt's
 *     snake_case format (`client.name` → `client_name: ...`).
 *   - RuntimeJob / RuntimeResume keep `*_id` as the only hard-required field
 *     and use `[key: string]: unknown` for the rest — upstream Job_Requisition
 *     / Resume DataObject schemas are property-bag style and evolve.
 */

export interface RuntimeClient {
  /** Rendered as `client_name: <name>` in the CLIENT block. */
  name: string;
  /** Rendered as `department: <department>` when present; line omitted otherwise. */
  department?: string;
  [key: string]: unknown;
}

export interface RuntimeJob {
  job_requisition_id: string;
  [field: string]: unknown;
}

export interface RuntimeResume {
  candidate_id: string;
  [field: string]: unknown;
}

export interface MatchResumeRuntimeInput {
  kind: "matchResume";
  client: RuntimeClient;
  job: RuntimeJob;
  resume: RuntimeResume;
}

export type RuntimeInputV4 =
  | MatchResumeRuntimeInput
  | string
  | Record<string, unknown>;

export function isMatchResumeRuntimeInput(x: unknown): x is MatchResumeRuntimeInput {
  return (
    typeof x === "object" &&
    x !== null &&
    (x as { kind?: unknown }).kind === "matchResume"
  );
}
