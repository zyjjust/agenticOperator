"use client";
import React from "react";
import { useApp } from "@/lib/i18n";
import { Ic, IcName } from "@/components/shared/Ic";
import { Badge, Btn } from "@/components/shared/atoms";
import { AgenticToggle } from "@/components/shared/AgenticToggle";
import { WORKFLOW_META } from "@/lib/workflow-meta";
import { fetchJson } from "@/lib/api/client";
import { byShortFunction } from "@/lib/agent-functions";
import type { ExplainResponse } from "@/app/api/agents/[short]/explain/route";
import { LogStream } from "@/components/shared/LogStream";

type ActiveAgentRow = {
  agentName: string;
  type: string;
  narrative: string;
  createdAt: string;
};
type ActiveAgentsResponse = { rows: ActiveAgentRow[] };

type NodeKind = "trigger" | "agent" | "branch" | "hitl" | "guard" | "done";

type NodeDef = {
  id: string;
  kind: NodeKind;
  x: number;
  y: number;
  title: string;
  sub: string;
  icon: IcName;
  status?: "running" | "review" | "degraded";
};

export function WorkflowContent() {
  const { t } = useApp();
  const [selectedId, setSelectedId] = React.useState("jd");

  const nodes: NodeDef[] = [
    { id: "trig", kind: "trigger", x: 20, y: 240, title: "定时同步 / Webhook", sub: "SCHEDULED_SYNC · 客户 RMS", icon: "bolt" },
    { id: "sync", kind: "agent", x: 200, y: 240, title: "ReqSync", sub: t("agent_req_sync") + " → REQUIREMENT_SYNCED", icon: "db", status: "running" },
    { id: "analyze", kind: "agent", x: 380, y: 240, title: "ReqAnalyzer", sub: t("agent_req_analyzer") + " → ANALYSIS_COMPLETED", icon: "sparkle", status: "running" },
    { id: "clarify", kind: "branch", x: 560, y: 240, title: "信息完整?", sub: "缺失字段 / 冲突", icon: "branch" },
    { id: "ask", kind: "hitl", x: 740, y: 360, title: "HSM 澄清", sub: "CLARIFICATION_RETRY", icon: "user" },
    { id: "jd", kind: "agent", x: 740, y: 140, title: "JDGenerator", sub: t("agent_jd_gen") + " → JD_GENERATED", icon: "sparkle", status: "running" },
    { id: "jdappr", kind: "hitl", x: 920, y: 140, title: "HSM 审批 JD", sub: "JD_APPROVED / JD_REJECTED", icon: "shield" },
    { id: "publish", kind: "agent", x: 1100, y: 140, title: "Publisher", sub: t("agent_publisher") + " → CHANNEL_PUBLISHED", icon: "plug", status: "degraded" },
    { id: "collect", kind: "agent", x: 1280, y: 140, title: "ResumeCollector", sub: "RESUME_DOWNLOADED", icon: "db", status: "running" },
    { id: "parse", kind: "agent", x: 1280, y: 240, title: "ResumeParser + DupeCheck", sub: "RESUME_PROCESSED / LOCKED_CONFLICT", icon: "cpu", status: "running" },
    { id: "match", kind: "branch", x: 1100, y: 340, title: "人岗匹配", sub: "Matcher · 硬性 / 加分 / 负向", icon: "branch" },
    { id: "reject", kind: "done", x: 1280, y: 420, title: "归档 · MATCH_FAILED", sub: "黑名单 / 硬性不符", icon: "cross" },
    { id: "itv", kind: "agent", x: 920, y: 340, title: "AIInterviewer", sub: t("agent_interviewer") + " → AI_INTERVIEW_COMPLETED", icon: "sparkle", status: "review" },
    { id: "eval", kind: "agent", x: 740, y: 340, title: "Evaluator", sub: "EVALUATION_PASSED / FAILED", icon: "cpu", status: "running" },
    { id: "pkg", kind: "agent", x: 560, y: 340, title: "PackageBuilder", sub: "PACKAGE_GENERATED · 简历+评估", icon: "book", status: "running" },
    { id: "review", kind: "hitl", x: 380, y: 440, title: "HSM 审核推荐包", sub: "PACKAGE_APPROVED · SLA 4h", icon: "user" },
    { id: "guard", kind: "guard", x: 200, y: 440, title: "合规 & 黑名单", sub: "PII / EEO / Blacklist", icon: "shield" },
    { id: "submit", kind: "agent", x: 20, y: 440, title: "PortalSubmitter", sub: "APPLICATION_SUBMITTED", icon: "mail", status: "running" },
  ];

  const edges = [
    { from: "trig", to: "sync" },
    { from: "sync", to: "analyze" },
    { from: "analyze", to: "clarify" },
    { from: "clarify", to: "jd", label: "OK" },
    { from: "clarify", to: "ask", label: "缺失", dashed: true },
    { from: "ask", to: "analyze", dashed: true },
    { from: "jd", to: "jdappr" },
    { from: "jdappr", to: "publish" },
    { from: "publish", to: "collect" },
    { from: "collect", to: "parse" },
    { from: "parse", to: "match" },
    { from: "match", to: "reject", label: "不符", dashed: true },
    { from: "match", to: "itv", label: "匹配" },
    { from: "itv", to: "eval" },
    { from: "eval", to: "pkg" },
    { from: "pkg", to: "review" },
    { from: "review", to: "guard" },
    { from: "guard", to: "submit" },
  ];

  const sel = nodes.find((n) => n.id === selectedId) || nodes[0];

  // Live agent activity (last 5 min)
  const [recentActivity, setRecentActivity] = React.useState<ActiveAgentRow[]>([]);
  React.useEffect(() => {
    const tick = async () => {
      try {
        const r = await fetchJson<ActiveAgentsResponse>("/api/workflow/active");
        setRecentActivity(r.rows);
      } catch {
        /* keep last */
      }
    };
    tick();
    const id = setInterval(tick, 3000);
    return () => clearInterval(id);
  }, []);
  const activeAgents = new Set(recentActivity.map((r) => r.agentName));

  return (
    <div className="flex-1 flex flex-col min-w-0">
      {/* sub-header */}
      <div className="flex items-center gap-4 border-b border-line bg-surface" style={{ padding: "14px 22px" }}>
        <div className="flex-1">
          <div className="text-[15px] font-semibold tracking-tight">{t("wf_title")}</div>
          <div className="text-ink-3 text-[12px] mt-px">{t("wf_sub")}</div>
        </div>
        <Badge variant={activeAgents.size > 0 ? "ok" : "info"} dot pulse={activeAgents.size > 0}>
          {activeAgents.size > 0 ? `${activeAgents.size} 个 agent 活跃中` : "空闲"}
        </Badge>
        <Badge variant="info">{WORKFLOW_META.version} · {WORKFLOW_META.status}</Badge>
        <div className="w-px h-5 bg-line" />
        <AgenticToggle />
        <div className="w-px h-5 bg-line" />
        <Btn size="sm"><Ic.clock /> 版本历史</Btn>
        <Btn size="sm"><Ic.play /> 试运行</Btn>
        <Btn variant="primary" size="sm">发布</Btn>
      </div>

      {/* work area */}
      <div className="flex-1 grid min-h-0" style={{ gridTemplateColumns: "200px 1fr 300px" }}>
        {/* palette */}
        <aside className="border-r border-line bg-surface overflow-auto">
          <PaletteSection title="触发 · TRIGGERS" items={[
            { icon: "bolt", label: "客户 RMS 同步 / SCHEDULED_SYNC" },
            { icon: "plug", label: "渠道 Webhook (新简历)" },
            { icon: "calendar", label: "定时重扫" },
            { icon: "mail", label: "HSM 手动发起" },
          ]} />
          <PaletteSection title="智能体 · AGENTS" items={[
            { icon: "db", label: "ReqSync" },
            { icon: "sparkle", label: "ReqAnalyzer" },
            { icon: "sparkle", label: "JDGenerator" },
            { icon: "plug", label: "Publisher" },
            { icon: "db", label: "ResumeCollector" },
            { icon: "cpu", label: "ResumeParser" },
            { icon: "cpu", label: "DupeChecker" },
            { icon: "cpu", label: "Matcher" },
            { icon: "sparkle", label: "AIInterviewer" },
            { icon: "cpu", label: "Evaluator" },
            { icon: "book", label: "PackageBuilder" },
            { icon: "mail", label: "PortalSubmitter" },
          ]} />
          <PaletteSection title="控制流 · LOGIC" items={[
            { icon: "branch", label: "分支 (匹配 / 完整性)" },
            { icon: "clock", label: "等待 / 重试" },
            { icon: "user", label: "HSM 审批" },
            { icon: "shield", label: "合规 / 黑名单护栏" },
            { icon: "db", label: "分布式锁" },
          ]} />
          <PaletteSection title="输出 · OUTPUT" items={[
            { icon: "plug", label: "渠道发布 API" },
            { icon: "mail", label: "客户门户提交" },
            { icon: "db", label: "写入知识库" },
            { icon: "check", label: "完成 Done" },
          ]} />
        </aside>

        {/* canvas */}
        <div className="relative overflow-hidden bg-panel">
          <div
            className="absolute inset-0"
            style={{
              backgroundImage: "radial-gradient(circle, oklch(0.88 0.006 260) 1px, transparent 1px)",
              backgroundSize: "18px 18px",
              opacity: 0.9,
            }}
          />
          <svg
            viewBox="0 0 1620 560"
            preserveAspectRatio="xMidYMid meet"
            className="absolute inset-0 w-full h-full"
          >
            <defs>
              <marker id="arrowhead-b" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto">
                <path d="M0,0 L0,6 L9,3 z" fill="var(--c-ink-3)" />
              </marker>
              <marker id="arrowhead-b-dim" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto">
                <path d="M0,0 L0,6 L9,3 z" fill="var(--c-ink-4)" />
              </marker>
            </defs>
            {edges.map((e, i) => {
              const a = nodes.find((n) => n.id === e.from);
              const b = nodes.find((n) => n.id === e.to);
              if (!a || !b) return null;
              const ax = a.x + 140;
              const ay = a.y + 34;
              const bx = b.x;
              const by = b.y + 34;
              const mid = (ax + bx) / 2;
              const d = `M ${ax} ${ay} C ${mid} ${ay}, ${mid} ${by}, ${bx} ${by}`;
              return (
                <g key={i}>
                  <path
                    d={d}
                    stroke={e.dashed ? "var(--c-ink-4)" : "var(--c-ink-3)"}
                    strokeWidth="1.5"
                    strokeDasharray={e.dashed ? "4 4" : "none"}
                    fill="none"
                    markerEnd={e.dashed ? "url(#arrowhead-b-dim)" : "url(#arrowhead-b)"}
                  />
                  {e.label && (
                    <g transform={`translate(${mid} ${(ay + by) / 2 - 2})`}>
                      <rect x="-16" y="-10" width="32" height="18" rx="9" fill="var(--c-surface)" stroke="var(--c-line)" />
                      <text x="0" y="3" textAnchor="middle" fontSize="10" fontFamily="var(--f-mono)" fill="var(--c-ink-2)">{e.label}</text>
                    </g>
                  )}
                </g>
              );
            })}
            {/* animated packet */}
            <circle r="4" fill="var(--c-accent)">
              <animateMotion dur="5s" repeatCount="indefinite" path="M 160 274 L 340 274 L 520 274 L 700 274" />
              <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.1;0.9;1" dur="5s" repeatCount="indefinite" />
            </circle>

            {nodes.map((n) => (
              <WFNode key={n.id} node={n} selected={n.id === selectedId} onSelect={() => setSelectedId(n.id)} />
            ))}
          </svg>

          {/* canvas chrome */}
          <div className="absolute top-3 left-3 flex gap-1.5 bg-surface border border-line rounded-md p-[3px] shadow-sh-1">
            <Btn size="sm" variant="ghost" style={{ height: 22, width: 22, padding: 0 }} title="undo">↶</Btn>
            <Btn size="sm" variant="ghost" style={{ height: 22, width: 22, padding: 0 }} title="redo">↷</Btn>
          </div>
          <div className="absolute bottom-3 left-3 flex gap-1.5 items-center bg-surface border border-line rounded-md mono text-[11px] text-ink-3 shadow-sh-1" style={{ padding: "3px 8px" }}>
            <Btn size="sm" variant="ghost" style={{ height: 22, width: 22, padding: 0 }}>−</Btn>
            <span>84%</span>
            <Btn size="sm" variant="ghost" style={{ height: 22, width: 22, padding: 0 }}>+</Btn>
            <span className="w-px h-3 bg-line mx-1" />
            <span>fit</span>
          </div>
          <div className="absolute bottom-3 right-3 bg-surface border border-line rounded-md text-[11px] text-ink-3 shadow-sh-1 flex gap-2.5 items-center" style={{ padding: "6px 10px" }}>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-accent-bg border border-accent-line" /> 触发</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-white border border-line-strong" /> 智能体</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-[color:var(--c-warn-bg)] border border-[color:color-mix(in_oklab,var(--c-warn)_40%,transparent)]" /> 人工</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-[color:var(--c-ok-bg)] border border-[color:color-mix(in_oklab,var(--c-ok)_30%,transparent)]" /> 护栏</span>
          </div>
        </div>

        {/* inspector */}
        <aside className="border-l border-line bg-surface flex flex-col min-h-0">
          <Inspector node={sel} />
        </aside>
      </div>
    </div>
  );
}

