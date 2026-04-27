"use client";
import React from "react";
import { useApp } from "@/lib/i18n";
import { Ic, IcName } from "@/components/shared/Ic";
import { Badge, Btn, Spark } from "@/components/shared/atoms";
import { fetchJson } from "@/lib/api/client";
import type { AlertsResponse } from "@/lib/api/types";

type AlertRow = {
  id: string;
  title: string;
  rule: string;
  sev: "P1" | "P2" | "P3" | "P4";
  state: "firing" | "ack" | "resolved" | "snoozed";
  started: string;
  duration: string;
  source: string;
  stage: string;
  assignee: string;
  channel: string;
  affected: { runs: number; jobs: number; candidates: number };
  spark: number[];
  desc: string;
  related: string[];
  timeline: { t: string; k: string; by: string; text: string }[];
};

const ALERTS: AlertRow[] = [
  {
    id: "AL-1042",
    title: "ANALYSIS_BLOCKED 速率突增",
    rule: "rate(ANALYSIS_BLOCKED) > 3/min for 5m",
    sev: "P1",
    state: "firing",
    started: "11:04:22",
    duration: "12m 41s",
    source: "ReqAnalyzer",
    stage: "requirement",
    assignee: "周航",
    channel: "feishu · #ops-incident",
    affected: { runs: 18, jobs: 6, candidates: 0 },
    spark: [2, 1, 2, 2, 1, 3, 4, 6, 7, 5, 8, 9],
    desc: "分析阶段连续阻塞，疑似客户 RMS 字段 schema 变更。",
    related: ["SYNC_FAILED_ALERT", "ANALYSIS_BLOCKED", "REQUIREMENT_SYNCED"],
    timeline: [
      { t: "11:04:22", k: "fired", by: "rule-engine", text: "阈值触发：5 分钟内 23 次 BLOCKED" },
      { t: "11:04:25", k: "notify", by: "feishu", text: "通知 #ops-incident · @周航 @值班" },
      { t: "11:05:10", k: "ack", by: "周航", text: "已确认，开始排查 ReqAnalyzer 日志" },
      { t: "11:08:46", k: "note", by: "周航", text: "定位：客户 ATS 端字段 `seniority_level` 改为 enum，未同步映射" },
      { t: "11:12:01", k: "action", by: "周航", text: "降级该客户的 `ReqAnalyzer/v3.2` 到 `v3.1`，等待客户回复" },
    ],
  },
  {
    id: "AL-1041",
    title: "JD 重复检测命中率下降",
    rule: "p95(jd-dedupe.score) < 0.78 for 15m",
    sev: "P2",
    state: "firing",
    started: "10:48:09",
    duration: "28m 04s",
    source: "JDDedupe",
    stage: "jd",
    assignee: "未指派",
    channel: "feishu · #recruit-quality",
    affected: { runs: 4, jobs: 4, candidates: 0 },
    spark: [9, 9, 8, 8, 7, 7, 7, 6, 6, 5, 6, 5],
    desc: "去重模型嵌入分数持续低于阈值，疑似客户提交了大量短描述需求。",
    related: ["JD_GENERATED", "JD_REJECTED"],
    timeline: [
      { t: "10:48:09", k: "fired", by: "rule-engine", text: "P95 score 跌至 0.74" },
      { t: "10:48:14", k: "notify", by: "feishu", text: "通知 #recruit-quality" },
    ],
  },
  {
    id: "AL-1039",
    title: "Inngest 队列 backlog 偏高",
    rule: "queue.depth > 500 for 10m",
    sev: "P3",
    state: "ack",
    started: "10:21:55",
    duration: "54m 18s",
    source: "inngest.queue",
    stage: "system",
    assignee: "刘星",
    channel: "feishu · #infra",
    affected: { runs: 0, jobs: 0, candidates: 0 },
    spark: [3, 4, 5, 6, 7, 8, 8, 7, 7, 6, 6, 6],
    desc: "MatchScorer worker 副本数偏低，已自动扩容 +2。",
    related: ["MATCH_SCORED"],
    timeline: [
      { t: "10:21:55", k: "fired", by: "rule-engine", text: "Backlog = 612" },
      { t: "10:22:30", k: "auto", by: "autoscaler", text: "扩容 MatchScorer · 副本 4 → 6" },
      { t: "10:34:11", k: "ack", by: "刘星", text: "确认，观察自动恢复" },
    ],
  },
  {
    id: "AL-1037",
    title: "面试反馈 SLA 即将逾期",
    rule: "feedback.pending_hours > 36",
    sev: "P3",
    state: "firing",
    started: "09:15:02",
    duration: "1h 41m",
    source: "FeedbackTracker",
    stage: "interview",
    assignee: "陈璐",
    channel: "feishu · #recruit-ops",
    affected: { runs: 12, jobs: 9, candidates: 12 },
    spark: [1, 2, 3, 3, 4, 5, 6, 7, 8, 8, 9, 9],
    desc: "12 位候选人面试反馈超过 36 小时未收回。",
    related: ["INTERVIEW_FEEDBACK_PENDING", "INTERVIEW_COMPLETED"],
    timeline: [
      { t: "09:15:02", k: "fired", by: "rule-engine", text: "12 个 pending feedback" },
      { t: "09:15:08", k: "notify", by: "feishu", text: "通知 #recruit-ops · @陈璐" },
      { t: "09:42:11", k: "ack", by: "陈璐", text: "已开始逐一催办" },
    ],
  },
];

