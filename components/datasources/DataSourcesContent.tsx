"use client";
import React from "react";
import { useApp } from "@/lib/i18n";
import { Ic, IcName } from "@/components/shared/Ic";
import { Badge, Btn, Spark } from "@/components/shared/atoms";
import { fetchJson } from "@/lib/api/client";
import type { DataSourcesResponse } from "@/lib/api/types";

type SourceStatus = "healthy" | "degraded" | "failing" | "paused" | "pending";

type Source = {
  id: string;
  cat: string;
  name: string;
  vendor: string;
  logo: string;
  color: string;
  status: SourceStatus;
  syncMode: string;
  lastSync: string;
  events_1d: number;
  errs: number;
  latency: string;
  fields: number;
  mapped: number;
  owner: string;
  contractEnd: string;
  desc: string;
};

const SOURCE_CATS: { id: string; label: string; n: number; ic: IcName }[] = [
  { id: "all", label: "全部", n: 24, ic: "grid" },
  { id: "ats", label: "客户 ATS / RMS", n: 6, ic: "plug" },
  { id: "channel", label: "招聘渠道", n: 5, ic: "bolt" },
  { id: "model", label: "模型与向量库", n: 4, ic: "cpu" },
  { id: "messaging", label: "消息与协作", n: 3, ic: "bell" },
  { id: "storage", label: "存储与数据库", n: 4, ic: "book" },
  { id: "identity", label: "身份与权限", n: 2, ic: "key" },
];

const STATUS: Record<SourceStatus, { label: string; dot: string; variant: "ok" | "warn" | "err" | "info" | "default" }> = {
  healthy: { label: "正常", dot: "var(--c-ok)", variant: "ok" },
  degraded: { label: "降级", dot: "oklch(0.62 0.14 75)", variant: "warn" },
  failing: { label: "异常", dot: "var(--c-err)", variant: "err" },
  paused: { label: "暂停", dot: "var(--c-ink-3)", variant: "info" },
  pending: { label: "待授权", dot: "var(--c-info)", variant: "info" },
};

