"use client";
import React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Ic } from "@/components/shared/Ic";
import { Badge, Btn, EmptyState } from "@/components/shared/atoms";
import { fetchJson } from "@/lib/api/client";
import type {
  CorrelationsResponse,
  TimelineEntry,
} from "@/app/api/correlations/[traceId]/route";

export function CorrelationContent({ traceId }: { traceId: string }) {
  const router = useRouter();
  const [data, setData] = React.useState<CorrelationsResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState(traceId);

  const refresh = React.useCallback(
    (id: string) => {
      setLoading(true);
      fetchJson<CorrelationsResponse>(`/api/correlations/${encodeURIComponent(id)}`)
        .then((r) => {
          setData(r);
          setError(null);
        })
        .catch((e) => setError((e as Error).message))
        .finally(() => setLoading(false));
    },
    [],
  );

  React.useEffect(() => {
    refresh(traceId);
  }, [traceId, refresh]);

  const onSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (search && search !== traceId) {
      router.replace(`/correlations/${encodeURIComponent(search.trim())}`);
    } else {
      refresh(search);
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <Header
        traceId={traceId}
        totals={data?.totals}
        search={search}
        setSearch={setSearch}
        onSubmit={onSearch}
        onRefresh={() => refresh(traceId)}
      />
      {loading && !data ? (
        <div className="flex-1 flex items-center justify-center">
          <span className="text-ink-3 text-[12px]">加载中…</span>
        </div>
      ) : error ? (
        <div className="flex-1 flex items-center justify-center">
          <EmptyState
            icon={<Ic.alert />}
            title="加载失败"
            hint={error}
            variant="warn"
            action={<Btn size="sm" onClick={() => refresh(traceId)}>重试</Btn>}
          />
        </div>
      ) : !data || data.timeline.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <EmptyState
            icon={<Ic.search />}
            title="无关联记录"
            hint={`没有任何 AuditLog / EventInstance / WorkflowRun / HumanTask 与 trace_id "${traceId}" 关联。试试 external_event_id、run id 或 EventInstance id。`}
          />
        </div>
      ) : (
        <Timeline entries={data.timeline} />
      )}
    </div>
  );
}

