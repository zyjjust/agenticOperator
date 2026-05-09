"use client";
import React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Ic } from "@/components/shared/Ic";
import { Badge, Btn, EmptyState } from "@/components/shared/atoms";
import { fetchJson } from "@/lib/api/client";
import type { RunsResponse, RunSummary } from "@/lib/api/types";
import { AGENT_MAP } from "@/lib/agent-mapping";
import { RunSummaryModal } from "./RunSummaryModal";
import { RealRunCenter, RealRunRight } from "./RealRunDetail";

// /live — the run inspection surface.
//
// Job: "show me what happened in that run." Nothing else.
// Removed (2026-05-09):
//   - Mock RUN-J2041 swimlane / decisions / trace / anomaly cards. Those
//     were lying — they didn't move when you clicked a different run, and
//     they mixed system-level and run-level semantics.
//   - System-wide indicators. /overview is the home for those.
//
// Selection model:
//   - URL state is the source of truth (?run=, ?status=, ?agent=, etc.)
//     so a filtered view is bookmarkable and shareable.
//   - When no run is selected, center+right show "select a run".

const STATUS_GROUPS: Array<{ id: string; label: string; statuses: string[] }> = [
  { id: "all", label: "全部", statuses: [] },
  { id: "active", label: "运行中", statuses: ["running", "paused", "suspended"] },
  { id: "completed", label: "已完成", statuses: ["completed"] },
  { id: "failed", label: "失败", statuses: ["failed", "timed_out", "interrupted"] },
];

const TIME_OPTIONS: Array<{ id: string; label: string; sinceMs: number | null }> = [
  { id: "1h", label: "1h", sinceMs: 60 * 60 * 1000 },
  { id: "24h", label: "24h", sinceMs: 24 * 60 * 60 * 1000 },
  { id: "7d", label: "7d", sinceMs: 7 * 24 * 60 * 60 * 1000 },
  { id: "all", label: "全部", sinceMs: null },
];

type RunRow = {
  id: string;
  jobLabel: string;
  startedLabel: string;
  durLabel: string;
  status: RunSummary["status"];
  pendingHitl: number;
  hasError: boolean;
  raw: RunSummary;
};

