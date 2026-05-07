// EM library health tracker — implements spec v2 §12.
//
// When the main em.publish() flow throws (DB write fails, registry barfs,
// inngest.send rejects), we DON'T crash the caller. Instead we:
//   1. flip the in-process degraded flag
//   2. record the error in EmSystemStatus (via async fire-and-forget — if
//      the DB itself is what failed, this write also fails, but we still
//      retain the in-memory flag)
//   3. fall back to a raw inngest.send so the business event still flows
//
// On recovery, /api/em/health (or any successful em.publish) calls
// `recoverIfPossible()` which probes dependencies and clears the flag.

import { prisma } from "../db";

let _state: "healthy" | "degraded" | "down" = "healthy";
let _lastError: { message: string; at: Date } | null = null;
let _fallbackCount24h = 0;
let _publishCount24h = 0;
let _rejectCount24h = 0;
let _degradedSince: Date | null = null;

const RESET_WINDOW_MS = 24 * 60 * 60 * 1000;
let _windowStart = Date.now();

function rotateWindow(): void {
  if (Date.now() - _windowStart > RESET_WINDOW_MS) {
    _fallbackCount24h = 0;
    _publishCount24h = 0;
    _rejectCount24h = 0;
    _windowStart = Date.now();
  }
}

export function isDegraded(): boolean {
  return _state !== "healthy";
}

export function getState(): {
  state: "healthy" | "degraded" | "down";
  lastError: { message: string; at: Date } | null;
  fallbackCount24h: number;
  publishCount24h: number;
  rejectCount24h: number;
  degradedSince: Date | null;
} {
  rotateWindow();
  return {
    state: _state,
    lastError: _lastError,
    fallbackCount24h: _fallbackCount24h,
    publishCount24h: _publishCount24h,
    rejectCount24h: _rejectCount24h,
    degradedSince: _degradedSince,
  };
}

export function recordPublish(): void {
  rotateWindow();
  _publishCount24h++;
  void persist();
}

export function recordReject(): void {
  rotateWindow();
  _rejectCount24h++;
  void persist();
}

export function activate(err: Error | string): void {
  const msg = typeof err === "string" ? err : err.message;
  rotateWindow();
  _fallbackCount24h++;
  _lastError = { message: msg, at: new Date() };
  if (_state === "healthy") {
    _state = "degraded";
    _degradedSince = new Date();
  }
  void persist();
}

/** Called by /api/em/health when probes succeed. */
export async function recoverIfPossible(): Promise<boolean> {
  if (_state === "healthy") return true;
  // Self-test: a trivial DB read. If this works the persistence layer is fine.
  try {
    await prisma.emSystemStatus.findUnique({ where: { id: "singleton" } });
    _state = "healthy";
    _degradedSince = null;
    void persist();
    return true;
  } catch {
    return false;
  }
}

async function persist(): Promise<void> {
  try {
    await prisma.emSystemStatus.upsert({
      where: { id: "singleton" },
      create: {
        id: "singleton",
        state: _state,
        degradedSince: _degradedSince,
        lastError: _lastError?.message,
        lastErrorAt: _lastError?.at,
        fallbackCount24h: _fallbackCount24h,
        publishCount24h: _publishCount24h,
        rejectCount24h: _rejectCount24h,
      },
      update: {
        state: _state,
        degradedSince: _degradedSince,
        lastError: _lastError?.message,
        lastErrorAt: _lastError?.at,
        fallbackCount24h: _fallbackCount24h,
        publishCount24h: _publishCount24h,
        rejectCount24h: _rejectCount24h,
      },
    });
  } catch {
    // DB writes fail — that's exactly the case for which we had to keep
    // the in-memory mirror. Silently swallow.
  }
}

/** Test helper — only used by the unit tests. */
export function _resetForTests(): void {
  _state = "healthy";
  _lastError = null;
  _fallbackCount24h = 0;
  _publishCount24h = 0;
  _rejectCount24h = 0;
  _degradedSince = null;
  _windowStart = Date.now();
}
