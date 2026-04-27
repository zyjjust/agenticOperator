"use client";
import React from "react";
import { useApp } from "@/lib/i18n";
import { Ic } from "@/components/shared/Ic";
import { Badge, Btn, Card, CardHead, Metric, Spark, StatusDot } from "@/components/shared/atoms";
import { fetchJson } from "@/lib/api/client";
import type { AgentsResponse } from "@/lib/api/types";

const fakeSpark = (i: number) => {
  const base = [3, 4, 5, 4, 6, 7, 6, 8, 7, 9, 8, 9, 8, 7, 9, 8];
  return base.map((v, j) => Math.max(1, v + ((i * 3 + j * 2) % 4) - 2));
};

// /fleet legacy row shape (4-status enum). Map RunStatus → legacy.
type LegacyRow = {
  id: string;
  name: string;
  roleK: string;       // i18n key for sublabel
  status: "running" | "review" | "degraded" | "paused";
  owner: string;
  p50: string;
  runs: number;
  success: number | string;
  cost: string;
  last: string;
  ver: string;
  spark: number[];
};

function mapStatus(s: AgentsResponse["agents"][number]["status"]): LegacyRow["status"] {
  if (s === "running") return "running";
  if (s === "suspended") return "review";
  if (s === "failed" || s === "timed_out" || s === "interrupted") return "degraded";
  return "paused"; // null / paused / completed
}

