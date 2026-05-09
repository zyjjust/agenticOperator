"use client";
import React from "react";
import { Ic } from "@/components/shared/Ic";
import { Badge, Btn, EmptyState } from "@/components/shared/atoms";
import { fetchJson } from "@/lib/api/client";
import type {
  TraceResponse,
  TraceBlock,
  AgentLane,
  EventLaneEntry,
} from "@/app/api/runs/[id]/trace/route";

// Real swimlane for one run. Replaces the mock RUN-J2041 swimlane that
// used to live in /live's center area. Each agent has its own lane with
// time-positioned blocks; events are pinned on a separate lane below.
//
// Visual contract (so it's recognisable to anyone who saw the old mock):
//   - Lane height matches old `Swimlane` component
//   - Color groups match LogStream + lifecycle badges
//   - Time axis uses 5 ticks across span
//
// All data is real, all numbers belong to THIS run.

type Props = {
  runId: string;
  /** Polled by parent so multiple consumers share one fetch. Optional. */
  externalData?: TraceResponse | null;
  pollIntervalMs?: number;
};

const ROW_HEIGHT = 36;
const LANE_LABEL_WIDTH = 130;

export function RunTraceTimeline({ runId, externalData, pollIntervalMs = 4000 }: Props) {
  const [data, setData] = React.useState<TraceResponse | null>(externalData ?? null);
  const [loading, setLoading] = React.useState(externalData == null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (externalData !== undefined) {
      // Caller manages the fetch; just mirror it.
      setData(externalData);
      setLoading(externalData == null);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetchJson<TraceResponse>(
          `/api/runs/${encodeURIComponent(runId)}/trace`,
        );
        if (cancelled) return;
        setData(r);
        setError(null);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void tick();
    const id = setInterval(tick, pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [runId, externalData, pollIntervalMs]);

  if (loading && !data) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <span className="text-ink-3 text-[12px]">加载 trace 中…</span>
      </div>
    );
  }
  if (error && !data) {
    return (
      <div style={{ padding: 22 }}>
        <EmptyState
          icon={<Ic.alert />}
          title="加载 trace 失败"
          hint={error}
          variant="warn"
        />
      </div>
    );
  }
  if (!data) {
    return null;
  }

  const hasAnyContent = data.agentLanes.length > 0 || data.eventLane.length > 0;

  return (
    <div className="flex flex-col min-h-0 overflow-auto" style={{ padding: "16px 22px" }}>
      <Stats data={data} />
      {!hasAnyContent ? (
        <div style={{ padding: 24 }}>
          <EmptyState
            icon={<Ic.search />}
            title="这条 run 暂无可绘制的时间线"
            hint="还没有 AgentActivity / WorkflowStep 数据落表。Agent 在做事时应写 AgentActivity 行（参考契约），swimlane 才有内容可画。"
          />
        </div>
      ) : (
        <Swimlane data={data} />
      )}
    </div>
  );
}

// ── Header stats ─────────────────────────────────────────────────────

function Stats({ data }: { data: TraceResponse }) {
  const totalRuns = data.eventLane.reduce((acc, e) => acc + e.inngestRuns.length, 0);
  const totalBlocks = data.agentLanes.reduce((acc, l) => acc + l.blocks.length, 0);
  const totalErrors = data.agentLanes.reduce((acc, l) => acc + l.errorCount, 0);
  return (
    <div className="flex items-center gap-3 mb-3 flex-wrap">
      <div className="text-[10.5px] tracking-[0.06em] uppercase text-ink-4 font-semibold mr-2">
        实例追踪
      </div>
      <Badge variant="info">{data.agentLanes.length} agent lanes</Badge>
      <Badge variant="info">{data.eventLane.length} events</Badge>
      <Badge variant="info">{totalRuns} inngest runs</Badge>
      <Badge variant="default">{totalBlocks} blocks</Badge>
      {totalErrors > 0 && <Badge variant="err">{totalErrors} 异常</Badge>}
      <span className="mono text-[10.5px] text-ink-4">跨度 {formatDuration(data.span.durationMs)}</span>
      {data.meta.eventLookupError && (
        <span className="mono text-[10.5px]" style={{ color: "oklch(0.5 0.14 75)" }}>
          ⚠ Inngest 查询部分失败：{data.meta.eventLookupError}
        </span>
      )}
      {data.meta.raasError && (
        <span title={data.meta.raasError}>
          <Badge variant="warn">RAAS lane: {data.meta.raasError}</Badge>
        </span>
      )}
    </div>
  );
}

