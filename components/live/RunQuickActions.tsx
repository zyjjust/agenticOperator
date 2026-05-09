"use client";
import React from "react";
import { Ic } from "@/components/shared/Ic";
import { Badge, Btn } from "@/components/shared/atoms";
import { fetchJson } from "@/lib/api/client";
import type {
  TraceResponse,
  TraceBlock,
  EventLaneEntry,
} from "@/app/api/runs/[id]/trace/route";
import type { RunSummaryResponse } from "@/app/api/runs/[id]/summary/route";

// 4 deterministic quick-action buttons that sit above the trace
// timeline. They answer the most common questions a user has about a
// specific run, WITHOUT requiring a free-form chatbot:
//
//   1. 总结 — calls the existing /api/runs/:id/summary (LLM-backed; cached)
//   2. 为什么慢 — pure template: longest blocks ranked by duration
//   3. 失败根因 — pure template: failed steps + errors collated
//   4. RAAS 干了什么 — outbound forwardToRaas calls + Inngest runs (P2 deepens)
//
// The "no LLM hallucination" property comes from #2/#3/#4 doing zero LLM
// calls — they synthesize an answer from `trace` data using fixed
// rules. #1 reuses the already-citation-friendly summary endpoint.

type Props = {
  runId: string;
  /** Pre-fetched trace from RunTraceTimeline so we don't re-poll. */
  trace: TraceResponse | null;
};

type ActionId = "summary" | "slowness" | "failure" | "raas";

const ACTIONS: Array<{
  id: ActionId;
  label: string;
  hint: string;
  llm: boolean;
}> = [
  { id: "summary", label: "总结", hint: "AI 生成（带 fallback）", llm: true },
  { id: "slowness", label: "为什么慢", hint: "确定性 · 找最长 block", llm: false },
  { id: "failure", label: "失败根因", hint: "确定性 · 列错误项", llm: false },
  { id: "raas", label: "RAAS 干了什么", hint: "确定性 · 列 emit + Inngest run", llm: false },
];

export function RunQuickActions({ runId, trace }: Props) {
  const [active, setActive] = React.useState<ActionId | null>(null);

  return (
    <div className="border border-line rounded-md bg-surface mb-3" style={{ padding: "8px 10px" }}>
      <div className="flex items-center mb-2 gap-2 flex-wrap">
        <span className="text-[10.5px] tracking-[0.06em] uppercase text-ink-4 font-semibold">
          快捷问题
        </span>
        <span className="mono text-[10px] text-ink-4">作用域 · 仅这条 run</span>
        <div className="flex-1" />
        {ACTIONS.map((a) => (
          <button
            key={a.id}
            onClick={() => setActive(active === a.id ? null : a.id)}
            title={a.hint}
            className="bg-transparent border cursor-pointer mono rounded-sm transition-colors"
            style={{
              padding: "3px 9px",
              fontSize: 11,
              borderColor: active === a.id ? "var(--c-accent)" : "var(--c-line)",
              background: active === a.id ? "var(--c-accent-bg)" : "var(--c-panel)",
              color: active === a.id ? "var(--c-accent)" : "var(--c-ink-2)",
              fontWeight: active === a.id ? 600 : 500,
            }}
          >
            {a.llm && <span className="mr-0.5" style={{ color: "var(--c-accent)" }}>✨</span>}
            {a.label}
          </button>
        ))}
      </div>
      {active && (
        <div className="border-t border-line pt-2">
          <ActionBody id={active} runId={runId} trace={trace} />
        </div>
      )}
    </div>
  );
}

function ActionBody({
  id,
  runId,
  trace,
}: {
  id: ActionId;
  runId: string;
  trace: TraceResponse | null;
}) {
  if (id === "summary") return <SummaryBody runId={runId} />;
  if (id === "slowness") return <SlownessBody trace={trace} />;
  if (id === "failure") return <FailureBody trace={trace} />;
  if (id === "raas") return <RaasBody trace={trace} />;
  return null;
}

// ── 1. 总结 (LLM-backed, reuses /api/runs/:id/summary) ───────────────

function SummaryBody({ runId }: { runId: string }) {
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

  if (loading && !resp) {
    return <div className="text-[11.5px] text-ink-3">AI 生成中…</div>;
  }
  if (err && !resp) {
    return <div className="text-[11.5px]" style={{ color: "var(--c-warn)" }}>⚠ {err}</div>;
  }
  if (!resp) return null;
  return (
    <>
      <div className="flex items-center mb-2 gap-2">
        <Badge variant={resp.source === "llm" ? "ok" : "info"}>
          {resp.source === "llm" ? `via ${resp.modelUsed ?? "llm"}` : "fallback"}
        </Badge>
        <Btn size="sm" variant="ghost" onClick={fetchSummary} disabled={loading}>
          <Ic.bolt /> 重新生成
        </Btn>
      </div>
      <pre
        className="mono text-[11.5px] text-ink-2 whitespace-pre-wrap"
        style={{ margin: 0, lineHeight: 1.55 }}
      >
        {resp.text}
      </pre>
    </>
  );
}

