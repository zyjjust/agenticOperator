/**
 * Stage ① — fetch + validate + coerce.
 *
 * Two entry points share `mapApiResponseToAction(raw)`:
 *   - `fetchAction(opts)` calls `GET /api/v1/ontology/actions/{ref}/rules?domain=...`
 *   - `parseAction(raw)`  applies the same map without HTTP (used by fixtures)
 *
 * The map enforces spec §6.5 (whitelist + drop list), applies the §4.3
 * default-fill rules, coerces `order` to integer, and hoists the polysemic
 * `triggered_event` (singular at notification level, plural at action top-level).
 * Then `assertActionInvariants` (§6.4) runs.
 */

import { getJson } from "./client";
import { OntologyContractError } from "./errors";
import type { FetchOptions } from "./types.internal";
import type {
  Action,
  ActionDataChange,
  ActionInput,
  ActionNotification,
  ActionOutput,
  ActionRule,
  ActionStep,
  ActionStepInput,
  ActionStepOutput,
} from "./types.public";
import { assertActionInvariants } from "./validate";

export async function fetchAction(opts: FetchOptions): Promise<Action> {
  if (!opts.apiToken) {
    throw new OntologyContractError(
      "fetchAction requires apiToken (set ONTOLOGY_API_TOKEN env or pass via opts)",
    );
  }
  const apiBase = opts.apiBase ?? process.env["ONTOLOGY_API_BASE"];
  if (!apiBase) {
    throw new OntologyContractError(
      "fetchAction requires apiBase (set ONTOLOGY_API_BASE env or pass via opts)",
    );
  }

  const ref = encodeURIComponent(opts.actionRef);
  const domain = encodeURIComponent(opts.domain);
  const path = `/api/v1/ontology/actions/${ref}/rules?domain=${domain}`;

  const raw = await getJson({
    apiBase,
    apiToken: opts.apiToken,
    path,
    timeoutMs: opts.timeoutMs,
  });
  return mapApiResponseToAction(raw);
}

export function parseAction(raw: unknown): Action {
  return mapApiResponseToAction(raw);
}

// ───── internals ─────

function mapApiResponseToAction(raw: unknown): Action {
  if (!isObject(raw)) {
    throw new OntologyContractError("Upstream Action response is not a JSON object", {
      observedType: typeof raw,
    });
  }

  // The live Ontology API returns property-bag fields JSON-stringified per
  // its "flatten rule" (API doc §"The flatten rule"). E.g. `actor_json`,
  // `inputs_json`, `side_effects_json`, etc. The composite endpoint inflates
  // `action_steps` (graph traversal) but NOT the Action's own properties.
  // We rehydrate here so downstream code sees the structured form regardless
  // of whether the input came from a curated JSON file or the live API.
  const inflated = inflateJsonFields(raw, [
    "actor",
    "trigger",
    "target_objects",
    "inputs",
    "outputs",
    "side_effects",
    "triggered_event",
  ]);

  // Same inflate inside each step (live API uses `inputs_json` / `outputs_json`
  // on ActionStep nodes too).
  const stepsRaw = (inflated["action_steps"] ?? inflated["actionSteps"]) as unknown;
  if (Array.isArray(stepsRaw)) {
    inflated["action_steps"] = stepsRaw.map((s) =>
      isObject(s) ? inflateJsonFields(s, ["inputs", "outputs"]) : s,
    );
  }

  // §4.4 — `action_steps` MUST be present (may be empty) AFTER inflation.
  if (!("action_steps" in inflated) && !("actionSteps" in inflated)) {
    throw new OntologyContractError(
      "Upstream Action response is missing `action_steps` (see spec §4.4 — codegen requires the nested-tree shape returned by /actions/{ref}/rules)",
      { keys: Object.keys(inflated) },
    );
  }

  const action: Action = {
    id: requireString(inflated, "id", "Action"),
    name: requireString(inflated, "name", "Action"),
    description: pickString(inflated, "description", ""),
    submissionCriteria: pickString(inflated, "submission_criteria", "", "submissionCriteria"),
    objectType: pickString(inflated, "object_type", "action", "objectType"),
    category: pickString(inflated, "category", ""),
    actor: pickStringArray(inflated, "actor", []),
    trigger: pickStringArray(inflated, "trigger", []),
    targetObjects: pickStringArray(inflated, "target_objects", [], "targetObjects"),
    inputs: mapInputs(pickArray(inflated, "inputs", [])),
    outputs: mapOutputs(pickArray(inflated, "outputs", [])),
    actionSteps: mapSteps(pickArray(inflated, "action_steps", [], "actionSteps")),
    sideEffects: mapSideEffects(inflated["side_effects"] ?? inflated["sideEffects"]),
    triggeredEvents: pickStringArray(inflated, "triggered_event", [], "triggeredEvents"),
  };

  assertActionInvariants(action);
  return action;
}

