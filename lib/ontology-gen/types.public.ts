/**
 * Action Object codegen — public ABI.
 *
 * This file defines the contract between the codegen and its consumer (the
 * external LLM Agent runtime). It is propagated to `generated/v3/action-object.types.ts`
 * verbatim by `scripts/gen-action-types.ts`, so it MUST NOT import anything.
 *
 * See docs/2026-05-08-action-object-codegen.spec.md §6 for the type contract,
 * and §7 / §8 / §13 for the prompt template, emit rules, and ABI policy.
 */

// ───── Action source-of-truth (post-fetch, pre-compile) ─────

export interface Action {
  id: string;
  name: string;
  description: string;
  submissionCriteria: string;
  objectType: "action" | string;
  category: string;
  actor: string[];
  trigger: string[];
  targetObjects: string[];
  inputs: ActionInput[];
  outputs: ActionOutput[];
  actionSteps: ActionStep[];
  sideEffects: ActionSideEffects;
  triggeredEvents: string[];
}

export interface ActionInput {
  name: string;
  type: string;
  description: string;
  sourceObject?: string;
  required: boolean;
}

export interface ActionOutput {
  name: string;
  type: string;
  description: string;
}

export interface ActionStep {
  order: number;
  name: string;
  description: string;
  objectType: "logic" | "tool" | "data" | "unknown" | string;
  condition?: string;
  rules: ActionRule[];
  inputs: ActionStepInput[];
  outputs: ActionStepOutput[];
  doneWhen?: string;
}

export interface ActionStepInput {
  name: string;
  type: string;
  description: string;
  sourceObject?: string;
}

export interface ActionStepOutput {
  name: string;
  type: string;
  description: string;
}

export interface ActionRule {
  id: string;
  submissionCriteria: string;
  description: string;
  severity: "blocker" | "branch" | "advisory" | string;
  /** Human-readable rule name on the live API (`(:Rule).businessLogicRuleName`).
   *  Surfaced in `## Rule index` labels and rule lines when present. */
  businessLogicRuleName?: string;
  /** Live-API alias of `description`. When upstream supplies this and `description`
   *  is empty, fetch uses this as `description`. Stored separately so consumers
   *  that need both can introspect. */
  standardizedLogicRule?: string;
  /** "Agent" / "Human" / etc. — declarative, not currently rendered. */
  executor?: string;
  /** "内部流程" / "客户系统" / etc. — declarative, not currently rendered. */
  ruleSource?: string;
  /** "通用" or a specific client. Declarative; reserved for future filtering. */
  applicableClient?: string;
}

export interface ActionSideEffects {
  dataChanges: ActionDataChange[];
  notifications: ActionNotification[];
}

export interface ActionDataChange {
  objectType: string;
  action: string;
  propertyImpacted: string[];
  description: string;
  stepRefId?: string;
}

export interface ActionNotification {
  recipient: string;
  channel: string;
  condition: string;
  message: string;
  triggeredEvent: string;
  stepRefId?: string;
}

// ───── ActionObject (post-compile, the emitted shape) ─────

export interface ActionObject {
  // 1:1 mirror of Action (structured truth).
  id: string;
  name: string;
  description: string;
  submissionCriteria: string;
  category: string;
  actor: string[];
  trigger: string[];
  targetObjects: string[];
  inputs: ActionInput[];
  outputs: ActionOutput[];
  actionSteps: ActionStep[];
  sideEffects: ActionSideEffects;
  triggeredEvents: string[];

  // Compilation products.
  /** Default prose rendering. Equals the non-null sections joined by "\n\n", in spec §7.2 order. */
  prompt: string;

  /**
   * Structured access to the same content. Four sections always render
   * (`actionSpec`, `errorPolicy`, `completionCriteria`, `beforeReturning`);
   * the rest are `null` when their source data is empty.
   */
  sections: {
    actionSpec: string;
    purpose: string | null;
    preconditions: string | null;
    inputsSpec: string | null;
    steps: string | null;
    output: string | null;
    sideEffectBoundary: string | null;
    errorPolicy: string;
    completionCriteria: string;
    ruleIndex: string | null;
    beforeReturning: string;
  };

  // Provenance.
  meta: {
    actionId: string;
    actionName: string;
    domain: string;
    compiledAt: string;
    templateVersion: "v3";
  };
}
