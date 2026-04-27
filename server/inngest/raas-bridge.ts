// RAAS event bridge — pulls events from the shared Inngest (RAAS team's
// 10.100.0.70:8288) and re-emits them to AO's local Inngest. Solves the
// single-direction-routing problem: AO can reach 10.100.0.70 outbound,
// but 10.100.0.70 can't reach back to 172.16.1.83.
//
// One-way pull. Idempotent via a seen-set so the same event isn't
// re-dispatched.
//
// Started by app/api/raas-bridge/start/route.ts (or any other server-side
// boot path); polls every RAAS_BRIDGE_POLL_INTERVAL_MS.

import { inngest } from "./client";
import { prisma } from "../db";

const SHARED_URL = process.env.RAAS_INNGEST_URL ?? "http://10.100.0.70:8288";
const POLL_INTERVAL = Number(process.env.RAAS_BRIDGE_POLL_INTERVAL_MS ?? 5000);
const EVENT_NAMES = (process.env.RAAS_BRIDGE_EVENTS ?? "RESUME_DOWNLOADED")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

type SharedEvent = {
  id: string;
  internal_id?: string;
  name: string;
  data: unknown;
  ts?: number;
  received_at?: string;
};

let _started = false;
let _seenIds = new Set<string>();
let _lastPolledAt = "";
let _stats = {
  pollsCompleted: 0,
  eventsBridged: 0,
  errors: 0,
  lastError: null as string | null,
  lastEventBridgedAt: null as string | null,
};

export function getRaasBridgeStatus() {
  return {
    started: _started,
    sharedUrl: SHARED_URL,
    pollIntervalMs: POLL_INTERVAL,
    eventNames: EVENT_NAMES,
    lastPolledAt: _lastPolledAt,
    seenCount: _seenIds.size,
    ..._stats,
  };
}

export function startRaasBridge(): void {
  if (_started) return;
  if (process.env.RAAS_BRIDGE_ENABLED !== "1") {
    console.log("[raas-bridge] disabled (set RAAS_BRIDGE_ENABLED=1 to enable)");
    return;
  }
  _started = true;
  console.log(
    `[raas-bridge] starting. polling ${SHARED_URL}/v1/events every ${POLL_INTERVAL}ms for ${EVENT_NAMES.join(",")}`,
  );

  // Seed seen-set with the recent events so we don't re-fire historical
  // events when the bridge first starts.
  seedSeen()
    .then(() => {
      // Start poll loop
      tick();
    })
    .catch((e) => {
      console.error("[raas-bridge] seed failed:", e);
      tick();
    });
}

async function seedSeen(): Promise<void> {
  try {
    const r = await fetchSharedEvents(50);
    for (const e of r) _seenIds.add(e.id);
    _lastPolledAt = new Date().toISOString();
    console.log(`[raas-bridge] seeded ${r.length} historical events to skip`);
  } catch (e) {
    console.warn("[raas-bridge] seed: shared bus unreachable yet:", (e as Error).message);
  }
}

async function tick(): Promise<void> {
  try {
    const events = await fetchSharedEvents(20);
    _stats.pollsCompleted++;
    _lastPolledAt = new Date().toISOString();

    for (const e of events) {
      if (_seenIds.has(e.id)) continue;
      if (!EVENT_NAMES.includes(e.name)) {
        _seenIds.add(e.id);
        continue;
      }

      // New event from RAAS — re-emit locally so AO functions process it.
      try {
        await inngest.send({
          name: e.name,
          data: e.data as Record<string, unknown>,
        });
        _seenIds.add(e.id);
        _stats.eventsBridged++;
        _stats.lastEventBridgedAt = new Date().toISOString();

        // Log to AgentActivity so /agent-demo + /events firehose can show
        // the bridge activity.
        await prisma.agentActivity
          .create({
            data: {
              nodeId: "raas-bridge",
              agentName: "RAASBridge",
              type: "event_received",
              narrative: `Bridged ${e.name} from RAAS · ${e.id}`,
              metadata: JSON.stringify({
                source: "raas-bridge",
                shared_event_id: e.id,
                event_name: e.name,
                data: e.data,
              }),
            },
          })
          .catch((err) => {
            console.warn("[raas-bridge] AgentActivity write failed:", err.message);
          });

        console.log(`[raas-bridge] bridged ${e.name} (${e.id})`);
      } catch (sendErr) {
        _stats.errors++;
        _stats.lastError = `send: ${(sendErr as Error).message}`;
        console.error("[raas-bridge] re-emit failed:", sendErr);
      }
    }

    // Cap seen-set so it doesn't grow unbounded.
    if (_seenIds.size > 5000) {
      const arr = [..._seenIds];
      _seenIds = new Set(arr.slice(-2500));
    }
  } catch (e) {
    _stats.errors++;
    _stats.lastError = `poll: ${(e as Error).message}`;
    if (_stats.errors % 10 === 1) {
      console.error("[raas-bridge] poll failed:", (e as Error).message);
    }
  } finally {
    setTimeout(tick, POLL_INTERVAL);
  }
}

async function fetchSharedEvents(limit: number): Promise<SharedEvent[]> {
  const ctl = AbortSignal.timeout(8_000);
  const res = await fetch(`${SHARED_URL}/v1/events?limit=${limit}`, { signal: ctl });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as { data?: SharedEvent[] };
  return Array.isArray(json.data) ? json.data : [];
}
