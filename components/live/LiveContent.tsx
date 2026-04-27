"use client";
import React from "react";
import { useApp } from "@/lib/i18n";
import { Ic } from "@/components/shared/Ic";
import { Badge, Btn, StatusDot } from "@/components/shared/atoms";
import { fetchJson } from "@/lib/api/client";
import type { RunsResponse, RunSummary } from "@/lib/api/types";

type RunStatus = "running" | "review" | "ok" | "err";
type Run = {
  id: string;
  job: string;
  started: string;
  dur: string;
  status: RunStatus;
  tokens: string;
  cost: string;
  current?: boolean;
};

type EventKind = "ok" | "warn" | "err" | "tool" | "hitl";

// Map P1 RunStatus (7 values) → legacy /live status enum (4 values).
function liveStatusFor(s: RunSummary["status"]): RunStatus {
  if (s === "running" || s === "paused") return "running";
  if (s === "suspended") return "review";
  if (s === "completed") return "ok";
  return "err"; // failed | timed_out | interrupted
}

function durationFor(r: RunSummary): string {
  const start = new Date(r.startedAt).getTime();
  const end = r.completedAt ? new Date(r.completedAt).getTime() : new Date(r.lastActivityAt).getTime();
  const ms = Math.max(0, end - start);
  const s = Math.floor(ms / 1000);
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function startedFor(r: RunSummary): string {
  const d = new Date(r.startedAt);
  if (isNaN(d.getTime())) return "—";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function LiveContent() {
  const { t } = useApp();
  const [liveRuns, setLiveRuns] = React.useState<Run[] | null>(null);
  const [partialFlag, setPartialFlag] = React.useState(false);

  React.useEffect(() => {
    fetchJson<RunsResponse>("/api/runs?limit=6")
      .then((res) => {
        if (res.meta.partial?.includes("ws")) setPartialFlag(true);
        if (res.runs.length === 0) {
          // No runs yet — keep using mock so the demo still shows shape
          setLiveRuns(null);
          return;
        }
        const mapped: Run[] = res.runs.map((r, i) => ({
          id: r.id,
          job: `${r.triggerData.client} · ${r.triggerData.jdId}`,
          started: startedFor(r),
          dur: durationFor(r),
          status: liveStatusFor(r.status),
          tokens: "—",
          cost: "—",
          current: i === 0,
        }));
        setLiveRuns(mapped);
      })
      .catch(() => setPartialFlag(true));
  }, []);

  const mockRuns: Run[] = [
    { id: "RUN-J2041", job: "工行 · 高级后端工程师 · 上海", started: "14:02", dur: "00:04:21", status: "running", tokens: "1.82M", cost: "¥12.41", current: true },
    { id: "RUN-J2040", job: "平安 · ML 工程师 · 远程", started: "13:58", dur: "00:02:14", status: "review", tokens: "612k", cost: "¥4.80" },
    { id: "RUN-J2039", job: "微众 · 产品设计师 · 北京", started: "13:41", dur: "00:03:02", status: "ok", tokens: "841k", cost: "¥5.32" },
    { id: "RUN-J2038", job: "字节 · 前端工程师 · 深圳", started: "13:33", dur: "00:01:48", status: "ok", tokens: "412k", cost: "¥3.12" },
    { id: "RUN-J2037", job: "滴滴 · 增长 PM · 远程", started: "13:18", dur: "00:04:55", status: "err", tokens: "201k", cost: "¥1.88" },
    { id: "RUN-J2036", job: "阿里 · 数据科学家 · 杭州", started: "13:02", dur: "00:02:40", status: "ok", tokens: "722k", cost: "¥4.44" },
  ];

  const lanes: { agent: string; events: { s: number; e: number; kind: EventKind; label: string }[] }[] = [
    { agent: "ReqSync", events: [
      { s: 0, e: 4, kind: "ok", label: "RMS.pull · JD-2041" },
      { s: 4, e: 7, kind: "ok", label: "REQUIREMENT_SYNCED" },
    ] },
    { agent: "ReqAnalyzer", events: [
      { s: 7, e: 14, kind: "ok", label: "LLM.extract·技能+薪资" },
      { s: 14, e: 18, kind: "warn", label: "缺失: 年限下限" },
    ] },
    { agent: "HSM · 人工", events: [{ s: 18, e: 22, kind: "hitl", label: "CLARIFICATION_RETRY" }] },
    { agent: "JDGenerator", events: [
      { s: 22, e: 32, kind: "ok", label: "LLM.generateJD" },
      { s: 32, e: 36, kind: "tool", label: "compliance.lint" },
    ] },
    { agent: "Publisher", events: [
      { s: 36, e: 42, kind: "ok", label: "前程无忧·51·智联" },
      { s: 42, e: 46, kind: "err", label: "BOSS API 429" },
      { s: 46, e: 50, kind: "ok", label: "retry·恢复" },
    ] },
    { agent: "ResumeParser", events: [{ s: 50, e: 64, kind: "ok", label: "parse 3102 · OCR+LLM" }] },
    { agent: "Matcher", events: [
      { s: 64, e: 76, kind: "ok", label: "硬性+加分+负向" },
      { s: 76, e: 78, kind: "warn", label: "低置信: 12" },
    ] },
    { agent: "AIInterviewer", events: [
      { s: 78, e: 90, kind: "ok", label: "conduct 88 · voice" },
      { s: 90, e: 92, kind: "err", label: "audio.jitter" },
    ] },
    { agent: "Evaluator", events: [{ s: 92, e: 96, kind: "ok", label: "rubric + bias check" }] },
    { agent: "PackageBuilder", events: [{ s: 96, e: 100, kind: "hitl", label: "等待 HSM 审批" }] },
  ];

  const decisions = [
    { t: "14:06:12", agent: "Matcher", type: "decision" as const, text: "CAND-8821 匹配度 0.92 · 硬性 5/6 · 加分 +12 (Spring Cloud + 金融背景)。进入 AI 面试。", conf: 0.92 },
    { t: "14:06:09", agent: "Matcher", type: "tool" as const, text: "调用 LLM.classify(model=haiku-4-5, tokens=4,218) · scoring rubric v3.2", conf: null },
    { t: "14:06:04", agent: "AIInterviewer", type: "anomaly" as const, text: "音频抖动超过阈值 320ms，已自动重连。候选人体验评分下降 0.12。", conf: null },
    { t: "14:05:58", agent: "AIInterviewer", type: "decision" as const, text: "候选人对『分布式事务』的回答置信度 0.61，追加 1 个场景题。", conf: 0.71 },
    { t: "14:05:41", agent: "ResumeParser", type: "decision" as const, text: "12 份简历置信度 <0.6 (模糊字段)，标记 RESUME_LOCKED_PENDING · 待人工复核。", conf: 0.58 },
    { t: "14:05:22", agent: "Publisher", type: "tool" as const, text: "渠道发布 · 前程/智联/猛聘/BOSS · 4 个渠道 · CHANNEL_PUBLISHED", conf: null },
    { t: "14:05:08", agent: "Publisher", type: "anomaly" as const, text: "BOSS 直聘返回 429 Too Many Requests · 退避 2s 重试 · 恢复。", conf: null },
    { t: "14:04:51", agent: "JDGenerator", type: "decision" as const, text: "生成 4 条渠道变体 (前程/智联/猛聘/BOSS)，合规预检 ✓。JD_GENERATED。", conf: 0.94 },
    { t: "14:04:11", agent: "ReqAnalyzer", type: "decision" as const, text: "检测到缺失关键字段：年限下限 · 触发 CLARIFICATION_RETRY → HSM。", conf: 0.88 },
    { t: "14:03:04", agent: "ReqSync", type: "tool" as const, text: "拉取客户 RMS 职位 JD-2041 · rev=42 · REQUIREMENT_SYNCED", conf: null },
  ];

  const trace = [
    { lv: 0, label: "run.start", detail: "RUN-J2041 · workflow: Client→Submit v4.2", t: "+0.00s" },
    { lv: 1, label: "ReqSync.execute", detail: "input: {client_id:ICBC, job_id:JD-2041}", t: "+0.04s" },
    { lv: 2, label: "tool: rms.pull", detail: "REQUIREMENT_SYNCED · 812ms", t: "+0.86s" },
    { lv: 1, label: "ReqAnalyzer.execute", detail: "ANALYSIS_COMPLETED · completeness=0.83", t: "+18.1s" },
    { lv: 2, label: "⚠ CLARIFICATION_RETRY", detail: "missing: years_min → HSM queue", t: "+22.3s" },
    { lv: 1, label: "JDGenerator.execute", detail: "JD_GENERATED · 4 channel variants", t: "+1m 12s" },
    { lv: 1, label: "Publisher.execute", detail: "CHANNEL_PUBLISHED · 51Job+Zhilian+Liepin", t: "+1m 56s" },
    { lv: 2, label: "⚠ channel.boss 429", detail: "retry · recovered", t: "+2m 11s" },
    { lv: 1, label: "ResumeParser.execute", detail: "3102 parsed · OCR+LLM", t: "+2m 50s" },
    { lv: 1, label: "Matcher.execute", detail: "2802 scored · top 88", t: "+3m 04s" },
    { lv: 1, label: "AIInterviewer.execute", detail: "88 conducted · voice mode", t: "+3m 42s" },
    { lv: 2, label: "⚠ audio.jitter", detail: "320ms > 280ms threshold · recovered", t: "+4m 01s" },
  ];

  return (
    <div className="flex-1 grid min-h-0" style={{ gridTemplateColumns: "260px 1fr 320px" }}>
      {/* run list */}
      <aside className="border-r border-line bg-surface flex flex-col min-h-0">
        <div className="border-b border-line flex items-center gap-2" style={{ padding: "12px 14px" }}>
          <div className="flex-1 text-[13px] font-semibold">{t("nav_runs")}</div>
          {partialFlag ? (
            <Badge variant="warn" dot>{t("ui_partial_data")}</Badge>
          ) : (
            <Badge variant="info" dot>{t("realtime")}</Badge>
          )}
        </div>
        <div className="border-b border-line flex gap-1.5" style={{ padding: "8px 10px" }}>
          <Btn size="sm" style={{ flex: 1 }}>全部</Btn>
          <Btn size="sm" variant="ghost">运行中</Btn>
          <Btn size="sm" variant="ghost">失败</Btn>
        </div>
        <div className="flex-1 overflow-auto">
          {(liveRuns ?? mockRuns).map((r) => (
            <div
              key={r.id}
              className="cursor-pointer border-b border-line"
              style={{
                padding: "12px 14px",
                background: r.current ? "var(--c-accent-bg)" : "transparent",
                borderLeft: r.current ? "2px solid var(--c-accent)" : "2px solid transparent",
              }}
            >
              <div className="flex items-center mb-1">
                <span
                  className="mono text-[11px] font-semibold"
                  style={{ color: r.current ? "var(--c-accent)" : "var(--c-ink-3)" }}
                >
                  {r.id}
                </span>
                <div className="flex-1" />
                <StatusDot kind={r.status === "running" ? "ok" : r.status === "err" ? "err" : r.status === "review" ? "warn" : "info"} />
              </div>
              <div className="text-[12.5px] font-medium mb-0.5 leading-snug">{r.job}</div>
              <div className="mono text-ink-3 text-[10.5px]">{r.started} · {r.dur} · {r.tokens}</div>
            </div>
          ))}
        </div>
      </aside>

      {/* center: timeline + decisions */}
      <div className="flex flex-col min-h-0 overflow-auto">
        {/* header */}
        <div className="border-b border-line bg-surface" style={{ padding: "16px 22px" }}>
          <div className="flex items-center gap-2 mb-1.5">
            <span className="mono text-[11px] font-semibold text-[color:var(--c-accent)]">RUN-J2041</span>
            <Badge variant="ok" dot pulse>{t("s_running")}</Badge>
            <div className="flex-1" />
            <Btn size="sm" variant="ghost"><Ic.pause /> 暂停</Btn>
            <Btn size="sm" variant="ghost">导出轨迹</Btn>
            <Btn size="sm" variant="danger">中止</Btn>
          </div>
          <div className="text-[17px] font-semibold tracking-tight">工行 · 高级后端工程师 · 上海 · JD-2041</div>
          <div className="text-ink-3 text-[12px] mt-0.5">Workflow: Client→Submit v4.2 · 启动 14:02:41 · 已运行 4m 21s · 当前阶段 PACKAGE_GENERATED→待审批</div>
          <div className="mt-3 grid grid-cols-5 gap-3.5">
            <MiniStat label={t("live_tokens")} value="1.82M" sub="+8.4k/s" />
            <MiniStat label={t("live_latency") + " P50"} value="820ms" sub="→ within SLA" ok />
            <MiniStat label={t("live_decisions")} value="47" sub="3 low-conf" warn />
            <MiniStat label={t("live_tools")} value="128" sub="12 tools" />
            <MiniStat label="成本" value="¥12.41" sub="budget ¥30" ok />
          </div>
        </div>

        {/* timeline */}
        <div className="border-b border-line" style={{ padding: "16px 22px" }}>
          <div className="flex items-center mb-2.5">
            <div className="text-[13px] font-semibold">{t("live_timeline")}</div>
            <span className="hint ml-2.5">swimlane · per agent</span>
            <div className="flex-1" />
            <div className="hint">↕ {lanes.length} agents · ↔ 4m 21s</div>
          </div>
          <Swimlane lanes={lanes} />
        </div>

        {/* decisions */}
        <div className="flex-1 min-h-0 flex flex-col" style={{ padding: "16px 22px" }}>
          <div className="flex items-center mb-2.5">
            <div className="text-[13px] font-semibold">决策流 · Decision stream</div>
            <div className="flex-1" />
            <Btn size="sm" variant="ghost"><Ic.search /> 过滤</Btn>
          </div>
          <div className="border border-line rounded-lg bg-surface overflow-hidden flex-1">
            {decisions.map((d, i) => (
              <DecisionRow key={i} d={d} last={i === decisions.length - 1} />
            ))}
          </div>
        </div>
      </div>

      {/* right: trace + anomaly */}
      <aside className="border-l border-line bg-surface flex flex-col min-h-0">
        <div className="border-b border-line flex items-center" style={{ padding: "12px 16px" }}>
          <div className="text-[13px] font-semibold">{t("live_trace")}</div>
          <div className="flex-1" />
          <Btn size="sm" variant="ghost"><Ic.dots /></Btn>
        </div>
        <div className="flex-1 overflow-auto" style={{ padding: "8px 4px" }}>
          {trace.map((x, i) => (
            <div key={i} className="flex gap-2 items-start" style={{ padding: "4px 12px" }}>
              <span className="mono text-[10px] text-ink-4 w-[52px] flex-shrink-0">{x.t}</span>
              <div className="flex-1 min-w-0">
                <div
                  className="mono text-[11px]"
                  style={{
                    color: x.label.startsWith("⚠") ? "var(--c-err)" : "var(--c-ink-1)",
                    paddingLeft: x.lv * 10,
                  }}
                >
                  {x.label}
                </div>
                <div className="mono text-ink-3 text-[10.5px]" style={{ paddingLeft: x.lv * 10 }}>{x.detail}</div>
              </div>
            </div>
          ))}
        </div>

        {/* anomaly card */}
        <div className="border-t border-line p-3.5">
          <div className="flex items-center mb-2">
            <span className="w-[22px] h-[22px] rounded-sm grid place-items-center bg-[color:var(--c-warn-bg)] text-[color:oklch(0.5_0.14_75)]">
              <Ic.alert />
            </span>
            <span className="text-[13px] font-semibold ml-2">{t("live_anomaly")}</span>
            <div className="flex-1" />
            <Badge variant="warn">{t("al_sev_med")}</Badge>
          </div>
          <div className="text-[12.5px] font-medium mb-0.5">AIInterviewer · 音频抖动</div>
          <div className="text-ink-3 text-[11.5px] leading-snug">
            连续 3 次 ping 超过 280ms 阈值。已自动重连，候选人体验评分下降 0.12。建议检查 WebRTC 边缘节点。
          </div>
          <div className="mt-2.5 flex gap-1.5">
            <Btn size="sm" variant="primary" style={{ flex: 1 }}>{t("live_investigate")}</Btn>
            <Btn size="sm">{t("live_ack")}</Btn>
            <Btn size="sm" variant="ghost">{t("live_suppress")}</Btn>
          </div>
        </div>
      </aside>
    </div>
  );
}

function MiniStat({ label, value, sub, ok, warn }: { label: string; value: string; sub: string; ok?: boolean; warn?: boolean }) {
  const col = warn ? "oklch(0.5 0.14 75)" : ok ? "var(--c-ok)" : "var(--c-ink-3)";
  return (
    <div>
      <div className="hint">{label}</div>
      <div className="font-semibold text-[18px] tracking-tight tabular-nums">{value}</div>
      <div className="mono text-[10.5px]" style={{ color: col }}>{sub}</div>
    </div>
  );
}

function Swimlane({ lanes }: { lanes: { agent: string; events: { s: number; e: number; kind: EventKind; label: string }[] }[] }) {
  const rowH = 34;
  return (
    <div className="border border-line rounded-lg overflow-hidden bg-surface">
      <div className="grid border-b border-line bg-panel" style={{ gridTemplateColumns: "130px 1fr" }}>
        <div className="border-r border-line text-[10.5px] text-ink-4 tracking-[0.06em] uppercase" style={{ padding: "6px 12px" }}>Agent</div>
        <div className="relative h-[22px]">
          {[0, 20, 40, 60, 80, 100].map((p) => (
            <div
              key={p}
              className="absolute text-[10px] text-ink-4 mono"
              style={{ left: `${p}%`, top: 4 }}
            >
              {p === 0 ? "0" : p === 100 ? "4m 21s" : `${Math.round(p * 0.0421 * 60)}s`}
            </div>
          ))}
        </div>
      </div>

      {lanes.map((ln, i) => (
        <div
          key={i}
          className="grid"
          style={{
            gridTemplateColumns: "130px 1fr",
            borderBottom: i < lanes.length - 1 ? "1px solid var(--c-line)" : "0",
          }}
        >
          <div className="flex items-center gap-1.5 text-[12px] border-r border-line bg-panel" style={{ padding: "0 12px" }}>
            <StatusDot kind="ok" />
            <span className="font-medium">{ln.agent}</span>
          </div>
          <div className="relative" style={{ height: rowH }}>
            {[20, 40, 60, 80].map((p) => (
              <div key={p} className="absolute top-0 bottom-0 w-px bg-line opacity-60" style={{ left: `${p}%` }} />
            ))}
            {ln.events.map((ev, j) => {
              const col =
                ev.kind === "ok" ? "var(--c-accent)" :
                ev.kind === "tool" ? "var(--c-info)" :
                ev.kind === "warn" ? "var(--c-warn)" :
                ev.kind === "err" ? "var(--c-err)" :
                ev.kind === "hitl" ? "oklch(0.5 0.14 75)" :
                "var(--c-ink-3)";
              const bg =
                ev.kind === "ok" ? "color-mix(in oklab, var(--c-accent) 18%, transparent)" :
                ev.kind === "tool" ? "var(--c-info-bg)" :
                ev.kind === "warn" ? "var(--c-warn-bg)" :
                ev.kind === "err" ? "var(--c-err-bg)" :
                ev.kind === "hitl" ? "var(--c-warn-bg)" :
                "var(--c-panel)";
              return (
                <div
                  key={j}
                  className="absolute flex items-center rounded-sm text-[10.5px] text-ink-1 whitespace-nowrap overflow-hidden text-ellipsis"
                  style={{
                    left: `${ev.s}%`,
                    width: `calc(${ev.e - ev.s}% - 2px)`,
                    top: 5,
                    bottom: 5,
                    background: bg,
                    border: `1px solid ${col}`,
                    borderLeft: `3px solid ${col}`,
                    padding: "0 6px",
                  }}
                >
                  {ev.label}
                </div>
              );
            })}
            {i === lanes.length - 1 && (
              <div className="absolute top-0 bottom-0 w-0.5 bg-[color:var(--c-accent)]" style={{ left: "96%" }}>
                <div
                  className="absolute anim-pulse"
                  style={{
                    top: -3,
                    left: -4,
                    width: 10,
                    height: 10,
                    borderRadius: "50%",
                    background: "var(--c-accent)",
                    boxShadow: "0 0 0 4px color-mix(in oklab, var(--c-accent) 24%, transparent)",
                  }}
                />
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function DecisionRow({ d, last }: { d: { t: string; agent: string; type: "decision" | "tool" | "anomaly"; text: string; conf: number | null }; last: boolean }) {
  const isAnomaly = d.type === "anomaly";
  const isTool = d.type === "tool";
  const dotCol = isAnomaly ? "var(--c-err)" : isTool ? "var(--c-info)" : "var(--c-accent)";
  return (
    <div
      className="flex items-start gap-3"
      style={{
        padding: "11px 14px",
        borderBottom: last ? "0" : "1px solid var(--c-line)",
      }}
    >
      <span className="mono text-[10.5px] text-ink-4 w-[60px] flex-shrink-0 pt-0.5">{d.t}</span>
      <span
        className="w-2 h-2 rounded-full flex-shrink-0 mt-1.5"
        style={{
          background: dotCol,
          boxShadow: `0 0 0 3px color-mix(in oklab, ${dotCol} 18%, transparent)`,
        }}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-0.5">
          <span className="mono text-[10.5px] text-ink-3">{d.agent}</span>
          <Badge variant={isAnomaly ? "err" : isTool ? "info" : "default"}>
            {isAnomaly ? "异常" : isTool ? "工具" : "决策"}
          </Badge>
          {d.conf != null && (
            <span
              className="mono text-[10.5px]"
              style={{
                color: d.conf >= 0.8 ? "var(--c-ok)" : d.conf >= 0.65 ? "oklch(0.5 0.14 75)" : "var(--c-err)",
              }}
            >
              conf {d.conf.toFixed(2)}
            </span>
          )}
        </div>
        <div className="text-[12.5px] leading-snug">{d.text}</div>
      </div>
    </div>
  );
}
