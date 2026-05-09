"use client";
import React from "react";
import Link from "next/link";
import { Ic } from "./Ic";
import { Badge, Btn, EmptyState } from "./atoms";
import { fetchJson } from "@/lib/api/client";
import type {
  ActivityResponse,
  LogEntry,
  LogKind,
} from "@/lib/api/activity-types";

// Reusable activity-log viewer.
//
// Drop in anywhere we want to surface AgentActivity as a Palantir-style
// log stream. Same component serves /workflow Inspector (per-agent,
// cross-run, "recent first") and /live Run detail (per-run, one timeline,
// "oldest first") — only `endpoint` and `order` differ.

const ALL_KINDS: LogKind[] = [
  "step.started",
  "step.completed",
  "step.failed",
  "step.retrying",
  "tool",
  "decision",
  "anomaly",
  "narrative",
  "error",
  "hitl",
  "info",
];

const KIND_GROUPS: Array<{ id: string; label: string; kinds: LogKind[] }> = [
  { id: "all", label: "全部", kinds: ALL_KINDS },
  { id: "decisions", label: "决策", kinds: ["decision"] },
  { id: "tools", label: "工具", kinds: ["tool"] },
  { id: "errors", label: "异常", kinds: ["anomaly", "error", "step.failed"] },
  { id: "lifecycle", label: "生命周期", kinds: ["step.started", "step.completed", "step.retrying"] },
  { id: "hitl", label: "人工", kinds: ["hitl"] },
];

type Props = {
  /** Backend endpoint that returns ActivityResponse. */
  endpoint: string;
  /** "asc" for run timeline (oldest first); "desc" for cross-run feed (newest first). */
  order?: "asc" | "desc";
  /** Hide the agent column when the scope is already a single agent. */
  hideAgent?: boolean;
  /** Auto-refresh interval. 0 to disable polling. Default 3000. */
  pollIntervalMs?: number;
  /** Compact rendering (smaller padding/text) for narrow inspectors. */
  compact?: boolean;
  /** Custom empty hint for the scope. */
  emptyHint?: string;
};

