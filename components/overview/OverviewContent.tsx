"use client";
import React from "react";
import Link from "next/link";
import { Ic } from "@/components/shared/Ic";
import { Badge, Btn, EmptyState } from "@/components/shared/atoms";
import { fetchJson } from "@/lib/api/client";
import type { RunSummary, RunsResponse } from "@/lib/api/types";
import type { ActivityResponse, LogEntry } from "@/lib/api/activity-types";
import { useAgentsHealth } from "@/lib/api/agents-health";
import type { AgentHealth, AgentHealthStatus } from "@/app/api/agents/health/route";
import { byShortFunction } from "@/lib/agent-functions";

// /overview — system-at-a-glance dashboard.
//
// Job: "what's happening across the whole system right now?"
// Scope:
//   - everything姓"系统"; nothing scoped to a single run / agent / event
//   - one screen, no tabs, no per-row drill-in (clicking jumps to the
//     appropriate detail surface — /live, /workflow, /events, etc.)
//
// Sections:
//   A. 顶部 KPI 条 — active runs / 1h failed runs / 1h anomalies / total agents healthy
//   B. Agent 健康矩阵 — 22 agents 的实时状态点 + counts; click → /workflow
//   C. 最近异常 — 跨 run 的 anomaly / error / step.failed 流; click → /live?run=...
//   D. 当前 active run — top N; click → /live?run=...

const HEALTH_TONE: Record<AgentHealthStatus, { color: string; label: string; pulse: boolean }> = {
  idle: { color: "var(--c-ink-4)", label: "idle", pulse: false },
  running: { color: "var(--c-ok)", label: "running", pulse: true },
  healthy: { color: "var(--c-ok)", label: "healthy", pulse: false },
  degraded: { color: "var(--c-warn)", label: "degraded", pulse: false },
  failed: { color: "var(--c-err)", label: "failed", pulse: true },
};

export function OverviewContent() {
  const health = useAgentsHealth(4_000);
  const [activeRuns, setActiveRuns] = React.useState<RunSummary[] | null>(null);
  const [failed1h, setFailed1h] = React.useState<RunSummary[] | null>(null);
  const [anomalies, setAnomalies] = React.useState<LogEntry[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    try {
      const [active, failed, recent] = await Promise.all([
        fetchJson<RunsResponse>("/api/runs?status=running,paused&limit=10"),
        fetchJson<RunsResponse>(
          `/api/runs?status=failed,timed_out,interrupted&since=${encodeURIComponent(
            new Date(Date.now() - 60 * 60_000).toISOString(),
          )}&limit=20`,
        ),
        fetchJson<ActivityResponse>(
          "/api/activity/recent?kind=anomaly,error,step.failed&windowMs=3600000&limit=15",
        ),
      ]);
      setActiveRuns(active.runs);
      setFailed1h(failed.runs);
      setAnomalies(recent.entries);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
    const id = setInterval(refresh, 8_000);
    return () => clearInterval(id);
  }, [refresh]);

  // Diagnose "is the system actually emitting data?". When everything is
  // empty, surface a concrete banner explaining WHY (so users don't assume
  // the UI is broken when in fact no agents are running).
  const isAllIdle =
    health.agents.length > 0 &&
    health.agents.every((a) => a.status === "idle") &&
    (activeRuns?.length ?? 0) === 0 &&
    (anomalies?.length ?? 0) === 0;

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-auto">
      <Header onRefresh={refresh} fetchedAt={health.fetchedAt} />
      {isAllIdle && <DataFlowDiagnostic />}
      <KpiBar
        agents={health.agents}
        activeCount={activeRuns?.length ?? null}
        failed1hCount={failed1h?.length ?? null}
        anomaly1hCount={anomalies?.length ?? null}
      />
      {error && (
        <div
          className="border-b border-line mono text-[11.5px]"
          style={{
            padding: "8px 22px",
            background: "var(--c-warn-bg)",
            color: "oklch(0.5 0.14 75)",
          }}
        >
          ⚠ 加载部分失败：{error}
        </div>
      )}
      <div
        className="flex-1 grid min-h-0"
        style={{
          gridTemplateColumns: "1fr 360px",
          gap: 0,
        }}
      >
        <div className="overflow-auto" style={{ padding: "16px 22px" }}>
          <AgentMatrix agents={health.agents} loading={health.loading} />
          <ActiveRunsSection runs={activeRuns} />
        </div>
        <aside className="border-l border-line bg-surface flex flex-col min-h-0 overflow-auto">
          <AnomaliesSection entries={anomalies} />
        </aside>
      </div>
    </div>
  );
}