const RULE_CHANNELS: { id: string; label: string; n: number; ic: IcName }[] = [
  { id: "all", label: "全部规则", n: 12, ic: "alert" },
  { id: "event", label: "事件速率", n: 5, ic: "bolt" },
  { id: "quality", label: "模型质量", n: 3, ic: "spark" },
  { id: "sla", label: "SLA · 承诺", n: 2, ic: "clock" },
  { id: "infra", label: "基础设施", n: 1, ic: "cpu" },
  { id: "security", label: "权限与审计", n: 1, ic: "shield" },
];

const SEV_FACETS: { sev: "P1" | "P2" | "P3" | "P4"; n: number; color: string }[] = [
  { sev: "P1", n: 1, color: "var(--c-err)" },
  { sev: "P2", n: 2, color: "oklch(0.6 0.16 35)" },
  { sev: "P3", n: 3, color: "oklch(0.62 0.14 75)" },
  { sev: "P4", n: 1, color: "var(--c-ink-3)" },
];

const ON_CALL = [
  { name: "周航", role: "L2 · ReqOps", status: "primary", shift: "08:00–20:00" },
  { name: "陈璐", role: "L2 · Recruit", status: "primary", shift: "08:00–20:00" },
  { name: "刘星", role: "L3 · Platform", status: "secondary", shift: "今日 全天" },
  { name: "李韵", role: "Commercial", status: "advisory", shift: "工作时间" },
  { name: "Bei", role: "L2 · 夜班", status: "off", shift: "20:00 接班" },
];

const SILENCED = [
  { id: "SIL-08", scope: "stage = jd · severity ≤ P3", until: "+2h", by: "陈璐", reason: "JD 模型 A/B 实验中" },
  { id: "SIL-07", scope: "rule = inngest.queue.depth", until: "+30m", by: "刘星", reason: "扩容观察期" },
];

export function AlertsContent() {
  const [selectedId, setSelectedId] = React.useState("AL-1042");
  const [channel, setChannel] = React.useState("all");
  const [sevFilter, setSevFilter] = React.useState<string | null>(null);
  const [showResolved, setShowResolved] = React.useState(false);
  const [apiAlertCount, setApiAlertCount] = React.useState<number | null>(null);
  const [partial, setPartial] = React.useState(false);

  // P1: fetch live alert count + partial-data state. Detailed rendering
  // (per-alert rich timeline) deferred to P2 — current AlertRow mock has
  // shape richer than /api/alerts can deliver.
  React.useEffect(() => {
    fetchJson<AlertsResponse>("/api/alerts")
      .then((res) => {
        setApiAlertCount(res.alerts.length);
        if (res.meta.partial?.length) setPartial(true);
      })
      .catch(() => setPartial(true));
  }, []);

  const visible = ALERTS.filter((a) => {
    if (!showResolved && a.state === "resolved") return false;
    if (sevFilter && a.sev !== sevFilter) return false;
    return true;
  });
  const selected = ALERTS.find((a) => a.id === selectedId) || visible[0] || ALERTS[0];

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <AlertsSubHeader showResolved={showResolved} setShowResolved={setShowResolved} apiAlertCount={apiAlertCount} partial={partial} />
      <div className="flex-1 grid min-h-0" style={{ gridTemplateColumns: "232px 1fr 320px" }}>
        <AlertsLeftRail channel={channel} setChannel={setChannel} sev={sevFilter} setSev={setSevFilter} />
        <AlertsCenter alerts={visible} selectedId={selected.id} onSelect={setSelectedId} alert={selected} />
        <AlertsRightRail />
      </div>
    </div>
  );
}