export function LogStream({
  endpoint,
  order = "asc",
  hideAgent = false,
  pollIntervalMs = 3000,
  compact = false,
  emptyHint,
}: Props) {
  const [data, setData] = React.useState<ActivityResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState<string | null>(null);
  const [groupId, setGroupId] = React.useState<string>("all");
  const [search, setSearch] = React.useState("");
  const [paused, setPaused] = React.useState(false);
  const [autoScroll, setAutoScroll] = React.useState(order === "asc");
  const scrollRef = React.useRef<HTMLDivElement | null>(null);

  const refresh = React.useCallback(() => {
    fetchJson<ActivityResponse>(endpoint)
      .then((r) => {
        setData(r);
        setErr(null);
      })
      .catch((e) => setErr((e as Error).message))
      .finally(() => setLoading(false));
  }, [endpoint]);

  React.useEffect(() => {
    setLoading(true);
    refresh();
  }, [refresh]);

  React.useEffect(() => {
    if (paused || pollIntervalMs <= 0) return;
    const id = setInterval(refresh, pollIntervalMs);
    return () => clearInterval(id);
  }, [paused, pollIntervalMs, refresh]);

  // Auto-scroll to newest when in asc/tail mode and user hasn't disabled it.
  React.useEffect(() => {
    if (!autoScroll || order !== "asc" || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [data, autoScroll, order]);

  const allowed = React.useMemo(() => {
    const g = KIND_GROUPS.find((x) => x.id === groupId) ?? KIND_GROUPS[0];
    return new Set<LogKind>(g.kinds);
  }, [groupId]);

  const visibleEntries = React.useMemo(() => {
    if (!data) return [] as LogEntry[];
    const q = search.trim().toLowerCase();
    return data.entries.filter((e) => {
      if (!allowed.has(e.kind)) return false;
      if (!q) return true;
      return (
        e.message.toLowerCase().includes(q) ||
        e.agent.toLowerCase().includes(q) ||
        (e.runId ?? "").toLowerCase().includes(q)
      );
    });
  }, [data, allowed, search]);

  return (
    <div className="flex flex-col min-h-0 h-full">
      <Toolbar
        groupId={groupId}
        setGroupId={setGroupId}
        search={search}
        setSearch={setSearch}
        paused={paused}
        setPaused={setPaused}
        autoScroll={autoScroll}
        setAutoScroll={setAutoScroll}
        order={order}
        compact={compact}
        loading={loading}
      />
      {err ? (
        <div
          className="border-t border-line mono"
          style={{
            padding: compact ? "8px 10px" : "10px 14px",
            background: "var(--c-warn-bg)",
            color: "oklch(0.5 0.14 75)",
            fontSize: compact ? 10.5 : 11.5,
          }}
        >
          ⚠ {err}
        </div>
      ) : null}
      <div
        ref={scrollRef}
        className="flex-1 overflow-auto min-h-0"
        style={{ background: "var(--c-bg)" }}
      >
        {loading && !data ? (
          <div
            className="text-ink-3"
            style={{ padding: 18, textAlign: "center", fontSize: 11.5 }}
          >
            加载日志中…
          </div>
        ) : visibleEntries.length === 0 ? (
          <div style={{ padding: compact ? 16 : 24 }}>
            <EmptyState
              icon={<Ic.search />}
              title={
                search || groupId !== "all"
                  ? "无匹配日志"
                  : "暂无活动日志"
              }
              hint={
                search || groupId !== "all"
                  ? "尝试清空过滤条件"
                  : emptyHint ??
                    "Agent 在这一作用域下还没写入 AgentActivity 行。日志契约：每个 agent 在做有意义的事时（开始/完成 step、调用工具、决策、异常）应写一条 AgentActivity。"
              }
            />
          </div>
        ) : (
          <ol className="flex flex-col" style={{ margin: 0, padding: 0, listStyle: "none" }}>
            {visibleEntries.map((e, i) => (
              <LogRow
                key={e.id}
                entry={e}
                hideAgent={hideAgent}
                compact={compact}
                isFresh={
                  data != null &&
                  i === visibleEntries.length - 1 &&
                  order === "asc" &&
                  Date.now() - new Date(e.ts).getTime() < 5_000
                }
              />
            ))}
          </ol>
        )}
      </div>
      <Footer
        total={data?.total ?? data?.entries.length ?? 0}
        shown={visibleEntries.length}
        compact={compact}
        fetchedAt={data?.fetchedAt}
      />
    </div>
  );
}

// ── Toolbar ──────────────────────────────────────────────────────────────

function Toolbar({
  groupId,
  setGroupId,
  search,
  setSearch,
  paused,
  setPaused,
  autoScroll,
  setAutoScroll,
  order,
  compact,
  loading,
}: {
  groupId: string;
  setGroupId: (s: string) => void;
  search: string;
  setSearch: (s: string) => void;
  paused: boolean;
  setPaused: (v: boolean) => void;
  autoScroll: boolean;
  setAutoScroll: (v: boolean) => void;
  order: "asc" | "desc";
  compact: boolean;
  loading: boolean;
}) {
  return (
    <div
      className="border-b border-line bg-surface flex flex-col gap-1.5"
      style={{ padding: compact ? "6px 10px" : "8px 12px" }}
    >
      <div className="flex items-center gap-1.5">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索 message / agent / runId…"
          className="flex-1 border border-line bg-panel rounded-sm mono text-ink-1 outline-none"
          style={{
            height: compact ? 22 : 26,
            padding: "0 8px",
            fontSize: compact ? 10.5 : 11.5,
          }}
        />
        <Btn
          size="sm"
          variant={paused ? "default" : "ghost"}
          onClick={() => setPaused(!paused)}
          title={paused ? "恢复轮询" : "暂停轮询"}
          style={{ padding: "0 6px" }}
        >
          {paused ? <Ic.play /> : <Ic.pause />}
        </Btn>
        {order === "asc" && (
          <Btn
            size="sm"
            variant={autoScroll ? "default" : "ghost"}
            onClick={() => setAutoScroll(!autoScroll)}
            title="跟随最新"
            style={{ padding: "0 6px" }}
          >
            <Ic.arrowR />
          </Btn>
        )}
        <Badge variant={loading ? "info" : paused ? "default" : "ok"} dot pulse={!paused && !loading}>
          {paused ? "paused" : loading ? "loading" : "live"}
        </Badge>
      </div>
      <div className="flex flex-wrap gap-1">
        {KIND_GROUPS.map((g) => {
          const active = groupId === g.id;
          return (
            <button
              key={g.id}
              onClick={() => setGroupId(g.id)}
              className="bg-transparent border cursor-pointer mono rounded-sm transition-colors"
              style={{
                padding: "1px 6px",
                fontSize: compact ? 9.5 : 10,
                borderColor: active ? "var(--c-accent)" : "var(--c-line)",
                background: active ? "var(--c-accent-bg)" : "var(--c-panel)",
                color: active ? "var(--c-accent)" : "var(--c-ink-2)",
                fontWeight: active ? 600 : 500,
              }}
            >
              {g.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Row ──────────────────────────────────────────────────────────────────

const KIND_TONE: Record<LogKind, { color: string; label: string }> = {
  "step.started": { color: "var(--c-info)", label: "▶ start" },
  "step.completed": { color: "var(--c-ok)", label: "✓ done" },
  "step.failed": { color: "var(--c-err)", label: "✗ fail" },
  "step.retrying": { color: "oklch(0.5 0.14 75)", label: "↻ retry" },
  narrative: { color: "var(--c-ink-2)", label: "·  log" },
  tool: { color: "var(--c-info)", label: "→ tool" },
  decision: { color: "var(--c-accent)", label: "★ decide" },
  anomaly: { color: "oklch(0.5 0.14 75)", label: "⚠ anomaly" },
  error: { color: "var(--c-err)", label: "✗ error" },
  hitl: { color: "oklch(0.5 0.14 75)", label: "✋ hitl" },
  info: { color: "var(--c-ink-3)", label: "i  info" },
};

function LogRow({
  entry,
  hideAgent,
  compact,
  isFresh,
}: {
  entry: LogEntry;
  hideAgent: boolean;
  compact: boolean;
  isFresh: boolean;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const tone = KIND_TONE[entry.kind] ?? KIND_TONE.info;
  const ts = new Date(entry.ts);
  const time =
    ts.toLocaleTimeString(undefined, { hour12: false }) +
    "." +
    String(ts.getMilliseconds()).padStart(3, "0");
  const date = ts.toLocaleDateString(undefined, { month: "2-digit", day: "2-digit" });
  const hasMeta = entry.metadata && Object.keys(entry.metadata).length > 0;
  const hasRun = !!entry.runId;
  const expandable = hasMeta;

  return (
    <li
      onClick={() => expandable && setExpanded((v) => !v)}
      className="border-b border-line transition-colors"
      style={{
        padding: compact ? "4px 10px" : "6px 12px",
        cursor: expandable ? "pointer" : "default",
        background: isFresh
          ? "color-mix(in oklab, var(--c-accent) 8%, transparent)"
          : undefined,
      }}
    >
      <div className="flex items-start gap-2">
        <span
          className="mono flex-shrink-0"
          style={{
            fontSize: compact ? 9.5 : 10,
            color: "var(--c-ink-4)",
            width: compact ? 76 : 88,
            paddingTop: 1,
          }}
          title={ts.toLocaleString(undefined, { hour12: false })}
        >
          {compact ? time : `${date} ${time}`}
        </span>
        <span
          className="mono flex-shrink-0"
          style={{
            fontSize: compact ? 9.5 : 10,
            color: tone.color,
            width: 56,
            paddingTop: 1,
            fontWeight: 600,
          }}
        >
          {tone.label}
        </span>
        {!hideAgent && (
          <span
            className="mono flex-shrink-0"
            style={{
              fontSize: compact ? 10 : 11,
              color: "var(--c-ink-1)",
              width: compact ? 88 : 110,
              paddingTop: 1,
              fontWeight: 600,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={entry.agent}
          >
            {entry.agent}
          </span>
        )}
        <div
          className="flex-1 min-w-0"
          style={{
            fontSize: compact ? 11 : 12,
            lineHeight: 1.45,
            color: "var(--c-ink-1)",
          }}
        >
          {entry.message}
          {hasRun && hideAgent === false && entry.runId && (
            <Link
              href={`/live?run=${encodeURIComponent(entry.runId)}`}
              className="mono text-ink-4 ml-2 no-underline hover:text-ink-1"
              style={{ fontSize: compact ? 9 : 10 }}
              onClick={(e) => e.stopPropagation()}
            >
              run {entry.runId.slice(0, 8)}…
            </Link>
          )}
        </div>
        {expandable && (
          <span
            className="mono flex-shrink-0 text-ink-4"
            style={{ fontSize: 10, paddingTop: 1 }}
          >
            {expanded ? "▾" : "▸"}
          </span>
        )}
      </div>
      {expanded && hasMeta && (
        <pre
          className="mono mt-1.5 rounded-sm overflow-auto"
          style={{
            padding: 6,
            marginLeft: compact ? 142 : 168,
            fontSize: compact ? 9.5 : 10,
            maxHeight: 180,
            background: "var(--c-panel)",
            border: "1px solid var(--c-line)",
            color: "var(--c-ink-2)",
            lineHeight: 1.4,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {safeJson(entry.metadata)}
        </pre>
      )}
    </li>
  );
}

function Footer({
  total,
  shown,
  compact,
  fetchedAt,
}: {
  total: number;
  shown: number;
  compact: boolean;
  fetchedAt?: string;
}) {
  return (
    <div
      className="border-t border-line bg-surface flex items-center text-ink-4 mono"
      style={{ padding: compact ? "4px 10px" : "6px 12px", fontSize: compact ? 9.5 : 10.5 }}
    >
      <span>
        {shown} / {total} 行
      </span>
      <div className="flex-1" />
      {fetchedAt && (
        <span>
          {new Date(fetchedAt).toLocaleTimeString(undefined, { hour12: false })}
        </span>
      )}
    </div>
  );
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