// ── 2. 为什么慢 (deterministic) ──────────────────────────────────────

function SlownessBody({ trace }: { trace: TraceResponse | null }) {
  if (!trace) return <Loading />;
  const allBlocks = trace.agentLanes.flatMap((l) =>
    l.blocks.map((b) => ({ agent: l.agent, block: b })),
  );
  const withDuration = allBlocks.filter((x) => typeof x.block.durationMs === "number");
  if (withDuration.length === 0) {
    return (
      <Reason
        title="无可比较的耗时数据"
        body="这条 run 还没有任何带 duration 的 step / 工具调用。"
      />
    );
  }
  const ranked = withDuration
    .slice()
    .sort((a, b) => (b.block.durationMs ?? 0) - (a.block.durationMs ?? 0))
    .slice(0, 5);
  const total = trace.span.durationMs;
  return (
    <>
      <Reason
        title="耗时排名 · top 5 block"
        body={`这条 run 跨度 ${formatDuration(total)}。耗时最长的 block：`}
      />
      <table className="tbl mt-2">
        <thead>
          <tr>
            <th style={{ width: 130 }}>agent</th>
            <th style={{ width: 80 }}>kind</th>
            <th>label</th>
            <th style={{ width: 80 }}>duration</th>
            <th style={{ width: 60 }}>占比</th>
          </tr>
        </thead>
        <tbody>
          {ranked.map(({ agent, block }) => {
            const pct = total > 0 ? ((block.durationMs ?? 0) / total) * 100 : 0;
            return (
              <tr key={block.id}>
                <td className="mono text-[11px] text-ink-1">{agent}</td>
                <td className="mono text-[10.5px] text-ink-3">{block.kind}</td>
                <td className="text-[11px] text-ink-2">{block.label}</td>
                <td className="mono text-[11px] tabular-nums">{formatBlockDur(block.durationMs)}</td>
                <td className="mono text-[10.5px] text-ink-3">{pct.toFixed(1)}%</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <Footnote
        text={
          ranked[0].block.durationMs && ranked[0].block.durationMs / total > 0.5
            ? `主要瓶颈：${ranked[0].agent} · ${ranked[0].block.label}（占总耗时 ${(((ranked[0].block.durationMs ?? 0) / total) * 100).toFixed(1)}%）。`
            : "耗时分布相对均匀；没有明显瓶颈。"
        }
      />
    </>
  );
}

// ── 3. 失败根因 (deterministic) ──────────────────────────────────────

function FailureBody({ trace }: { trace: TraceResponse | null }) {
  if (!trace) return <Loading />;
  const failures = trace.agentLanes.flatMap((l) =>
    l.blocks
      .filter((b) => b.status === "err")
      .map((b) => ({ agent: l.agent, block: b })),
  );
  if (failures.length === 0) {
    return (
      <Reason
        title="未发现失败"
        body={`run 状态: ${trace.run.status}. 没有 step.failed / error / anomaly block。`}
      />
    );
  }
  // Earliest failure first — root cause typically near the start.
  failures.sort((a, b) => a.block.ts - b.block.ts);
  const root = failures[0];
  return (
    <>
      <Reason
        title={`${failures.length} 处异常 · 最早异常发生在 ${root.agent}`}
        body="按时间排序——根因通常是最早那个：后续异常往往是它的余波。"
      />
      <div className="flex flex-col gap-1.5 mt-2">
        {failures.map(({ agent, block }, i) => (
          <FailureRow key={block.id} agent={agent} block={block} root={i === 0} />
        ))}
      </div>
    </>
  );
}

function FailureRow({
  agent,
  block,
  root,
}: {
  agent: string;
  block: TraceBlock;
  root: boolean;
}) {
  return (
    <div
      className="border rounded-sm"
      style={{
        padding: "6px 10px",
        background: root ? "var(--c-err-bg)" : "var(--c-panel)",
        borderColor: root
          ? "color-mix(in oklab, var(--c-err) 40%, transparent)"
          : "var(--c-line)",
      }}
    >
      <div className="flex items-center gap-2 mb-0.5">
        <span className="mono text-[10.5px]" style={{ color: "var(--c-err)" }}>
          {block.kind === "error" ? "✗ error" : block.kind === "anomaly" ? "⚠ anomaly" : "✗ step.failed"}
        </span>
        <span className="mono text-[11px] font-semibold text-ink-1">{agent}</span>
        <span className="mono text-[10px] text-ink-3">
          {new Date(block.ts).toLocaleTimeString(undefined, { hour12: false })}
        </span>
        {root && <Badge variant="err">最早 / 候选根因</Badge>}
      </div>
      <div className="text-[11.5px] text-ink-2 leading-snug">
        {block.message ?? block.label}
      </div>
    </div>
  );
}

// ── 4. RAAS 干了什么 (deterministic, P2 deepens) ─────────────────────

function RaasBody({ trace }: { trace: TraceResponse | null }) {
  if (!trace) return <Loading />;
  // forwardToRaas writes a tool AgentActivity row with toolName "RAAS.forward"
  // — pull those out and pair with eventLane entries when possible.
  const raasForwards = trace.agentLanes.flatMap((l) =>
    l.blocks
      .filter((b) => b.kind === "tool" && b.toolName?.startsWith("RAAS"))
      .map((b) => ({ agent: l.agent, block: b })),
  );
  // Events emitted by AO (those that show up in eventLane) are candidates
  // for RAAS-side processing once forwarded.
  const emittedEvents = trace.eventLane;

  if (raasForwards.length === 0 && emittedEvents.length === 0) {
    return (
      <Reason
        title="未观察到 RAAS 交互"
        body="这条 run 没有调用 forwardToRaas，也没有产生进入 Inngest 总线的事件。"
      />
    );
  }
  return (
    <>
      <Reason
        title={`${raasForwards.length} 次 forwardToRaas · ${emittedEvents.length} 个事件可被 RAAS 订阅`}
        body="RAAS 端实查（/v1/events/{id}/runs on RAAS_INNGEST_URL）需要 VPN，本刀仅展示 AO 端可见的部分。完整的跨系统 trace 在 P2 接通。"
      />
      {raasForwards.length > 0 && (
        <div className="mt-2">
          <div className="text-[10.5px] text-ink-4 font-semibold mb-1">forwardToRaas 调用</div>
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 130 }}>agent</th>
                <th>narrative</th>
                <th style={{ width: 80 }}>at</th>
              </tr>
            </thead>
            <tbody>
              {raasForwards.map(({ agent, block }) => (
                <tr key={block.id}>
                  <td className="mono text-[11px] text-ink-1">{agent}</td>
                  <td className="text-[11px] text-ink-2">{block.message ?? block.label}</td>
                  <td className="mono text-[10.5px] text-ink-3">
                    {new Date(block.ts).toLocaleTimeString(undefined, { hour12: false })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {emittedEvents.length > 0 && (
        <div className="mt-3">
          <div className="text-[10.5px] text-ink-4 font-semibold mb-1">
            可被 RAAS 订阅的事件 · 含本地 Inngest 实查
          </div>
          <table className="tbl">
            <thead>
              <tr>
                <th>event</th>
                <th style={{ width: 90 }}>at</th>
                <th style={{ width: 110 }}>本地 inngest runs</th>
              </tr>
            </thead>
            <tbody>
              {emittedEvents.map((e) => (
                <tr key={e.eventId}>
                  <td className="mono text-[11px] text-ink-1">
                    {e.name}
                    <span className="text-ink-4 ml-1">{e.eventId.slice(0, 8)}…</span>
                  </td>
                  <td className="mono text-[10.5px] text-ink-3">
                    {new Date(e.ts).toLocaleTimeString(undefined, { hour12: false })}
                  </td>
                  <td className="mono text-[10.5px] text-ink-2">
                    {e.inngestRuns.length === 0 ? (
                      <span className="text-ink-4">—</span>
                    ) : (
                      e.inngestRuns.map((r) => `${r.functionId} ${r.status}`).join(" / ")
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// ── shared bits ──────────────────────────────────────────────────────

function Reason({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <div className="text-[12px] font-semibold text-ink-1 mb-1">{title}</div>
      <div className="text-[11.5px] text-ink-3 leading-snug">{body}</div>
    </div>
  );
}

function Footnote({ text }: { text: string }) {
  return (
    <div className="mono text-[10.5px] text-ink-4 mt-2 pt-2 border-t border-line">
      → {text}
    </div>
  );
}

function Loading() {
  return <div className="text-[11.5px] text-ink-3">trace 加载中…</div>;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function formatBlockDur(ms: number | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}