function PaletteSection({ title, items }: { title: string; items: { icon: IcName; label: string }[] }) {
  return (
    <div style={{ padding: "12px 10px 4px" }}>
      <div className="text-[10.5px] tracking-[0.06em] uppercase text-ink-4 font-semibold" style={{ padding: "4px 6px 8px" }}>
        {title}
      </div>
      <div className="flex flex-col gap-0.5">
        {items.map((it, i) => {
          const Icon = Ic[it.icon];
          return (
            <div
              key={i}
              className="flex items-center gap-2 px-2 py-1.5 rounded-md text-[12.5px] cursor-grab text-ink-2 hover:bg-panel"
            >
              <span className="text-ink-3"><Icon /></span>
              <span>{it.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WFNode({
  node,
  selected,
  onSelect,
}: {
  node: NodeDef;
  selected: boolean;
  onSelect: () => void;
}) {
  const w = 140;
  const h = 68;
  const style = (() => {
    switch (node.kind) {
      case "trigger": return { fill: "var(--c-accent-bg)", stroke: "var(--c-accent-line)", accent: "var(--c-accent)" };
      case "hitl": return { fill: "var(--c-warn-bg)", stroke: "color-mix(in oklab, var(--c-warn) 40%, transparent)", accent: "oklch(0.5 0.14 75)" };
      case "guard": return { fill: "var(--c-ok-bg)", stroke: "color-mix(in oklab, var(--c-ok) 30%, transparent)", accent: "var(--c-ok)" };
      case "branch": return { fill: "var(--c-panel)", stroke: "var(--c-line-strong)", accent: "var(--c-ink-2)" };
      case "done": return { fill: "var(--c-raised)", stroke: "var(--c-line-strong)", accent: "var(--c-ink-3)" };
      default: return { fill: "var(--c-surface)", stroke: "var(--c-line-strong)", accent: "var(--c-ink-1)" };
    }
  })();
  const statusDot = node.status === "running" ? "var(--c-ok)"
    : node.status === "review" ? "var(--c-warn)"
    : node.status === "degraded" ? "var(--c-err)"
    : null;
  const Icon = Ic[node.icon];
  return (
    <g transform={`translate(${node.x} ${node.y})`} style={{ cursor: "pointer" }} onClick={onSelect}>
      {selected && (
        <rect x="-5" y="-5" width={w + 10} height={h + 10} rx="11" fill="none" stroke="var(--c-accent)" strokeWidth="1.5" strokeDasharray="4 3" opacity="0.8" />
      )}
      <rect x="0" y="0" width={w} height={h} rx="7" fill={style.fill} stroke={style.stroke} strokeWidth="1" />
      <rect x="0" y="0" width={w} height="3" rx="7" fill={style.accent} />
      <foreignObject x="8" y="10" width="22" height="22">
        <div
          className="w-[22px] h-[22px] rounded-sm grid place-items-center bg-surface border border-line"
          style={{ color: style.accent }}
        >
          <Icon />
        </div>
      </foreignObject>
      <text x="36" y="24" fontSize="12" fontWeight="600" fill="var(--c-ink-1)" style={{ fontFamily: "var(--f-sans)" }}>{node.title}</text>
      <text x="36" y="40" fontSize="10.5" fill="var(--c-ink-3)" style={{ fontFamily: "var(--f-sans)" }}>{node.sub}</text>
      {statusDot && (
        <>
          <circle cx={w - 12} cy="14" r="4" fill={statusDot} opacity="0.2" />
          <circle cx={w - 12} cy="14" r="2.5" fill={statusDot}>
            <animate attributeName="opacity" values="1;0.4;1" dur="2s" repeatCount="indefinite" />
          </circle>
        </>
      )}
      <line x1="0" y1="52" x2={w} y2="52" stroke="var(--c-line)" />
      <text x="10" y="63" fontSize="9.5" fill="var(--c-ink-4)" style={{ fontFamily: "var(--f-mono)" }}>
        {node.kind === "trigger" ? "event · cron"
          : node.kind === "hitl" ? "SLA 4h · HSM"
          : node.kind === "guard" ? "blocks on fail"
          : node.kind === "branch" ? "if / else"
          : node.kind === "done" ? "terminal"
          : "retry 3× · HITL"}
      </text>
      <circle cx="0" cy={h / 2} r="3.5" fill="var(--c-surface)" stroke="var(--c-ink-4)" />
      <circle cx={w} cy={h / 2} r="3.5" fill="var(--c-surface)" stroke="var(--c-ink-4)" />
    </g>
  );
}

// Resolve the AGENT_FUNCTIONS `short` from a workflow node. Node titles
// in the canvas sometimes carry decorations ("ResumeParser + DupeCheck"),
// so try the whole title first, then progressively shorter prefixes.
function resolveAgentShort(node: NodeDef): string | null {
  if (node.kind !== "agent") return null;
  const tries = [
    node.title,
    node.title.split(/\s|\+|·/)[0],
  ].filter(Boolean);
  for (const t of tries) {
    if (byShortFunction(t)) return t;
  }
  return null;
}

function Inspector({ node }: { node: NodeDef }) {
  const { t } = useApp();
  const Icon = Ic[node.icon];
  const agentShort = resolveAgentShort(node);
  return (
    <>
      <div className="border-b border-line" style={{ padding: "14px 16px" }}>
        <div className="hint mb-1">{t("wf_inspector")}</div>
        <div className="flex items-center gap-2">
          <div
            className="w-7 h-7 rounded-md grid place-items-center bg-panel border border-line text-[color:var(--c-accent)]"
          >
            <Icon />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-semibold">{node.title}</div>
            <div className="text-ink-3 text-[11px]">{node.sub}</div>
          </div>
          <Btn size="sm" variant="ghost" style={{ padding: "0 6px" }}><Ic.dots /></Btn>
        </div>
      </div>
      <div className="overflow-auto py-1.5">
        {agentShort && <AgentExplainPanel short={agentShort} />}
        {agentShort && <AgentLogsPanel short={agentShort} />}
        <InspectField label={t("wf_when")} value="event == 'ANALYSIS_COMPLETED' && completeness >= 0.9" mono />
        <InspectField label={t("wf_tools")}>
          <div className="flex flex-wrap gap-1">
            <Badge><Ic.db /> KB.readJob</Badge>
            <Badge><Ic.sparkle /> LLM.generateJD</Badge>
            <Badge><Ic.book /> Template.render</Badge>
            <Badge><Ic.shield /> Compliance.lint</Badge>
          </div>
        </InspectField>
        <InspectField label={t("wf_input")}>
          <pre className="mono text-[11px] bg-panel border border-line rounded-sm text-ink-2 whitespace-pre-wrap m-0" style={{ padding: "8px 10px" }}>
{`{
  job_id, client_id,
  analysis: { skills[], seniority, comp_band },
  hsm_preferences: { tone, channels[] }
}`}
          </pre>
        </InspectField>
        <InspectField label={t("wf_output")}>
          <pre className="mono text-[11px] bg-panel border border-line rounded-sm text-ink-2 whitespace-pre-wrap m-0" style={{ padding: "8px 10px" }}>
{`{
  jd_md, jd_html,
  variants: [channel→title+hook],
  compliance: { pii: bool, eeo_flags[] },
  next: 'JD_GENERATED'
}`}
          </pre>
        </InspectField>
        <InspectField label={t("wf_on_error")}>
          <div className="flex flex-col gap-1.5">
            <OnErrorRow icon="clock" label={t("wf_retry") + " · 指数退避"} kind="ok" />
            <OnErrorRow icon="user" label={t("wf_escalate") + " → HSM 手工撰写"} kind="warn" />
            <OnErrorRow icon="shield" label="合规失败 → CLARIFICATION_RETRY" kind="info" />
          </div>
        </InspectField>
        <InspectField label={t("wf_permissions")}>
          <div className="flex flex-col gap-1.5 text-[12px]">
            <PermRow label="KB · 读取职位分析" scope="read" />
            <PermRow label="KB · 写入 JD 草稿" scope="write" />
            <PermRow label="LLM · 调用生成" scope="write" />
            <PermRow label="Channels · 无直接发布" scope="none" />
          </div>
        </InspectField>
        <InspectField label={t("wf_sla") + " · " + t("wf_policies")}>
          <div className="grid grid-cols-2 gap-2 text-[12px]">
            <KV k={t("unit_ms") + " P95"} v="4800" />
            <KV k={t("concurrency")} v="12" />
            <KV k={t("rate_limit")} v="60/min" />
            <KV k="预算" v="¥0.42 / 次" />
          </div>
        </InspectField>
      </div>
      <div className="border-t border-line flex gap-2 p-3">
        <Btn variant="ghost" style={{ flex: 1 }}>{t("cancel")}</Btn>
        <Btn variant="primary" style={{ flex: 1 }}>{t("save")}</Btn>
      </div>
    </>
  );
}

function InspectField({ label, value, mono, children }: { label: string; value?: string; mono?: boolean; children?: React.ReactNode }) {
  return (
    <div className="border-b border-line" style={{ padding: "10px 16px" }}>
      <div className="text-[10.5px] tracking-[0.06em] uppercase text-ink-4 font-semibold mb-1.5">{label}</div>
      {value && <div className={mono ? "mono text-[11.5px]" : "text-[12.5px]"}>{value}</div>}
      {children}
    </div>
  );
}

function OnErrorRow({ icon, label, kind }: { icon: IcName; label: string; kind: "ok" | "warn" | "info" }) {
  const Icon = Ic[icon];
  const bg = kind === "ok" ? "var(--c-ok-bg)" : kind === "warn" ? "var(--c-warn-bg)" : "var(--c-info-bg)";
  const col = kind === "ok" ? "var(--c-ok)" : kind === "warn" ? "oklch(0.5 0.14 75)" : "var(--c-info)";
  return (
    <div
      className="flex items-center gap-2 rounded-sm text-[12px]"
      style={{
        padding: "6px 8px",
        background: bg,
        border: `1px solid color-mix(in oklab, ${col} 30%, transparent)`,
      }}
    >
      <span style={{ color: col }}><Icon /></span>
      <span>{label}</span>
    </div>
  );
}

function PermRow({ label, scope }: { label: string; scope: "read" | "write" | "none" }) {
  const text = scope === "write" ? "写入" : scope === "read" ? "只读" : "无";
  const variant = scope === "write" ? "warn" : scope === "read" ? "info" : "default";
  return (
    <div className="flex items-center gap-2">
      <span className="flex-1">{label}</span>
      <Badge variant={variant as any}>{text}</Badge>
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex flex-col bg-panel rounded-sm border border-line" style={{ padding: "6px 8px" }}>
      <span className="hint">{k}</span>
      <span className="mono text-[12px] font-medium">{v}</span>
    </div>
  );
}

// Renders the registry-driven snapshot inline, plus a "AI 解读" button that
// lazily fetches /api/agents/:short/explain. The endpoint serves a
// deterministic markdown rendering when no LLM gateway is configured —
// meaning the panel is useful even offline.
function AgentExplainPanel({ short }: { short: string }) {
  const fn = byShortFunction(short);
  const [resp, setResp] = React.useState<ExplainResponse | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  // Reset whenever the inspector switches agents.
  React.useEffect(() => {
    setResp(null);
    setErr(null);
  }, [short]);

  const fetchExplain = React.useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetchJson<ExplainResponse>(
        `/api/agents/${encodeURIComponent(short)}/explain`,
      );
      setResp(r);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [short]);

  if (!fn) return null;

  return (
    <div className="border-b border-line" style={{ padding: "10px 16px" }}>
      <div className="flex items-center mb-2">
        <div className="text-[10.5px] tracking-[0.06em] uppercase text-ink-4 font-semibold flex-1">
          AI 解读
        </div>
        {resp && (
          <Badge variant={resp.source === "llm" ? "ok" : "info"}>
            {resp.source === "llm" ? `via ${resp.modelUsed ?? "llm"}` : "fallback (无网关)"}
          </Badge>
        )}
      </div>

      {/* Always show the registry snapshot — it's instant and grounds the
          UI even before the LLM call returns. */}
      <div className="text-[12.5px] text-ink-1 leading-relaxed mb-2">{fn.summary}</div>
      <div className="grid gap-2 mb-2" style={{ gridTemplateColumns: "1fr" }}>
        <ExplainBlock title="典型操作" items={fn.operations} />
        <ExplainBlock title="调用工具" items={fn.tools} />
        {fn.failureModes && fn.failureModes.length > 0 && (
          <ExplainBlock title="常见失败模式" items={fn.failureModes} muted />
        )}
      </div>

      {!resp && !loading && (
        <Btn size="sm" onClick={fetchExplain} variant="default">
          <Ic.sparkle /> 让 AI 详细解读
        </Btn>
      )}
      {loading && (
        <div className="text-[11px] text-ink-3">AI 正在生成解读…</div>
      )}
      {err && (
        <div className="text-[11px]" style={{ color: "var(--c-warn)" }}>
          ⚠ {err}
        </div>
      )}
      {resp && (
        <div
          className="mono text-[11.5px] text-ink-2 bg-panel border border-line rounded-sm overflow-auto whitespace-pre-wrap"
          style={{ padding: 10, maxHeight: 320, lineHeight: 1.5 }}
        >
          {resp.text}
        </div>
      )}
    </div>
  );
}

// Cross-run activity log filtered to this agent. Renders inside the
// Inspector — `compact` mode keeps it usable in the narrow right rail.
// Auto-polls every 4s; toolbar lets the user pause and search.
function AgentLogsPanel({ short }: { short: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="border-b border-line" style={{ padding: "10px 16px" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full bg-transparent border-0 cursor-pointer flex items-center"
        style={{ padding: 0 }}
      >
        <div className="text-[10.5px] tracking-[0.06em] uppercase text-ink-4 font-semibold flex-1 text-left">
          运行日志 · 跨 run
        </div>
        <span className="mono text-[10px] text-ink-3">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div
          className="mt-2 border border-line rounded-md overflow-hidden bg-surface"
          style={{ height: 360 }}
        >
          <LogStream
            endpoint={`/api/agents/${encodeURIComponent(short)}/activity?limit=100`}
            order="desc"
            hideAgent
            compact
            pollIntervalMs={4000}
            emptyHint={`${short} 还没有写入 AgentActivity 行。日志契约：每个 agent 在做有意义的事时（开始/完成 step、调用工具、决策、异常）应写一条 AgentActivity，rumtime 才能在这里看到。`}
          />
        </div>
      )}
    </div>
  );
}

function ExplainBlock({
  title,
  items,
  muted,
}: {
  title: string;
  items: string[];
  muted?: boolean;
}) {
  return (
    <div>
      <div className="text-[10.5px] text-ink-4 font-semibold mb-1">{title}</div>
      <ul className="text-[12px] text-ink-2 leading-relaxed pl-4 m-0" style={{ listStyle: "disc", opacity: muted ? 0.85 : 1 }}>
        {items.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>
    </div>
  );
}
