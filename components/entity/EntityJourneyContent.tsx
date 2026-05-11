"use client";
import React from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { fetchJson } from "@/lib/api/client";
import type { EntityType } from "@/lib/entity-types";
import type {
  JourneyResponse,
  JourneyAgentRollup,
} from "@/app/api/entities/[type]/[id]/journey/route";
import type { EntitySummaryResponse } from "@/app/api/entities/[type]/[id]/route";
import { EntityHeader } from "./EntityHeader";
import { EntityTimeline } from "./EntityTimeline";

type Density = "compact" | "full";

export function EntityJourneyContent({
  type,
  id,
}: {
  type: EntityType;
  id: string;
}) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const density: Density = (searchParams.get("density") as Density) ?? "compact";
  const days = clamp(
    Number.parseInt(searchParams.get("days") ?? "", 10) || 30,
    1,
    365,
  );

  const [summary, setSummary] = React.useState<EntitySummaryResponse | null>(null);
  const [journey, setJourney] = React.useState<JourneyResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    Promise.all([
      fetchJson<EntitySummaryResponse>(
        `/api/entities/${encodeURIComponent(type)}/${encodeURIComponent(id)}`,
      ),
      fetchJson<JourneyResponse>(
        `/api/entities/${encodeURIComponent(type)}/${encodeURIComponent(id)}/journey?days=${days}`,
        { timeoutMs: 20_000 },
      ),
    ])
      .then(([s, j]) => {
        if (!alive) return;
        setSummary(s);
        setJourney(j);
      })
      .catch((e) => {
        if (!alive) return;
        setErr((e as Error).message ?? "请求失败");
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [type, id, days]);

  const setQuery = React.useCallback(
    (next: Record<string, string>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [k, v] of Object.entries(next)) {
        if (v) params.set(k, v);
        else params.delete(k);
      }
      router.replace(`${pathname}?${params.toString()}`);
    },
    [searchParams, router, pathname],
  );

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0">
      <EntityHeader
        type={type}
        id={id}
        summary={summary}
        days={days}
        density={density}
        onDaysChange={(d) => setQuery({ days: String(d) })}
        onDensityChange={(d) => setQuery({ density: d })}
      />
      <div className="flex-1 grid min-h-0" style={{ gridTemplateColumns: "240px 1fr" }}>
        <aside className="border-r border-line bg-surface overflow-auto">
          <AgentSidebar agents={journey?.agentSummary ?? []} loading={loading} />
        </aside>
        <main className="overflow-auto bg-panel">
          {err && (
            <div
              className="m-4 border rounded-md text-[12.5px]"
              style={{
                padding: "10px 14px",
                background: "var(--c-warn-bg)",
                borderColor: "color-mix(in oklab, var(--c-warn) 40%, transparent)",
                color: "oklch(0.45 0.14 75)",
              }}
            >
              加载失败：{err}
            </div>
          )}
          {loading && !journey && (
            <div className="p-6 text-ink-3 text-sm">加载历程数据中…</div>
          )}
          {journey && (
            <EntityTimeline
              type={type}
              id={id}
              journey={journey}
              density={density}
            />
          )}
        </main>
      </div>
    </div>
  );
}

function AgentSidebar({
  agents,
  loading,
}: {
  agents: JourneyAgentRollup[];
  loading: boolean;
}) {
  if (loading && agents.length === 0) {
    return <div className="p-3 text-ink-3 text-[12px]">…</div>;
  }
  if (agents.length === 0) {
    return (
      <div className="p-3 text-ink-3 text-[12px]">
        此实体在选定时间窗内无任何 agent 经手记录。
      </div>
    );
  }
  return (
    <div style={{ padding: "12px 10px" }}>
      <div className="text-[10.5px] tracking-[0.06em] uppercase text-ink-4 font-semibold mb-2 px-1">
        经手 agent
      </div>
      <div className="flex flex-col gap-1">
        {agents.map((a) => (
          <div
            key={a.short}
            className="rounded-sm border border-line bg-surface"
            style={{ padding: "6px 8px" }}
          >
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[12px] font-semibold flex-1 truncate">
                {a.short}
              </span>
              {a.errorCount > 0 && (
                <span className="mono text-[9.5px]" style={{ color: "var(--c-err)" }}>
                  {a.errorCount} err
                </span>
              )}
            </div>
            <div className="mono text-[10px] text-ink-3 flex items-center gap-1.5">
              <span>{a.activityCount} 行</span>
              <span>·</span>
              <span>{a.eventEmittedCount} emit</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