/**
 * For each `<key>` in `keys`, ensure the value at `<key>` ends up structured
 * (array / object) regardless of how the API delivered it. Two flatten-rule
 * variants are handled (both observed against the live ontology API):
 *
 *   variant A — `<key>_json` alias present (older shape):
 *       { actor_json: '["Agent"]' } → { actor: ["Agent"] }
 *
 *   variant B — bare `<key>` present but JSON-stringified (newer shape):
 *       { actor: '["Agent"]' }      → { actor: ["Agent"] }
 *
 *   variant C — already structured (curated JSON file or pre-inflated backend):
 *       { actor: ["Agent"] }        → unchanged
 *
 * Returns a shallow-cloned object; the original is not mutated. Any `<key>_json`
 * alias is dropped from the result regardless of which variant was active.
 *
 * Empty strings ('', '   ') under `<key>` are treated as "absent" — the key is
 * removed so downstream default-fill (e.g. `[]`, `""`) kicks in.
 */
function inflateJsonFields(
  src: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...src };
  for (const key of keys) {
    const jsonKey = `${key}_json`;

    // Choose the source: non-null bare `<key>` wins, else `<key>_json` alias.
    let candidate: unknown = undefined;
    if (out[key] !== undefined && out[key] !== null) {
      candidate = out[key];
    } else if (out[jsonKey] !== undefined && out[jsonKey] !== null) {
      candidate = out[jsonKey];
    }

    // The `_json` alias is consumed regardless — never reaches the whitelist stage.
    delete out[jsonKey];

    if (candidate === undefined) {
      // Neither form present; leave `<key>` absent for default-fill downstream.
      continue;
    }

    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      if (trimmed.length === 0) {
        // Empty string treated as absent.
        delete out[key];
        continue;
      }
      try {
        out[key] = JSON.parse(trimmed);
      } catch (e) {
        throw new OntologyContractError(
          `Failed to JSON-parse ${key} (live API returned a flattened property; expected JSON): ${e instanceof Error ? e.message : String(e)}`,
          { key, snippet: trimmed.slice(0, 120) },
        );
      }
    } else {
      // Already structured (array/object/primitive) — pass through.
      out[key] = candidate;
    }
  }
  return out;
}

function mapInputs(raw: unknown[]): ActionInput[] {
  return raw.map((entry, i) => {
    if (!isObject(entry)) {
      throw new OntologyContractError(`inputs[${i}] is not an object`, { index: i });
    }
    return {
      name: requireString(entry, "name", `inputs[${i}]`),
      type: pickString(entry, "type", "Unknown"),
      description: pickString(entry, "description", ""),
      sourceObject: pickOptionalString(entry, "source_object", "sourceObject"),
      required: pickBoolean(entry, "required", false),
    } satisfies ActionInput;
  });
}

function mapOutputs(raw: unknown[]): ActionOutput[] {
  return raw.map((entry, i) => {
    if (!isObject(entry)) {
      throw new OntologyContractError(`outputs[${i}] is not an object`, { index: i });
    }
    return {
      name: requireString(entry, "name", `outputs[${i}]`),
      type: pickString(entry, "type", "Unknown"),
      description: pickString(entry, "description", ""),
    } satisfies ActionOutput;
  });
}

