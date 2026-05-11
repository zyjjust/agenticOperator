// Pure graph derivations over AGENT_MAP. Used by the Inspector
// "Neighborhood" panel (P0): given a selected agent, which agents are
// upstream (could trigger me) or downstream (consume what I emit).
//
// Read-only — never mutates AGENT_MAP. Pure function, no I/O. Re-derive
// on every render is fine (22 agents × 22 lookups = trivial).

import { AGENT_MAP, type AgentMeta } from './agent-mapping';

export type Neighbor = {
  agent: AgentMeta;
  /** Event names through which the relationship flows (display: "via FOO_EVENT"). */
  viaEvents: string[];
};

/**
 * Agents whose emitsEvents intersect this agent's triggersEvents.
 * Empty for entry-point agents (whose triggers come from external systems,
 * e.g. SCHEDULED_SYNC for ReqSync).
 */
export function upstreamOf(short: string): Neighbor[] {
  const me = AGENT_MAP.find((a) => a.short === short);
  if (!me || me.triggersEvents.length === 0) return [];
  const myTriggers = new Set(me.triggersEvents);
  const out: Neighbor[] = [];
  for (const other of AGENT_MAP) {
    if (other.short === short) continue;
    const shared = other.emitsEvents.filter((e) => myTriggers.has(e));
    if (shared.length > 0) {
      out.push({ agent: other, viaEvents: shared });
    }
  }
  return out;
}

/**
 * Agents whose triggersEvents intersect this agent's emitsEvents.
 * Empty for terminal agents that emit nothing (or whose emits are only
 * consumed by external systems / channels).
 */
export function downstreamOf(short: string): Neighbor[] {
  const me = AGENT_MAP.find((a) => a.short === short);
  if (!me || me.emitsEvents.length === 0) return [];
  const myEmits = new Set(me.emitsEvents);
  const out: Neighbor[] = [];
  for (const other of AGENT_MAP) {
    if (other.short === short) continue;
    const shared = other.triggersEvents.filter((e) => myEmits.has(e));
    if (shared.length > 0) {
      out.push({ agent: other, viaEvents: shared });
    }
  }
  return out;
}
