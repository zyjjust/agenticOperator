"use client";
import React from "react";
import { Ic } from "@/components/shared/Ic";
import { Badge, Btn, EmptyState } from "@/components/shared/atoms";
import { fetchJson } from "@/lib/api/client";
import type { RunSummaryResponse } from "@/app/api/runs/[id]/summary/route";

// AI summary modal for a workflow run, opened from /live's run list.
//
// Run details (steps / agent operations / general agent function) are not
// duplicated here — those live in /workflow (Inspector AI 解读) and in
// /events instance trail. This pane only adds the LLM-generated
// run-scoped narrative on top of statistics that came from prisma.

type Props = {
  runId: string | null;
  jobLabel: string | null;
  onClose: () => void;
};

export function RunSummaryModal({ runId, jobLabel, onClose }: Props) {
  const [resp, setResp] = React.useState<RunSummaryResponse | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const fetchSummary = React.useCallback(async () => {
    if (!runId) return;
    setLoading(true);
    setErr(null);
    try {
      const r = await fetchJson<RunSummaryResponse>(
        `/api/runs/${encodeURIComponent(runId)}/summary`,
        { timeoutMs: 60_000 }, // LLM 6-15s; default 5s would always fail
      );
      setResp(r);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [runId]);

  React.useEffect(() => {
    if (!runId) {
      setResp(null);
      setErr(null);
      return;
    }
    void fetchSummary();
  }, [runId, fetchSummary]);

  React.useEffect(() => {
    if (!runId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [runId, onClose]);

  if (!runId) return null;

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
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-bg border border-line rounded-lg flex flex-col"
        style={{
          width: "min(720px, 96vw)",
          maxHeight: "min(86vh, 800px)",
          boxShadow: "0 24px 64px rgba(0,0,0,0.32)",
        }}
      >
        <div className="border-b border-line bg-surface flex items-start gap-3" style={{ padding: "14px 18px" }}>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <span className="mono text-[13px] font-semibold text-ink-1 break-all">
                {runId}
              </span>
              {resp && (
                <Badge variant={resp.source === "llm" ? "ok" : "info"}>
                  {resp.source === "llm" ? `via ${resp.modelUsed ?? "llm"}` : "fallback (无网关)"}
                </Badge>
              )}
              {resp && (
                <Badge
                  variant={
                    resp.status === "completed"
                      ? "ok"
                      : resp.status === "failed"
                        ? "err"
                        : resp.status === "running"
                          ? "info"
                          : "warn"
                  }
                  dot
                >
                  {resp.status}
                </Badge>
              )}
            </div>
            {jobLabel && (
              <div className="text-[12px] text-ink-2">{jobLabel}</div>
            )}
            <div className="text-[10.5px] text-ink-4 leading-relaxed mt-0.5">
              基于 WorkflowRun + WorkflowStep + AgentActivity 的事实生成。LLM 网关未配置时
              fallback 到统计渲染。Agent 自身的功能解读请在 /workflow 节点 Inspector 查看。
            </div>
          </div>
          <div className="flex gap-1.5 flex-shrink-0">
            <Btn size="sm" variant="ghost" onClick={fetchSummary} disabled={loading} title="重新生成">
              <Ic.bolt />
            </Btn>
            <Btn
              size="sm"
              variant="ghost"
              onClick={async () => {
                await fetch(`/api/runs/${encodeURIComponent(runId)}/summary`, { method: "DELETE" });
                await fetchSummary();
              }}
              disabled={loading}
              title="清缓存重新调用"
            >
              <Ic.sparkle />
            </Btn>
            <Btn size="sm" onClick={onClose}>
              <Ic.cross /> Esc
            </Btn>
          </div>
        </div>

        <div className="flex-1 overflow-auto" style={{ padding: "14px 18px" }}>
          {loading && !resp && (
            <div className="text-ink-3 text-[12px]">AI 正在生成总结…</div>
          )}
          {err && !resp && (
            <EmptyState
              icon={<Ic.alert />}
              title="生成总结失败"
              hint={err}
              variant="warn"
              action={
                <Btn size="sm" onClick={fetchSummary}>
                  重试
                </Btn>
              }
            />
          )}
          {resp && (
            <>
              <div className="grid gap-2 mb-3" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
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
                className="mono text-[11.5px] text-ink-2 bg-panel border border-line rounded-sm whitespace-pre-wrap"
                style={{ padding: 12, lineHeight: 1.55 }}
              >
                {resp.text}
              </div>

              {resp.agentBreakdown.length > 0 && (
                <div className="mt-3">
                  <div className="text-[10.5px] text-ink-4 font-semibold tracking-[0.06em] uppercase mb-1.5">
                    Run-scoped agent 统计
                  </div>
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th style={{ width: 160 }}>agent</th>
                        <th style={{ width: 60 }}>steps</th>
                        <th style={{ width: 60 }}>failed</th>
                        <th style={{ width: 100 }}>耗时</th>
                        <th>最近 narrative</th>
                      </tr>
                    </thead>
                    <tbody>
                      {resp.agentBreakdown.map((row) => (
                        <tr key={row.agentName}>
                          <td className="mono text-[11.5px] font-semibold text-ink-1">{row.agentName}</td>
                          <td className="mono text-[11px] text-ink-2 tabular-nums">{row.steps}</td>
                          <td>
                            {row.failed > 0 ? (
                              <Badge variant="err">{row.failed}</Badge>
                            ) : (
                              <span className="mono text-[11px] text-ink-4">0</span>
                            )}
                          </td>
                          <td className="mono text-[11px] text-ink-2 tabular-nums">
                            {formatStepDuration(row.totalDurationMs)}
                          </td>
                          <td className="text-[11px] text-ink-2 truncate max-w-[280px]" title={row.lastNarrative ?? ""}>
                            {row.lastNarrative ?? "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </div>
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