// ── Swimlane ─────────────────────────────────────────────────────────

function Swimlane({ data }: { data: TraceResponse }) {
  const span = data.span;
  // Make the trace position computation safe even when start == end (single
  // moment). Use a 1ms floor so percentages don't NaN out.
  const safeDuration = Math.max(1, span.durationMs);
  const pct = (ts: number, dur?: number) => {
    const left = ((ts - span.startMs) / safeDuration) * 100;
    const width = dur != null ? (dur / safeDuration) * 100 : 0;
    return { left, width };
  };

  const ticks = buildTicks(span.startMs, span.endMs);

  return (
    <div className="border border-line rounded-md overflow-hidden bg-surface">
      {/* Time axis */}
      <div
        className="grid border-b border-line bg-panel"
        style={{ gridTemplateColumns: `${LANE_LABEL_WIDTH}px 1fr` }}
      >
        <div
          className="border-r border-line text-[10px] text-ink-4 tracking-[0.06em] uppercase"
          style={{ padding: "6px 12px" }}
        >
          Lane
        </div>
        <div className="relative h-[22px]">
          {ticks.map((tk, i) => (
            <div
              key={i}
              className="absolute text-[10px] text-ink-4 mono"
              style={{ left: `${tk.pct}%`, top: 4, transform: "translateX(-50%)" }}
            >
              {tk.label}
            </div>
          ))}
        </div>
      </div>

      {/* Agent lanes */}
      {data.agentLanes.map((lane) => (
        <LaneRow key={`agent-${lane.agent}`} label={lane.agent} sub={`${lane.blocks.length} block${lane.errorCount > 0 ? ` · ${lane.errorCount} err` : ""}`} tone="agent">
          {lane.blocks.map((b) => (
            <Block key={b.id} block={b} pct={pct(b.ts, b.durationMs)} />
          ))}
        </LaneRow>
      ))}

      {/* Event bus lane */}
      {data.eventLane.length > 0 && (
        <LaneRow
          key="events"
          label="事件总线"
          sub={`${data.eventLane.length} events`}
          tone="event"
        >
          {data.eventLane.map((e) => (
            <EventMarker key={e.eventId} entry={e} pct={pct(e.ts)} />
          ))}
        </LaneRow>
      )}

      {/* RAAS placeholder lanes — surface the eventual location even when
          empty so users know where RAAS data WILL appear. */}
      {data.raasLanes.length === 0 && (
        <LaneRow
          label="RAAS partner"
          sub={data.meta.raasError ? "暂未接通" : "未启用 ?includeRaas=1"}
          tone="raas"
        >
          <div
            className="absolute text-[10.5px] text-ink-4 mono"
            style={{ left: 8, top: 9 }}
          >
            P2 接通后这里展示 RAAS 端 functions 的执行
          </div>
        </LaneRow>
      )}
    </div>
  );
}

function LaneRow({
  label,
  sub,
  tone,
  children,
}: {
  label: string;
  sub?: string;
  tone: "agent" | "event" | "raas";
  children: React.ReactNode;
}) {
  const dotColor =
    tone === "agent" ? "var(--c-ok)" : tone === "event" ? "var(--c-info)" : "var(--c-ink-4)";
  return (
    <div
      className="grid border-b border-line"
      style={{ gridTemplateColumns: `${LANE_LABEL_WIDTH}px 1fr` }}
    >
      <div
        className="border-r border-line bg-panel flex items-center gap-1.5"
        style={{ padding: "0 12px", height: ROW_HEIGHT }}
      >
        <span
          className="w-1.5 h-1.5 rounded-full flex-shrink-0"
          style={{ background: dotColor }}
        />
        <div className="flex-1 min-w-0">
          <div className="text-[11.5px] font-medium text-ink-1 truncate">{label}</div>
          {sub && <div className="mono text-[9.5px] text-ink-4 truncate">{sub}</div>}
        </div>
      </div>
      <div className="relative" style={{ height: ROW_HEIGHT }}>
        {/* Vertical guides at each tick */}
        {[20, 40, 60, 80].map((p) => (
          <div
            key={p}
            className="absolute top-0 bottom-0 w-px bg-line opacity-50"
            style={{ left: `${p}%` }}
          />
        ))}
        {children}
      </div>
    </div>
  );
}

