/**
 * Internal option types — not emitted to consumers, not part of the ABI.
 */

export interface FetchOptions {
  /** The Action ref — sent verbatim as the URL path segment. The server resolves
   *  id → action_id → name. CLI maps both `--action-id` and `--action-name` here. */
  actionRef: string;
  domain: string;
  apiBase?: string;
  apiToken: string;
  timeoutMs?: number;
}

export interface CompileOptions {
  /** Currently the only valid value. */
  templateVersion: "v3";
  /** Reserved; renderer ignores. */
  locale?: "zh" | "en";
  /** Override `meta.compiledAt`. Used by fixture verification to normalise to a
   *  fixed sentinel; production callers leave this undefined. */
  compiledAtOverride?: string;
  /** Required for `meta.domain` — provenance only. Defaulted from FetchOptions in the orchestrator. */
  domain: string;
  /** Optional per-call scope filter on rules. When supplied, rules whose
   *  `applicableClient` is non-empty / non-"通用" and doesn't match `client`
   *  are dropped from `actionSteps[*].rules` (and from `ruleIndex` by
   *  transitive effect). `clientDepartment` is reserved for upstream API
   *  support — currently a no-op until `ActionRule.applicableClientDepartment`
   *  ships. The filter touches rules only; steps / inputs / outputs /
   *  side-effects skeleton pass through unchanged. */
  clientFilter?: {
    client?: string;
    clientDepartment?: string;
  };
}

export interface EmitOptions {
  /** Path used in the emitted `import type { ActionObject } from "<here>"`. */
  typesImportPath: string;
}

export interface GenerateOptions extends FetchOptions, CompileOptions, EmitOptions {
  outputPath: string;
}