const SOURCES: Source[] = [
  { id: "src-bytedance", cat: "ats", name: "ByteDance · ATS", vendor: "Lever-自研", logo: "BD", color: "oklch(0.55 0.18 255)", status: "healthy", syncMode: "webhook + 5min poll", lastSync: "12s 前", events_1d: 1842, errs: 0, latency: "84ms", fields: 38, mapped: 36, owner: "周航", contractEnd: "2026-08", desc: "字节跳动需求中心 webhook 推送 + 兜底轮询。" },
  { id: "src-meituan", cat: "ats", name: "美团 · 内部 RMS", vendor: "Workday", logo: "MT", color: "oklch(0.65 0.16 35)", status: "degraded", syncMode: "OAuth · 15min poll", lastSync: "3m 前", events_1d: 412, errs: 12, latency: "612ms", fields: 41, mapped: 33, owner: "周航", contractEnd: "2026-04", desc: "Workday SOAP 偶发 504，已开 ticket。" },
  { id: "src-xiaomi", cat: "ats", name: "小米 · MiHire", vendor: "MiHire", logo: "Mi", color: "oklch(0.6 0.18 35)", status: "healthy", syncMode: "REST · 实时 webhook", lastSync: "实时", events_1d: 308, errs: 0, latency: "42ms", fields: 28, mapped: 28, owner: "陈璐", contractEnd: "2027-02", desc: "全字段对齐，无映射缺口。" },
  { id: "src-baidu", cat: "ats", name: "百度 · 招聘云", vendor: "Beisen", logo: "Bd", color: "oklch(0.55 0.16 255)", status: "failing", syncMode: "Webhook v3", lastSync: "1h 前", events_1d: 0, errs: 47, latency: "—", fields: 35, mapped: 30, owner: "周航", contractEnd: "2026-12", desc: "客户端 webhook 证书过期，已通知联系人续签。" },
  { id: "src-tencent", cat: "ats", name: "腾讯 · TCRMS", vendor: "自研", logo: "Tx", color: "oklch(0.6 0.14 145)", status: "pending", syncMode: "尚未授权", lastSync: "—", events_1d: 0, errs: 0, latency: "—", fields: 0, mapped: 0, owner: "李韵", contractEnd: "2026-06", desc: "等待安全合规评审通过。" },
  { id: "src-xhs", cat: "ats", name: "小红书 · HRTalent", vendor: "MoSeeker", logo: "RS", color: "oklch(0.62 0.18 15)", status: "healthy", syncMode: "REST · 30min poll", lastSync: "8m 前", events_1d: 96, errs: 0, latency: "210ms", fields: 24, mapped: 24, owner: "陈璐", contractEnd: "2027-09", desc: "低频，但稳定。" },
  { id: "src-liepin", cat: "channel", name: "猎聘 · 简历库", vendor: "Liepin Open", logo: "LP", color: "oklch(0.6 0.16 35)", status: "healthy", syncMode: "REST · API push", lastSync: "实时", events_1d: 4218, errs: 6, latency: "98ms", fields: 56, mapped: 54, owner: "陈璐", contractEnd: "2026-03", desc: "含主动检索、JD 投放、候选人推送三类接口。" },
  { id: "src-boss", cat: "channel", name: "BOSS 直聘", vendor: "Boss API", logo: "BS", color: "oklch(0.6 0.18 145)", status: "healthy", syncMode: "OAuth · webhook", lastSync: "实时", events_1d: 6790, errs: 18, latency: "76ms", fields: 42, mapped: 41, owner: "陈璐", contractEnd: "2026-11", desc: "主力渠道，每日推送量第一。" },
  { id: "src-zhilian", cat: "channel", name: "智联招聘", vendor: "Zhilian Open", logo: "ZL", color: "oklch(0.6 0.16 255)", status: "degraded", syncMode: "REST · 5min poll", lastSync: "1m 前", events_1d: 1102, errs: 33, latency: "1.2s", fields: 38, mapped: 36, owner: "陈璐", contractEnd: "2026-07", desc: "p95 延迟突增，疑似上游 API 限速。" },
  { id: "src-linkedin", cat: "channel", name: "LinkedIn Recruiter", vendor: "LinkedIn", logo: "in", color: "oklch(0.55 0.16 255)", status: "paused", syncMode: "OAuth", lastSync: "已暂停", events_1d: 0, errs: 0, latency: "—", fields: 32, mapped: 28, owner: "李韵", contractEnd: "2026-05", desc: "等待跨境合规复核，暂停同步 14 天。" },
  { id: "src-maimai", cat: "channel", name: "脉脉 · 人才库", vendor: "Maimai Open", logo: "MM", color: "oklch(0.6 0.18 75)", status: "healthy", syncMode: "REST", lastSync: "21s 前", events_1d: 540, errs: 1, latency: "120ms", fields: 26, mapped: 26, owner: "陈璐", contractEnd: "2027-01", desc: "辅助渠道，覆盖被动候选人。" },
  { id: "src-openai", cat: "model", name: "OpenAI · gpt-4o", vendor: "OpenAI", logo: "AI", color: "oklch(0.6 0.14 145)", status: "healthy", syncMode: "Inference", lastSync: "实时", events_1d: 18420, errs: 14, latency: "640ms", fields: 0, mapped: 0, owner: "刘星", contractEnd: "—", desc: "JD 生成 / 摘要 / 分析。月用量 78%。" },
  { id: "src-claude", cat: "model", name: "Anthropic · Claude", vendor: "Anthropic", logo: "An", color: "oklch(0.7 0.14 35)", status: "healthy", syncMode: "Inference", lastSync: "实时", events_1d: 9128, errs: 2, latency: "510ms", fields: 0, mapped: 0, owner: "刘星", contractEnd: "—", desc: "结构化抽取 / 长文本分析。" },
  { id: "src-bge", cat: "model", name: "BGE-M3 · 嵌入服务", vendor: "自托管", logo: "BG", color: "oklch(0.6 0.14 200)", status: "healthy", syncMode: "Inference", lastSync: "实时", events_1d: 22340, errs: 0, latency: "38ms", fields: 0, mapped: 0, owner: "刘星", contractEnd: "—", desc: "候选人 / JD / 知识库 嵌入。" },
  { id: "src-milvus", cat: "model", name: "Milvus 向量库", vendor: "Zilliz Cloud", logo: "Mv", color: "oklch(0.55 0.18 275)", status: "healthy", syncMode: "持久化", lastSync: "实时", events_1d: 0, errs: 0, latency: "12ms", fields: 0, mapped: 0, owner: "刘星", contractEnd: "2026-12", desc: "candidate_index / jd_index / knowledge_index, 共 1.2 亿向量。" },
  { id: "src-feishu", cat: "messaging", name: "飞书 · 通知 / 审批", vendor: "Lark", logo: "FS", color: "oklch(0.6 0.18 215)", status: "healthy", syncMode: "Webhook + Open API", lastSync: "实时", events_1d: 4280, errs: 1, latency: "84ms", fields: 0, mapped: 0, owner: "刘星", contractEnd: "—", desc: "告警、审批、面试约面、群组同步。" },
  { id: "src-wecom", cat: "messaging", name: "企业微信", vendor: "Tencent", logo: "WX", color: "oklch(0.6 0.18 145)", status: "healthy", syncMode: "Webhook", lastSync: "实时", events_1d: 612, errs: 0, latency: "92ms", fields: 0, mapped: 0, owner: "陈璐", contractEnd: "—", desc: "客户侧通知通道。" },
  { id: "src-email", cat: "messaging", name: "出站邮件 · SMTP", vendor: "AWS SES", logo: "EM", color: "oklch(0.6 0.16 35)", status: "healthy", syncMode: "SMTP", lastSync: "实时", events_1d: 1290, errs: 4, latency: "—", fields: 0, mapped: 0, owner: "刘星", contractEnd: "2026-09", desc: "面试邀请、确认信、Offer。" },
  { id: "src-pg", cat: "storage", name: "Postgres · 主库", vendor: "AWS Aurora", logo: "PG", color: "oklch(0.55 0.18 245)", status: "healthy", syncMode: "Direct", lastSync: "实时", events_1d: 0, errs: 0, latency: "3ms", fields: 0, mapped: 0, owner: "刘星", contractEnd: "—", desc: "Job_Requisition / Candidate / Interview …" },
  { id: "src-ch", cat: "storage", name: "ClickHouse · 分析库", vendor: "Self-hosted", logo: "CH", color: "oklch(0.7 0.16 75)", status: "healthy", syncMode: "CDC · Debezium", lastSync: "实时", events_1d: 0, errs: 0, latency: "—", fields: 0, mapped: 0, owner: "刘星", contractEnd: "—", desc: "事件 + 度量持久化，支撑告警与报表。" },
  { id: "src-s3", cat: "storage", name: "对象存储 · S3", vendor: "AWS", logo: "S3", color: "oklch(0.62 0.16 35)", status: "healthy", syncMode: "Direct", lastSync: "实时", events_1d: 0, errs: 0, latency: "—", fields: 0, mapped: 0, owner: "刘星", contractEnd: "—", desc: "原始简历 / JD / 通话录音 / 模型产物。" },
  { id: "src-kafka", cat: "storage", name: "Kafka · 事件总线", vendor: "MSK", logo: "Kf", color: "oklch(0.55 0.16 0)", status: "healthy", syncMode: "Stream", lastSync: "实时", events_1d: 218400, errs: 12, latency: "8ms", fields: 0, mapped: 0, owner: "刘星", contractEnd: "—", desc: "Inngest 事件持久化通道。" },
  { id: "src-okta", cat: "identity", name: "Okta · SSO", vendor: "Okta", logo: "Ok", color: "oklch(0.55 0.18 245)", status: "healthy", syncMode: "SAML / SCIM", lastSync: "5m 前", events_1d: 38, errs: 0, latency: "—", fields: 0, mapped: 0, owner: "刘星", contractEnd: "2026-10", desc: "全员 SSO + 员工目录同步。" },
  { id: "src-keycloak", cat: "identity", name: "客户子账号 · Keycloak", vendor: "Self-hosted", logo: "KC", color: "oklch(0.55 0.18 280)", status: "healthy", syncMode: "OIDC", lastSync: "实时", events_1d: 14, errs: 0, latency: "—", fields: 0, mapped: 0, owner: "刘星", contractEnd: "—", desc: "客户外部用户 / 面试官登录。" },
];