function mapStepInputs(raw: unknown[]): ActionStepInput[] {
  return raw.map((entry, i) => {
    if (!isObject(entry)) {
      throw new OntologyContractError(`step.inputs[${i}] is not an object`, { index: i });
    }
    return {
      name: requireString(entry, "name", `step.inputs[${i}]`),
      type: pickString(entry, "type", "Unknown"),
      description: pickString(entry, "description", ""),
      sourceObject: pickOptionalString(entry, "source_object", "sourceObject"),
    } satisfies ActionStepInput;
  });
}

function mapStepOutputs(raw: unknown[]): ActionStepOutput[] {
  return raw.map((entry, i) => {
    if (!isObject(entry)) {
      throw new OntologyContractError(`step.outputs[${i}] is not an object`, { index: i });
    }
    return {
      name: requireString(entry, "name", `step.outputs[${i}]`),
      type: pickString(entry, "type", "Unknown"),
      description: pickString(entry, "description", ""),
    } satisfies ActionStepOutput;
  });
}

function mapSteps(raw: unknown[]): ActionStep[] {
  return raw.map((entry, i) => {
    if (!isObject(entry)) {
      throw new OntologyContractError(`actionSteps[${i}] is not an object`, { index: i });
    }
    const orderRaw = entry["order"];
    const orderNum =
      typeof orderRaw === "number"
        ? orderRaw
        : typeof orderRaw === "string"
          ? Number(orderRaw)
          : NaN;
    return {
      order: orderNum, // validate.ts asserts finite positive integer
      name: pickString(entry, "name", ""),
      description: pickString(entry, "description", ""),
      objectType: pickString(entry, "object_type", "unknown", "objectType"),
      condition: pickOptionalString(entry, "condition"),
      rules: mapRules(pickArray(entry, "rules", [])),
      inputs: mapStepInputs(pickArray(entry, "inputs", [])),
      outputs: mapStepOutputs(pickArray(entry, "outputs", [])),
      doneWhen: pickOptionalString(entry, "done_when", "doneWhen"),
    } satisfies ActionStep;
  });
}

function mapRules(raw: unknown[]): ActionRule[] {
  return raw.map((entry, i) => {
    if (!isObject(entry)) {
      throw new OntologyContractError(`rules[${i}] is not an object`, { index: i });
    }

    // Live API stores the rule body under `standardizedLogicRule`; the JSON-file
    // shape uses `description`. Prefer the explicit `description` when non-empty,
    // otherwise fall back to `standardizedLogicRule` so both shapes render the
    // same prose without per-call branching downstream.
    const stdLogic = pickOptionalString(entry, "standardizedLogicRule");
    const explicitDesc = pickString(entry, "description", "");
    const description = explicitDesc.length > 0 ? explicitDesc : (stdLogic ?? "");

    return {
      id: requireString(entry, "id", `rules[${i}]`),
      submissionCriteria: pickString(entry, "submission_criteria", "", "submissionCriteria"),
      description,
      severity: pickString(entry, "severity", "advisory"),
      businessLogicRuleName: pickOptionalString(entry, "businessLogicRuleName"),
      standardizedLogicRule: stdLogic,
      executor: pickOptionalString(entry, "executor"),
      ruleSource: pickOptionalString(entry, "ruleSource", "rule_source"),
      applicableClient: pickOptionalString(entry, "applicableClient", "applicable_client"),
    } satisfies ActionRule;
  });
}

function mapSideEffects(raw: unknown): Action["sideEffects"] {
  if (raw === undefined || raw === null) {
    return { dataChanges: [], notifications: [] };
  }
  if (!isObject(raw)) {
    throw new OntologyContractError("side_effects must be an object when present", {
      observedType: typeof raw,
    });
  }
  return {
    dataChanges: mapDataChanges(pickArray(raw, "data_changes", [], "dataChanges")),
    notifications: mapNotifications(pickArray(raw, "notifications", [])),
  };
}

