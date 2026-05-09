"use client";
import * as React from "react";
import type {
  AgentHealth,
  AgentsHealthResponse,
} from "@/app/api/agents/health/route";

export type UseAgentsHealthResult = {
  /** keyed by agent.short. Empty until first poll lands. */
  byShort: Map<string, AgentHealth>;
  /** Same data flat, sorted as the server returned (failed > degraded > running > healthy > idle). */
  agents: AgentHealth[];
  loading: boolean;
  error: string | null;
  fetchedAt: Date | null;
  windowMs: number | null;
};

/**
 * Polls /api/agents/health on `intervalMs`. Used by /workflow to drive
 * node status badges + the Inspector's AgentHealthPanel.
 */
export function useAgentsHealth(intervalMs = 4_000): UseAgentsHealthResult {
  const [agents, setAgents] = React.useState<AgentHealth[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = React.useState<Date | null>(null);
  const [windowMs, setWindowMs] = React.useState<number | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch("/api/agents/health");
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        const j = (await r.json()) as AgentsHealthResponse;
        if (cancelled) return;
        setAgents(j.agents);
        setWindowMs(j.windowMs);
        setError(null);
        setFetchedAt(new Date());
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [intervalMs]);

  const byShort = React.useMemo(() => {
    const m = new Map<string, AgentHealth>();
    for (const a of agents) m.set(a.short, a);
    return m;
  }, [agents]);

  return { byShort, agents, loading, error, fetchedAt, windowMs };
}
