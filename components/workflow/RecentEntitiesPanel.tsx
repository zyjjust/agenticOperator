"use client";
import React from "react";
import Link from "next/link";
import { Badge } from "@/components/shared/atoms";
import { fetchJson } from "@/lib/api/client";
import type {
  RecentEntitiesResponse,
  RecentEntity,
} from "@/app/api/agents/[short]/recent-entities/route";

// Inspector inline panel: most-recent entities (JD / requirement / candidate)
// touched by this agent in the last 7d. Each row links to /entities/:type/:id
// for the full journey (F2). Polls every 30s — slow enough not to hammer
// the DB scan, fast enough to feel live during a demo run.

const POLL_MS = 30_000;

export function RecentEntitiesPanel({ short }: { short: string }) {
  const [data, setData] = React.useState<RecentEntitiesResponse | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    let alive = true;
    setData(null);
    setErr(null);
    const load = async (): Promise<void> => {
      try {
        const r = await fetchJson<RecentEntitiesResponse>(
          `/api/agents/${encodeURIComponent(short)}/recent-entities?limit=5`,
          { timeoutMs: 10_000 },
        );
        if (alive) {
          setData(r);
          setErr(null);
        }
      } catch (e) {
        if (alive) setErr((e as Error).message ?? "失败");
      }
    };
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [short]);

  if (err && !data) {
    return (
      <div className="border-b border-line" style={{ padding: "10px 16px" }}>
        <div className="text-[10.5px] tracking-[0.06em] uppercase text-ink-4 font-semibold mb-1">
          最近实例 · RECENT
        </div>
        <div className="text-[11px]" style={{ color: "var(--c-warn)" }}>
          ⚠ {err}
        </div>
      </div>
    );
  }

  return (
    <div className="border-b border-line" style={{ padding: "10px 16px" }}>
      <div className="flex items-center mb-2">
        <div className="text-[10.5px] tracking-[0.06em] uppercase text-ink-4 font-semibold flex-1">
          最近实例 · RECENT
        </div>
        {data && (
          <span className="mono text-[10px] text-ink-4">
            {data.windowHours}h · 扫 {data.scanned}
          </span>
        )}
      </div>
      {!data && <div className="text-[11px] text-ink-3">加载中…</div>}
      {data && data.entities.length === 0 && (
        <div className="text-[11px] text-ink-3">
          过去 {data.windowHours}h 内此 agent 没有触碰任何已知实体。
        </div>
      )}
      {data && data.entities.length > 0 && (
        <div className="flex flex-col gap-1">
          {data.entities.map((e) => (
            <EntityRow key={`${e.type}:${e.id}`} entity={e} />
          ))}
        </div>
      )}
    </div>
  );
}

function EntityRow({ entity }: { entity: RecentEntity }) {
  const time = new Date(entity.lastSeenAt).toLocaleTimeString(undefined, {
    hour12: false,
  });
  return (
    <Link
      href={`/entities/${entity.type}/${encodeURIComponent(entity.id)}`}
      className="flex items-center gap-2 bg-panel border border-line rounded-sm hover:bg-surface no-underline transition-colors"
      style={{ padding: "5px 8px" }}
    >
      <Badge variant="info" className="text-[9.5px]">
        {entity.typeLabel}
      </Badge>
      <div className="flex-1 min-w-0">
        <div className="text-[12px] text-ink-1 truncate">
          {entity.displayName ?? entity.id}
        </div>
        {entity.displayName && (
          <div className="mono text-[9.5px] text-ink-4 truncate">{entity.id}</div>
        )}
      </div>
      <div className="mono text-[10px] text-ink-3 flex-shrink-0">{time}</div>
      <span className="mono text-[10px] text-ink-4 flex-shrink-0">
        {entity.activityCount}×
      </span>
    </Link>
  );
}