export function DataSourcesContent() {
  const [cat, setCat] = React.useState("all");
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [apiCount, setApiCount] = React.useState<number | null>(null);
  const [partial, setPartial] = React.useState(false);

  // P1: fetch live count + partial-data state. Detailed per-source rendering
  // (vendor logos, deep tab content) deferred — current Source mock has
  // shape richer than /api/datasources delivers.
  React.useEffect(() => {
    fetchJson<DataSourcesResponse>("/api/datasources")
      .then((res) => {
        setApiCount(res.sources.length);
        if (res.meta.partial?.length) setPartial(true);
      })
      .catch(() => setPartial(true));
  }, []);

  const visible = SOURCES.filter((s) => cat === "all" || s.cat === cat);
  const selected = selectedId ? SOURCES.find((s) => s.id === selectedId) : null;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <DSSubHeader apiCount={apiCount} partial={partial} />
      <div className="flex-1 grid min-h-0" style={{ gridTemplateColumns: "232px 1fr 320px" }}>
        <DSCatRail cat={cat} setCat={setCat} />
        {selected ? (
          <DSDetail s={selected} onBack={() => setSelectedId(null)} />
        ) : (
          <DSGrid sources={visible} onOpen={setSelectedId} />
        )}
        <DSRightRail />
      </div>
    </div>
  );
}