export function FleetContent() {
  const { t } = useApp();
  const [apiAgents, setApiAgents] = React.useState<LegacyRow[] | null>(null);
  const [partial, setPartial] = React.useState(false);

  React.useEffect(() => {
    fetchJson<AgentsResponse>("/api/agents")
      .then((res) => {
        if (res.meta.partial?.includes("ws")) setPartial(true);
        const rows: LegacyRow[] = res.agents.map((a, i) => ({
          id: a.short.toUpperCase().slice(0, 3) + "-" + String(i + 1).padStart(2, "0"),
          name: a.short,
          roleK: a.displayName, // display_<short_lower>
          status: mapStatus(a.status),
          owner: a.ownerTeam,
          p50: a.p50Ms != null ? `${a.p50Ms}ms` : "—",
          runs: a.runs24h,
          success: a.successRate != null ? Number((a.successRate * 100).toFixed(1)) : "—",
          cost: a.costYuan ? `¥${a.costYuan}` : "¥0",
          last: a.lastActivityAt ?? "—",
          ver: a.version,
          spark: a.spark.length === 16 ? a.spark : fakeSpark(i),
        }));
        setApiAgents(rows);
      })
      .catch(() => setPartial(true));
  }, []);

  const metrics = [
    { key: "m_active_agents", value: "11 / 12", delta: "+1", kind: "up" as const },
    { key: "m_runs_24h", value: "9,427", delta: "+22.4%", kind: "up" as const },
    { key: "m_success_rate", value: "94.8%", delta: "+0.6pp", kind: "up" as const },
    { key: "m_hitl_queue", value: "42", delta: "−8", kind: "up" as const, sub: "JD审批 · 推荐包 · 评分分歧" },
    { key: "m_cost_today", value: "¥2,749", delta: "+¥312", kind: "down" as const },
    { key: "m_anomalies", value: "4", delta: "1 new", kind: "down" as const },
  ];

  const agents = [
    { id: "REQ-01", name: "ReqSync", roleK: "agent_req_sync", status: "running", owner: "HSM · 交付", p50: "420ms", runs: 214, success: 99.1, cost: "¥48", last: "刚刚", ver: "v1.4.2", spark: [3, 4, 2, 5, 7, 6, 8, 5, 9, 6, 7, 8, 9, 7, 8, 9] },
    { id: "ANA-02", name: "ReqAnalyzer", roleK: "agent_req_analyzer", status: "running", owner: "HSM · 交付", p50: "1.8s", runs: 204, success: 96.6, cost: "¥182", last: "1m", ver: "v2.1.0", spark: [2, 3, 4, 3, 5, 6, 5, 7, 6, 8, 5, 6, 7, 6, 5, 7] },
    { id: "JDG-03", name: "JDGenerator", roleK: "agent_jd_gen", status: "running", owner: "HSM · 交付", p50: "2.1s", runs: 198, success: 97.3, cost: "¥221", last: "2m", ver: "v1.9.4", spark: [4, 5, 6, 7, 5, 6, 8, 7, 9, 6, 7, 5, 8, 7, 6, 7] },
    { id: "PUB-04", name: "Publisher", roleK: "agent_publisher", status: "degraded", owner: "招聘运营", p50: "3.4s", runs: 187, success: 82.4, cost: "¥64", last: "4m", ver: "v1.2.0", spark: [3, 4, 5, 3, 4, 5, 3, 4, 2, 3, 4, 5, 3, 4, 3, 4] },
    { id: "COL-05", name: "ResumeCollector", roleK: "agent_collector", status: "running", owner: "招聘运营", p50: "680ms", runs: 3284, success: 99.6, cost: "¥58", last: "刚刚", ver: "v3.0.1", spark: [5, 6, 7, 8, 6, 7, 9, 8, 9, 8, 9, 7, 9, 8, 7, 9] },
    { id: "PAR-06", name: "ResumeParser", roleK: "agent_parser", status: "running", owner: "招聘运营", p50: "1.2s", runs: 3102, success: 94.8, cost: "¥412", last: "刚刚", ver: "v2.8.0", spark: [4, 5, 6, 7, 6, 7, 8, 7, 9, 6, 7, 8, 9, 7, 8, 9] },
    { id: "DUP-07", name: "DupeCheck", roleK: "agent_dupe", status: "running", owner: "合规", p50: "280ms", runs: 2941, success: 99.9, cost: "¥36", last: "刚刚", ver: "v1.5.3", spark: [2, 3, 3, 4, 5, 6, 5, 7, 6, 8, 7, 8, 9, 7, 8, 9] },
    { id: "MAT-08", name: "Matcher", roleK: "agent_matcher", status: "running", owner: "招聘运营", p50: "1.6s", runs: 2802, success: 93.1, cost: "¥264", last: "刚刚", ver: "v2.3.1", spark: [3, 4, 5, 4, 6, 7, 6, 8, 7, 9, 8, 9, 8, 7, 9, 8] },
    { id: "ITV-09", name: "AIInterviewer", roleK: "agent_interviewer", status: "review", owner: "技术招聘", p50: "24m", runs: 88, success: 88.6, cost: "¥1,204", last: "6m", ver: "v0.7.2", spark: [1, 2, 2, 3, 4, 3, 5, 4, 6, 5, 7, 6, 5, 4, 3, 4] },
    { id: "EVL-10", name: "Evaluator", roleK: "agent_evaluator", status: "running", owner: "技术招聘", p50: "2.4s", runs: 81, success: 97.5, cost: "¥172", last: "8m", ver: "v1.6.0", spark: [2, 3, 3, 4, 5, 6, 5, 7, 6, 8, 7, 8, 9, 7, 8, 9] },
    { id: "PKG-11", name: "PackageBuilder", roleK: "agent_packager", status: "running", owner: "招聘运营", p50: "3.1s", runs: 64, success: 98.4, cost: "¥88", last: "12m", ver: "v1.1.2", spark: [1, 2, 1, 2, 3, 2, 3, 4, 3, 4, 3, 4, 5, 4, 5, 4] },
    { id: "SUB-12", name: "PortalSubmitter", roleK: "agent_submitter", status: "paused", owner: "招聘运营", p50: "—", runs: 0, success: "—" as any, cost: "¥0", last: "2h", ver: "v2.0.0", spark: [2, 2, 1, 2, 3, 2, 1, 2, 1, 0, 0, 0, 0, 0, 0, 0] },
  ];

  const alerts = [
    { sev: "high", title: "Publisher · 猎聘渠道推送失败率 17.6%", sub: "CHANNEL_PUBLISHED_FAILED · token 校验 401", agent: "PUB-04", time: "6m" },
    { sev: "med", title: "AIInterviewer · 评分置信度 <0.65", sub: "CAND-8821 · JOB-142 建议人工复核", agent: "ITV-09", time: "14m" },
    { sev: "med", title: "ResumeParser · 解析错误率上升", sub: "近 30 分钟 5.2% → 9.8% · RESUME_PARSE_ERROR", agent: "PAR-06", time: "22m" },
    { sev: "low", title: "Matcher · 3 份简历归属冲突", sub: "RESUME_LOCKED_CONFLICT · 另一顾问已锁定", agent: "MAT-08", time: "38m" },
  ];

  const activity = [
    { who: "System", what: "事件 · REQUIREMENT_SYNCED", meta: "JR-2041 · 工行 · 高级后端工程师", t: "2分钟前", kind: "info" as const },
    { who: "Zhang W.", what: "批准 · PACKAGE_APPROVED", meta: "CAND-8790 → JR-1987 · 字节", t: "6分钟前", kind: "ok" as const },
    { who: "System", what: "事件 · JD_APPROVED", meta: "JR-2039 · HSM 李航 审批", t: "11分钟前", kind: "info" as const },
    { who: "System", what: "告警 · CHANNEL_PUBLISHED_FAILED", meta: "猎聘 · JR-2035", t: "28分钟前", kind: "err" as const },
    { who: "Chen Y.", what: "澄清 · CLARIFICATION_READY", meta: "JR-2032 · 补充必备技能 + 薪资带宽", t: "1小时前", kind: "info" as const },
    { who: "System", what: "事件 · APPLICATION_SUBMITTED", meta: "CAND-8731 → 招行招聘门户", t: "2小时前", kind: "ok" as const },
  ];

  const statusBadge = (s: string) => {
    if (s === "running") return <Badge variant="ok" dot pulse>{t("s_running")}</Badge>;
    if (s === "paused") return <Badge dot>{t("s_paused")}</Badge>;
    if (s === "review") return <Badge variant="warn" dot>{t("s_review")}</Badge>;
    if (s === "degraded") return <Badge variant="err" dot pulse>{t("s_degraded")}</Badge>;
    if (s === "failed") return <Badge variant="err" dot>{t("s_failed")}</Badge>;
    return <Badge>{s}</Badge>;
  };

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-auto">
      {/* page header */}
      <div className="flex items-end gap-4 border-b border-line" style={{ padding: "18px 22px 10px" }}>
        <div className="flex-1">
          <div className="text-[18px] font-semibold tracking-tight">{t("fleet_title")}</div>
          <div className="text-ink-3 text-[12px] mt-0.5">{t("fleet_sub")}</div>
        </div>
        <div className="flex items-center gap-2">
          <Btn size="sm"><Ic.clock /> {t("last_24h")} <Ic.chevD /></Btn>
          <Btn size="sm"><Ic.user /> {t("everyone")} <Ic.chevD /></Btn>
          <div className="w-px h-5 bg-line" />
          <Btn size="sm"><Ic.plug /> {t("new_workflow")}</Btn>
          <Btn variant="primary" size="sm"><Ic.plus /> {t("deploy_agent")}</Btn>
        </div>
      </div>

      {/* metric strip */}
      <div className="grid grid-cols-6 gap-px bg-line border-b border-line">
        {metrics.map((m, i) => (
          <div key={i} className="bg-surface" style={{ padding: "14px 18px" }}>
            <Metric label={t(m.key)} value={m.value} delta={m.delta} deltaKind={m.kind} sub={m.sub} />
            <div className="mt-2"><Spark data={fakeSpark(i)} /></div>
          </div>
        ))}
      </div>

      {/* body grid */}
      <div className="grid flex-1 min-h-0" style={{ gridTemplateColumns: "minmax(0, 1fr) 320px" }}>
        {/* agents table */}
        <div className="min-w-0" style={{ padding: "16px 22px" }}>
          <Card>
            <CardHead>
              <h3 className="m-0 text-[13px] font-semibold tracking-tight">{t("fleet_title")}</h3>
              <Badge variant="info">{(apiAgents ?? agents).length}</Badge>
              {partial && <Badge variant="warn" dot>{t("ui_partial_data")}</Badge>}
              <div className="flex-1" />
              <Btn size="sm" variant="ghost"><Ic.search /> {t("filter")}</Btn>
              <Btn size="sm" variant="ghost"><Ic.dots /></Btn>
            </CardHead>
            <div className="overflow-auto">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{t("col_agent")}</th>
                    <th>{t("col_role")}</th>
                    <th>{t("col_status")}</th>
                    <th>24h</th>
                    <th style={{ textAlign: "right" }}>{t("col_runs")}</th>
                    <th style={{ textAlign: "right" }}>{t("col_success")}</th>
                    <th style={{ textAlign: "right" }}>{t("col_p50")}</th>
                    <th style={{ textAlign: "right" }}>{t("col_cost")}</th>
                    <th>{t("col_version")}</th>
                  </tr>
                </thead>
                <tbody>
                  {(apiAgents ?? agents).map((a) => (
                    <tr key={a.id}>
                      <td>
                        <div className="flex items-center gap-2.5">
                          <AgentGlyph id={a.id} />
                          <div>
                            <div className="font-medium">{a.name}</div>
                            <div className="mono text-[10.5px] text-ink-4">{a.id} · {a.owner}</div>
                          </div>
                        </div>
                      </td>
                      <td>{t(a.roleK)}</td>
                      <td>{statusBadge(a.status)}</td>
                      <td style={{ width: 96 }}><Spark data={a.spark} height={22} /></td>
                      <td style={{ textAlign: "right" }} className="mono">{a.runs}</td>
                      <td style={{ textAlign: "right" }} className="mono">
                        {typeof a.success === "number" ? (
                          <span style={{ color: a.success >= 95 ? "var(--c-ok)" : a.success >= 88 ? "var(--c-ink-1)" : "var(--c-err)" }}>
                            {a.success.toFixed(1)}%
                          </span>
                        ) : a.success}
                      </td>
                      <td style={{ textAlign: "right" }} className="mono">{a.p50}</td>
                      <td style={{ textAlign: "right" }} className="mono">{a.cost}</td>
                      <td className="mono" style={{ color: "var(--c-ink-3)" }}>{a.ver}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center text-[11.5px] text-ink-3 border-t border-line" style={{ padding: "8px 14px" }}>
              显示 {(apiAgents ?? agents).length} / {apiAgents ? 22 : 14} · <span className="text-ink-3 ml-1.5">已筛选：所有状态</span>
              <div className="flex-1" />
              <Btn size="sm" variant="ghost">{t("view_all")} <Ic.chev /></Btn>
            </div>
          </Card>

          {/* pipeline strip */}
          <Card className="mt-4">
            <CardHead>
              <h3 className="m-0 text-[13px] font-semibold tracking-tight">{t("pipeline")} · JR-2041 高级后端工程师 · 工行</h3>
              <div className="flex-1" />
              <Badge variant="info">{t("realtime")}</Badge>
            </CardHead>
            <div style={{ padding: "16px 18px" }}>
              <PipelineStrip />
            </div>
          </Card>
        </div>

        {/* right rail */}
        <div className="flex flex-col gap-4" style={{ padding: "16px 22px 16px 0" }}>
          {/* alerts */}
          <Card>
            <CardHead>
              <h3 className="m-0 text-[13px] font-semibold">{t("al_title")}</h3>
              <Badge variant="err">{alerts.length}</Badge>
              <div className="flex-1" />
              <Btn size="sm" variant="ghost">{t("view_all")}</Btn>
            </CardHead>
            <div>
              {alerts.map((a, i) => (
                <div
                  key={i}
                  className="flex gap-2.5 items-start"
                  style={{
                    padding: "12px 14px",
                    borderBottom: i < alerts.length - 1 ? "1px solid var(--c-line)" : "0",
                  }}
                >
                  <div
                    className="w-6 h-6 rounded-md flex-shrink-0 grid place-items-center"
                    style={{
                      background: a.sev === "high" ? "var(--c-err-bg)" : a.sev === "med" ? "var(--c-warn-bg)" : "var(--c-info-bg)",
                      color: a.sev === "high" ? "var(--c-err)" : a.sev === "med" ? "oklch(0.5 0.14 75)" : "var(--c-info)",
                    }}
                  >
                    <Ic.alert />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[12.5px] font-medium leading-snug">{a.title}</div>
                    <div className="text-[11px] text-ink-3 mt-0.5">{a.sub}</div>
                    <div className="mt-2 flex gap-1.5 flex-wrap">
                      <Btn size="sm" variant="ghost" style={{ height: 22, padding: "0 7px", fontSize: 11 }}>{t("live_investigate")}</Btn>
                      <Btn size="sm" variant="ghost" style={{ height: 22, padding: "0 7px", fontSize: 11 }}>{t("live_ack")}</Btn>
                    </div>
                  </div>
                  <div className="mono text-[10.5px] text-ink-4 whitespace-nowrap">{a.time}</div>
                </div>
              ))}
            </div>
          </Card>

          {/* activity feed */}
          <Card>
            <CardHead>
              <h3 className="m-0 text-[13px] font-semibold">活动 · Activity</h3>
              <div className="flex-1" />
              <span className="hint">{t("last_24h")}</span>
            </CardHead>
            <div style={{ padding: "6px 0" }}>
              {activity.map((it, i) => (
                <div key={i} className="flex gap-2.5 items-start" style={{ padding: "8px 14px" }}>
                  <div
                    className="w-1.5 h-1.5 rounded-full flex-shrink-0 mt-[6px]"
                    style={{
                      background: it.kind === "ok" ? "var(--c-ok)" : it.kind === "err" ? "var(--c-err)" : "var(--c-info)",
                    }}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px]">
                      <span className="font-medium">{it.who}</span>
                      {" · "}
                      <span>{it.what}</span>
                    </div>
                    <div className="mono text-[10.5px] text-ink-3 mt-px">{it.meta}</div>
                  </div>
                  <div className="mono text-[10.5px] text-ink-4">{it.t}</div>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <CardHead>
              <h3 className="m-0 text-[13px] font-semibold">合规 · Compliance</h3>
              <div className="flex-1" />
              <Badge variant="ok" dot>100%</Badge>
            </CardHead>
            <div className="grid grid-cols-2 gap-2.5 text-[12px]" style={{ padding: "12px 14px" }}>
              <ComplianceRow label="PII 数据处理" ok />
              <ComplianceRow label="候选人同意" ok />
              <ComplianceRow label="EEO 偏差检测" ok />
              <ComplianceRow label="GDPR 留存" ok />
              <ComplianceRow label="审计覆盖率" ok sub="100%" />
              <ComplianceRow label="权限最小化" ok sub="14 / 14" />
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function ComplianceRow({ label, ok, sub }: { label: string; ok?: boolean; sub?: string }) {
  return (
    <div className="flex items-center gap-2">
      <span
        className="w-4 h-4 rounded-sm grid place-items-center"
        style={{
          background: ok ? "var(--c-ok-bg)" : "var(--c-err-bg)",
          color: ok ? "var(--c-ok)" : "var(--c-err)",
        }}
      >
        {ok ? <Ic.check /> : <Ic.cross />}
      </span>
      <span className="flex-1">{label}</span>
      {sub && <span className="mono text-ink-3 text-[10.5px]">{sub}</span>}
    </div>
  );
}

function AgentGlyph({ id }: { id: string }) {
  const seed = id.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const hues = [255, 210, 155, 75, 25, 320, 175];
  const h = hues[seed % hues.length];
  return (
    <div
      className="w-6 h-6 rounded-md flex-shrink-0 grid place-items-center mono font-semibold"
      style={{
        background: `linear-gradient(135deg, oklch(0.94 0.04 ${h}) 0%, oklch(0.86 0.08 ${h}) 100%)`,
        border: `1px solid oklch(0.80 0.08 ${h})`,
        fontSize: 9.5,
        color: `oklch(0.35 0.10 ${h})`,
        letterSpacing: "0.02em",
      }}
    >
      {id.slice(0, 3)}
    </div>
  );
}

function PipelineStrip() {
  const stages = [
    { label: "需求同步", agent: "ReqSync", count: 24, hitl: false },
    { label: "JD 生成", agent: "JDGenerator", count: 22, hitl: false },
    { label: "渠道发布", agent: "Publisher", count: 20, hitl: false },
    { label: "简历入库", agent: "ResumeParser", count: 3102, hitl: false },
    { label: "人岗匹配", agent: "Matcher", count: 2802, hitl: false },
    { label: "AI 面试", agent: "AIInterviewer", count: 214, hitl: false },
    { label: "综合评估", agent: "Evaluator", count: 88, hitl: false },
    { label: "推荐包", agent: "PackageBuilder", count: 64, hitl: true },
    { label: "已提客户", agent: "PortalSubmitter", count: 42, hitl: false },
  ];
  const max = stages[0].count;
  return (
    <div
      className="grid gap-px bg-line rounded-md overflow-hidden border border-line"
      style={{ gridTemplateColumns: `repeat(${stages.length}, 1fr)` }}
    >
      {stages.map((s, i) => (
        <div
          key={i}
          className="p-2.5"
          style={{ background: s.hitl ? "var(--c-warn-bg)" : "var(--c-surface)" }}
        >
          <div className="text-[10.5px] tracking-[0.04em] uppercase text-ink-3">{s.label}</div>
          <div className="mono text-[18px] font-semibold mt-1 tracking-tight">{s.count.toLocaleString()}</div>
          <div className="h-[3px] bg-line rounded-sm mt-1.5 overflow-hidden">
            <div
              className="h-full rounded-sm"
              style={{
                width: `${(s.count / max) * 100}%`,
                background: s.hitl ? "var(--c-warn)" : "var(--c-accent)",
              }}
            />
          </div>
          <div className="hint mt-1.5">{s.agent}</div>
        </div>
      ))}
    </div>
  );
}