function Block({
  block,
  pct,
}: {
  block: TraceBlock;
  pct: { left: number; width: number };
}) {
  const tone = STATUS_TONE[block.status];
  const minWidth = block.kind === "step" ? 1.5 : 0; // px-equivalent via min-width
  const width = Math.max(pct.width, 0.6);
  const tooltip = [
    `${block.kind} · ${block.label}`,
    block.message ? `\n${block.message}` : "",
    block.durationMs != null ? `\nduration: ${block.durationMs}ms` : "",
    `\nstart: ${new Date(block.ts).toLocaleTimeString(undefined, { hour12: false })}`,
  ].join("");

  return (
    <div
      title={tooltip}
      className="absolute flex items-center mono text-[10px] text-ink-1 whitespace-nowrap overflow-hidden text-ellipsis cursor-help"
      style={{
        left: `${pct.left}%`,
        width: `calc(${width}% - 1px)`,
        minWidth: minWidth ? `${minWidth}px` : undefined,
        top: 5,
        bottom: 5,
        background: tone.bg,
        border: `1px solid ${tone.border}`,
        borderLeft: `3px solid ${tone.accent}`,
        padding: "0 6px",
        borderRadius: 2,
      }}
    >
      {block.label}
    </div>
  );
}

function EventMarker({
  entry,
  pct,
}: {
  entry: EventLaneEntry;
  pct: { left: number; width: number };
}) {
  const runs = entry.inngestRuns.length;
  const tooltip = [
    `event · ${entry.name}`,
    `\nid: ${entry.eventId}`,
    `\nsource: ${entry.source}`,
    `\nat: ${new Date(entry.ts).toLocaleTimeString(undefined, { hour12: false })}`,
    runs > 0 ? `\n${runs} inngest run${runs > 1 ? "s" : ""}:` : "",
    ...entry.inngestRuns.map((r) => `\n  ${r.functionId} · ${r.status}`),
    entry.inngestError ? `\nINNGEST error: ${entry.inngestError}` : "",
  ].join("");
  return (
    <div
      title={tooltip}
      className="absolute flex items-center gap-1 mono text-[9.5px] cursor-help"
      style={{
        left: `${pct.left}%`,
        top: 4,
        bottom: 4,
        transform: "translateX(-50%)",
        padding: "0 4px",
        background: "var(--c-info-bg)",
        border: "1px solid color-mix(in oklab, var(--c-info) 40%, transparent)",
        borderRadius: 3,
        color: "var(--c-info)",
        fontWeight: 600,
      }}
    >
      ▼ {truncate(entry.name, 16)}
      {runs > 0 && <span className="text-ink-3 ml-0.5">·{runs}</span>}
    </div>
  );
}

const STATUS_TONE: Record<
  TraceBlock["status"],
  { bg: string; border: string; accent: string }
> = {
  ok: {
    bg: "color-mix(in oklab, var(--c-accent) 18%, transparent)",
    border: "color-mix(in oklab, var(--c-accent) 30%, transparent)",
    accent: "var(--c-accent)",
  },
  warn: {
    bg: "var(--c-warn-bg)",
    border: "color-mix(in oklab, var(--c-warn) 40%, transparent)",
    accent: "var(--c-warn)",
  },
  err: {
    bg: "var(--c-err-bg)",
    border: "color-mix(in oklab, var(--c-err) 40%, transparent)",
    accent: "var(--c-err)",
  },
  info: {
    bg: "var(--c-info-bg)",
    border: "color-mix(in oklab, var(--c-info) 40%, transparent)",
    accent: "var(--c-info)",
  },
  muted: {
    bg: "var(--c-panel)",
    border: "var(--c-line)",
    accent: "var(--c-ink-3)",
  },
};

// ── Helpers ──────────────────────────────────────────────────────────

function buildTicks(startMs: number, endMs: number): Array<{ pct: number; label: string }> {
  const span = Math.max(1, endMs - startMs);
  const result: Array<{ pct: number; label: string }> = [];
  for (let i = 0; i <= 4; i++) {
    const ts = startMs + (span * i) / 4;
    result.push({
      pct: (i / 4) * 100,
      label: i === 0 ? "0" : formatRelative(ts - startMs),
    });
  }
  return result;
}

function formatRelative(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
  return `${Math.floor(ms / 3_600_000)}h`;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