function mapDataChanges(raw: unknown[]): ActionDataChange[] {
  return raw.map((entry, i) => {
    if (!isObject(entry)) {
      throw new OntologyContractError(`data_changes[${i}] is not an object`, { index: i });
    }
    return {
      objectType: pickString(entry, "object_type", "", "objectType"),
      action: pickString(entry, "action", ""),
      propertyImpacted: pickStringArray(entry, "property_impacted", [], "propertyImpacted"),
      description: pickString(entry, "description", ""),
      stepRefId: pickOptionalString(entry, "step_ref_id", "stepRefId"),
    } satisfies ActionDataChange;
  });
}

function mapNotifications(raw: unknown[]): ActionNotification[] {
  return raw.map((entry, i) => {
    if (!isObject(entry)) {
      throw new OntologyContractError(`notifications[${i}] is not an object`, { index: i });
    }
    return {
      recipient: pickString(entry, "recipient", ""),
      channel: pickString(entry, "channel", ""),
      condition: pickString(entry, "condition", ""),
      message: pickString(entry, "message", ""),
      triggeredEvent: pickString(entry, "triggered_event", "", "triggeredEvent"),
      stepRefId: pickOptionalString(entry, "step_ref_id", "stepRefId"),
    } satisfies ActionNotification;
  });
}

// ───── primitive helpers ─────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Read either snake_case `key` or its camelCase alias. snake_case wins on conflict (it's the canonical API form). */
function readEither(obj: Record<string, unknown>, snakeKey: string, camelKey?: string): unknown {
  if (snakeKey in obj) return obj[snakeKey];
  if (camelKey && camelKey in obj) return obj[camelKey];
  return undefined;
}

function requireString(obj: Record<string, unknown>, key: string, container: string): string {
  const v = obj[key];
  if (typeof v !== "string") {
    throw new OntologyContractError(`${container}.${key} must be a string (got ${typeof v})`, {
      container,
      key,
      observedType: typeof v,
    });
  }
  return v;
}

function pickString(
  obj: Record<string, unknown>,
  snakeKey: string,
  fallback: string,
  camelKey?: string,
): string {
  const v = readEither(obj, snakeKey, camelKey);
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "string") {
    throw new OntologyContractError(
      `Expected ${snakeKey} to be a string (got ${typeof v})`,
      { key: snakeKey, observedType: typeof v },
    );
  }
  return v;
}

function pickOptionalString(
  obj: Record<string, unknown>,
  snakeKey: string,
  camelKey?: string,
): string | undefined {
  if (!(snakeKey in obj) && !(camelKey && camelKey in obj)) {
    return undefined;
  }
  const v = readEither(obj, snakeKey, camelKey);
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") {
    throw new OntologyContractError(
      `Expected ${snakeKey} to be a string when present (got ${typeof v})`,
      { key: snakeKey, observedType: typeof v },
    );
  }
  return v;
}

function pickBoolean(obj: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = obj[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "boolean") {
    throw new OntologyContractError(
      `Expected ${key} to be a boolean (got ${typeof v})`,
      { key, observedType: typeof v },
    );
  }
  return v;
}

function pickStringArray(
  obj: Record<string, unknown>,
  snakeKey: string,
  fallback: string[],
  camelKey?: string,
): string[] {
  const v = readEither(obj, snakeKey, camelKey);
  if (v === undefined || v === null) return fallback;
  if (!Array.isArray(v)) {
    throw new OntologyContractError(
      `Expected ${snakeKey} to be a string[] (got ${typeof v})`,
      { key: snakeKey, observedType: typeof v },
    );
  }
  for (const item of v) {
    if (typeof item !== "string") {
      throw new OntologyContractError(
        `Expected every ${snakeKey}[i] to be a string (got ${typeof item})`,
        { key: snakeKey, observedItemType: typeof item },
      );
    }
  }
  return v as string[];
}

function pickArray(
  obj: Record<string, unknown>,
  snakeKey: string,
  fallback: unknown[],
  camelKey?: string,
): unknown[] {
  const v = readEither(obj, snakeKey, camelKey);
  if (v === undefined || v === null) return fallback;
  if (!Array.isArray(v)) {
    throw new OntologyContractError(
      `Expected ${snakeKey} to be an array (got ${typeof v})`,
      { key: snakeKey, observedType: typeof v },
    );
  }
  return v;
}