function Header({
  traceId,
  totals,
  search,
  setSearch,
  onSubmit,
  onRefresh,
}: {
  traceId: string;
  totals?: CorrelationsResponse["totals"];
  search: string;
  setSearch: (s: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  onRefresh: () => void;
}) {
  return (
    <div
      className="border-b border-line bg-surface flex items-center"
      style={{ padding: "14px 22px", gap: 18 }}
    >
      <div className="min-w-0">
        <div className="text-[15px] font-semibold tracking-tight">跨系统时间线</div>
        <div className="text-ink-3 text-[12px] mt-px">
          AuditLog · EventInstance · WorkflowRun · HumanTask 按 trace_id 关联
        </div>
      </div>
      <form onSubmit={onSubmit} className="flex items-center gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="trace_id / external_event_id / run id"
          className="h-7 border border-line bg-panel rounded-sm mono text-[11.5px] text-ink-1 outline-none w-[280px]"
          style={{ padding: "0 8px" }}
        />
        <Btn size="sm" type="submit">
          <Ic.search /> 切换
        </Btn>
      </form>
      <div className="flex-1" />
      {totals && (
        <div className="flex gap-3 text-[11px] mono">
          <Counter label="audit" value={totals.auditLog} tone="muted" />
          <Counter label="event" value={totals.eventInstance} tone="ok" />
          <Counter label="run" value={totals.workflowRun} tone="info" />
          <Counter label="hitl" value={totals.humanTask} tone="warn" />
        </div>
      )}
      <Btn size="sm" variant="ghost" onClick={onRefresh}>
        <Ic.bolt /> 刷新
      </Btn>
    </div>
  );
}

function Counter({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "muted" | "ok" | "info" | "warn";
}) {
  const color =
    tone === "ok"
      ? "var(--c-ok)"
      : tone === "info"
        ? "var(--c-info)"
        : tone === "warn"
          ? "var(--c-warn)"
          : "var(--c-ink-3)";
  return (
    <span
      className="px-2 py-0.5 rounded-sm border border-line"
      style={{ color, background: `color-mix(in oklab, ${color} 8%, transparent)` }}
    >
      {label} {value.toLocaleString()}
    </span>
  );
}

function Timeline({ entries }: { entries: TimelineEntry[] }) {
  return (
    <div className="flex-1 overflow-auto" style={{ padding: "16px 22px" }}>
      <ol className="relative" style={{ paddingLeft: 22 }}>
        <span
          className="absolute top-1 bottom-1 left-[6px] w-px"
          style={{ background: "var(--c-line)" }}
          aria-hidden
        />
        {entries.map((e, i) => (
          <TimelineRow key={`${e.source}-${e.refId ?? i}-${e.ts}`} entry={e} />
        ))}
      </ol>
    </div>
  );
}

function TimelineRow({ entry }: { entry: TimelineEntry }) {
  const ts = new Date(entry.ts);
  const time = `${ts.toLocaleDateString(undefined, { month: "2-digit", day: "2-digit" })} ${ts.toLocaleTimeString(undefined, { hour12: false })}`;
  const palette = sourcePalette(entry.source);
  const Body = (
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="mono text-[10.5px] text-ink-3 w-[105px] flex-shrink-0">{time}</span>
        <span
          className="text-[10.5px] mono px-1.5 py-px rounded-sm flex-shrink-0"
          style={{
            color: palette.color,
            background: `color-mix(in oklab, ${palette.color} 12%, transparent)`,
          }}
        >
          {palette.label}
        </span>
        <span className="text-[12px] text-ink-1 truncate">{entry.title}</span>
        <KindBadge kind={entry.kind} />
      </div>
      {entry.detail && (
        <div className="mono text-[10.5px] text-ink-3 mt-0.5" style={{ paddingLeft: 119 }}>
          {entry.detail}
        </div>
      )}
    </div>
  );

  return (
    <li className="relative" style={{ padding: "8px 0" }}>
      <span
        className="absolute left-[-22px] top-3 w-3 h-3 rounded-full grid place-items-center"
        style={{
          background: palette.color,
          boxShadow: `0 0 0 3px color-mix(in oklab, ${palette.color} 18%, transparent)`,
        }}
        aria-hidden
      />
      {entry.link ? (
        <Link href={entry.link} className="flex items-start gap-3 no-underline hover:bg-panel rounded-sm" style={{ padding: 6, margin: -6 }}>
          {Body}
        </Link>
      ) : (
        <div className="flex items-start gap-3" style={{ padding: 6, margin: -6 }}>
          {Body}
        </div>
      )}
    </li>
  );
}

function sourcePalette(s: TimelineEntry["source"]): { color: string; label: string } {
  switch (s) {
    case "audit":
      return { color: "var(--c-ink-3)", label: "audit" };
    case "event_instance":
      return { color: "var(--c-ok)", label: "event" };
    case "workflow_run":
      return { color: "var(--c-info)", label: "run" };
    case "workflow_step":
      return { color: "var(--c-info)", label: "step" };
    case "human_task":
      return { color: "var(--c-warn)", label: "hitl" };
  }
}

function KindBadge({ kind }: { kind: string }) {
  // Compact variant — just the suffix after "rejected_" or "step_" etc.
  const v = kindVariant(kind);
  const short = kind.replace(/^(run_|step_|hitl_)/, "");
  return <Badge variant={v}>{short}</Badge>;
}
function kindVariant(kind: string): "ok" | "warn" | "err" | "info" | "default" {
  if (kind.includes("rejected") || kind.includes("failed") || kind.includes("timed_out")) return "err";
  if (kind.includes("accepted") || kind.includes("completed")) return "ok";
  if (kind.includes("duplicate") || kind.includes("publish")) return "info";
  return "default";
}