export function LiveContent() {
  const router = useRouter();
  const sp = useSearchParams();

  // ── URL state ─────────────────────────────────────────────────────
  const selectedRunId = sp.get("run") ?? null;
  const statusGroup = sp.get("status") ?? "all";
  const timeId = sp.get("time") ?? "24h";
  const agentParam = sp.get("agent") ?? "";
  const selectedAgents = agentParam ? agentParam.split(",").filter(Boolean) : [];
  const hasErrorFilter = sp.get("hasError") === "1";
  const hasHitlFilter = sp.get("hasHitl") === "1";

  const setUrl = React.useCallback(
    (mut: (params: URLSearchParams) => void) => {
      const next = new URLSearchParams(sp.toString());
      mut(next);
      router.replace(`/live${next.toString() ? `?${next.toString()}` : ""}`);
    },
    [router, sp],
  );

  const selectRun = React.useCallback(
    (id: string | null) => {
      setUrl((p) => {
        if (id) p.set("run", id);
        else p.delete("run");
      });
    },
    [setUrl],
  );

  // ── Run list fetch ────────────────────────────────────────────────
  const [runs, setRuns] = React.useState<RunRow[] | null>(null);
  const [total, setTotal] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [summaryRun, setSummaryRun] = React.useState<{ id: string; job: string } | null>(null);

  const refresh = React.useCallback(async () => {
    const qs = new URLSearchParams();
    qs.set("limit", "30");
    const group = STATUS_GROUPS.find((g) => g.id === statusGroup);
    if (group && group.statuses.length > 0) {
      qs.set("status", group.statuses.join(","));
    }
    const timeOpt = TIME_OPTIONS.find((t) => t.id === timeId);
    if (timeOpt?.sinceMs) {
      qs.set("since", new Date(Date.now() - timeOpt.sinceMs).toISOString());
    }
    if (selectedAgents.length > 0) {
      qs.set("agent", selectedAgents.join(","));
    }
    if (hasErrorFilter) qs.set("hasError", "1");
    if (hasHitlFilter) qs.set("hasHitl", "1");
    try {
      const r = await fetchJson<RunsResponse>(`/api/runs?${qs.toString()}`);
      setRuns(r.runs.map(toRow));
      setTotal(r.total);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [statusGroup, timeId, agentParam, hasErrorFilter, hasHitlFilter]);
  // (agentParam is the encoded form so the dep array doesn't churn on
  // every render even when selectedAgents content is unchanged.)

  React.useEffect(() => {
    void refresh();
    const id = setInterval(refresh, 5_000);
    return () => clearInterval(id);
  }, [refresh]);

  const selected = runs?.find((r) => r.id === selectedRunId) ?? null;

  return (
    <>
      <div className="flex-1 grid min-h-0" style={{ gridTemplateColumns: "300px 1fr 320px" }}>
        {/* Left: filter bar + run list */}
        <aside className="border-r border-line bg-surface flex flex-col min-h-0">
          <FilterBar
            statusGroup={statusGroup}
            timeId={timeId}
            selectedAgents={selectedAgents}
            hasErrorFilter={hasErrorFilter}
            hasHitlFilter={hasHitlFilter}
            setUrl={setUrl}
            shown={runs?.length ?? 0}
            total={total}
            onRefresh={refresh}
          />
          <RunList
            runs={runs}
            error={error}
            selectedRunId={selectedRunId}
            onSelect={(id) => selectRun(id)}
            onShowSummary={(id, job) => setSummaryRun({ id, job })}
          />
        </aside>

        {/* Center: real run detail OR empty state */}
        {selected ? (
          <RealRunCenter
            runId={selected.id}
            jobLabel={selected.jobLabel}
            onClear={() => selectRun(null)}
          />
        ) : (
          <CenterEmpty hasRuns={!!runs && runs.length > 0} />
        )}

        {/* Right: linked objects OR placeholder */}
        {selected ? (
          <RealRunRight
            runId={selected.id}
            onShowSummaryModal={() => setSummaryRun({ id: selected.id, job: selected.jobLabel })}
          />
        ) : (
          <RightEmpty />
        )}
      </div>
      <RunSummaryModal
        runId={summaryRun?.id ?? null}
        jobLabel={summaryRun?.job ?? null}
        onClose={() => setSummaryRun(null)}
      />
    </>
  );
}

// ── Row mapping ──────────────────────────────────────────────────────

function toRow(r: RunSummary): RunRow {
  // triggerData often comes through with placeholder "—" values for runs
  // that didn't carry client/jdId in their trigger envelope. Build a
  // useful headline regardless: prefer real entity, fall back to event
  // name + run id suffix so cards never look like "—  ·  —".
  const hasClient = r.triggerData.client && r.triggerData.client !== "—";
  const hasJd = r.triggerData.jdId && r.triggerData.jdId !== "—";
  let jobLabel: string;
  if (hasClient && hasJd) {
    jobLabel = `${r.triggerData.client} · ${r.triggerData.jdId}`;
  } else if (hasClient) {
    jobLabel = r.triggerData.client;
  } else if (hasJd) {
    jobLabel = r.triggerData.jdId;
  } else {
    // Truly anonymous run — surface the trigger name so you can tell rows
    // apart even when entity context is missing.
    jobLabel = `${r.triggerEvent} · ${r.id.slice(-6)}`;
  }
  return {
    id: r.id,
    jobLabel,
    startedLabel: shortStart(r.startedAt),
    durLabel: shortDuration(r),
    status: r.status,
    pendingHitl: r.pendingHumanTasks,
    hasError:
      r.status === "failed" ||
      r.status === "timed_out" ||
      r.status === "interrupted",
    raw: r,
  };
}

function shortStart(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function shortDuration(r: RunSummary): string {
  const start = new Date(r.startedAt).getTime();
  const end = r.completedAt
    ? new Date(r.completedAt).getTime()
    : new Date(r.lastActivityAt).getTime();
  const ms = Math.max(0, end - start);
  const s = Math.floor(ms / 1000);
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

// ── Filter bar ───────────────────────────────────────────────────────

function FilterBar({
  statusGroup,
  timeId,
  selectedAgents,
  hasErrorFilter,
  hasHitlFilter,
  setUrl,
  shown,
  total,
  onRefresh,
}: {
  statusGroup: string;
  timeId: string;
  selectedAgents: string[];
  hasErrorFilter: boolean;
  hasHitlFilter: boolean;
  setUrl: (mut: (p: URLSearchParams) => void) => void;
  shown: number;
  total: number | null;
  onRefresh: () => void;
}) {
  return (
    <div className="border-b border-line" style={{ padding: "10px 12px" }}>
      <div className="flex items-center gap-2 mb-2">
        <div className="text-[13px] font-semibold flex-1">运行记录</div>
        <Btn size="sm" variant="ghost" onClick={onRefresh} title="刷新" style={{ padding: "0 6px" }}>
          <Ic.bolt />
        </Btn>
      </div>

      {/* Status group */}
      <Row label="状态">
        {STATUS_GROUPS.map((g) => (
          <Chip
            key={g.id}
            active={statusGroup === g.id}
            onClick={() =>
              setUrl((p) => {
                if (g.id === "all") p.delete("status");
                else p.set("status", g.id);
              })
            }
          >
            {g.label}
          </Chip>
        ))}
      </Row>

      {/* Time range */}
      <Row label="时间">
        {TIME_OPTIONS.map((t) => (
          <Chip
            key={t.id}
            active={timeId === t.id}
            onClick={() =>
              setUrl((p) => {
                if (t.id === "24h") p.delete("time");
                else p.set("time", t.id);
              })
            }
          >
            {t.label}
          </Chip>
        ))}
      </Row>

      {/* Toggles */}
      <Row label="标记">
        <Chip
          active={hasErrorFilter}
          onClick={() =>
            setUrl((p) => {
              if (hasErrorFilter) p.delete("hasError");
              else p.set("hasError", "1");
            })
          }
        >
          有错误
        </Chip>
        <Chip
          active={hasHitlFilter}
          onClick={() =>
            setUrl((p) => {
              if (hasHitlFilter) p.delete("hasHitl");
              else p.set("hasHitl", "1");
            })
          }
        >
          待人工
        </Chip>
      </Row>

      {/* Agent multi-select (compact) */}
      <AgentPicker
        selected={selectedAgents}
        onToggle={(short) =>
          setUrl((p) => {
            const next = new Set(selectedAgents);
            if (next.has(short)) next.delete(short);
            else next.add(short);
            const v = Array.from(next).join(",");
            if (v) p.set("agent", v);
            else p.delete("agent");
          })
        }
        onClear={() => setUrl((p) => p.delete("agent"))}
      />

      <div className="mono text-[10px] text-ink-4 mt-2 flex items-center">
        <span>{shown} 条{total != null && total !== shown && ` / 总 ${total}`}</span>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 mb-1.5">
      <div
        className="mono text-[10px] text-ink-4 uppercase tracking-[0.06em]"
        style={{ width: 36, paddingTop: 2, flexShrink: 0 }}
      >
        {label}
      </div>
      <div className="flex flex-wrap gap-1 flex-1 min-w-0">{children}</div>
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="bg-transparent border cursor-pointer mono rounded-sm transition-colors"
      style={{
        padding: "1px 7px",
        fontSize: 10.5,
        borderColor: active ? "var(--c-accent)" : "var(--c-line)",
        background: active ? "var(--c-accent-bg)" : "var(--c-panel)",
        color: active ? "var(--c-accent)" : "var(--c-ink-2)",
        fontWeight: active ? 600 : 500,
      }}
    >
      {children}
    </button>
  );
}

function AgentPicker({
  selected,
  onToggle,
  onClear,
}: {
  selected: string[];
  onToggle: (short: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const label =
    selected.length === 0
      ? "全部 agent"
      : selected.length === 1
        ? selected[0]
        : `${selected[0]} +${selected.length - 1}`;
  return (
    <div className="flex items-start gap-2 mb-1.5">
      <div
        className="mono text-[10px] text-ink-4 uppercase tracking-[0.06em]"
        style={{ width: 36, paddingTop: 2, flexShrink: 0 }}
      >
        Agent
      </div>
      <div className="flex-1 min-w-0">
        <button
          onClick={() => setOpen((v) => !v)}
          className="bg-panel border border-line text-ink-1 cursor-pointer mono rounded-sm w-full text-left"
          style={{ padding: "2px 7px", fontSize: 10.5, height: 22 }}
        >
          {label}{" "}
          <span className="text-ink-4">{open ? "▴" : "▾"}</span>
          {selected.length > 0 && (
            <span
              className="ml-1 text-ink-3 hover:text-ink-1"
              onClick={(e) => {
                e.stopPropagation();
                onClear();
              }}
              title="清空 agent 过滤"
            >
              ✕
            </span>
          )}
        </button>
        {open && (
          <div
            className="mt-1 border border-line rounded-sm bg-surface overflow-auto"
            style={{ maxHeight: 220, padding: "4px 4px" }}
          >
            {AGENT_MAP.map((a) => {
              const active = selected.includes(a.short);
              return (
                <button
                  key={a.short}
                  onClick={() => onToggle(a.short)}
                  className="w-full bg-transparent border-0 cursor-pointer text-left mono"
                  style={{
                    padding: "3px 6px",
                    fontSize: 10.5,
                    color: active ? "var(--c-accent)" : "var(--c-ink-2)",
                    fontWeight: active ? 600 : 500,
                    background: active ? "var(--c-accent-bg)" : "transparent",
                    borderRadius: 2,
                  }}
                >
                  {active ? "✓ " : "  "}
                  {a.short}
                  <span className="ml-1 text-ink-4">· {a.stage}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Run list ─────────────────────────────────────────────────────────

function RunList({
  runs,
  error,
  selectedRunId,
  onSelect,
  onShowSummary,
}: {
  runs: RunRow[] | null;
  error: string | null;
  selectedRunId: string | null;
  onSelect: (id: string) => void;
  onShowSummary: (id: string, job: string) => void;
}) {
  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <EmptyState
          icon={<Ic.alert />}
          title="加载失败"
          hint={error}
          variant="warn"
        />
      </div>
    );
  }
  if (!runs) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <span className="text-ink-3 text-[12px]">加载中…</span>
      </div>
    );
  }
  if (runs.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <EmptyState
          icon={<Ic.search />}
          title="无匹配 run"
          hint="尝试放宽过滤条件，或等下一条触发事件"
        />
      </div>
    );
  }
  return (
    <div className="flex-1 overflow-auto" style={{ padding: "8px 10px" }}>
      <div className="flex flex-col gap-2">
        {runs.map((r) => {
          const isSelected = r.id === selectedRunId;
          return (
            <RunCard
              key={r.id}
              row={r}
              selected={isSelected}
              onClick={() => onSelect(r.id)}
              onAi={() => onShowSummary(r.id, r.jobLabel)}
            />
          );
        })}
      </div>
    </div>
  );
}

// Card-style run row. Entity context (client / JD) is the headline; the
// run id is footnote material. This matches the "run is just one
// instance of (candidate × JD)" mental model — the entity is what people
// reason about, not the cuid.
function RunCard({
  row,
  selected,
  onClick,
  onAi,
}: {
  row: RunRow;
  selected: boolean;
  onClick: () => void;
  onAi: () => void;
}) {
  const tone =
    row.status === "completed"
      ? { color: "var(--c-ok)", label: "completed" }
      : row.status === "failed" || row.status === "timed_out" || row.status === "interrupted"
        ? { color: "var(--c-err)", label: row.status }
        : row.status === "suspended" || row.status === "paused"
          ? { color: "var(--c-warn)", label: row.status }
          : { color: "var(--c-accent)", label: row.status };
  const [client, jd] = splitJobLabel(row.jobLabel);
  return (
    <div
      onClick={onClick}
      className="cursor-pointer border rounded-md transition-colors"
      style={{
        padding: "10px 12px",
        background: selected ? "var(--c-accent-bg)" : "var(--c-surface)",
        borderColor: selected ? "var(--c-accent)" : "var(--c-line)",
      }}
    >
      <div className="flex items-center gap-1.5 mb-1.5">
        <span
          className="w-1.5 h-1.5 rounded-full flex-shrink-0"
          style={{
            background: tone.color,
            boxShadow: `0 0 0 3px color-mix(in oklab, ${tone.color} 18%, transparent)`,
          }}
        />
        <span
          className="mono text-[10px] uppercase tracking-[0.06em] font-semibold"
          style={{ color: tone.color }}
        >
          {tone.label}
        </span>
        <span className="mono text-[10.5px] text-ink-3">
          {row.startedLabel} · {row.durLabel}
        </span>
        <div className="flex-1" />
        {row.pendingHitl > 0 && <Badge variant="warn">{row.pendingHitl} 人工</Badge>}
      </div>
      <div className="text-[12.5px] font-medium text-ink-1 leading-snug mb-1">
        {client}
      </div>
      {(jd || (client && client !== "—")) && (
        <div className="flex items-center gap-1 flex-wrap mb-1">
          {jd && <EntityChip label={jd} kind="jd" />}
          {client && client !== "—" && <EntityChip label={client} kind="client" />}
          {!jd && !(client && client !== "—") && (
            <span className="mono text-[10px] text-ink-4">无 entity 上下文</span>
          )}
        </div>
      )}
      {/* When triggerData is empty, surface trigger event so the card carries
          useful info instead of looking blank. raw.triggerEvent is always set. */}
      {!jd && (!client || client === "—") && (
        <div className="mono text-[10.5px] text-ink-3 mb-1">
          trigger · {row.raw.triggerEvent}
        </div>
      )}
      <div className="flex items-center gap-2">
        <span
          className="mono text-[9.5px] text-ink-4 truncate flex-1"
          title={row.id}
        >
          {row.id.length > 24 ? row.id.slice(0, 24) + "…" : row.id}
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onAi();
          }}
          title="AI 总结这次运行"
          className="bg-transparent border border-line rounded-sm cursor-pointer mono text-[10px] text-ink-2 hover:text-ink-1 hover:border-line-strong"
          style={{ padding: "1px 6px" }}
        >
          <span style={{ color: "var(--c-accent)" }}>✨</span> AI
        </button>
      </div>
    </div>
  );
}

function EntityChip({ label, kind }: { label: string; kind: "jd" | "client" }) {
  // Profile pages don't exist yet — chips hint at the future link via tooltip
  // but don't actually navigate anywhere. Spec doc tags entity portals as P2.
  const tooltip = kind === "jd"
    ? "JD profile 页 (P2)"
    : "客户 profile 页 (P2)";
  const accent = kind === "jd" ? "var(--c-info)" : "var(--c-ink-3)";
  return (
    <span
      title={tooltip}
      onClick={(e) => e.stopPropagation()}
      className="mono text-[10px] inline-flex items-center gap-1 rounded-sm border cursor-help"
      style={{
        padding: "1px 6px",
        background: "var(--c-panel)",
        borderColor: "var(--c-line)",
        color: accent,
      }}
    >
      <span className="text-ink-4 uppercase tracking-[0.04em]" style={{ fontSize: 8.5 }}>
        {kind}
      </span>
      <span className="text-ink-1 truncate" style={{ maxWidth: 160 }}>{label}</span>
    </span>
  );
}

// Splits "工行 · 高级后端工程师 · 上海 · JD-2041" into roughly client + JD parts.
// triggerData has separate client/jdId fields; jobLabel was their join with " · ".
function splitJobLabel(s: string): [string, string | null] {
  const idx = s.indexOf(" · ");
  if (idx === -1) return [s, null];
  return [s.slice(0, idx), s.slice(idx + 3)];
}

// ── Empty states ────────────────────────────────────────────────────

function CenterEmpty({ hasRuns }: { hasRuns: boolean }) {
  return (
    <div className="flex-1 flex items-center justify-center bg-bg">
      <EmptyState
        icon={<Ic.play />}
        title={hasRuns ? "👈 选一条 run 查看详情" : "暂无 run"}
        hint={
          hasRuns
            ? "运行记录的核心问题：那次运行发生了什么。点击左侧任意一行看 step 时间线、实时日志、AI 总结。"
            : "/api/runs 当前没返回任何 run。等真实事件触发或先去 /agent-demo 触一次。"
        }
      />
    </div>
  );
}

function RightEmpty() {
  return (
    <aside className="border-l border-line bg-surface flex flex-col min-h-0" style={{ padding: "16px 18px" }}>
      <div className="text-[13px] font-semibold mb-2 text-ink-3">关联对象</div>
      <div className="text-[11.5px] text-ink-4 leading-relaxed">
        选中一条 run 后，这里会显示：
        <ul className="mt-2 pl-4" style={{ listStyle: "disc" }}>
          <li>触发事件（→ /events）</li>
          <li>客户 / JD</li>
          <li>命中的 agent（→ /workflow）</li>
          <li>产生的 HITL 任务（→ /inbox）</li>
          <li>AI 总结的 mini stats</li>
        </ul>
      </div>
    </aside>
  );
}
