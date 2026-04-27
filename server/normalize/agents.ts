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
  return `agent_${short.toLowerCase()}`;
}
