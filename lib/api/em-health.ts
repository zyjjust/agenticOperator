// Hook for /api/em/health — polls every 30 s, returns last good snapshot
// while a refresh is in flight so the UI never blanks.

"use client";
import { useEffect, useState } from "react";
import { fetchJson } from "./client";

export type EmHealthSnapshot = {
  state: "healthy" | "degraded" | "down" | "unconfigured";
  neo4j: {
    configured: boolean;
    uri?: string;
    database?: string;
    reachable: boolean;
    error?: string;
    lastSyncAt: string | null;
    lastError: string | null;
    lastUpserted: number;
  };
  em: {
    state: string;
    degradedSince: string | null;
    lastError: string | null;
    fallbackCount24h: number;
  };
  generatedAt: string;
};

export type UseEmHealthResult = {
  data: EmHealthSnapshot | null;
  loading: boolean;
  error: string | null;
  /** Trigger an immediate refresh (e.g. after manually hitting sync-now). */
  refresh: () => Promise<void>;
  /** POST /api/em/sync-now then refresh. */
  syncNow: () => Promise<void>;
};

const POLL_MS = 30_000;

export function useEmHealth(): UseEmHealthResult {
  const [data, setData] = useState<EmHealthSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const tick = async () => {
    try {
      const r = await fetchJson<EmHealthSnapshot>("/api/em/health", {
        timeoutMs: 10_000,
      });
      setData(r);
      setError(null);
    } catch (e) {
      setError((e as Error)?.message ?? "fetch failed");
    } finally {
      setLoading(false);
    }
  };

  const syncNow = async () => {
    try {
      await fetch("/api/em/sync-now", { method: "POST" });
    } catch {
      // ignore — health refresh below will surface error
    }
    await tick();
  };

  useEffect(() => {
    void tick();
    const id = setInterval(tick, POLL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { data, loading, error, refresh: tick, syncNow };
}
