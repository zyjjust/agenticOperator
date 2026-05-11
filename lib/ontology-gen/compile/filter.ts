/**
 * Per-call rule scope filter.
 *
 * Runtime callers (`resolveActionObject`) supply `(client?, clientDepartment?)`
 * to scope an Action's prompt to a specific tenant. The filter rewrites
 * `actionSteps[*].rules` in a shallow Action copy; it does NOT touch top-level
 * `inputs` / `outputs` / `targetObjects` / `triggeredEvents` / `sideEffects` —
 * the action's structural skeleton is identical for every client.
 *
 * "通用" is the sentinel used by current Ontology API responses for
 * "applies to all clients". Empty / undefined `applicableClient` is treated
 * the same way (universal).
 */

import type { Action, ActionRule } from "../types.public";

export interface ClientFilter {
  client?: string;
  clientDepartment?: string;
}

export function applyClientFilter(action: Action, filter: ClientFilter): Action {
  return {
    ...action,
    actionSteps: action.actionSteps.map((step) => ({
      ...step,
      rules: step.rules.filter((rule) => matchClientFilter(rule, filter)),
    })),
  };
}

function matchClientFilter(rule: ActionRule, filter: ClientFilter): boolean {
  if (filter.client !== undefined) {
    const ac = rule.applicableClient;
    if (ac && ac.length > 0 && ac !== "通用" && ac !== filter.client) return false;
  }
  if (filter.clientDepartment !== undefined) {
    // Reserved: ActionRule has no `applicableClientDepartment` field yet.
    // When upstream ships it, mirror the `client` check above.
  }
  return true;
}
