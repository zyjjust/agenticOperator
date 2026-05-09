"use client";
import React from "react";
import Link from "next/link";
import { Ic } from "@/components/shared/Ic";
import { Badge, Btn, EmptyState } from "@/components/shared/atoms";
import { LogStream } from "@/components/shared/LogStream";
import { fetchJson } from "@/lib/api/client";
import type { RunStatus, StepDetail, StepsResponse } from "@/lib/api/types";
import type { RunSummaryResponse } from "@/app/api/runs/[id]/summary/route";
import { byShortFunction } from "@/lib/agent-functions";

// Real-run detail rendered into the center+right of /live when the user
// clicks a real WorkflowRun row in the left list. Replaces the mock
// "RUN-J2041 theatre". Two named exports — `RealRunCenter` and
// `RealRunRight` — because /live's grid lays them as siblings, not parent
// and child.

type Tab = "logs" | "trail" | "ai";

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
  const [tab, setTab] = React.useState<Tab>("logs");

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
        {tab === "logs" && (
          <LogStream
            endpoint={`/api/runs/${encodeURIComponent(runId)}/activity?limit=300`}
            order="asc"
            pollIntervalMs={3000}
            emptyHint="Run 还没有 AgentActivity 行。日志契约：每个 agent 在做有意义的事（开始/完成 step、调用工具、决策、异常）时都应写一条 AgentActivity，否则这条 run 在这里看起来就是空的。"
          />
        )}
        {tab === "trail" && <TrailTab runId={runId} />}
        {tab === "ai" && <AiTab runId={runId} />}
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
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "logs", label: "实时日志" },
    { id: "trail", label: "Step 时间线" },
    { id: "ai", label: "AI 总结" },
  ];
  return (
    <div className="border-b border-line bg-surface flex gap-0.5" style={{ padding: "0 14px" }}>
      {tabs.map((tb) => {
        const active = tab === tb.id;
        return (
          <button
            key={tb.id}
            onClick={() => setTab(tb.id)}
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

// ── Trail Tab ─────────────────────────────────────────────────────────

function TrailTab({ runId }: { runId: string }) {
  const [steps, setSteps] = React.useState<StepDetail[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const tick = () => {
      fetchJson<StepsResponse>(`/api/runs/${encodeURIComponent(runId)}/steps`)
        .then((r) => {
          setSteps(r.steps);
          setError(null);
        })
        .catch((e) => setError((e as Error).message));
    };
    tick();
    const id = setInterval(tick, 5_000);
    return () => clearInterval(id);
  }, [runId]);

  if (error && !steps) {
    return (
      <div style={{ padding: 22 }}>
        <div
          className="border border-line rounded-md mono text-[11.5px]"
          style={{
            padding: "10px 12px",
            background: "var(--c-warn-bg)",
            color: "oklch(0.5 0.14 75)",
          }}
        >
          ⚠ 加载 step 失败：{error}
          <div className="text-[10.5px] mt-1 opacity-80">
            /api/runs/[id]/steps 走 ws sidecar，sidecar 不在线时本视图为空，AI 总结仍可基于
            WorkflowRun 表生成。
          </div>
        </div>
      </div>
    );
  }
  if (!steps) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <span className="text-ink-3 text-[12px]">加载 step 中…</span>
      </div>
    );
  }
  if (steps.length === 0) {
    return (
      <div style={{ padding: 22 }}>
        <EmptyState
          title="暂无 step 记录"
          hint="该 run 未在 WorkflowStep 表写入任何 step（可能还没开始执行，或 step 入库滞后）。"
        />
      </div>
    );
  }
  return (
    <div className="overflow-auto" style={{ padding: "16px 22px" }}>
      <ol className="flex flex-col gap-2" style={{ margin: 0, padding: 0, listStyle: "none" }}>
        {steps.map((s, i) => (
          <StepCard key={s.id} step={s} index={i} />
        ))}
      </ol>
    </div>
  );
}

function StepCard({ step, index }: { step: StepDetail; index: number }) {
  const fn = byShortFunction(step.agentShort);
  const tone =
    step.status === "completed"
      ? "var(--c-ok)"
      : step.status === "failed"
        ? "var(--c-err)"
        : step.status === "running" || step.status === "retrying"
          ? "var(--c-info)"
          : "var(--c-ink-4)";
  return (
    <li className="border border-line rounded-md bg-surface" style={{ padding: "10px 12px" }}>
      <div className="flex items-center gap-2 mb-1 flex-wrap">
        <span
          className="w-5 h-5 rounded-full grid place-items-center mono text-[10px] font-semibold flex-shrink-0"
          style={{ color: "white", background: tone }}
        >
          {index + 1}
        </span>
        <span className="mono text-[12px] font-semibold text-ink-1">{step.agentShort}</span>
        <Badge
          variant={
            step.status === "completed"
              ? "ok"
              : step.status === "failed"
                ? "err"
                : step.status === "running" || step.status === "retrying"
                  ? "info"
                  : "default"
          }
        >
          {step.status}
        </Badge>
        {step.durationMs != null && (
          <span className="mono text-[10.5px] text-ink-3">
            {formatStepDuration(step.durationMs)}
          </span>
        )}
        <div className="flex-1" />
        <span className="mono text-[10px] text-ink-4">
          {new Date(step.startedAt).toLocaleTimeString(undefined, { hour12: false })}
        </span>
      </div>
      {fn && <div className="text-[11.5px] text-ink-3 mb-2">{fn.summary}</div>}
      {step.error && (
        <div
          className="mono text-[11px] mb-2 rounded-sm"
          style={{ padding: "6px 8px", background: "var(--c-err-bg)", color: "var(--c-err)" }}
        >
          {step.error}
        </div>
      )}
      <div className="grid gap-2" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <IOBlock label="input" value={step.input} />
        <IOBlock label="output" value={step.output} />
      </div>
    </li>
  );
}

function IOBlock({ label, value }: { label: string; value: unknown }) {
  if (value == null) {
    return (
      <div>
        <div className="text-[10.5px] text-ink-4 font-semibold mb-1">{label}</div>
        <div className="text-[11px] text-ink-4">—</div>
      </div>
    );
  }
  const truncated =
    typeof value === "object" &&
    value &&
    (value as { _truncated?: boolean })._truncated;
  return (
    <div>
      <div className="text-[10.5px] text-ink-4 font-semibold mb-1 flex items-center gap-1">
        {label}
        {truncated && <Badge variant="warn">truncated</Badge>}
      </div>
      <pre
        className="mono text-[10.5px] text-ink-2 bg-panel border border-line rounded-sm overflow-auto"
        style={{ padding: 8, margin: 0, maxHeight: 180, lineHeight: 1.4 }}
      >
        {safeJson(value)}
      </pre>
    </div>
  );
}

// ── AI Tab ─────────────────────────────────────────────────────────────

function AiTab({ runId }: { runId: string }) {
  const [resp, setResp] = React.useState<RunSummaryResponse | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const fetchSummary = React.useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetchJson<RunSummaryResponse>(
        `/api/runs/${encodeURIComponent(runId)}/summary`,
      );
      setResp(r);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [runId]);

  React.useEffect(() => {
    void fetchSummary();
  }, [fetchSummary]);

  return (
    <div className="overflow-auto" style={{ padding: "16px 22px" }}>
      <div className="flex items-center mb-2 gap-2">
        {resp && (
          <Badge variant={resp.source === "llm" ? "ok" : "info"}>
            {resp.source === "llm" ? `via ${resp.modelUsed ?? "llm"}` : "fallback (无网关)"}
          </Badge>
        )}
        <div className="flex-1" />
        <Btn size="sm" onClick={fetchSummary} disabled={loading}>
          <Ic.sparkle /> {loading ? "生成中…" : "重新生成"}
        </Btn>
        <Btn
          size="sm"
          variant="ghost"
          onClick={async () => {
            await fetch(`/api/runs/${encodeURIComponent(runId)}/summary`, {
              method: "DELETE",
            });
            await fetchSummary();
          }}
          disabled={loading}
        >
          <Ic.bolt /> 清缓存
        </Btn>
      </div>
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
          <div
            className="mono text-[11.5px] text-ink-2 bg-panel border border-line rounded-sm overflow-auto whitespace-pre-wrap"
            style={{ padding: 12, lineHeight: 1.55 }}
          >
            {resp.text}
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
    fetchJson<RunSummaryResponse>(`/api/runs/${encodeURIComponent(runId)}/summary`)
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