function AlertsSubHeader({ showResolved, setShowResolved, apiAlertCount, partial }: { showResolved: boolean; setShowResolved: (b: boolean) => void; apiAlertCount: number | null; partial: boolean }) {
  const { t } = useApp();
  const stats = [
    { l: "firing", v: "4", d: "+1 · 10m", tone: "down" },
    { l: "ack 中", v: "2", d: "MTTA 47s", tone: "up" },
    { l: "今日已解决", v: "9", d: "MTTR 18m", tone: "up" },
    { l: "P1 · 上月", v: "3 → 1", d: "−66%", tone: "up" },
    { l: "noise score", v: "0.12", d: "目标 < 0.2", tone: "up" },
    { l: "on-call 响应率", v: "100%", d: "30 天", tone: "up" },
  ];
  return (
    <div className="border-b border-line bg-surface flex items-center" style={{ padding: "14px 22px", gap: 18 }}>
      <div>
        <div className="text-[15px] font-semibold tracking-tight flex items-center gap-2">
          异常与告警
          {apiAlertCount != null && <Badge variant="info">{apiAlertCount}</Badge>}
          {partial && <Badge variant="warn" dot>{t("ui_partial_data")}</Badge>}
        </div>
        <div className="text-ink-3 text-[12px] mt-px">规则触发 · 自动通知 · 升级跟踪 · 静默与回放</div>
      </div>
      <div
        className="flex-1 grid border-l border-line"
        style={{ gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 14, paddingLeft: 18 }}
      >
        {stats.map((s, i) => (
          <div key={i}>
            <div className="hint">{s.l}</div>
            <div className="text-[16px] font-semibold tracking-tight tabular-nums">{s.v}</div>
            <div
              className="mono text-[10.5px]"
              style={{
                color: s.tone === "up" ? "var(--c-ok)" : s.tone === "down" ? "var(--c-err)" : "var(--c-ink-4)",
              }}
            >
              {s.d}
            </div>
          </div>
        ))}
      </div>
      <label className="flex items-center gap-1.5 text-[12px] text-ink-2">
        <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
        含已解决
      </label>
      <Btn size="sm"><Ic.bell /> 静默规则</Btn>
      <Btn size="sm" variant="primary"><Ic.plus /> 新建规则</Btn>
    </div>
  );
}