// ── Data-flow diagnostic banner ──────────────────────────────────────
//
// Shows up when /overview can't find ANY signs of life — no active runs,
// no anomalies, all agents idle. The point: distinguish "UI is broken"
// from "no agents are emitting data" — the latter is a setup issue, not
// a UI bug. Lists exactly which data sources are empty and what the
// cross-process logging contract is so a user can fix it themselves.

function DataFlowDiagnostic() {
  return (
    <div
      className="border-b flex items-start gap-3"
      style={{
        background: "color-mix(in oklab, var(--c-info) 8%, transparent)",
        borderColor: "color-mix(in oklab, var(--c-info) 30%, var(--c-line))",
        padding: "12px 22px",
      }}
    >
      <Ic.alert />
      <div className="flex-1 text-[12px] leading-relaxed">
        <div className="font-semibold mb-1" style={{ color: "var(--c-info)" }}>
          数据流诊断 · 当前所有 agent 空闲、零活跃 run、零最近异常
        </div>
        <div className="text-ink-2">
          AO-main 自己**不再注册任何 Inngest function**（见 <code className="mono text-[11px]">server/inngest/functions.ts</code>，agents 已迁到 sibling 项目 <code className="mono text-[11px]">resume-parser-agent</code> port 3020）。
          所以 AO-main 的 DB 不会自动收到新的 AgentActivity，除非外部 runtime 通过下面任一方式推送：
        </div>
        <ul className="mt-2 text-ink-2" style={{ listStyle: "disc", paddingLeft: 18 }}>
          <li>
            外部 runtime POST{" "}
            <code className="mono text-[11px]">/api/runs/[runId]/activity</code> with{" "}
            <code className="mono text-[11px]">{`{ entries: [...] }`}</code>{" "}
            — 详见路由文件顶部注释
          </li>
          <li>
            或者用 <code className="mono text-[11px]">POST /api/test/trigger-requirement</code>{" "}
            触发测试事件（在 RPA 项目 port 3020 跑起的前提下 —— agents 全部由
            resume-parser-agent 持有，AO-main 不再注册 Inngest function）
          </li>
        </ul>
        <div className="text-ink-3 text-[11.5px] mt-2 mono">
          这不是 UI bug——是数据契约还没接通。配置后这一面板会自动消失。
        </div>
      </div>
    </div>
  );
}

// ── Header ───────────────────────────────────────────────────────────

function Header({
  onRefresh,
  fetchedAt,
}: {
  onRefresh: () => void;
  fetchedAt: Date | null;
}) {
  return (
    <div
      className="border-b border-line bg-surface flex items-center"
      style={{ padding: "14px 22px", gap: 18 }}
    >
      <div className="flex-1">
        <div className="text-[15px] font-semibold tracking-tight">总览</div>
        <div className="text-ink-3 text-[12px] mt-px">
          系统视角 · 当下整体跑得怎样。所有数字姓"系统"，不属于任何单条 run。
        </div>
      </div>
      {fetchedAt && (
        <span className="mono text-[10.5px] text-ink-4">
          updated {fetchedAt.toLocaleTimeString(undefined, { hour12: false })}
        </span>
      )}
      <Btn size="sm" variant="ghost" onClick={onRefresh}>
        <Ic.bolt /> 刷新
      </Btn>
    </div>
  );
}

// ── KPI bar ──────────────────────────────────────────────────────────

function KpiBar({
  agents,
  activeCount,
  failed1hCount,
  anomaly1hCount,
}: {
  agents: AgentHealth[];
  activeCount: number | null;
  failed1hCount: number | null;
  anomaly1hCount: number | null;
}) {
  const counts = React.useMemo(() => {
    const out = { running: 0, healthy: 0, degraded: 0, failed: 0, idle: 0 };
    for (const a of agents) out[a.status] += 1;
    return out;
  }, [agents]);
  const totalAgents = agents.length;
  const unhealthy = counts.degraded + counts.failed;

  return (
    <div
      className="border-b border-line bg-surface grid"
      style={{
        padding: "14px 22px",
        gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
        gap: 18,
      }}
    >
      <Kpi
        label="active runs"
        value={activeCount ?? "…"}
        sub="运行中 / 暂停"
        href="/live?status=active"
      />
      <Kpi
        label="failed · 1h"
        value={failed1hCount ?? "…"}
        sub="失败 / 超时 / 中断"
        tone={failed1hCount && failed1hCount > 0 ? "err" : undefined}
        href="/live?status=failed&time=1h"
      />
      <Kpi
        label="anomaly · 1h"
        value={anomaly1hCount ?? "…"}
        sub="跨 run 异常 / 错误"
        tone={anomaly1hCount && anomaly1hCount > 0 ? "warn" : undefined}
      />
      <Kpi
        label="agents · health"
        value={`${counts.healthy + counts.running}/${totalAgents}`}
        sub={`${counts.running} running · ${counts.healthy} healthy · ${counts.idle} idle`}
        tone={
          counts.failed > 0 ? "err" : counts.degraded > 0 ? "warn" : "ok"
        }
        href="/workflow"
      />
      <Kpi
        label="agents · 异常"
        value={unhealthy}
        sub={`${counts.failed} failed · ${counts.degraded} degraded`}
        tone={counts.failed > 0 ? "err" : counts.degraded > 0 ? "warn" : undefined}
        href="/workflow"
      />
    </div>
  );
}