function DSSubHeader({ apiCount, partial }: { apiCount: number | null; partial: boolean }) {
  const { t } = useApp();
  const stats = [
    { l: "已连接", v: "21 / 24", d: "1 待授权 · 2 异常", tone: "muted" },
    { l: "事件 · 1d", v: "262.4k", d: "+8.4%", tone: "up" },
    { l: "错误率", v: "0.06%", d: "目标 < 0.5%", tone: "up" },
    { l: "p95 延迟", v: "184ms", d: "+22ms", tone: "down" },
    { l: "本月支出", v: "¥38,210", d: "−4.1%", tone: "up" },
    { l: "合规审核", v: "2 待处理", d: "Okta · Keycloak", tone: "muted" },
  ];
  return (
    <div className="border-b border-line bg-surface flex items-center" style={{ padding: "14px 22px", gap: 18 }}>
      <div>
        <div className="text-[15px] font-semibold tracking-tight flex items-center gap-2">
          数据源 · 连接器
          {apiCount != null && <Badge variant="info">{apiCount}</Badge>}
          {partial && <Badge variant="warn" dot>{t("ui_partial_data")}</Badge>}
        </div>
        <div className="text-ink-3 text-[12px] mt-px">客户系统 · 渠道 · 模型 · 消息 · 存储 · 身份</div>
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
      <Btn size="sm">导入 Manifest</Btn>
      <Btn size="sm" variant="primary"><Ic.plus /> 新增连接器</Btn>
    </div>
  );
}

