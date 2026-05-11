"use client";
import React from "react";
import Link from "next/link";
import { Ic } from "@/components/shared/Ic";
import { Badge, Btn, EmptyState } from "@/components/shared/atoms";
import { LogStream } from "@/components/shared/LogStream";
import { fetchJson } from "@/lib/api/client";
import type { RunStatus, StepDetail, StepsResponse } from "@/lib/api/types";
import type { RunSummaryResponse } from "@/app/api/runs/[id]/summary/route";
import type { ActivityResponse, LogEntry } from "@/lib/api/activity-types";
import type { TraceResponse } from "@/app/api/runs/[id]/trace/route";
import { byShortFunction } from "@/lib/agent-functions";
import { RunTraceTimeline } from "./RunTraceTimeline";
import { RunQuickActions } from "./RunQuickActions";
import { RunChatbot } from "./RunChatbot";
import { Markdown } from "@/components/shared/Markdown";

// Real-run detail rendered into the center+right of /live when the user
// clicks a real WorkflowRun row in the left list. Two named exports —
// `RealRunCenter` and `RealRunRight` — because /live's grid lays them as
// siblings, not parent and child.
//
// All KPIs / anomalies / agent counts are scoped to the selected run.
// Nothing system-wide leaks in here; that's /overview's job.

// Consolidated 2026-05-09 from 5 → 3 tabs. Old set was: overview / logs /
// trail / trace / ai — they had ~70% data overlap (see commit message).
// New mental model:
//   flow → 看图：swimlane + KPIs + anomalies + quick actions, all in one
//   ai   → 听故事：AI summary + chatbot
//   logs → 看细节：raw activity stream
type Tab = "flow" | "ai" | "logs";

type RunDetail = {
  id: string;
  triggerEvent: string;
  triggerData: { client: string; jdId: string };
  status: RunStatus;
  startedAt: string;
  lastActivityAt: string;
  completedAt: string | null;
  agentCount: number;
  pendingHumanTasks: number;
  suspendedReason: string | null;
};

// Shared run-detail fetch used by both halves so we don't double-poll.
function useRunDetail(runId: string): {
  run: RunDetail | null;
  error: string | null;
  refresh: () => void;
} {
  const [run, setRun] = React.useState<RunDetail | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const refresh = React.useCallback(() => {
    fetchJson<RunDetail>(`/api/runs/${encodeURIComponent(runId)}`)
      .then((r) => {
        setRun(r);
        setError(null);
      })
      .catch((e) => setError((e as Error).message));
  }, [runId]);
  React.useEffect(() => {
    refresh();
    const id = setInterval(refresh, 5_000);
    return () => clearInterval(id);
  }, [refresh]);
  return { run, error, refresh };
}

// ── Center ─────────────────────────────────────────────────────────────

export function RealRunCenter({
  runId,
  jobLabel,
  onClear,
}: {
  runId: string;
  jobLabel: string;
  onClear: () => void;
}) {
  const { run, error, refresh } = useRunDetail(runId);
  const [tab, setTab] = React.useState<Tab>("flow");

  // Reset to Flow when the user picks a different run.
  React.useEffect(() => {
    setTab("flow");
  }, [runId]);

  return (
    <div className="flex flex-col min-h-0 overflow-hidden">
      <Header
        runId={runId}
        jobLabel={jobLabel}
        run={run}
        error={error}
        onClear={onClear}
        onRefresh={refresh}
      />
      <Tabs tab={tab} setTab={setTab} />
      <div className="flex-1 min-h-0 flex flex-col">
        {tab === "flow" && <FlowTab runId={runId} run={run} />}
        {tab === "ai" && <AiAssistantTab runId={runId} />}
        {tab === "logs" && (
          <LogStream
            endpoint={`/api/runs/${encodeURIComponent(runId)}/activity?limit=300`}
            order="asc"
            pollIntervalMs={3000}
            emptyHint="Run 还没有 AgentActivity 行。日志契约：每个 agent 在做有意义的事（开始/完成 step、调用工具、决策、异常）时都应写一条 AgentActivity，否则这条 run 在这里看起来就是空的。"
          />
        )}
      </div>
    </div>
  );
}