function AlertsLeftRail({
  channel,
  setChannel,
  sev,
  setSev,
}: {
  channel: string;
  setChannel: (s: string) => void;
  sev: string | null;
  setSev: (s: string | null) => void;
}) {
  return (
    <div className="border-r border-line bg-bg flex flex-col min-h-0">
      <div style={{ padding: "12px 14px 6px" }}>
        <div className="hint mb-1.5">规则通道</div>
        {RULE_CHANNELS.map((c) => {
          const Icon = Ic[c.ic] || Ic.alert;
          const active = channel === c.id;
          return (
            <div
              key={c.id}
              onClick={() => setChannel(c.id)}
              className="flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer"
              style={{
                background: active ? "var(--c-accent-bg)" : "transparent",
                color: active ? "var(--c-accent)" : "var(--c-ink-2)",
              }}
            >
              <Icon />
              <span className="flex-1">{c.label}</span>
              <span className="mono text-[10.5px]" style={{ color: active ? "var(--c-accent)" : "var(--c-ink-4)" }}>{c.n}</span>
            </div>
          );
        })}
      </div>
      <div className="border-t border-line mt-1.5" style={{ padding: "10px 14px" }}>
        <div className="hint mb-2">严重度</div>
        <div className="flex flex-col gap-1.5">
          {SEV_FACETS.map((s) => {
            const active = sev === s.sev;
            return (
              <button
                key={s.sev}
                onClick={() => setSev(active ? null : s.sev)}
                className="flex items-center gap-2 h-[26px] rounded-md cursor-pointer text-[11.5px] font-medium text-ink-1"
                style={{
                  padding: "0 8px",
                  border: "1px solid " + (active ? s.color : "var(--c-line)"),
                  background: active ? `color-mix(in oklab, ${s.color} 12%, transparent)` : "var(--c-surface)",
                }}
              >
                <span className="w-2 h-2 rounded-sm" style={{ background: s.color }} />
                <span className="flex-1 text-left">{s.sev}</span>
                <span className="mono text-ink-3 text-[11px]">{s.n}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="border-t border-line mt-1.5" style={{ padding: "10px 14px" }}>
        <div className="hint mb-2">视图</div>
        {[
          ["未指派", 1],
          ["我负责", 0],
          ["我订阅", 4],
          ["近 24h", 11],
        ].map(([label, n]) => (
          <div key={label as string} className="flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer text-ink-2 hover:bg-panel">
            <Ic.bookmark />
            <span className="flex-1">{label}</span>
            <span className="mono text-[10.5px] text-ink-4">{n}</span>
          </div>
        ))}
      </div>
      <div className="flex-1" />
      <div className="border-t border-line flex flex-col gap-1.5" style={{ padding: "12px 14px" }}>
        <div className="hint">每分钟噪声</div>
        <Spark values={[0.12, 0.18, 0.10, 0.14, 0.08, 0.16, 0.12, 0.09, 0.11, 0.13, 0.10, 0.12]} h={28} />
        <div className="mono text-[10.5px] text-ink-3">0.12 · 目标 {"<"} 0.2</div>
      </div>
    </div>
  );
}

function SevPill({ sev }: { sev: string }) {
  const map: Record<string, { bg: string; fg: string; label: string }> = {
    P1: { bg: "var(--c-err-bg)", fg: "var(--c-err)", label: "P1" },
    P2: { bg: "color-mix(in oklab, oklch(0.6 0.16 35) 14%, transparent)", fg: "oklch(0.55 0.16 35)", label: "P2" },
    P3: { bg: "var(--c-warn-bg)", fg: "oklch(0.5 0.14 75)", label: "P3" },
    P4: { bg: "color-mix(in oklab, var(--c-ink-3) 14%, transparent)", fg: "var(--c-ink-3)", label: "P4" },
  };
  const m = map[sev] || map.P4;
  return (
    <span
      className="inline-flex items-center h-5 px-[7px] rounded font-medium text-[10.5px] border"
      style={{
        background: m.bg,
        color: m.fg,
        borderColor: `color-mix(in oklab, ${m.fg} 30%, transparent)`,
      }}
    >
      {m.label}
    </span>
  );
}

function StateBadge({ state }: { state: string }) {
  const map: Record<string, { variant: "ok" | "warn" | "err" | "info" | "default"; label: string; pulse: boolean }> = {
    firing: { variant: "err", label: "firing", pulse: true },
    ack: { variant: "info", label: "ack", pulse: false },
    snoozed: { variant: "warn", label: "snoozed", pulse: false },
    resolved: { variant: "ok", label: "resolved", pulse: false },
  };
  const m = map[state] || map.firing;
  return (
    <Badge variant={m.variant} dot pulse={m.pulse}>
      {m.label}
    </Badge>
  );
}

function AlertsCenter({
  alerts,
  selectedId,
  onSelect,
  alert,
}: {
  alerts: AlertRow[];
  selectedId: string;
  onSelect: (id: string) => void;
  alert: AlertRow;
}) {
  return (
    <div className="grid min-h-0" style={{ gridTemplateRows: "minmax(220px, 0.95fr) 1fr" }}>
      <AlertsTable alerts={alerts} selectedId={selectedId} onSelect={onSelect} />
      <AlertDetail a={alert} />
    </div>
  );
}

function AlertsTable({
  alerts,
  selectedId,
  onSelect,
}: {
  alerts: AlertRow[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="border-b border-line bg-surface flex flex-col min-h-0">
      <div className="flex items-center gap-2 border-b border-line" style={{ padding: "10px 14px" }}>
        <div className="text-[13px] font-semibold">当前告警</div>
        <Badge variant="err" dot pulse className="ml-1">4 firing</Badge>
        <div className="flex-1" />
        <div className="flex items-center gap-1.5 text-ink-3 text-[11.5px]">
          <Ic.search />
          <span>搜索告警 / 规则 / 标签…</span>
          <kbd className="ml-1 mono text-[10px] bg-surface border border-line rounded-sm px-1.5 py-[1px] text-ink-3">/</kbd>
        </div>
      </div>
      <div className="flex-1 overflow-auto min-h-0">
        <table className="tbl" style={{ tableLayout: "fixed" }}>
          <colgroup>
            <col style={{ width: 56 }} />
            <col style={{ width: 86 }} />
            <col />
            <col style={{ width: 124 }} />
            <col style={{ width: 96 }} />
            <col style={{ width: 120 }} />
            <col style={{ width: 92 }} />
            <col style={{ width: 96 }} />
            <col style={{ width: 110 }} />
          </colgroup>
          <thead>
            <tr>
              <th>sev</th><th>state</th><th>告警</th><th>规则源</th>
              <th>持续</th><th>影响</th><th>负责人</th><th>趋势</th><th></th>
            </tr>
          </thead>
          <tbody>
            {alerts.map((a) => {
              const active = a.id === selectedId;
              return (
                <tr
                  key={a.id}
                  onClick={() => onSelect(a.id)}
                  style={{ cursor: "pointer", background: active ? "var(--c-accent-bg)" : undefined }}
                >
                  <td><SevPill sev={a.sev} /></td>
                  <td><StateBadge state={a.state} /></td>
                  <td>
                    <div className="font-semibold text-[12.5px] text-ink-1">{a.title}</div>
                    <div className="mono text-[10.5px] text-ink-3 overflow-hidden text-ellipsis whitespace-nowrap">{a.id} · {a.rule}</div>
                  </td>
                  <td>
                    <div className="mono text-[11px]">{a.source}</div>
                    <div className="hint text-[10.5px]">{a.stage}</div>
                  </td>
                  <td>
                    <div className="mono text-[11.5px] tabular-nums">{a.duration}</div>
                    <div className="hint text-[10.5px]">{a.started}</div>
                  </td>
                  <td>
                    <div className="text-[11.5px] text-ink-2">
                      <span className="mono">{a.affected.runs}</span> runs · <span className="mono">{a.affected.jobs}</span> jobs
                    </div>
                    <div className="hint text-[10.5px]">candidates {a.affected.candidates}</div>
                  </td>
                  <td>
                    {a.assignee === "未指派" ? (
                      <Badge variant="warn">{a.assignee}</Badge>
                    ) : (
                      <span className="text-[11.5px]">{a.assignee}</span>
                    )}
                  </td>
                  <td>
                    <Spark
                      values={a.spark.length ? a.spark : [0, 0, 0, 0, 0, 0]}
                      h={22}
                      stroke={a.spark.length ? "var(--c-err)" : "var(--c-ink-4)"}
                    />
                  </td>
                  <td>
                    <div className="flex gap-1">
                      <Btn size="sm" variant="ghost" onClick={(e) => e.stopPropagation()}>ack</Btn>
                      <Btn size="sm" variant="ghost" onClick={(e) => e.stopPropagation()}>snooze</Btn>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AlertDetail({ a }: { a: AlertRow }) {
  const [tab, setTab] = React.useState("timeline");
  const tabs = [
    ["timeline", "时间线"],
    ["events", "关联事件"],
    ["rule", "规则定义"],
    ["runbook", "Runbook"],
  ];
  return (
    <div className="bg-bg flex flex-col min-h-0">
      <div className="border-b border-line bg-surface" style={{ padding: "12px 18px 10px" }}>
        <div className="flex items-center gap-2.5">
          <SevPill sev={a.sev} />
          <StateBadge state={a.state} />
          <div className="text-[14px] font-semibold tracking-tight">{a.title}</div>
          <span className="mono text-ink-3 text-[11.5px]">{a.id}</span>
          <div className="flex-1" />
          <Btn size="sm"><Ic.bell />通知</Btn>
          <Btn size="sm">分配</Btn>
          <Btn size="sm">snooze</Btn>
          <Btn size="sm" variant="primary">resolve</Btn>
        </div>
        <div className="mono text-[11px] text-ink-3 mt-1.5">{a.rule}</div>
        <div className="flex gap-4.5 text-[11.5px] text-ink-2 mt-2" style={{ gap: 18 }}>
          <span>开始 <span className="mono">{a.started}</span></span>
          <span>持续 <span className="mono">{a.duration}</span></span>
          <span>来源 <span className="mono">{a.source}</span></span>
          <span>通道 <span className="mono">{a.channel}</span></span>
          <span>负责 <b>{a.assignee}</b></span>
        </div>
        <div className="flex mt-3 -mb-2.5" style={{ borderBottom: "1px solid transparent" }}>
          {tabs.map(([id, label]) => (
            <button
              key={id as string}
              onClick={() => setTab(id as string)}
              className="cursor-pointer bg-transparent border-0 text-[12px]"
              style={{
                padding: "8px 12px",
                borderBottom: "2px solid " + (tab === id ? "var(--c-ink-1)" : "transparent"),
                color: tab === id ? "var(--c-ink-1)" : "var(--c-ink-3)",
                fontWeight: tab === id ? 600 : 500,
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-auto min-h-0" style={{ padding: "14px 18px" }}>
        {tab === "timeline" && <AlertTimeline a={a} />}
        {tab === "events" && <AlertEvents a={a} />}
        {tab === "rule" && <AlertRule a={a} />}
        {tab === "runbook" && <AlertRunbook a={a} />}
      </div>
    </div>
  );
}

function AlertTimeline({ a }: { a: AlertRow }) {
  const kindMap: Record<string, { color: string; ic: IcName }> = {
    fired: { color: "var(--c-err)", ic: "alert" },
    notify: { color: "var(--c-info)", ic: "bell" },
    ack: { color: "var(--c-info)", ic: "check" },
    note: { color: "var(--c-ink-3)", ic: "edit" },
    action: { color: "var(--c-accent)", ic: "bolt" },
    auto: { color: "var(--c-accent)", ic: "cpu" },
    deploy: { color: "var(--c-accent)", ic: "play" },
    snooze: { color: "oklch(0.62 0.14 75)", ic: "clock" },
    resolved: { color: "var(--c-ok)", ic: "check" },
  };
  return (
    <div>
      <div className="flex gap-3.5 mb-3.5">
        <div className="flex-1 p-3 border border-line rounded-lg bg-surface">
          <div className="hint">影响范围</div>
          <div className="flex gap-[22px] mt-1.5">
            <div><div className="mono text-[18px] font-semibold tabular-nums">{a.affected.runs}</div><div className="hint">runs</div></div>
            <div><div className="mono text-[18px] font-semibold tabular-nums">{a.affected.jobs}</div><div className="hint">jobs</div></div>
            <div><div className="mono text-[18px] font-semibold tabular-nums">{a.affected.candidates}</div><div className="hint">candidates</div></div>
          </div>
          <div className="mt-2 text-[11.5px] text-ink-2">{a.desc}</div>
        </div>
        <div className="w-[280px] p-3 border border-line rounded-lg bg-surface">
          <div className="hint">触发频率 · 12m</div>
          <Spark values={a.spark} h={48} stroke="var(--c-err)" />
          <div className="mono text-[10.5px] text-ink-3 mt-1">peak 9 · last 12 buckets</div>
        </div>
      </div>
      <div className="relative" style={{ paddingLeft: 22 }}>
        <div className="absolute top-1 bottom-1 w-px bg-line" style={{ left: 9 }} />
        {a.timeline.map((e, i) => {
          const m = kindMap[e.k] || kindMap.note;
          const Icon = Ic[m.ic] || Ic.alert;
          return (
            <div key={i} className="relative flex gap-3 mb-3.5">
              <div
                className="absolute grid place-items-center"
                style={{
                  left: -22,
                  top: 0,
                  width: 18,
                  height: 18,
                  borderRadius: "50%",
                  background: "var(--c-bg)",
                  border: "1.5px solid " + m.color,
                  color: m.color,
                }}
              >
                <Icon />
              </div>
              <div className="flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="mono text-[11px] font-semibold" style={{ color: m.color }}>{e.t}</span>
                  <span className="text-[10.5px] text-ink-3 uppercase tracking-[0.06em]">{e.k}</span>
                  <span className="hint">· {e.by}</span>
                </div>
                <div className="text-[12.5px] text-ink-1 mt-0.5">{e.text}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AlertEvents({ a }: { a: AlertRow }) {
  return (
    <div>
      <div className="hint mb-2">关联事件类型 ({a.related.length})</div>
      <div className="flex flex-col gap-2">
        {a.related.length === 0 && <div className="text-ink-3 text-[12px]">无关联事件。规则基于系统度量触发。</div>}
        {a.related.map((name, i) => (
          <div
            key={i}
            className="flex items-center gap-2.5 border border-line rounded-lg bg-surface"
            style={{ padding: 10 }}
          >
            <Ic.bolt />
            <span className="mono font-semibold text-[12px]">{name}</span>
            <div className="flex-1" />
            <Badge variant="info" dot>监听中</Badge>
            <Btn size="sm" variant="ghost">查看 →</Btn>
          </div>
        ))}
      </div>
      <div className="hint mt-4 mb-2">受影响最近 runs</div>
      <table className="tbl">
        <thead><tr><th>run</th><th>workflow</th><th>状态</th><th>触发事件</th><th>用时</th></tr></thead>
        <tbody>
          {[
            ["run_8e21", "client→submit/v4.2", "failed", "REQUIREMENT_SYNCED", "2.4s"],
            ["run_8e1f", "client→submit/v4.2", "failed", "REQUIREMENT_SYNCED", "2.1s"],
            ["run_8e1c", "client→submit/v4.2", "failed", "REQUIREMENT_SYNCED", "1.9s"],
            ["run_8e1a", "human-clarify/v1", "running", "ANALYSIS_BLOCKED", "31s"],
          ].map((r, i) => (
            <tr key={i}>
              <td className="mono">{r[0]}</td>
              <td className="mono">{r[1]}</td>
              <td>
                {r[2] === "failed" ? (
                  <StateBadge state="firing" />
                ) : (
                  <Badge variant="info" dot>running</Badge>
                )}
              </td>
              <td className="mono">{r[3]}</td>
              <td className="mono">{r[4]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AlertRule({ a }: { a: AlertRow }) {
  return (
    <div>
      <div className="hint mb-1.5">规则 (PromQL-like)</div>
      <pre
        className="m-0 rounded-lg mono text-[12px] text-ink-1 whitespace-pre-wrap bg-panel border border-line"
        style={{ padding: 12 }}
      >{`expr: ${a.rule}
for:  5m
labels:
  severity: ${a.sev.toLowerCase()}
  team: req-ops
  source: ${a.source}
annotations:
  summary: "${a.title}"
  runbook_url: https://wiki.internal/runbooks/${a.id.toLowerCase()}
notifications:
  - feishu: ${a.channel}
  - escalate_after: 15m → on-call.secondary
  - escalate_after: 45m → manager`}</pre>
      <div className="grid grid-cols-2 gap-3 mt-3">
        <div className="p-2.5 border border-line rounded-lg bg-surface">
          <div className="hint">最近 7 天触发</div>
          <div className="flex items-baseline gap-1.5 mt-1">
            <span className="mono text-[18px] font-semibold">14</span>
            <span className="text-[color:var(--c-ok)] text-[11px]">−21%</span>
          </div>
          <Spark values={[3, 2, 4, 1, 2, 1, 1]} h={28} />
        </div>
        <div className="p-2.5 border border-line rounded-lg bg-surface">
          <div className="hint">误报率</div>
          <div className="flex items-baseline gap-1.5 mt-1">
            <span className="mono text-[18px] font-semibold">4.3%</span>
            <span className="text-[color:var(--c-ok)] text-[11px]">正常</span>
          </div>
          <div className="hint mt-1">3 / 70 · 30 天</div>
        </div>
      </div>
    </div>
  );
}

function AlertRunbook({ a }: { a: AlertRow }) {
  const steps = [
    { done: true, text: "在 Inngest 控制台过滤 `event:ANALYSIS_BLOCKED`，确认错误集中类型。" },
    { done: true, text: "若错误为 schema 不匹配 → 进入「数据源 → 客户 ATS」查看字段映射变更日志。" },
    { done: false, text: "联系客户技术对接确认字段语义；必要时降级到 ReqAnalyzer/v3.1。" },
    { done: false, text: "更新映射后重放最近 30 分钟的失败 runs。" },
    { done: false, text: "回归绿色后关闭告警并归档 RCA。" },
  ];
  return (
    <div>
      <div className="flex flex-col gap-2">
        {steps.map((s, i) => (
          <div
            key={i}
            className="flex gap-2.5 p-2.5 border border-line rounded-lg"
            style={{
              background: s.done ? "color-mix(in oklab, var(--c-ok) 5%, var(--c-surface))" : "var(--c-surface)",
            }}
          >
            <div
              className="w-[18px] h-[18px] rounded-full grid place-items-center text-white flex-shrink-0"
              style={{
                border: "1.5px solid " + (s.done ? "var(--c-ok)" : "var(--c-line-strong)"),
                background: s.done ? "var(--c-ok)" : "transparent",
                fontSize: 10,
              }}
            >
              {s.done ? "✓" : i + 1}
            </div>
            <div
              className="flex-1 text-[12.5px] text-ink-1 leading-normal"
              style={{ textDecoration: s.done ? "line-through" : "none" }}
            >
              {s.text}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3.5 p-2.5 border-dashed border border-line-strong rounded-lg text-[11.5px] text-ink-3">
        Runbook · <span className="mono">runbooks/{a.id.toLowerCase()}.md</span> · 维护人 平台运营 · 上次更新 3 天前
      </div>
    </div>
  );
}

function AlertsRightRail() {
  return (
    <div className="border-l border-line bg-bg flex flex-col min-h-0">
      <div className="border-b border-line bg-surface" style={{ padding: "12px 14px" }}>
        <div className="text-[13px] font-semibold">On-call · 当值</div>
        <div className="hint mt-0.5">轮值表 / 升级路径 / 静默</div>
      </div>
      <div style={{ padding: "10px 12px" }}>
        {ON_CALL.map((p, i) => {
          const dot = p.status === "primary" ? "var(--c-ok)" : p.status === "secondary" ? "var(--c-info)" : p.status === "advisory" ? "oklch(0.62 0.14 75)" : "var(--c-ink-4)";
          return (
            <div
              key={i}
              className="flex items-center gap-2.5"
              style={{
                padding: "8px 6px",
                borderBottom: i === ON_CALL.length - 1 ? "none" : "1px solid var(--c-line)",
              }}
            >
              <div className="w-[30px] h-[30px] rounded-full bg-panel border border-line flex items-center justify-center text-[12px] font-semibold">
                {p.name[0]}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px] font-semibold">{p.name}</div>
                <div className="hint overflow-hidden text-ellipsis whitespace-nowrap">{p.role} · {p.shift}</div>
              </div>
              <span className="w-2 h-2 rounded-full" style={{ background: dot }} />
            </div>
          );
        })}
      </div>
      <div className="border-t border-line bg-surface" style={{ padding: "10px 14px" }}>
        <div className="text-[12.5px] font-semibold">升级策略</div>
      </div>
      <div className="flex flex-col gap-2" style={{ padding: "10px 14px" }}>
        {[
          ["0 min", "primary", "feishu · 电话"],
          ["+15 min", "secondary", "feishu"],
          ["+45 min", "manager", "短信 · 电话"],
          ["+90 min", "org-wide", "广播"],
        ].map((r, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="mono text-[11px] text-ink-3" style={{ width: 56 }}>{r[0]}</span>
            <Badge>{r[1]}</Badge>
            <span className="text-[11.5px] text-ink-2">→ {r[2]}</span>
          </div>
        ))}
      </div>
      <div className="border-t border-line bg-surface" style={{ padding: "10px 14px" }}>
        <div className="flex items-center gap-1.5">
          <span className="text-[12.5px] font-semibold">静默规则</span>
          <Badge variant="warn" dot>{SILENCED.length}</Badge>
        </div>
      </div>
      <div className="flex flex-col gap-2" style={{ padding: "10px 14px" }}>
        {SILENCED.map((s) => (
          <div key={s.id} className="flex items-start gap-2">
            <span className="mono text-[11px] text-ink-3" style={{ width: 56 }}>{s.id}</span>
            <div className="flex-1 min-w-0">
              <div className="mono text-[11px]">{s.scope}</div>
              <div className="hint">{s.by} · {s.reason}</div>
            </div>
            <Badge variant="info">{s.until}</Badge>
          </div>
        ))}
      </div>
      <div className="flex-1" />
      <div className="border-t border-line flex gap-2" style={{ padding: "10px 14px" }}>
        <Btn size="sm" variant="ghost" style={{ flex: 1 }}><Ic.bell /> 全部静音 1h</Btn>
        <Btn size="sm" variant="ghost" style={{ flex: 1 }}>导出 RCA</Btn>
      </div>
    </div>
  );
}
