/**
 * Action invariant assertions per spec §6.4.
 *
 * Called at the end of fetch (after whitelist + coerce + default-fill). Failure
 * throws `ActionValidationError` with structured `details` so the CLI can print
 * an actionable diagnostic.
 */

import { ActionValidationError } from "./errors";
import type { Action } from "./types.public";

const TS_IDENT = /^[a-zA-Z][a-zA-Z0-9]*$/;

export function assertActionInvariants(action: Action): void {
  if (typeof action.id !== "string" || action.id.length === 0) {
    throw fail("id-non-empty", "Action.id must be a non-empty string", "id", action.id);
  }
  if (typeof action.name !== "string" || action.name.length === 0) {
    throw fail("name-non-empty", "Action.name must be a non-empty string", "name", action.name);
  }
  if (!TS_IDENT.test(action.name)) {
    throw fail(
      "name-ts-identifier",
      `Action.name must match ${TS_IDENT} (used as TS export name root)`,
      "name",
      action.name,
    );
  }
  if (!Array.isArray(action.actionSteps)) {
    throw fail(
      "action-steps-array",
      "Action.actionSteps must be an array (may be empty)",
      "actionSteps",
      action.actionSteps,
    );
  }

  const seenOrders = new Set<number>();
  for (let i = 0; i < action.actionSteps.length; i++) {
    const step = action.actionSteps[i]!;
    const path = `actionSteps[${i}]`;

    if (
      typeof step.order !== "number" ||
      !Number.isFinite(step.order) ||
      !Number.isInteger(step.order) ||
      step.order <= 0
    ) {
      throw fail(
        "step-order-positive-integer",
        `${path}.order must be a finite positive integer (got ${String(step.order)})`,
        `${path}.order`,
        step.order,
      );
    }

    if (seenOrders.has(step.order)) {
      throw fail(
        "step-order-unique",
        `${path}.order=${step.order} is not unique within the Action`,
        `${path}.order`,
        step.order,
      );
    }
    seenOrders.add(step.order);

    if (!Array.isArray(step.rules)) {
      throw fail("step-rules-array", `${path}.rules must be an array`, `${path}.rules`, step.rules);
    }

    for (let j = 0; j < step.rules.length; j++) {
      const rule = step.rules[j]!;
      const rulePath = `${path}.rules[${j}]`;
      if (typeof rule.id !== "string" || rule.id.length === 0) {
        throw fail(
          "rule-id-non-empty",
          `${rulePath}.id must be a non-empty string`,
          `${rulePath}.id`,
          rule.id,
        );
      }
    }
  }

  // sideEffects.dataChanges[*].objectType must be non-empty when entry is present
  for (let i = 0; i < action.sideEffects.dataChanges.length; i++) {
    const dc = action.sideEffects.dataChanges[i]!;
    if (typeof dc.objectType !== "string" || dc.objectType.length === 0) {
      throw fail(
        "data-change-object-type-non-empty",
        `sideEffects.dataChanges[${i}].objectType must be a non-empty string`,
        `sideEffects.dataChanges[${i}].objectType`,
        dc.objectType,
      );
    }
  }
}

function fail(invariant: string, message: string, path: string, observedValue: unknown): ActionValidationError {
  return new ActionValidationError(message, { invariant, path, observedValue });
}
