import { AGENT_MAP } from '../../lib/agent-mapping';

export class UnknownAgentError extends Error {
  constructor(public wsId: string) {
    super(`Unknown WS agent id: ${wsId}`);
    this.name = 'UnknownAgentError';
  }
}

export function shortFromWs(wsId: string): string {
  const m = AGENT_MAP.find((a) => a.wsId === wsId);
  if (!m) throw new UnknownAgentError(wsId);
  return m.short;
}

export function displayKey(short: string): string {
  // Returns the i18n key for the agent's canonical display name.
  // Distinct from existing `agent_<short>` keys (canvas sub-labels) — see lib/i18n.tsx.
  return `display_${short.toLowerCase()}`;
}
