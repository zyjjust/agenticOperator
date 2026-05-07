// Server-side init — runs once per Next.js dev/prod boot.
// Imported by app/api/inngest/route.ts (which is loaded on first hit).

import { startRaasBridge } from "./inngest/raas-bridge";
import { startEventDefinitionSync } from "./em/sync/event-definition-sync";

let _booted = false;

export function bootOnce(): void {
  if (_booted) return;
  _booted = true;
  // Bridge is gated on RAAS_BRIDGE_ENABLED=1 — see raas-bridge.ts.
  startRaasBridge();
  // Neo4j → EventDefinition sync. Gated on NEO4J_SYNC_ENABLED=1 and
  // degrades gracefully when the host is unreachable (off-VPN).
  startEventDefinitionSync();
}