function DSCatRail({ cat, setCat }: { cat: string; setCat: (s: string) => void }) {
  return (
    <div className="border-r border-line bg-bg flex flex-col min-h-0">
      <div style={{ padding: "12px 14px 6px" }}>
        <div className="hint mb-1.5">分类</div>
        {SOURCE_CATS.map((c) => {
          const Icon = Ic[c.ic] || Ic.plug;
          const active = cat === c.id;
          return (
            <div
              key={c.id}
              onClick={() => setCat(c.id)}
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
        <div className="hint mb-2">状态</div>
        {[
          ["healthy", "正常", 19, "var(--c-ok)"],
          ["degraded", "降级", 2, "oklch(0.62 0.14 75)"],
          ["failing", "异常", 1, "var(--c-err)"],
          ["paused", "暂停", 1, "var(--c-ink-3)"],
          ["pending", "待授权", 1, "var(--c-info)"],
        ].map(([k, label, n, color]) => (
          <div key={k as string} className="flex items-center gap-2 py-1 text-[12px] text-ink-2">
            <span className="w-2 h-2 rounded-sm" style={{ background: color as string }} />
            <span className="flex-1">{label}</span>
            <span className="mono text-[11px] text-ink-4">{n}</span>
          </div>
        ))}
      </div>
      <div className="flex-1" />
      <div className="border-t border-line" style={{ padding: "12px 14px" }}>
        <div className="hint mb-1">入站速率 · 1h</div>
        <Spark values={[3, 4, 5, 4, 6, 7, 6, 8, 7, 9, 8, 9, 8]} h={36} stroke="var(--c-accent)" />
        <div className="mono text-[10.5px] text-ink-3 mt-1">1,240 evt / min</div>
      </div>
    </div>
  );
}

function DSGrid({ sources, onOpen }: { sources: Source[]; onOpen: (id: string) => void }) {
  return (
    <div className="overflow-auto min-h-0">
      <div
        className="grid gap-3"
        style={{ padding: "16px 22px", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}
      >
        {sources.map((s) => (
          <ConnectorCard key={s.id} s={s} onOpen={() => onOpen(s.id)} />
        ))}
      </div>
    </div>
  );
}

function ConnectorCard({ s, onOpen }: { s: Source; onOpen: () => void }) {
  const st = STATUS[s.status];
  return (
    <div
      onClick={onOpen}
      className="bg-surface border border-line rounded-lg cursor-pointer shadow-sh-1 hover:shadow-sh-2 transition-shadow"
      style={{ padding: 14 }}
    >
      <div className="flex items-center gap-2.5 mb-3">
        <div
          className="w-[34px] h-[34px] rounded-md grid place-items-center text-white font-semibold text-[11px]"
          style={{ background: s.color }}
        >
          {s.logo}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold overflow-hidden text-ellipsis whitespace-nowrap">{s.name}</div>
          <div className="hint overflow-hidden text-ellipsis whitespace-nowrap">{s.vendor}</div>
        </div>
        <Badge variant={st.variant} dot pulse={s.status === "failing"}>{st.label}</Badge>
      </div>
      <div className="grid grid-cols-3 gap-2 mb-2.5">
        <KV label="事件/日" value={s.events_1d === 0 ? "—" : s.events_1d.toLocaleString()} />
        <KV label="错误" value={s.errs.toString()} tone={s.errs > 0 ? "err" : undefined} />
        <KV label="延迟" value={s.latency} />
      </div>
      <div className="mono text-[10.5px] text-ink-3 truncate">{s.syncMode}</div>
      <div className="flex items-center gap-2 mt-2 text-[10.5px] text-ink-4">
        <span className="mono">{s.lastSync}</span>
        <div className="flex-1" />
        {s.fields > 0 && <span className="mono">{s.mapped}/{s.fields} 字段</span>}
      </div>
      <div className="text-[11.5px] text-ink-3 mt-2 line-clamp-2">{s.desc}</div>
    </div>
  );
}

function KV({ label, value, tone }: { label: string; value: string; tone?: "err" }) {
  return (
    <div>
      <div className="hint">{label}</div>
      <div
        className="mono text-[12px] font-semibold tabular-nums"
        style={{ color: tone === "err" ? "var(--c-err)" : "var(--c-ink-1)" }}
      >
        {value}
      </div>
    </div>
  );
}

function DSDetail({ s, onBack }: { s: Source; onBack: () => void }) {
  const [tab, setTab] = React.useState("overview");
  const tabs = [
    ["overview", "概览"],
    ["mapping", "字段映射"],
    ["events", "事件流"],
    ["credentials", "凭证与权限"],
    ["webhook", "Webhook"],
    ["audit", "变更历史"],
  ];
  const st = STATUS[s.status];
  return (
    <div className="flex flex-col min-h-0 bg-panel">
      <div className="border-b border-line bg-surface" style={{ padding: "14px 22px" }}>
        <div className="flex items-center gap-2.5">
          <Btn size="sm" variant="ghost" onClick={onBack}>← 返回</Btn>
          <div
            className="w-[34px] h-[34px] rounded-md grid place-items-center text-white font-semibold text-[11px]"
            style={{ background: s.color }}
          >
            {s.logo}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[15px] font-semibold tracking-tight">{s.name}</div>
            <div className="text-ink-3 text-[12px]">{s.vendor} · {s.syncMode}</div>
          </div>
          <Badge variant={st.variant} dot pulse={s.status === "failing"}>{st.label}</Badge>
          <Btn size="sm"><Ic.play /> 重新同步</Btn>
          <Btn size="sm"><Ic.pause /> 暂停</Btn>
          <Btn size="sm" variant="primary">编辑配置</Btn>
        </div>
        <div className="flex mt-3 -mb-2.5">
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
      <div className="flex-1 overflow-auto min-h-0" style={{ padding: "18px 22px" }}>
        {tab === "overview" && <DSOverview s={s} />}
        {tab === "mapping" && <DSMapping s={s} />}
        {tab === "events" && <DSEventsStream s={s} />}
        {tab === "credentials" && <DSCredentials s={s} />}
        {tab === "webhook" && <DSWebhook s={s} />}
        {tab === "audit" && <DSAudit s={s} />}
      </div>
    </div>
  );
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border border-line rounded-lg bg-surface overflow-hidden">
      <div className="border-b border-line flex items-center" style={{ padding: "10px 14px" }}>
        <div className="text-[12px] font-semibold tracking-tight">{title}</div>
      </div>
      <div style={{ padding: 12 }}>{children}</div>
    </div>
  );
}

function DSOverview({ s }: { s: Source }) {
  return (
    <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
      <SectionCard title="连接元数据">
        <div className="grid gap-2 text-[12px]" style={{ gridTemplateColumns: "auto 1fr", columnGap: 14, rowGap: 8 }}>
          <div className="mono text-ink-4 text-[11px]">vendor</div>
          <div className="mono">{s.vendor}</div>
          <div className="mono text-ink-4 text-[11px]">sync_mode</div>
          <div className="mono">{s.syncMode}</div>
          <div className="mono text-ink-4 text-[11px]">last_sync</div>
          <div className="mono">{s.lastSync}</div>
          <div className="mono text-ink-4 text-[11px]">owner</div>
          <div>{s.owner}</div>
          <div className="mono text-ink-4 text-[11px]">contract_end</div>
          <div className="mono">{s.contractEnd}</div>
        </div>
      </SectionCard>
      <SectionCard title="24h 吞吐">
        <div className="grid grid-cols-3 gap-3">
          <KV label="events" value={s.events_1d === 0 ? "—" : s.events_1d.toLocaleString()} />
          <KV label="errors" value={s.errs.toString()} tone={s.errs > 0 ? "err" : undefined} />
          <KV label="P95 延迟" value={s.latency} />
        </div>
        <Spark data={[3, 4, 5, 6, 5, 7, 6, 8, 7, 8, 9, 7, 8, 9, 8, 9]} h={60} accent="var(--c-accent)" />
      </SectionCard>
      <SectionCard title="描述">
        <div className="text-[12.5px] text-ink-1 leading-relaxed">{s.desc}</div>
      </SectionCard>
      <SectionCard title="字段映射完成度">
        {s.fields === 0 ? (
          <div className="text-ink-3 text-[12.5px]">— 无字段需映射 —</div>
        ) : (
          <>
            <div className="flex items-baseline gap-2 mb-1.5">
              <span className="mono text-[18px] font-semibold">{s.mapped}</span>
              <span className="mono text-[12px] text-ink-3">/ {s.fields} 字段</span>
              <div className="flex-1" />
              <span
                className="mono text-[11px]"
                style={{ color: s.mapped === s.fields ? "var(--c-ok)" : "var(--c-warn)" }}
              >
                {Math.round((s.mapped / s.fields) * 100)}%
              </span>
            </div>
            <div className="h-1.5 rounded-sm bg-panel overflow-hidden">
              <div
                className="h-full rounded-sm"
                style={{
                  width: `${(s.mapped / s.fields) * 100}%`,
                  background: s.mapped === s.fields ? "var(--c-ok)" : "var(--c-warn)",
                }}
              />
            </div>
          </>
        )}
      </SectionCard>
    </div>
  );
}

function DSMapping({ s }: { s: Source }) {
  const rows = [
    ["external.requirement_id", "Job_Requisition.id", "String", "direct"],
    ["external.jd_content", "Job_Posting.description", "Text", "direct"],
    ["external.seniority_level", "Job_Requisition.seniority", "Enum", "mapped"],
    ["external.years_min", "Job_Requisition.years_min", "Integer", "direct"],
    ["external.salary_range", "Job_Requisition.comp_band", "Object", "transform"],
  ];
  return (
    <SectionCard title={`字段映射 · ${s.mapped}/${s.fields || "—"}`}>
      <table className="tbl">
        <thead>
          <tr>
            <th>外部字段</th>
            <th>内部字段</th>
            <th>类型</th>
            <th>模式</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td className="mono">{r[0]}</td>
              <td className="mono">{r[1]}</td>
              <td><Badge variant="info">{r[2]}</Badge></td>
              <td><Badge>{r[3]}</Badge></td>
            </tr>
          ))}
        </tbody>
      </table>
    </SectionCard>
  );
}

function DSEventsStream({ s }: { s: Source }) {
  const events = [
    { t: "14:06:04.812", name: "REQUIREMENT_SYNCED", tenant: "icbc", payload: "job=JD-2041" },
    { t: "14:06:02.190", name: "REQUIREMENT_LOGGED", tenant: "icbc", payload: "job=JD-2041" },
    { t: "14:05:58.441", name: "CLARIFICATION_READY", tenant: "icbc", payload: "job=JD-2041" },
    { t: "14:05:44.102", name: "REQUIREMENT_SYNCED", tenant: "icbc", payload: "job=JD-2038" },
  ];
  return (
    <SectionCard title={`来自 ${s.name} 的最近事件`}>
      <div>
        {events.map((e, i) => (
          <div key={i} className="flex items-center gap-2.5 py-2 border-b border-line last:border-0">
            <span className="mono text-[10px] text-ink-4" style={{ width: 90 }}>{e.t}</span>
            <span className="mono text-[11.5px] font-semibold">{e.name}</span>
            <Badge>{e.tenant}</Badge>
            <span className="mono text-[10.5px] text-ink-3 ml-auto">{e.payload}</span>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

function DSCredentials({ s }: { s: Source }) {
  return (
    <SectionCard title="凭证与权限">
      <div className="grid gap-2.5 text-[12px]" style={{ gridTemplateColumns: "auto 1fr", columnGap: 14, rowGap: 8 }}>
        <div className="mono text-ink-4 text-[11px]">auth_type</div>
        <div className="mono">{s.syncMode.includes("OAuth") ? "OAuth 2.0" : s.syncMode.includes("SAML") ? "SAML / SCIM" : "API Token"}</div>
        <div className="mono text-ink-4 text-[11px]">client_id</div>
        <div className="mono">cli_••••••••2b71</div>
        <div className="mono text-ink-4 text-[11px]">secret</div>
        <div className="mono">•••• (last rotated 12d 前)</div>
        <div className="mono text-ink-4 text-[11px]">scopes</div>
        <div>
          <Badge>read:jobs</Badge>{" "}<Badge>read:resumes</Badge>{" "}<Badge>write:status</Badge>
        </div>
        <div className="mono text-ink-4 text-[11px]">last_verified</div>
        <div className="mono">{s.lastSync}</div>
      </div>
    </SectionCard>
  );
}

function DSWebhook({ s }: { s: Source }) {
  return (
    <SectionCard title="Webhook 端点">
      <div className="grid gap-2.5 text-[12px]" style={{ gridTemplateColumns: "auto 1fr", columnGap: 14, rowGap: 8 }}>
        <div className="mono text-ink-4 text-[11px]">endpoint</div>
        <div className="mono text-ink-1 overflow-hidden text-ellipsis">https://hook.ao.internal/v1/{s.id}/ingest</div>
        <div className="mono text-ink-4 text-[11px]">signature</div>
        <div className="mono">HMAC-SHA256 · X-AO-Signature</div>
        <div className="mono text-ink-4 text-[11px]">retry</div>
        <div className="mono">5 次 · 指数退避 30s→30m</div>
        <div className="mono text-ink-4 text-[11px]">recent_deliveries</div>
        <div className="flex-1">
          <Spark data={[8, 9, 8, 7, 9, 9, 10, 9, 10, 9, 8, 9]} h={28} />
        </div>
      </div>
    </SectionCard>
  );
}

function DSAudit({ s }: { s: Source }) {
  const events = [
    { t: "3d 前", by: s.owner, what: "rotated API token · scopes unchanged" },
    { t: "14d 前", by: "compliance", what: "approved GDPR data residency · EU-West" },
    { t: "1m 前", by: s.owner, what: "added field mapping · external.seniority_level" },
  ];
  return (
    <SectionCard title="变更历史 · Audit">
      <div className="flex flex-col gap-2.5">
        {events.map((e, i) => (
          <div key={i} className="flex items-start gap-2.5">
            <span className="mono text-[10.5px] text-ink-4" style={{ width: 60 }}>{e.t}</span>
            <div className="flex-1">
              <div className="text-[12px]"><b>{e.by}</b> · {e.what}</div>
            </div>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

function DSRightRail() {
  return (
    <div className="border-l border-line bg-bg flex flex-col min-h-0">
      <div className="border-b border-line bg-surface" style={{ padding: "12px 14px" }}>
        <div className="text-[13px] font-semibold">跨源活动</div>
        <div className="hint mt-0.5">实时事件 + 健康指标</div>
      </div>
      <div className="flex-1 overflow-auto">
        {[
          { t: "14:06:04", src: "ByteDance·ATS", ev: "REQUIREMENT_SYNCED", tone: "ok" },
          { t: "14:06:01", src: "Liepin", ev: "RESUME_DOWNLOADED", tone: "ok" },
          { t: "14:05:58", src: "美团·RMS", ev: "FIELD_MISMATCH (warn)", tone: "warn" },
          { t: "14:05:54", src: "BOSS 直聘", ev: "RESUME_DOWNLOADED", tone: "ok" },
          { t: "14:05:49", src: "OpenAI", ev: "INFERENCE · gpt-4o", tone: "info" },
          { t: "14:05:42", src: "百度·招聘云", ev: "CERT_EXPIRED", tone: "err" },
          { t: "14:05:32", src: "智联招聘", ev: "RATE_LIMIT_HIT", tone: "warn" },
          { t: "14:05:28", src: "Claude", ev: "INFERENCE · claude-3.5-sonnet", tone: "info" },
        ].map((e, i) => {
          const col = e.tone === "ok" ? "var(--c-ok)" : e.tone === "warn" ? "oklch(0.62 0.14 75)" : e.tone === "err" ? "var(--c-err)" : "var(--c-info)";
          return (
            <div key={i} className="flex items-start gap-2 border-b border-line py-2 px-3">
              <span
                className="w-1.5 h-1.5 rounded-full flex-shrink-0 mt-1.5"
                style={{ background: col, boxShadow: `0 0 0 3px color-mix(in oklab, ${col} 18%, transparent)` }}
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 text-[11.5px] font-medium">
                  <span className="mono text-[10px] text-ink-4">{e.t}</span>
                  <span>{e.src}</span>
                </div>
                <div className="mono text-[10.5px] text-ink-3 overflow-hidden text-ellipsis whitespace-nowrap">{e.ev}</div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="border-t border-line bg-surface" style={{ padding: "10px 14px" }}>
        <div className="text-[12.5px] font-semibold mb-2">Webhook 健康</div>
        <div className="flex flex-col gap-1.5 text-[11px] text-ink-2">
          {[
            ["ByteDance", 98],
            ["Liepin", 94],
            ["BOSS", 91],
            ["百度", 12],
            ["智联", 76],
          ].map(([name, v]) => (
            <div key={name as string} className="flex items-center gap-2">
              <span className="mono" style={{ width: 76 }}>{name}</span>
              <div className="flex-1 h-1.5 rounded-sm bg-panel overflow-hidden">
                <div
                  className="h-full rounded-sm"
                  style={{
                    width: `${v}%`,
                    background: (v as number) < 50 ? "var(--c-err)" : (v as number) < 80 ? "var(--c-warn)" : "var(--c-ok)",
                  }}
                />
              </div>
              <span className="mono text-[10.5px]">{v}%</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
