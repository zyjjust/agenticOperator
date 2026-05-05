// Agentic on/off toggle.
//
// Single source of truth for "are AO agents allowed to do work?". Stored
// as a tiny JSON file under data/ so it survives Next.js hot-reloads
// and process restarts; no DB migration needed for a flag this simple.
//
// Effect when DISABLED:
//   - processResume + matchResume still get the event from Inngest,
//     but short-circuit immediately (writes one AgentActivity row with
//     type="event_received" + narrative="skipped: agentic disabled",
//     then returns).
//   - No MinIO fetch, no RoboHire call, no event re-emission.
//   - Inngest UI shows the run as "Completed" in <50ms.

import { promises as fs } from "node:fs";
import path from "node:path";

const STATE_FILE = path.resolve("data", "agentic-state.json");

export type AgenticState = {
  enabled: boolean;
  updatedAt: string;
  updatedBy?: string;
  reason?: string;
};

const DEFAULT_STATE: AgenticState = {
  enabled: false,
  updatedAt: new Date(0).toISOString(),
  reason: "default — flip to enabled via /api/agentic to start processing events",
};

let _cache: AgenticState | null = null;
let _cacheReadAt = 0;
const CACHE_TTL_MS = 1000; // re-read at most once per second

export async function getAgenticState(): Promise<AgenticState> {
  const now = Date.now();
  if (_cache && now - _cacheReadAt < CACHE_TTL_MS) return _cache;
  try {
    const raw = await fs.readFile(STATE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<AgenticState>;
    _cache = {
      enabled: Boolean(parsed.enabled),
      updatedAt: parsed.updatedAt ?? DEFAULT_STATE.updatedAt,
      updatedBy: parsed.updatedBy,
      reason: parsed.reason,
    };
  } catch {
    _cache = DEFAULT_STATE;
  }
  _cacheReadAt = now;
  return _cache;
}

export async function setAgenticState(
  next: { enabled: boolean; updatedBy?: string; reason?: string },
): Promise<AgenticState> {
  const value: AgenticState = {
    enabled: Boolean(next.enabled),
    updatedAt: new Date().toISOString(),
    updatedBy: next.updatedBy,
    reason: next.reason,
  };
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(value, null, 2), "utf-8");
  _cache = value;
  _cacheReadAt = Date.now();
  return value;
}

export async function isAgenticEnabled(): Promise<boolean> {
  return (await getAgenticState()).enabled;
}
