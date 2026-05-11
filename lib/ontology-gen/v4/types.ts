/**
 * Action Object Codegen v4 — public ABI for the v4 path.
 *
 * Independent from v3 types in `../types.public.ts`. v4 returns a minimal
 * ActionObjectV4 = { prompt, meta }, NOT the full v3 mirror of Action fields.
 *
 * Four parallel strategies (V4-1 / V4-2 / V4-3 / V4-4) produce identical output
 * shape — they only differ in WHEN/WHERE the LLM-generated content lives.
 *
 * See `/.claude/plans/spec-plan-mode-spec-api-glistening-hare.md` for design.
 */

import type { Action } from "../types.public";

// ───── Strategy enum ─────

export type PromptStrategy = "v4-1" | "v4-2" | "v4-3" | "v4-4";

// ───── ActionObject (v4) ─────

export interface ActionObjectV4 {
  /** Complete prompt string. Contains exactly one placeholder: {{RUNTIME_INPUT}}.
   *  The agent runtime substitutes it with the actual input data right before
   *  calling the LLM. */
  prompt: string;

  meta: ActionObjectMetaV4;
}

export interface ActionObjectMetaV4 {
  actionId: string;
  actionName: string;
  domain: string;
  /** When the prompt was scoped to a specific client at compile time. */
  client?: string;
  /** ISO 8601. For V4-1 it's the runtime call time; for V4-2/V4-4 the function
   *  call time; for V4-3 the dev-time generation time (frozen). */
  compiledAt: string;
  templateVersion: "v4";
  promptStrategy: PromptStrategy;

  /** Validation results — surface only, never block. */
  validation: ValidationReport;
}

export interface ValidationReport {
  /** True when committed instruction versions don't match upstream rule versions. */
  driftDetected: boolean;
  /** rule_ids whose round-trip semantic check failed during transform. */
  roundTripFailures: string[];
  /** rule_ids upstream supplies but committed templates don't have an instruction for. */
  missingInstructions: string[];
}

// ───── Per-rule and per-step LLM-generated content ─────

export interface RuleInstruction {
  id: string;
  /** The full natural-language actionable instruction with the 3-section
   *  structure: "How to evaluate this rule:" / "What to do when this rule
   *  fires:" / "How to verify before moving on:". */
  instruction: string;
  meta: RuleInstructionMeta;
}

export interface RuleInstructionMeta {
  /** sourceFile + version concatenated, for drift detection. */
  sourceVersion: string;
  transformedAt: string;
  transformedBy: string; // model name, e.g. "kimi-k2.6"
  roundTripCheck: "passed" | "failed" | "skipped";
  /** Original Chinese prose, preserved verbatim for audit. */
  originalProse: string;
}

export interface StepInstruction {
  order: number;
  /** Full natural-language step description: "What this step accomplishes:" /
   *  "How to perform this step:" / "When this step is complete:". */
  description: string;
  meta: StepInstructionMeta;
}

export interface StepInstructionMeta {
  sourceVersion: string;
  transformedAt: string;
  transformedBy: string;
  roundTripCheck: "passed" | "failed" | "skipped";
}

// ───── EnrichedAction — Action + DataObject + Event schemas ─────

export interface EnrichedAction {
  action: Action;
  /** key = DataObject id (e.g. "Resume"), value = parsed schema. */
  dataObjectSchemas: Record<string, DataObjectSchema>;
  /** key = Event id (e.g. "RESUME_PROCESSED"), value = parsed payload schema. */
  eventSchemas: Record<string, EventSchema>;
}

export interface DataObjectSchema {
  id: string;
  name: string;
  description: string;
  primaryKey: string;
  properties: DataObjectProperty[];
}

export interface DataObjectProperty {
  name: string;
  type: string;
  description: string;
  isForeignKey?: boolean;
  references?: string;
}

export interface EventSchema {
  id: string;
  name: string;
  description: string;
  sourceAction?: string;
  eventData: EventDataField[];
  stateMutations: EventStateMutation[];
}

export interface EventDataField {
  name: string;
  type: string;
  targetObject?: string;
}

export interface EventStateMutation {
  targetObject: string;
  mutationType: string;
  impactedProperties: string[];
}

// ───── Runtime input ─────

export interface ResolveActionInputV4 {
  actionRef: string;
  domain: string;
  client?: string;
  /** Optional runtime input data (string or JSON-serializable).
   *  When provided, replaces {{RUNTIME_INPUT}} in the final prompt.
   *  When omitted, the placeholder is left intact for the caller to fill later. */
  runtimeInput?: string | Record<string, unknown>;
  strategy?: PromptStrategy;
  apiBase?: string;
  apiToken?: string;
  timeoutMs?: number;
}

// ───── Internal options ─────

export interface TransformOptions {
  model?: string;
  apiBaseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
}

export interface AssemblePromptInput {
  enriched: EnrichedAction;
  client?: string;
  stepInstructions: Record<number, StepInstruction>;
  ruleInstructions: Record<string, RuleInstruction>;
  runtimeInput?: string | Record<string, unknown>;
}