function Kpi({
  label,
  value,
  sub,
  tone,
  href,
}: {
  label: string;
  value: React.ReactNode;
  sub: string;
  tone?: "err" | "warn" | "ok";
  href?: string;
}) {
  const color =
    tone === "err"
      ? "var(--c-err)"
      : tone === "warn"
        ? "oklch(0.5 0.14 75)"
        : tone === "ok"
          ? "var(--c-ok)"
          : "var(--c-ink-1)";
  const inner = (
    <div className={href ? "cursor-pointer hover:bg-panel rounded-sm transition-colors" : ""} style={href ? { padding: 4, margin: -4 } : undefined}>
      <div className="hint">{label}</div>
      <div
        className="font-semibold tracking-tight tabular-nums mono"
        style={{ fontSize: 22, color }}
      >
        {value}
      </div>
      <div className="mono text-[10.5px] text-ink-4">{sub}</div>
    </div>
  );
  return href ? (
    <Link href={href} className="no-underline">
      {inner}
    </Link>
  ) : (
    inner
  );
}

// ── Agent health matrix ──────────────────────────────────────────────

function AgentMatrix({ agents, loading }: { agents: AgentHealth[]; loading: boolean }) {
  return (
    <section className="mb-5">
      <div className="flex items-center mb-2">
        <div className="text-[13px] font-semibold flex-1">Agent 健康矩阵</div>
        <span className="mono text-[10.5px] text-ink-4">
          5min 窗口 · click → /workflow
        </span>
      </div>
      {loading && agents.length === 0 ? (
        <div className="text-[12px] text-ink-3 py-4">加载中…</div>
      ) : agents.length === 0 ? (
        <EmptyState title="暂无 agent" hint="AGENT_MAP 为空" />
      ) : (
        <div
          className="grid"
          style={{
            gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
            gap: 8,
          }}
        >
          {agents.map((a) => (
            <AgentCard key={a.short} health={a} />
          ))}
        </div>
      )}
    </section>
  );
}

function AgentCard({ health }: { health: AgentHealth }) {
  const tone = HEALTH_TONE[health.status];
  const fn = byShortFunction(health.short);
  const errorCount = health.counts.failed + health.counts.error;
  const lastLabel = health.lastActivityAt
    ? new Date(health.lastActivityAt).toLocaleTimeString(undefined, { hour12: false })
    : null;
  return (
    <Link
      href={`/workflow?agent=${encodeURIComponent(health.short)}`}
      className="no-underline border border-line rounded-md bg-surface hover:border-line-strong transition-colors block"
      style={{ padding: "8px 10px" }}
    >
      <div className="flex items-center gap-2 mb-0.5">
        <span
          className="w-1.5 h-1.5 rounded-full flex-shrink-0"
          style={{
            background: tone.color,
            boxShadow: `0 0 0 3px color-mix(in oklab, ${tone.color} 18%, transparent)`,
          }}
        />
        <span className="mono text-[11.5px] font-semibold text-ink-1 flex-1 truncate">
          {health.short}
        </span>
        <span
          className="mono text-[9.5px]"
          style={{ color: tone.color, fontWeight: 600 }}
        >
          {tone.label}
        </span>
      </div>
      {fn && <div className="text-[10.5px] text-ink-3 mb-1 truncate">{fn.summary}</div>}
      <div className="mono text-[10px] text-ink-4 flex items-center gap-2">
        <span>
          {health.counts.completed}/{health.counts.started} step
        </span>
        {errorCount > 0 && (
          <span style={{ color: "var(--c-err)" }}>· {errorCount} err</span>
        )}
        {health.counts.tool > 0 && <span>· {health.counts.tool} tool</span>}
        <div className="flex-1" />
        {lastLabel && <span title={health.lastActivityAt ?? ""}>{lastLabel}</span>}
      </div>
    </Link>
  );
}

