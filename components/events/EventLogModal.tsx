"use client";
import React from "react";
import { Ic } from "@/components/shared/Ic";
import { Badge, Btn } from "@/components/shared/atoms";
import {
  classifyEvent,
  lifecycleBadgeVariant,
  LIFECYCLE_HINT,
  LIFECYCLE_LABEL,
  type LifecycleClassification,
} from "@/lib/event-lifecycle";
import { EVENT_CATALOG, kindDot } from "@/lib/events-catalog";
import type { InngestEventRow } from "@/lib/api/inngest-events";
import type { EventRunRow, EventRunsResponse } from "@/app/api/inngest-events/[id]/runs/route";

// Full-screen modal that renders one Inngest event with all the context the
// in-stream row can't fit: lifecycle classification, decoded payload, and
// the function runs that the bus spawned for this event id.
//
// Open via `EventLiveStream` row's "expand" icon. Closes on Esc, on
// overlay click, or via the close button.

type Props = {
  event: InngestEventRow | null;
  onClose: () => void;
};

export function EventLogModal({ event, onClose }: Props) {
  React.useEffect(() => {
    if (!event) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    // Lock body scroll while the modal is up.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [event, onClose]);

  if (!event) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "color-mix(in oklab, black 55%, transparent)",
        zIndex: 50,
        display: "flex",
        alignItems: "stretch",
        justifyContent: "stretch",
        padding: "24px",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-bg border border-line rounded-lg flex flex-col min-h-0 w-full"
        style={{ boxShadow: "0 24px 64px rgba(0,0,0,0.32)" }}
      >
        <Header event={event} onClose={onClose} />
        <Body event={event} />
      </div>
    </div>
  );
}

function Header({ event, onClose }: { event: InngestEventRow; onClose: () => void }) {
  const cls = classifyEvent(event);
  const def = EVENT_CATALOG.find((e) => e.name === event.name);
  const dot = kindDot(def?.kind ?? "domain");
  const ts = event.received_at
    ? new Date(event.received_at)
    : event.ts
      ? new Date(event.ts)
      : null;

  return (
    <div className="border-b border-line bg-surface flex items-start gap-3" style={{ padding: "16px 22px" }}>
      <span
        className="w-2 h-2 rounded-full flex-shrink-0 mt-2"
        style={{
          background: dot,
          boxShadow: `0 0 0 4px color-mix(in oklab, ${dot} 18%, transparent)`,
        }}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap mb-1">
          <span className="mono text-[15px] font-semibold text-ink-1 break-all">{event.name}</span>
          <Badge variant={lifecycleBadgeVariant(cls.lifecycle)} dot>
            {LIFECYCLE_LABEL[cls.lifecycle]}
          </Badge>
          {event._source && event._source !== "local" && (
            <Badge variant="warn">{event._source}</Badge>
          )}
        </div>
        <div className="mono text-[11px] text-ink-3 flex items-center gap-2 flex-wrap">
          <span>id {event.id}</span>
          {event.internal_id && event.internal_id !== event.id && (
            <span>· internal {event.internal_id}</span>
          )}
          {ts && <span>· {ts.toLocaleString(undefined, { hour12: false })}</span>}
        </div>
        <div className="text-[11.5px] text-ink-3 mt-1">{LIFECYCLE_HINT[cls.lifecycle]}</div>
      </div>
      <div className="flex gap-2 flex-shrink-0">
        <Btn size="sm" variant="ghost" onClick={() => copyJson(event)}>
          <Ic.book /> 复制 JSON
        </Btn>
        <Btn size="sm" variant="ghost" onClick={() => downloadJson(event)}>
          <Ic.bookmark /> 下载
        </Btn>
        <Btn size="sm" onClick={onClose}>
          <Ic.cross /> 关闭 (Esc)
        </Btn>
      </div>
    </div>
  );
}

function Body({ event }: { event: InngestEventRow }) {
  const cls = classifyEvent(event);
  return (
    <div
      className="flex-1 grid min-h-0 overflow-hidden"
      style={{ gridTemplateColumns: "1fr 380px" }}
    >
      <div className="overflow-auto" style={{ padding: "16px 22px" }}>
        <Section label="结构化字段">
          <ParsedFields event={event} />
        </Section>
        <Section label="完整 payload (JSON)">
          <PayloadBlock value={event.data} />
        </Section>
        {cls.causedByEventId && (
          <Section label="caused_by 链">
            <a
              href={`/events?subtab=causality&causedByEventId=${encodeURIComponent(cls.causedByEventId)}`}
              className="mono text-[11px] text-ink-2 break-all no-underline hover:text-ink-1"
            >
              ↑ {cls.causedByEventId}
            </a>
          </Section>
        )}
        {cls.referencedEventId && (
          <Section label="run-end 引用的原事件">
            <div className="flex flex-col gap-1">
              {cls.referencedEventName && (
                <span className="mono text-[12px] text-ink-1">{cls.referencedEventName}</span>
              )}
              <span className="mono text-[10.5px] text-ink-3">{cls.referencedEventId}</span>
              {cls.runId && (
                <span className="mono text-[10.5px] text-ink-4">run {cls.runId}</span>
              )}
            </div>
          </Section>
        )}
      </div>
      <aside className="border-l border-line bg-surface overflow-auto" style={{ padding: "16px 22px" }}>
        <SubscriberRuns event={event} cls={cls} />
      </aside>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <div className="text-[10.5px] tracking-[0.06em] uppercase text-ink-4 font-semibold mb-2">
        {label}
      </div>
      {children}
    </div>
  );
}

function ParsedFields({ event }: { event: InngestEventRow }) {
  const data = (event.data ?? {}) as Record<string, unknown>;
  const payload = (data.payload as Record<string, unknown>) ?? {};
  const rows: Array<[string, unknown]> = [];
  const seen = new Set<string>();
  const push = (k: string, v: unknown) => {
    if (v == null || seen.has(k)) return;
    seen.add(k);
    rows.push([k, v]);
  };
  push("entity_type", data.entity_type);
  push("entity_id", data.entity_id);
  push("event_id", data.event_id);
  for (const k of Object.keys(payload)) push(k, payload[k]);

  if (rows.length === 0) {
    return <div className="text-ink-3 text-[11.5px]">— 无可解析字段 —</div>;
  }
  return (
    <table className="tbl mono text-[11px]">
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k}>
            <td className="text-ink-3" style={{ width: 200 }}>{k}</td>
            <td className="text-ink-1 break-all">{formatValue(v)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function formatValue(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function PayloadBlock({ value }: { value: unknown }) {
  const json = React.useMemo(() => safeJson(value), [value]);
  return (
    <pre
      className="mono text-[10.5px] text-ink-2 bg-panel border border-line rounded-md overflow-auto"
      style={{ padding: 12, margin: 0, lineHeight: 1.5, maxHeight: "60vh" }}
    >
      {json}
    </pre>
  );
}

function SubscriberRuns({
  event,
  cls,
}: {
  event: InngestEventRow;
  cls: LifecycleClassification;
}) {
  const [data, setData] = React.useState<EventRunsResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState<string | null>(null);

  // For run-end signal events (inngest/function.finished) we want the
  // runs of the underlying domain event, not of the system event itself.
  const lookupId = cls.referencedEventId ?? event.id;

  const fetchRuns = React.useCallback(() => {
    setLoading(true);
    fetch(`/api/inngest-events/${encodeURIComponent(lookupId)}/runs`)
      .then((r) => r.json())
      .then((j: EventRunsResponse) => {
        setData(j);
        setErr(j.error);
      })
      .catch((e) => setErr((e as Error).message))
      .finally(() => setLoading(false));
  }, [lookupId]);

  React.useEffect(() => {
    fetchRuns();
  }, [fetchRuns]);

  return (
    <div>
      <div className="flex items-center mb-2">
        <div className="text-[12px] font-semibold text-ink-1 flex-1">订阅函数运行</div>
        <Btn size="sm" variant="ghost" onClick={fetchRuns} title="刷新">
          <Ic.bolt />
        </Btn>
      </div>
      <div className="text-[10.5px] text-ink-4 mono mb-3">
        Inngest /v1/events/{lookupId.slice(0, 12)}…/runs
      </div>

      {loading ? (
        <div className="text-ink-3 text-[11.5px]">加载中…</div>
      ) : err ? (
        <div className="text-[11.5px]" style={{ color: "var(--c-warn)" }}>
          ⚠ {err}
        </div>
      ) : !data || data.runs.length === 0 ? (
        <div className="text-ink-3 text-[11.5px] leading-relaxed">
          没有为这条事件记录的函数运行。可能原因：<br />
          · 没有订阅者函数<br />
          · Inngest 还没把 run 写入历史（短延迟，等 1-2s 重试）<br />
          · 这是一条系统事件（inngest/*）
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {data.runs.map((r) => (
            <RunRow key={r.run_id} run={r} />
          ))}
        </div>
      )}
    </div>
  );
}

function RunRow({ run }: { run: EventRunRow }) {
  const status = (run.status ?? "").toLowerCase();
  const variant: "ok" | "warn" | "err" | "info" | "default" =
    status === "completed"
      ? "ok"
      : status === "failed"
        ? "err"
        : status === "cancelled"
          ? "warn"
          : status === "running"
            ? "info"
            : "default";
  const dur =
    run.run_started_at && run.ended_at
      ? formatDuration(
          new Date(run.ended_at).getTime() -
            new Date(run.run_started_at).getTime(),
        )
      : null;
  return (
    <div
      className="border border-line rounded-md bg-panel"
      style={{ padding: "8px 10px" }}
    >
      <div className="flex items-center gap-2 mb-1">
        <Badge variant={variant} dot>
          {run.status || "?"}
        </Badge>
        {dur && <span className="mono text-[10.5px] text-ink-3">{dur}</span>}
      </div>
      <div className="mono text-[11px] text-ink-1 break-all">
        {run.function_id ?? "—"}
      </div>
      <div className="mono text-[10px] text-ink-4 mt-0.5">{run.run_id}</div>
      {run.output != null && (
        <details className="mt-1">
          <summary className="text-[10.5px] text-ink-3 cursor-pointer">output</summary>
          <pre
            className="mono text-[10px] text-ink-2 mt-1 bg-surface border border-line rounded-sm overflow-auto"
            style={{ padding: 6, maxHeight: 160 }}
          >
            {safeJson(run.output)}
          </pre>
        </details>
      )}
    </div>
  );
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function copyJson(event: InngestEventRow): void {
  try {
    void navigator.clipboard.writeText(safeJson(event));
  } catch {
    /* ignore */
  }
}

function downloadJson(event: InngestEventRow): void {
  try {
    const blob = new Blob([safeJson(event)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${event.name}-${event.id}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    /* ignore */
  }
}