function Header({
  runId,
  jobLabel,
  run,
  error,
  onClear,
  onRefresh,
}: {
  runId: string;
  jobLabel: string;
  run: RunDetail | null;
  error: string | null;
  onClear: () => void;
  onRefresh: () => void;
}) {
  const start = run ? new Date(run.startedAt) : null;
  const end = run
    ? run.completedAt
      ? new Date(run.completedAt)
      : new Date(run.lastActivityAt)
    : null;
  const durMs = start && end ? Math.max(0, end.getTime() - start.getTime()) : null;

  return (
    <div className="border-b border-line bg-surface" style={{ padding: "16px 22px" }}>
      <div className="flex items-center gap-2 mb-1.5 flex-wrap">
        <span className="mono text-[12px] font-semibold text-[color:var(--c-accent)]">
          {runId}
        </span>
        {run ? (
          <Badge
            variant={
              run.status === "completed"
                ? "ok"
                : run.status === "failed" ||
                    run.status === "timed_out" ||
                    run.status === "interrupted"
                  ? "err"
                  : run.status === "suspended" || run.status === "paused"
                    ? "warn"
                    : "info"
            }
            dot
            pulse={run.status === "running"}
          >
            {run.status}
          </Badge>
        ) : error ? (
          <Badge variant="err" dot>
            error
          </Badge>
        ) : (
          <Badge variant="info" dot>
            loading
          </Badge>
        )}
        {run?.suspendedReason && <Badge variant="warn">{run.suspendedReason}</Badge>}
        <div className="flex-1" />
        <Btn size="sm" variant="ghost" onClick={onRefresh} title="刷新">
          <Ic.bolt />
        </Btn>
        <Btn size="sm" variant="ghost" onClick={onClear} title="返回总览">
          <Ic.cross /> 关闭
        </Btn>
      </div>
      <div className="text-[15px] font-semibold tracking-tight">{jobLabel}</div>
      <div className="text-ink-3 text-[12px] mt-0.5 mono">
        {run ? (
          <>
            trigger {run.triggerEvent} · 启动{" "}
            {start!.toLocaleString(undefined, { hour12: false })}
            {" · "}耗时 {formatDuration(durMs ?? 0)}
            {run.completedAt
              ? ""
              : ` · 最近活动 ${end!.toLocaleTimeString(undefined, { hour12: false })}`}
          </>
        ) : error ? (
          `加载 run 失败：${error}`
        ) : (
          "加载 run 信息中…"
        )}
      </div>
    </div>
  );
}