// ── Active runs ──────────────────────────────────────────────────────

function ActiveRunsSection({ runs }: { runs: RunSummary[] | null }) {
  return (
    <section>
      <div className="flex items-center mb-2">
        <div className="text-[13px] font-semibold flex-1">活跃 run</div>
        <Link
          href="/live?status=active"
          className="mono text-[10.5px] text-ink-3 no-underline hover:text-ink-1"
        >
          查看全部 →
        </Link>
      </div>
      {!runs ? (
        <div className="text-[12px] text-ink-3 py-4">加载中…</div>
      ) : runs.length === 0 ? (
        <div className="text-[11.5px] text-ink-3 py-4">当前无活跃 run。</div>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 130 }}>开始</th>
              <th style={{ width: 200 }}>触发事件</th>
              <th>客户 / JD</th>
              <th style={{ width: 100 }}>耗时</th>
              <th style={{ width: 90 }}>HITL</th>
              <th style={{ width: 80 }}></th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <ActiveRunRow key={r.id} run={r} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function ActiveRunRow({ run }: { run: RunSummary }) {
  const start = new Date(run.startedAt);
  const last = new Date(run.lastActivityAt);
  const durMs = Math.max(0, last.getTime() - start.getTime());
  return (
    <tr>
      <td className="mono text-[11px] text-ink-2">
        {start.toLocaleTimeString(undefined, { hour12: false })}
      </td>
      <td className="mono text-[11.5px] text-ink-1 truncate">{run.triggerEvent}</td>
      <td className="text-[11.5px] text-ink-2 truncate">
        {run.triggerData.client} · {run.triggerData.jdId}
      </td>
      <td className="mono text-[11px] text-ink-2 tabular-nums">{formatDuration(durMs)}</td>
      <td>
        {run.pendingHumanTasks > 0 ? (
          <Badge variant="warn">{run.pendingHumanTasks}</Badge>
        ) : (
          <span className="mono text-[10.5px] text-ink-4">—</span>
        )}
      </td>
      <td>
        <Link
          href={`/live?run=${encodeURIComponent(run.id)}`}
          className="mono text-[11px] text-ink-2 no-underline hover:text-ink-1"
        >
          打开 →
        </Link>
      </td>
    </tr>
  );
}

// ── Anomalies feed ───────────────────────────────────────────────────

function AnomaliesSection({ entries }: { entries: LogEntry[] | null }) {
  return (
    <>
      <div className="border-b border-line" style={{ padding: "12px 16px" }}>
        <div className="text-[13px] font-semibold mb-0.5">最近异常 · 1h</div>
        <div className="text-[10.5px] text-ink-4">
          跨 run / 跨 agent · click → /live 详情
        </div>
      </div>
      {!entries ? (
        <div className="text-[12px] text-ink-3 p-4">加载中…</div>
      ) : entries.length === 0 ? (
        <div className="p-4">
          <EmptyState
            title="过去 1h 无异常"
            hint="所有 agent 都健康跑着——保持就好。"
          />
        </div>
      ) : (
        <div className="flex flex-col">
          {entries.map((e) => (
            <AnomalyRow key={e.id} entry={e} />
          ))}
        </div>
      )}
    </>
  );
}

function AnomalyRow({ entry }: { entry: LogEntry }) {
  const ts = new Date(entry.ts);
  const tone =
    entry.kind === "step.failed" || entry.kind === "error"
      ? "var(--c-err)"
      : "oklch(0.5 0.14 75)";
  const kindLabel =
    entry.kind === "step.failed"
      ? "✗ step.failed"
      : entry.kind === "error"
        ? "✗ error"
        : "⚠ anomaly";
  const inner = (
    <div className="border-b border-line cursor-pointer hover:bg-panel" style={{ padding: "8px 16px" }}>
      <div className="flex items-center gap-1.5 mb-0.5 mono text-[10px]">
        <span className="text-ink-4">{ts.toLocaleTimeString(undefined, { hour12: false })}</span>
        <span style={{ color: tone, fontWeight: 600 }}>{kindLabel}</span>
        <span className="text-ink-1 font-semibold truncate" style={{ flex: 1 }}>
          {entry.agent}
        </span>
      </div>
      <div className="text-[11.5px] text-ink-2 leading-snug">{entry.message}</div>
    </div>
  );
  return entry.runId ? (
    <Link href={`/live?run=${encodeURIComponent(entry.runId)}`} className="no-underline">
      {inner}
    </Link>
  ) : (
    inner
  );
}

// ── Helpers ──────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}
