// Shared outbound forward helper.
//
// Inngest's step.sendEvent() only writes to OUR local Inngest dev
// (INNGEST_BASE_URL=localhost:8288). Partner subscribes on a separate
// Inngest instance (RAAS_INNGEST_URL=10.100.0.70:8288). To close the loop,
// every customer-facing event we emit (JD_GENERATED, RESUME_PROCESSED,
// MATCH_PASSED_*, MATCH_FAILED) is also POST'd to partner's Inngest via
// this helper. Always called inside a step.run for retry idempotency.
//
// Gated by RAAS_FORWARD_ENABLED=1 so local-only testing doesn't ping
// the shared bus.

import type { LoggerLike } from "@/server/agent-logger";
import { fetchWithTelemetry } from "@/server/http/instrumented";

export type RaasForwardResult =
  | { skipped: true; reason: string }
  | { forwarded: true; status: number; target: string };

export async function forwardToRaas(
  eventName: string,
  envelope: unknown,
  opts?: { logger?: LoggerLike },
): Promise<RaasForwardResult> {
  const url = process.env.RAAS_INNGEST_URL;
  const enabled = process.env.RAAS_FORWARD_ENABLED === "1";
  if (!url || !enabled) {
    return { skipped: true, reason: "RAAS_FORWARD_ENABLED!=1 or RAAS_INNGEST_URL unset" };
  }
  const eventKey = process.env.INNGEST_EVENT_KEY ?? "dev";
  const res = await fetchWithTelemetry(
    `${url}/e/${eventKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: eventName, data: envelope }),
      signal: AbortSignal.timeout(15_000),
    },
    {
      logger: opts?.logger,
      toolName: "RAAS.forward",
      meta: { event_name: eventName },
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`RAAS forward ${res.status}: ${body}`);
  }
  return { forwarded: true, status: res.status, target: url };
}