function Tabs({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  const tabs: Array<{ id: Tab; label: string; hint: string }> = [
    { id: "flow", label: "流程", hint: "看图：swimlane + KPI + 异常" },
    { id: "ai", label: "AI 助手", hint: "听故事：总结 + 自由问答" },
    { id: "logs", label: "日志", hint: "看细节：原始活动流" },
  ];
  return (
    <div className="border-b border-line bg-surface flex gap-0.5" style={{ padding: "0 14px" }}>
      {tabs.map((tb) => {
        const active = tab === tb.id;
        return (
          <button
            key={tb.id}
            onClick={() => setTab(tb.id)}
            title={tb.hint}
            className="bg-transparent border-0 cursor-pointer text-[12.5px]"
            style={{
              padding: "10px 12px",
              color: active ? "var(--c-ink-1)" : "var(--c-ink-3)",
              fontWeight: active ? 600 : 500,
              borderBottom: active ? "2px solid var(--c-accent)" : "2px solid transparent",
            }}
          >
            {tb.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Overview Tab ──────────────────────────────────────────────────
//
// All numbers belong to THIS run. The contract:
//   - tokens / LLM cost  → sum over `tool` activity rows whose meta.totalTokens
//                          is set (LLM rows added by withLlmTelemetry).
//   - decisions          → count of `decision` activity rows.
//   - tool calls         → count of `tool` activity rows.
//   - errors             → count of `agent_error` + `step.failed` rows.
//   - duration           → run.completedAt - run.startedAt (or now() while running).
//   - agents             → distinct agentName across all activities + steps.
//   - anomaly list       → recent anomaly / error rows, newest first.

type OverviewStats = {
  tokens: number;
  decisions: number;
  toolCalls: number;
  errors: number;
  agents: Map<string, AgentStat>;
  anomalies: LogEntry[];
};

type AgentStat = {
  name: string;
  steps: number;
  tools: number;
  decisions: number;
  errors: number;
};

function emptyStats(): OverviewStats {
  return {
    tokens: 0,
    decisions: 0,
    toolCalls: 0,
    errors: 0,
    agents: new Map(),
    anomalies: [],
  };
}

function computeStats(entries: LogEntry[]): OverviewStats {
  const stats = emptyStats();
  const ensure = (name: string): AgentStat => {
    let s = stats.agents.get(name);
    if (!s) {
      s = { name, steps: 0, tools: 0, decisions: 0, errors: 0 };
      stats.agents.set(name, s);
    }
    return s;
  };
  for (const e of entries) {
    const a = ensure(e.agent || "system");
    switch (e.kind) {
      case "tool":
        stats.toolCalls += 1;
        a.tools += 1;
        const total = (e.metadata?.totalTokens as number | undefined) ?? 0;
        if (typeof total === "number" && total > 0) stats.tokens += total;
        break;
      case "decision":
        stats.decisions += 1;
        a.decisions += 1;
        break;
      case "step.completed":
      case "step.started":
        a.steps += 1;
        break;
      case "anomaly":
      case "error":
      case "step.failed":
        stats.errors += 1;
        a.errors += 1;
        stats.anomalies.push(e);
        break;
    }
  }
  // Anomalies newest first, capped — overview pane shouldn't sprawl.
  stats.anomalies.sort((a, b) => b.ts.localeCompare(a.ts));
  stats.anomalies = stats.anomalies.slice(0, 6);
  return stats;
}

// Combined Flow Tab (default since 2026-05-09).
//
// Replaces 3 of the old 5 tabs:
//   - 概览 (KPI tiles + agent stats + anomalies)
//   - 实例追踪 (swimlane + 4 quick actions)
//   - Step 时间线 (step input/output detail — accessible via 日志 expansion)
//
// One scrollable view, top to bottom:
//   1. Quick action buttons (immediate "answer this for me")
//   2. KPI strip (5 tiles, all run-scoped)
//   3. Swimlane (the canvas — always visible on click)
//   4. Per-agent breakdown cards
//   5. Run-scoped anomaly cards
//
// One trace fetch shared between RunQuickActions and RunTraceTimeline so
// they don't double-poll.

function FlowTab({
  runId,
  run,
}: {
  runId: string;
  run: { startedAt: string; completedAt: string | null; lastActivityAt: string } | null;
}) {
  const [trace, setTrace] = React.useState<TraceResponse | null>(null);
  const [stats, setStats] = React.useState<OverviewStats | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const [t, a] = await Promise.all([
          fetchJson<TraceResponse>(
            `/api/runs/${encodeURIComponent(runId)}/trace`,
            { timeoutMs: 15_000 }, // trace fans out to Inngest per event
          ),
          fetchJson<ActivityResponse>(
            `/api/runs/${encodeURIComponent(runId)}/activity?limit=500`,
          ),
        ]);
        if (cancelled) return;
        setTrace(t);
        setStats(computeStats(a.entries));
        setError(null);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    };
    void tick();
    const id = setInterval(tick, 4_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [runId]);

  const durationMs = run
    ? (run.completedAt ? new Date(run.completedAt).getTime() : Date.now()) -
      new Date(run.startedAt).getTime()
    : 0;

  return (
    <div className="overflow-auto" style={{ padding: "16px 22px" }}>
      <RunQuickActions runId={runId} trace={trace} />

      {/* KPI strip — all numbers姓"this run" */}
      <div className="text-[10.5px] tracking-[0.06em] uppercase text-ink-4 font-semibold mb-2">
        这条 run 的指标
      </div>
      <div className="grid gap-2 mb-4" style={{ gridTemplateColumns: "repeat(5, 1fr)" }}>
        <Kpi label="这条 run · token" value={stats ? formatNumber(stats.tokens) : "…"} muted={!stats || stats.tokens === 0} />
        <Kpi label="这条 run · 决策" value={stats?.decisions.toString() ?? "…"} muted={!stats || stats.decisions === 0} />
        <Kpi label="这条 run · 工具调用" value={stats?.toolCalls.toString() ?? "…"} muted={!stats || stats.toolCalls === 0} />
        <Kpi label="这条 run · 异常" value={stats?.errors.toString() ?? "…"} tone={stats && stats.errors > 0 ? "err" : undefined} />
        <Kpi label="这条 run · 耗时" value={run ? formatDuration(durationMs) : "…"} />
      </div>

      {error && (
        <div
          className="mono text-[11.5px] mb-3 rounded-sm"
          style={{
            padding: "6px 10px",
            background: "var(--c-warn-bg)",
            color: "oklch(0.5 0.14 75)",
          }}
        >
          ⚠ trace / activity 加载失败: {error}
        </div>
      )}

      {/* Swimlane — the canvas. Always visible on the default tab. */}
      <div className="text-[10.5px] tracking-[0.06em] uppercase text-ink-4 font-semibold mb-2">
        实例追踪 · swimlane
      </div>
      <div className="mb-4">
        <RunTraceTimeline runId={runId} externalData={trace} />
      </div>

      {/* Per-agent breakdown cards (was in 概览). */}
      <div className="text-[10.5px] tracking-[0.06em] uppercase text-ink-4 font-semibold mb-2">
        参与 agent {stats && `· ${stats.agents.size}`}
      </div>
      <div className="grid gap-2 mb-4" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
        {stats && stats.agents.size > 0 ? (
          Array.from(stats.agents.values())
            .sort((a, b) => b.steps - a.steps)
            .map((a) => <AgentCard key={a.name} stat={a} />)
        ) : (
          <div className="text-[11.5px] text-ink-3 col-span-2">
            还没有 agent 活动写入。等待 AgentActivity 落表（或外部 runtime POST 推送）。
          </div>
        )}
      </div>

      {/* Run-scoped anomalies. */}
      <div className="text-[10.5px] tracking-[0.06em] uppercase text-ink-4 font-semibold mb-2">
        异常 · 仅这条 run
        {stats && stats.errors > 0 && ` · ${stats.errors}`}
      </div>
      {stats && stats.anomalies.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {stats.anomalies.map((a) => (
            <div
              key={a.id}
              className="border border-line rounded-sm bg-panel"
              style={{ padding: "6px 10px" }}
            >
              <div className="flex items-center gap-2 mb-0.5 mono text-[10.5px]">
                <span className="text-ink-4">
                  {new Date(a.ts).toLocaleTimeString(undefined, { hour12: false })}
                </span>
                <span style={{ color: "var(--c-err)" }}>
                  {a.kind === "step.failed" ? "✗ step.failed" : a.kind === "error" ? "✗ error" : "⚠ anomaly"}
                </span>
                <span className="text-ink-1 font-semibold">{a.agent}</span>
              </div>
              <div className="text-[12px] text-ink-2 leading-snug">{a.message}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-[11.5px] text-ink-3">未发现异常。</div>
      )}
    </div>
  );
}

// Legacy OverviewTab kept commented for ref — replaced by FlowTab above.
// Old standalone OverviewTab + TraceTab + TrailTab were removed
// 2026-05-09 — their content is in FlowTab above.

function Kpi({
  label,
  value,
  tone,
  muted,
}: {
  label: string;
  value: React.ReactNode;
  tone?: "err";
  muted?: boolean;
}) {
  const color = tone === "err" ? "var(--c-err)" : "var(--c-ink-1)";
  return (
    <div className="bg-panel border border-line rounded-sm" style={{ padding: "8px 10px" }}>
      <div className="hint">{label}</div>
      <div
        className="mono font-semibold tabular-nums"
        style={{ color, fontSize: 18, opacity: muted ? 0.7 : 1 }}
      >
        {value}
      </div>
    </div>
  );
}

function AgentCard({ stat }: { stat: AgentStat }) {
  const fn = byShortFunction(stat.name);
  return (
    <div
      className="border border-line rounded-sm bg-panel"
      style={{ padding: "6px 10px" }}
    >
      <div className="flex items-center gap-2 mb-0.5">
        <span className="mono text-[11.5px] font-semibold text-ink-1 flex-1 truncate">
          {stat.name}
        </span>
        {stat.errors > 0 ? (
          <Badge variant="err">{stat.errors} err</Badge>
        ) : null}
      </div>
      {fn && <div className="text-[10.5px] text-ink-3 mb-1 truncate">{fn.summary}</div>}
      <div className="mono text-[10.5px] text-ink-3 flex gap-3">
        <span>{stat.steps} step</span>
        <span>{stat.tools} tool</span>
        <span>{stat.decisions} decision</span>
      </div>
    </div>
  );
}

function formatNumber(n: number): string {
  if (n < 1000) return n.toString();
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

// ── Trace Tab ─────────────────────────────────────────────────────
//
// Owns one /api/runs/:id/trace fetch and shares it with both the quick
// actions panel (which derives slowness/failure/RAAS answers from it)
// and the swimlane (which renders it). One poll feeds two consumers.

// TraceTab + TrailTab + StepCard + IOBlock removed 2026-05-09 — content
// merged into FlowTab. Step input/output detail moved to /日志 Tab as
// expandable rows (TODO: future).

// ── AI Assistant Tab ───────────────────────────────────────────────────

function AiAssistantTab({ runId }: { runId: string }) {
  return (
    <div className="overflow-auto flex flex-col" style={{ padding: "16px 22px", gap: 14 }}>
      <AiSummarySection runId={runId} />
      <RunChatbot runId={runId} />
    </div>
  );
}

function AiSummarySection({ runId }: { runId: string }) {
  const [resp, setResp] = React.useState<RunSummaryResponse | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  // Track ms elapsed during regeneration so the progress text is concrete
  // ("生成中… 4.2s") instead of a static spinner. LLM calls regularly
  // take 5-15s; users want to know "is it working" not "did it hang".
  const [elapsedMs, setElapsedMs] = React.useState(0);
  const elapsedTimerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchSummary = React.useCallback(async (opts?: { bustCache?: boolean }) => {
    setLoading(true);
    setErr(null);
    setElapsedMs(0);
    const startedAt = Date.now();
    if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
    elapsedTimerRef.current = setInterval(
      () => setElapsedMs(Date.now() - startedAt),
      200,
    );
    try {
      if (opts?.bustCache) {
        await fetch(`/api/runs/${encodeURIComponent(runId)}/summary`, { method: "DELETE" });
      }
      const r = await fetchJson<RunSummaryResponse>(
        `/api/runs/${encodeURIComponent(runId)}/summary`,
        { timeoutMs: 60_000 }, // LLM 6-15s; default 5s would always fail
      );
      setResp(r);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      if (elapsedTimerRef.current) {
        clearInterval(elapsedTimerRef.current);
        elapsedTimerRef.current = null;
      }
      setLoading(false);
    }
  }, [runId]);

  React.useEffect(() => {
    void fetchSummary();
    return () => {
      if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
    };
  }, [fetchSummary]);

  // Reset state when switching runs.
  React.useEffect(() => {
    setResp(null);
    setErr(null);
  }, [runId]);

  return (
    <div className="overflow-auto" style={{ padding: "16px 22px" }}>
      <div className="flex items-center mb-2 gap-2">
        {resp && !loading && (
          <Badge variant={resp.source === "llm" ? "ok" : "info"}>
            {resp.source === "llm" ? `via ${resp.modelUsed ?? "llm"}` : "fallback (无网关)"}
          </Badge>
        )}
        {loading && (
          <Badge variant="info" dot pulse>
            生成中 · {(elapsedMs / 1000).toFixed(1)}s
          </Badge>
        )}
        {resp && resp.durationLLMms != null && !loading && (
          <span className="mono text-[10px] text-ink-4">
            上次 {(resp.durationLLMms / 1000).toFixed(1)}s
          </span>
        )}
        <div className="flex-1" />
        <Btn size="sm" onClick={() => void fetchSummary()} disabled={loading}>
          <Ic.sparkle /> {loading ? "生成中…" : "重新生成"}
        </Btn>
        <Btn
          size="sm"
          variant="ghost"
          onClick={() => void fetchSummary({ bustCache: true })}
          disabled={loading}
          title="清服务端缓存后重新调 LLM"
        >
          <Ic.bolt /> 清缓存
        </Btn>
      </div>
      {/* During regeneration, keep the previous summary visible (faded)
          rather than blanking the panel — gives the user a sense of
          continuity and they can read the old one while the new one cooks. */}
      {loading && resp && (
        <div
          className="border border-line border-dashed rounded-sm mb-2 mono text-[10.5px] text-ink-3"
          style={{ padding: "5px 10px" }}
        >
          ⏳ AI 重新生成中（基于最新 activity）。下方显示的是上一次结果，会被覆盖。
        </div>
      )}
      {err && (
        <div className="text-[11.5px]" style={{ color: "var(--c-warn)" }}>
          ⚠ {err}
        </div>
      )}
      {resp && (
        <>
          <div className="grid gap-2 mb-3" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
            <Stat label="参与 agent" value={resp.agentBreakdown.length} />
            <Stat label="活动条目" value={resp.activityCount} />
            <Stat
              label="错误"
              value={resp.errorCount}
              tone={resp.errorCount > 0 ? "err" : "muted"}
            />
            <Stat
              label="耗时"
              value={resp.durationMs ? formatDuration(resp.durationMs) : "—"}
            />
          </div>
          {/* Honesty banner — when activityCount=0 the AI summary endpoint
              now refuses to call LLM (would hallucinate). UI tells the
              user why and points at the fix. */}
          {resp.activityCount === 0 && resp.agentBreakdown.length === 0 && (
            <div
              className="border rounded-sm mb-2 text-[11.5px]"
              style={{
                padding: "8px 10px",
                background: "color-mix(in oklab, var(--c-info) 7%, transparent)",
                borderColor: "color-mix(in oklab, var(--c-info) 30%, var(--c-line))",
                color: "var(--c-ink-2)",
              }}
            >
              <div className="font-semibold mb-1" style={{ color: "var(--c-info)" }}>
                ⚠ 数据稀疏 · 跳过 LLM 调用
              </div>
              <div className="leading-relaxed">
                这条 run 在 AgentActivity / WorkflowStep 表里没有任何记录。
                之前 LLM 在零数据下会编造 agent 名（如 <code className="mono">JD_Writer</code>、
                <code className="mono">Recruiter_Agent</code> 等不在 AGENT_MAP 的虚构名）。
                现在直接返回诚实的"无数据"通知，详见下方。
              </div>
            </div>
          )}
          <div
            className="bg-panel border border-line rounded-sm overflow-auto transition-opacity"
            style={{ padding: "10px 14px", opacity: loading ? 0.5 : 1 }}
          >
            <Markdown>{resp.text}</Markdown>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  tone?: "muted" | "err";
}) {
  const color =
    tone === "err"
      ? "var(--c-err)"
      : tone === "muted"
        ? "var(--c-ink-3)"
        : "var(--c-ink-1)";
  return (
    <div className="bg-panel border border-line rounded-sm" style={{ padding: "6px 8px" }}>
      <div className="hint">{label}</div>
      <div className="mono text-[14px] font-semibold tabular-nums" style={{ color }}>
        {value}
      </div>
    </div>
  );
}

// ── Right rail ────────────────────────────────────────────────────────

export function RealRunRight({
  runId,
  onShowSummaryModal,
}: {
  runId: string;
  onShowSummaryModal: () => void;
}) {
  const { run } = useRunDetail(runId);
  const [resp, setResp] = React.useState<RunSummaryResponse | null>(null);

  React.useEffect(() => {
    fetchJson<RunSummaryResponse>(
      `/api/runs/${encodeURIComponent(runId)}/summary`,
      { timeoutMs: 60_000 }, // LLM 6-15s; default 5s would always fail
    )
      .then(setResp)
      .catch(() => {/* keep null */});
  }, [runId]);

  return (
    <aside className="border-l border-line bg-surface flex flex-col min-h-0 overflow-auto">
      <div className="border-b border-line" style={{ padding: "12px 16px" }}>
        <div className="text-[13px] font-semibold mb-2">关联对象 · Linked</div>
        <LinkRow
          label="trigger"
          mono={run?.triggerEvent ?? "…"}
          href={
            run?.triggerEvent
              ? `/events?event=${encodeURIComponent(run.triggerEvent)}`
              : undefined
          }
        />
        <LinkRow
          label="客户"
          mono={run?.triggerData.client ?? "…"}
          // Filter /live by client when we have that capability.
          href={undefined}
        />
        <LinkRow
          label="JD"
          mono={run?.triggerData.jdId ?? "…"}
          href={undefined}
        />
        {run?.pendingHumanTasks ? (
          <LinkRow
            label="HITL"
            mono={`${run.pendingHumanTasks} 待办`}
            href="/inbox"
          />
        ) : null}
      </div>

      <div className="border-b border-line" style={{ padding: "12px 16px" }}>
        <div className="flex items-center mb-2">
          <div className="text-[13px] font-semibold flex-1">运行摘要</div>
          {resp && (
            <Badge variant={resp.source === "llm" ? "ok" : "info"}>
              {resp.source === "llm" ? "AI" : "stat"}
            </Badge>
          )}
        </div>
        {resp ? (
          <div className="grid gap-1.5" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <MiniStat label="agent" value={resp.agentBreakdown.length} />
            <MiniStat label="活动" value={resp.activityCount} />
            <MiniStat
              label="错误"
              value={resp.errorCount}
              tone={resp.errorCount > 0 ? "err" : undefined}
            />
            <MiniStat
              label="耗时"
              value={resp.durationMs ? formatDuration(resp.durationMs) : "—"}
            />
          </div>
        ) : (
          <div className="text-[11px] text-ink-3">加载中…</div>
        )}
        <div className="mt-2">
          <Btn size="sm" onClick={onShowSummaryModal} style={{ width: "100%" }}>
            <Ic.sparkle /> AI 详细总结
          </Btn>
        </div>
      </div>

      {resp && resp.agentBreakdown.length > 0 && (
        <div className="border-b border-line" style={{ padding: "12px 16px" }}>
          <div className="text-[13px] font-semibold mb-2">
            参与 agent · {resp.agentBreakdown.length}
          </div>
          <div className="flex flex-col gap-1">
            {resp.agentBreakdown.map((row) => (
              <div
                key={row.agentName}
                className="flex items-center gap-1.5 mono text-[10.5px] border border-line bg-panel rounded-sm"
                style={{ padding: "4px 6px" }}
              >
                <span className="font-semibold text-ink-1 flex-1 truncate">
                  {row.agentName}
                </span>
                <span className="text-ink-3 tabular-nums">{row.steps}step</span>
                {row.failed > 0 && <Badge variant="err">{row.failed}</Badge>}
              </div>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}

function LinkRow({
  label,
  mono,
  href,
}: {
  label: string;
  mono: string;
  href?: string;
}) {
  const inner = (
    <span className="mono text-[11px] text-ink-1 truncate" title={mono}>
      {mono}
    </span>
  );
  return (
    <div
      className="flex items-center gap-2"
      style={{ padding: "4px 0", borderBottom: "1px dashed var(--c-line)" }}
    >
      <span className="text-[10.5px] text-ink-4 uppercase tracking-[0.06em] w-[44px] flex-shrink-0">
        {label}
      </span>
      <div className="flex-1 min-w-0">
        {href ? (
          <Link href={href} className="no-underline hover:underline">
            {inner}
          </Link>
        ) : (
          inner
        )}
      </div>
    </div>
  );
}

function MiniStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  tone?: "err";
}) {
  const color = tone === "err" ? "var(--c-err)" : "var(--c-ink-1)";
  return (
    <div className="bg-panel border border-line rounded-sm" style={{ padding: "5px 7px" }}>
      <div className="hint">{label}</div>
      <div className="mono text-[12px] font-semibold tabular-nums" style={{ color }}>
        {value}
      </div>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function formatStepDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}
