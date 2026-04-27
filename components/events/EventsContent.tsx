"use client";
import React from "react";
import { useApp } from "@/lib/i18n";
import { Ic } from "@/components/shared/Ic";
import { Badge, Btn, StatusDot } from "@/components/shared/atoms";
import { EVENT_CATALOG, EventDef, kindDot, STAGE_LABELS } from "@/lib/events-catalog";
import { fetchJson } from "@/lib/api/client";
import type { EventsResponse } from "@/lib/api/types";

// Convert API EventContract → legacy EventDef shape.
function toLegacy(c: EventsResponse["events"][number]): EventDef {
  return {
    name: c.name,
    stage: c.stage,
    kind: c.kind,
    rate: c.rateLastHour,
    err: c.errorRateLastHour,
    desc: c.desc,
    publishers: c.publishers,
    subscribers: c.subscribers,
    wf: [],
    emits: c.emits,
    data: [],
    mutations: [],
  };
}

export function EventsContent() {
  const { t } = useApp();
  const [selectedName, setSelectedName] = React.useState("ANALYSIS_COMPLETED");
  const [tab, setTab] = React.useState("overview");
  const [query, setQuery] = React.useState("");
  const [apiEvents, setApiEvents] = React.useState<EventDef[] | null>(null);

  React.useEffect(() => {
    fetchJson<EventsResponse>("/api/events")
      .then((res) => setApiEvents(res.events.map(toLegacy)))
      .catch(() => {/* keep null → fallback */});
  }, []);

  const events = apiEvents ?? EVENT_CATALOG;
  const selected = events.find((e) => e.name === selectedName) || events[0];

  const grouped = React.useMemo(() => {
    const groups: Record<string, EventDef[]> = {};
    const q = query.trim().toUpperCase();
    for (const e of events) {
      if (q && !e.name.includes(q)) continue;
      (groups[e.stage] ||= []).push(e);
    }
    return groups;
  }, [query, events]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <EMSubHeader />
      <div className="flex-1 grid min-h-0" style={{ gridTemplateColumns: "300px 1fr 340px" }}>
        <EventRegistry grouped={grouped} selectedName={selectedName} onSelect={setSelectedName} query={query} setQuery={setQuery} />
        <EventDetail event={selected} tab={tab} setTab={setTab} />
        <EventLiveStream />
      </div>
    </div>
  );
}

function EMSubHeader() {
  const { t } = useApp();
  const stats = [
    { label: "events · 1m", value: "4,827", delta: "+12%", tone: "up" },
    { label: "functions", value: "28 / 29", delta: "1 paused", tone: "muted" },
    { label: t("em_backlog"), value: "142", delta: "−38", tone: "up" },
    { label: t("em_dlq"), value: "6", delta: "+2", tone: "down" },
    { label: "P95 delivery", value: "84ms", delta: "→ SLA", tone: "muted" },
    { label: "Inngest 连接", value: "OK", delta: "eu-west-1 · v1.4", tone: "up" },
  ];
  return (
    <div className="border-b border-line bg-surface flex items-center gap-4.5" style={{ padding: "14px 22px", gap: 18 }}>
      <div>
        <div className="text-[15px] font-semibold tracking-tight">{t("em_title")}</div>
        <div className="text-ink-3 text-[12px] mt-px">{t("em_sub")}</div>
      </div>
      <div className="flex-1 grid pl-4.5 border-l border-line" style={{ gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 14, paddingLeft: 18 }}>
        {stats.map((s, i) => (
          <div key={i}>
            <div className="hint">{s.label}</div>
            <div className="text-[16px] font-semibold tracking-tight tabular-nums">{s.value}</div>
            <div
              className="mono text-[10.5px]"
              style={{
                color: s.tone === "up" ? "var(--c-ok)" : s.tone === "down" ? "var(--c-err)" : "var(--c-ink-4)",
              }}
            >
              {s.delta}
            </div>
          </div>
        ))}
      </div>
      <Btn size="sm"><Ic.plus /> 新建事件</Btn>
      <Btn size="sm" variant="primary"><Ic.bolt /> 发布事件</Btn>
    </div>
  );
}

function EventRegistry({
  grouped,
  selectedName,
  onSelect,
  query,
  setQuery,
}: {
  grouped: Record<string, EventDef[]>;
  selectedName: string;
  onSelect: (n: string) => void;
  query: string;
  setQuery: (s: string) => void;
}) {
  const { t } = useApp();
  const stageOrder = ["requirement", "jd", "resume", "match", "interview", "eval", "package", "submit", "system"];
  const totalCount = Object.values(grouped).reduce((a, arr) => a + arr.length, 0);

  return (
    <aside className="border-r border-line bg-surface flex flex-col min-h-0">
      <div className="border-b border-line" style={{ padding: "12px 14px" }}>
        <div className="flex items-center mb-2">
          <div className="text-[13px] font-semibold flex-1">{t("em_registry")}</div>
          <Badge>{totalCount} · {EVENT_CATALOG.length}</Badge>
        </div>
        <div className="relative">
          <span className="absolute left-2 top-1.5 text-ink-4"><Ic.search /></span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="EVENT_NAME_…"
            className="w-full h-7 border border-line bg-panel rounded-sm mono text-[11.5px] text-ink-1 outline-none"
            style={{ padding: "0 8px 0 28px" }}
          />
        </div>
      </div>
      <div className="flex-1 overflow-auto">
        {stageOrder.map((stage) => {
          const items = grouped[stage];
          if (!items || items.length === 0) return null;
          return (
            <div key={stage}>
              <div
                className="flex items-center uppercase tracking-[0.06em] text-[10.5px] text-ink-4 font-semibold bg-panel border-t border-b border-line"
                style={{ padding: "8px 14px 4px" }}
              >
                <span className="flex-1">{t(STAGE_LABELS[stage])}</span>
                <span className="mono text-ink-4 font-medium">{items.length}</span>
              </div>
              {items.map((e) => (
                <RegistryRow key={e.name} event={e} active={e.name === selectedName} onClick={() => onSelect(e.name)} />
              ))}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

function RegistryRow({ event, active, onClick }: { event: EventDef; active: boolean; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      className="flex items-center gap-2 cursor-pointer border-b border-line"
      style={{
        padding: "8px 14px",
        background: active ? "var(--c-accent-bg)" : "transparent",
        borderLeft: active ? "2px solid var(--c-accent)" : "2px solid transparent",
      }}
    >
      <span
        className="w-1.5 h-1.5 rounded-full flex-shrink-0"
        style={{
          background: kindDot(event.kind),
          boxShadow: `0 0 0 3px color-mix(in oklab, ${kindDot(event.kind)} 18%, transparent)`,
        }}
      />
      <div className="flex-1 min-w-0">
        <div
          className="mono text-[11px] font-semibold whitespace-nowrap overflow-hidden text-ellipsis"
          style={{ color: active ? "var(--c-accent)" : "var(--c-ink-1)" }}
        >
          {event.name}
        </div>
        <div className="mono text-[10px] text-ink-4 mt-px">
          {event.rate.toLocaleString()}/h · {event.subscribers.length} sub
          {event.err > 0 && <span style={{ color: "var(--c-err)" }}> · {event.err} err</span>}
        </div>
      </div>
    </div>
  );
}

function EventDetail({ event, tab, setTab }: { event: EventDef; tab: string; setTab: (t: string) => void }) {
  return (
    <div className="flex flex-col min-h-0 bg-panel">
      <EventDetailHeader event={event} />
      <EventDetailTabs tab={tab} setTab={setTab} />
      <div className="flex-1 overflow-auto">
        {tab === "overview" && <TabOverview event={event} />}
        {tab === "schema" && <TabSchema event={event} />}
        {tab === "subs" && <TabSubscribers event={event} />}
        {tab === "runs" && <TabRuns event={event} />}
        {tab === "history" && <TabHistory event={event} />}
        {tab === "logs" && <TabLogs event={event} />}
      </div>
    </div>
  );
}

function EventDetailHeader({ event }: { event: EventDef }) {
  const { t } = useApp();
  const isError = event.kind === "error";
  return (
    <div className="bg-surface border-b border-line" style={{ padding: "16px 22px" }}>
      <div className="flex items-center gap-2 mb-2">
        <span
          className="w-[30px] h-[30px] rounded-md grid place-items-center"
          style={{
            background: `color-mix(in oklab, ${kindDot(event.kind)} 14%, transparent)`,
            border: `1px solid color-mix(in oklab, ${kindDot(event.kind)} 32%, transparent)`,
            color: kindDot(event.kind),
          }}
        >
          {event.kind === "error" ? <Ic.alert /> : event.kind === "gate" ? <Ic.branch /> : <Ic.bolt />}
        </span>
        <div className="flex-1 min-w-0">
          <div className="mono text-[15px] font-semibold tracking-tight" style={{ color: isError ? "var(--c-err)" : "var(--c-ink-1)" }}>
            {event.name}
          </div>
          <div className="text-ink-3 text-[12px] mt-0.5">{event.desc}</div>
        </div>
        <Badge variant="info">v2 · schema</Badge>
        <Badge variant={event.err > 0 ? "warn" : "ok"} dot>
          {event.err > 0 ? `${event.err} err / 24h` : "healthy · 24h"}
        </Badge>
      </div>

      <div className="flex gap-4.5 mt-3" style={{ gap: 18 }}>
        <HeaderStat label="24h 发布" value={event.rate.toLocaleString()} />
        <HeaderStat label="P95 投递" value="84ms" tone="ok" />
        <HeaderStat label={t("em_subscribers")} value={event.subscribers.length.toString()} />
        <HeaderStat label={t("em_retention")} value="90d" />
        <HeaderStat label={t("em_persistence")} value="PostgreSQL + S3" muted />
        <div className="flex-1" />
        <Btn size="sm"><Ic.play /> {t("em_replay")}</Btn>
        <Btn size="sm"><Ic.pause /> {t("em_pause")}</Btn>
        <Btn size="sm" variant="ghost"><Ic.dots /></Btn>
      </div>
    </div>
  );
}

function HeaderStat({ label, value, tone, muted }: { label: string; value: string; tone?: "ok"; muted?: boolean }) {
  const col = tone === "ok" ? "var(--c-ok)" : "var(--c-ink-1)";
  return (
    <div>
      <div className="hint">{label}</div>
      <div
        className="mono text-[13.5px] font-semibold tabular-nums"
        style={{ color: col, opacity: muted ? 0.75 : 1 }}
      >
        {value}
      </div>
    </div>
  );
}

function EventDetailTabs({ tab, setTab }: { tab: string; setTab: (t: string) => void }) {
  const { t } = useApp();
  const tabs = [
    { id: "overview", label: t("em_tab_overview") },
    { id: "schema", label: t("em_tab_schema") },
    { id: "subs", label: t("em_tab_subs") },
    { id: "runs", label: t("em_tab_runs") },
    { id: "history", label: t("em_tab_history") },
    { id: "logs", label: t("em_tab_logs") },
  ];
  return (
    <div className="border-b border-line bg-surface flex gap-0.5" style={{ padding: "0 14px" }}>
      {tabs.map((tb) => (
        <button
          key={tb.id}
          onClick={() => setTab(tb.id)}
          className="bg-transparent border-0 cursor-pointer text-[12.5px]"
          style={{
            padding: "10px 12px",
            color: tab === tb.id ? "var(--c-ink-1)" : "var(--c-ink-3)",
            fontWeight: tab === tb.id ? 600 : 500,
            borderBottom: tab === tb.id ? "2px solid var(--c-accent)" : "2px solid transparent",
          }}
        >
          {tb.label}
        </button>
      ))}
    </div>
  );
}

function DetailCard({ title, count, children, span }: { title: string; count?: number; children: React.ReactNode; span?: boolean }) {
  return (
    <div
      className="border border-line rounded-lg bg-surface overflow-hidden"
      style={{ gridColumn: span ? "1 / -1" : undefined }}
    >
      <div className="border-b border-line flex items-center gap-2" style={{ padding: "10px 14px" }}>
        <div className="text-[12px] font-semibold flex-1 tracking-tight">{title}</div>
        {count != null && <span className="mono text-[10.5px] text-ink-4">{count}</span>}
      </div>
      <div style={{ padding: 12 }}>{children}</div>
    </div>
  );
}

function TabOverview({ event }: { event: EventDef }) {
  const { t } = useApp();
  const emitsEvents = event.emits || [];
  return (
    <div className="grid gap-4.5" style={{ padding: 22, gridTemplateColumns: "1fr 1fr", gap: 18 }}>
      <DetailCard title={t("em_publishers")} count={event.publishers.length}>
        {event.publishers.map((p, i) => (
          <EntityRow key={i} icon={<Ic.cpu />} name={p} meta={i === 0 ? "primary" : "fallback"} tone="info" />
        ))}
      </DetailCard>
      <DetailCard title={t("em_subscribers")} count={event.subscribers.length}>
        {event.subscribers.map((s, i) => (
          <EntityRow key={i} icon={<Ic.plug />} name={s} meta={`step.waitForEvent · #${i + 1}`} />
        ))}
      </DetailCard>

      <DetailCard title={t("em_source_action")} span>
        <EMKV rows={[
          ["source.action", "analyzeRequirement"],
          ["triggered_by", t("actor_agent") + " · ReqAnalyzer"],
          ["idempotency_key", "req_id + analysis_nonce"],
          ["dedupe_window", "60s"],
        ]} />
      </DetailCard>

      <DetailCard title={t("em_triggers_workflow") + " · 下游"} count={emitsEvents.length} span>
        <div className="flex flex-col gap-2">
          {emitsEvents.length === 0 && <div className="text-ink-3 text-[12.5px] p-2">— 终端事件 · 无下游 —</div>}
          {emitsEvents.map((ev, i) => {
            const target = EVENT_CATALOG.find((x) => x.name === ev);
            return (
              <div
                key={i}
                className="flex items-center gap-2.5 rounded-sm bg-panel border border-line"
                style={{ padding: "8px 10px" }}
              >
                <span className="mono text-[10.5px] text-ink-4">emit →</span>
                <span
                  className="w-1.5 h-1.5 rounded-full"
                  style={{ background: kindDot(target?.kind || "domain") }}
                />
                <span className="mono text-[11.5px] font-semibold">{ev}</span>
                <div className="flex-1" />
                <span className="mono text-[10.5px] text-ink-4">{target ? `${target.rate}/h` : "—"}</span>
              </div>
            );
          })}
        </div>
      </DetailCard>

      <DetailCard title={t("em_mutations")} count={event.mutations.length} span>
        {event.mutations.length === 0 && <div className="text-ink-3 text-[12.5px] p-2">— 该事件不修改状态 —</div>}
        <div className="flex flex-wrap gap-1.5">
          {event.mutations.map((m, i) => (
            <Badge key={i} style={{ background: "var(--c-panel)", border: "1px solid var(--c-line)" }}>
              <Ic.db /> {m}
            </Badge>
          ))}
        </div>
      </DetailCard>

      <DetailCard title={t("em_delivery") + " · Inngest"}>
        <EMKV rows={[
          ["delivery", "at-least-once"],
          ["concurrency", "25 / function"],
          ["rate_limit", "500/min · per job_id"],
          ["retries", "5 · exp. backoff 30s→30m"],
          ["timeout", "30s"],
        ]} />
      </DetailCard>
      <DetailCard title={t("em_persistence")}>
        <EMKV rows={[
          ["log_store", "PostgreSQL · events_log"],
          ["payload_blob", "S3 · ao-events/2025-…"],
          ["retention", "90 天 · WORM · 合规"],
          ["index", "name + job_requisition_id + ts"],
          ["GDPR", "PII 字段加密 · 字段级"],
        ]} />
      </DetailCard>
    </div>
  );
}

function EntityRow({ icon, name, meta, tone }: { icon: React.ReactNode; name: string; meta?: string; tone?: "info" }) {
  return (
    <div
      className="flex items-center gap-2.5"
      style={{ padding: "6px 4px", borderBottom: "1px dashed var(--c-line)" }}
    >
      <span
        className="w-[22px] h-[22px] rounded-sm grid place-items-center border border-line"
        style={{
          background: tone === "info" ? "var(--c-info-bg)" : "var(--c-panel)",
          color: tone === "info" ? "var(--c-info)" : "var(--c-ink-2)",
        }}
      >
        {icon}
      </span>
      <span className="text-[12.5px] font-medium flex-1">{name}</span>
      <span className="mono text-[10.5px] text-ink-4">{meta}</span>
    </div>
  );
}

function EMKV({ rows }: { rows: [string, string][] }) {
  return (
    <div className="grid text-[12px]" style={{ gridTemplateColumns: "auto 1fr", columnGap: 14, rowGap: 6 }}>
      {rows.map(([k, v], i) => (
        <React.Fragment key={i}>
          <div className="mono text-[11px] text-ink-4">{k}</div>
          <div className="mono text-[11.5px] text-ink-1">{v}</div>
        </React.Fragment>
      ))}
    </div>
  );
}

function TabSchema({ event }: { event: EventDef }) {
  const { t } = useApp();

  const sampleFor = (key: string, type: string) => {
    if (key.includes("_id")) return '"req_2041"';
    if (key.includes("_url")) return '"s3://ao-events/resumes/8821.pdf"';
    if (key === "confidence_rating" || key === "matching_score") return "0.83";
    if (key === "complexity_score") return "0.74";
    if (key === "extracted_skills") return '["Java","Spring Cloud","Kafka","MySQL"]';
    if (key === "analysis_duration_ms") return "1820";
    if (type === "Boolean") return "true";
    if (type === "Integer") return "42";
    if (type === "Float") return "0.92";
    if (type.startsWith("List")) return '["…"]';
    if (type === "Array") return "[]";
    if (type === "Object") return "{}";
    if (type === "Enum") return '"HIGH"';
    if (type === "Date") return '"2025-02-10"';
    return '"…"';
  };
  const jsonType = (tp: string) => {
    if (tp === "Integer" || tp === "Float") return "number";
    if (tp === "Boolean") return "boolean";
    if (tp === "Array" || tp.startsWith("List")) return "array";
    if (tp === "Object") return "object";
    return "string";
  };

  return (
    <div className="grid items-start gap-4.5" style={{ padding: 22, gridTemplateColumns: "1fr 1fr", gap: 18 }}>
      <div>
        <DetailCard title="event_data · payload fields" count={event.data.length}>
          <div className="grid" style={{ gridTemplateColumns: "1fr auto" }}>
            <div
              className="mono text-[10.5px] text-ink-4 tracking-[0.04em] uppercase border-b border-line"
              style={{ padding: "4px 6px" }}
            >
              field
            </div>
            <div
              className="mono text-[10.5px] text-ink-4 tracking-[0.04em] uppercase border-b border-line text-right"
              style={{ padding: "4px 6px" }}
            >
              type
            </div>
            {event.data.map(([k, tp], i) => (
              <React.Fragment key={i}>
                <div
                  className="mono text-[11.5px]"
                  style={{
                    padding: "8px 6px",
                    borderBottom: i === event.data.length - 1 ? 0 : "1px dashed var(--c-line)",
                  }}
                >
                  {k}
                </div>
                <div
                  className="text-right"
                  style={{
                    padding: "8px 6px",
                    borderBottom: i === event.data.length - 1 ? 0 : "1px dashed var(--c-line)",
                  }}
                >
                  <span
                    className="mono text-[10.5px]"
                    style={{
                      color: "var(--c-info)",
                      background: "var(--c-info-bg)",
                      padding: "2px 6px",
                      borderRadius: 4,
                      border: "1px solid color-mix(in oklab, var(--c-info) 20%, transparent)",
                    }}
                  >
                    {tp}
                  </span>
                </div>
              </React.Fragment>
            ))}
          </div>
        </DetailCard>

        <div style={{ height: 14 }} />

        <DetailCard title={t("em_mutations") + " · state_mutations"} count={event.mutations.length}>
          {event.mutations.length === 0 && <div className="text-ink-3 text-[12.5px] p-1.5">无状态变更 · pure signal event</div>}
          {event.mutations.map((m, i) => (
            <div
              key={i}
              className="rounded-sm mb-1.5 bg-panel border border-line flex items-center gap-2"
              style={{ padding: "8px 10px" }}
            >
              <Ic.db />
              <span className="mono text-[12px] font-semibold">{m}</span>
              <Badge variant="info" className="ml-auto">CREATE_OR_MODIFY</Badge>
            </div>
          ))}
        </DetailCard>
      </div>

      <div>
        <DetailCard title="Sample payload · JSON">
          <pre
            className="m-0 mono text-[11px] rounded-md overflow-auto"
            style={{
              padding: 14,
              background: "oklch(0.22 0.01 260)",
              color: "oklch(0.92 0.01 260)",
              border: "1px solid oklch(0.28 0.01 260)",
              lineHeight: 1.55,
            }}
          >
{`{
  "name": "${event.name}",
  "ts":   "2025-01-14T14:06:04.812Z",
  "id":   "evt_01HQ9K7MZE3XFN2P8T5RA6WQ0V",
  "data": {
${event.data.map(([k, tp]) => `    "${k}": ${sampleFor(k, tp)}`).join(",\n")}
  },
  "user": { "hsm_id": "u_482", "tenant": "icbc" },
  "meta": {
    "source":  "${event.publishers[0] || "system"}",
    "trace_id":"tr_7b3c29e1d2",
    "schema":  "v2"
  }
}`}
          </pre>
        </DetailCard>

        <div style={{ height: 14 }} />

        <DetailCard title="JSON Schema · validation">
          <pre
            className="m-0 mono text-[10.5px] rounded-md overflow-auto bg-panel text-ink-2"
            style={{
              padding: 14,
              border: "1px solid var(--c-line)",
              lineHeight: 1.5,
            }}
          >
{`{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title":   "${event.name}",
  "type":    "object",
  "required":[${event.data.slice(0, 2).map(([k]) => `"${k}"`).join(",")}],
  "properties": {
${event.data.map(([k, tp]) => `    "${k}": { "type": "${jsonType(tp)}" }`).join(",\n")}
  },
  "additionalProperties": false
}`}
          </pre>
        </DetailCard>
      </div>
    </div>
  );
}

function TabSubscribers({ event }: { event: EventDef }) {
  const allSubs = event.subscribers.map((s, i) => ({
    fn: s,
    match: "event.name == '" + event.name + "'" + (i === 0 ? "" : " && event.data.is_urgent == true"),
    concurrency: [25, 12, 8, 4, 2][i] ?? 2,
    runs24h: Math.max(0, event.rate - i * Math.round(event.rate * 0.15)),
    success: 98.2 + (i % 3) * 0.4,
    p95: 120 + i * 80,
    status: i === 0 ? "active" : i === 1 ? "active" : i === 2 ? "active" : "paused",
  }));
  return (
    <div style={{ padding: 22 }}>
      <DetailCard title={"Inngest functions · 订阅 " + event.name} count={allSubs.length}>
        <div>
          <div
            className="grid items-center text-[10.5px] text-ink-4 tracking-[0.06em] uppercase font-semibold border-b border-line"
            style={{
              gridTemplateColumns: "1.4fr 1.6fr repeat(4, 0.8fr)",
              padding: "6px 8px",
            }}
          >
            <div>function</div><div>match · if</div>
            <div className="text-right">conc.</div>
            <div className="text-right">runs 24h</div>
            <div className="text-right">success</div>
            <div className="text-right">P95</div>
          </div>
          {allSubs.map((s, i) => (
            <div
              key={i}
              className="grid items-center tabular-nums text-[12px]"
              style={{
                gridTemplateColumns: "1.4fr 1.6fr repeat(4, 0.8fr)",
                padding: "10px 8px",
                borderBottom: i === allSubs.length - 1 ? 0 : "1px dashed var(--c-line)",
              }}
            >
              <div className="flex items-center gap-2">
                <StatusDot kind={s.status === "active" ? "ok" : "paused"} />
                <span className="mono text-[11.5px] font-semibold">{s.fn}</span>
                {s.status === "paused" && <Badge>paused</Badge>}
              </div>
              <div className="mono text-[10.5px] text-ink-3 overflow-hidden text-ellipsis whitespace-nowrap">{s.match}</div>
              <div className="mono text-right text-[11px]">{s.concurrency}</div>
              <div className="mono text-right text-[11px]">{s.runs24h.toLocaleString()}</div>
              <div
                className="mono text-right text-[11px]"
                style={{ color: s.success >= 99 ? "var(--c-ok)" : "var(--c-ink-1)" }}
              >
                {s.success.toFixed(1)}%
              </div>
              <div className="mono text-right text-[11px]">{s.p95}ms</div>
            </div>
          ))}
        </div>
      </DetailCard>
    </div>
  );
}

function TabRuns({ event }: { event: EventDef }) {
  const runs = [
    { id: "run_01HQ…7MZE", fn: event.subscribers[0], state: "completed", took: "1.82s", started: "14:06:04", steps: 7, attempts: 1 },
    { id: "run_01HQ…7MZF", fn: event.subscribers[0], state: "completed", took: "2.14s", started: "14:06:02", steps: 7, attempts: 1 },
    { id: "run_01HQ…7MZG", fn: event.subscribers[1] || event.subscribers[0], state: "running", took: "0:01:04", started: "14:06:01", steps: 4, attempts: 1 },
    { id: "run_01HQ…7MZH", fn: event.subscribers[0], state: "failed", took: "0.92s", started: "14:05:58", steps: 3, attempts: 2, error: "TOOL_TIMEOUT · llm.extract" },
    { id: "run_01HQ…7MZJ", fn: event.subscribers[0], state: "completed", took: "1.68s", started: "14:05:52", steps: 7, attempts: 1 },
    { id: "run_01HQ…7MZK", fn: event.subscribers[0], state: "waiting", took: "—", started: "14:05:44", steps: 2, attempts: 1, waitOn: "CLARIFICATION_RETRY" },
  ] as { id: string; fn: string; state: string; took: string; started: string; steps: number; attempts: number; error?: string; waitOn?: string }[];

  const stateDot: Record<string, string> = {
    completed: "var(--c-ok)",
    running: "var(--c-info)",
    failed: "var(--c-err)",
    waiting: "oklch(0.5 0.14 75)",
    paused: "var(--c-ink-3)",
  };

  return (
    <div style={{ padding: 22 }}>
      <DetailCard title="Function runs · 最近 10 分钟" count={runs.length}>
        <div>
          <div
            className="grid items-center text-[10.5px] text-ink-4 tracking-[0.06em] uppercase font-semibold border-b border-line"
            style={{
              gridTemplateColumns: "1.4fr 1.4fr 0.8fr 0.8fr 0.8fr 0.6fr 1.4fr",
              padding: "6px 8px",
            }}
          >
            <div>run</div><div>function</div><div>state</div>
            <div className="text-right">took</div>
            <div className="text-right">started</div>
            <div className="text-right">steps</div>
            <div>detail</div>
          </div>
          {runs.map((r, i) => (
            <div
              key={i}
              className="grid items-center tabular-nums text-[11.5px]"
              style={{
                gridTemplateColumns: "1.4fr 1.4fr 0.8fr 0.8fr 0.8fr 0.6fr 1.4fr",
                padding: "10px 8px",
                borderBottom: i === runs.length - 1 ? 0 : "1px dashed var(--c-line)",
              }}
            >
              <div className="mono text-[10.5px] text-ink-3">{r.id}</div>
              <div className="mono text-[11px] font-medium">{r.fn}</div>
              <div className="flex items-center gap-1.5">
                <span
                  className="w-[7px] h-[7px] rounded-full"
                  style={{
                    background: stateDot[r.state],
                    boxShadow: `0 0 0 3px color-mix(in oklab, ${stateDot[r.state]} 18%, transparent)`,
                  }}
                />
                <span className="mono text-[10.5px]">{r.state}</span>
                {r.attempts > 1 && <span className="mono text-[10px] text-[color:var(--c-err)]">×{r.attempts}</span>}
              </div>
              <div className="mono text-right">{r.took}</div>
              <div className="mono text-right text-ink-3">{r.started}</div>
              <div className="mono text-right">{r.steps}</div>
              <div
                className="mono text-[10.5px] overflow-hidden text-ellipsis whitespace-nowrap"
                style={{ color: r.error ? "var(--c-err)" : "var(--c-ink-3)" }}
              >
                {r.error || (r.waitOn ? `⏸ wait for ${r.waitOn}` : "—")}
              </div>
            </div>
          ))}
        </div>
      </DetailCard>
    </div>
  );
}

function TabHistory({ event }: { event: EventDef }) {
  const { t } = useApp();
  const bars = Array.from({ length: 24 }, (_, i) => {
    const base = event.rate / 24;
    const noise = Math.sin(i * 0.8) * 0.45 + Math.cos(i * 1.3) * 0.25;
    return Math.max(0, Math.round(base * (1 + noise)));
  });
  const errBars = bars.map((v) => Math.round(v * 0.004 * (event.err / Math.max(1, event.rate / 1000))));
  const maxV = Math.max(...bars, 1);
  return (
    <div style={{ padding: 22 }}>
      <DetailCard title="过去 24 小时 · 事件速率" count={event.rate}>
        <div className="flex items-end gap-[3px] h-[140px]" style={{ padding: "6px 2px" }}>
          {bars.map((v, i) => (
            <div key={i} className="flex-1 flex flex-col items-center gap-0.5">
              <div
                className="w-full rounded-t-[3px] relative"
                style={{
                  height: `${(v / maxV) * 110}px`,
                  background: "color-mix(in oklab, var(--c-accent) 65%, transparent)",
                }}
              >
                {errBars[i] > 0 && (
                  <div
                    className="absolute bottom-0 left-0 right-0 rounded-t-[3px] bg-[color:var(--c-err)]"
                    style={{ height: `${Math.min(100, (errBars[i] / v) * 100)}%` }}
                  />
                )}
              </div>
              <span className="mono text-[8.5px] text-ink-4">{i}</span>
            </div>
          ))}
        </div>
      </DetailCard>

      <div style={{ height: 14 }} />

      <DetailCard title={t("em_versions") + " · schema evolution"}>
        <div>
          {[
            { ver: "v2", date: "2025-01-08", by: "HSM·treasury", note: "add `confidence_rating` · breaking" },
            { ver: "v1.4", date: "2024-11-22", by: "AI·schema-bot", note: "rename: `match_score`→`confidence_rating`" },
            { ver: "v1.3", date: "2024-10-05", by: "HSM·ops", note: "add `analysis_duration_ms`" },
            { ver: "v1.0", date: "2024-07-01", by: "初版", note: "initial" },
          ].map((v, i) => (
            <div
              key={i}
              className="grid text-[12px]"
              style={{
                gridTemplateColumns: "60px 100px 140px 1fr",
                gap: 10,
                padding: "8px 6px",
                borderBottom: i === 3 ? 0 : "1px dashed var(--c-line)",
              }}
            >
              <span
                className="mono text-[11px] font-semibold"
                style={{ color: i === 0 ? "var(--c-accent)" : "var(--c-ink-3)" }}
              >
                {v.ver}
              </span>
              <span className="mono text-[10.5px] text-ink-4">{v.date}</span>
              <span className="text-[11.5px]">{v.by}</span>
              <span className="mono text-[10.5px] text-ink-3">{v.note}</span>
            </div>
          ))}
        </div>
      </DetailCard>
    </div>
  );
}

function TabLogs({ event }: { event: EventDef }) {
  const logs = [
    { t: "14:06:04.812", lv: "info", msg: `event.published ${event.name} · payload=1.4kb` },
    { t: "14:06:04.814", lv: "info", msg: `→ dispatch to ${event.subscribers[0]} (conc 3/25)` },
    { t: "14:06:04.816", lv: "info", msg: `→ persisted · S3 key ao-events/2025-01-14/${event.name.toLowerCase()}/01HQ7MZE` },
    { t: "14:06:04.892", lv: "info", msg: `${event.subscribers[0]} step.run resolved in 68ms` },
    { t: "14:06:04.910", lv: "warn", msg: `replay triggered for run_01HQ…7MZH · attempt 2` },
    { t: "14:06:05.124", lv: "info", msg: `schema validated ok · v2` },
    { t: "14:06:05.288", lv: "error", msg: `llm.extract timeout 30s · run_01HQ…7MZH FAILED` },
    { t: "14:06:05.290", lv: "info", msg: `deadletter · 1 run → dlq.${event.name.toLowerCase()}` },
    { t: "14:06:05.431", lv: "info", msg: `consumer lag = 0ms · P95 = 84ms` },
    { t: "14:06:05.612", lv: "debug", msg: `event.data.job_requisition_id=JD-2041 tenant=icbc` },
    { t: "14:06:05.842", lv: "info", msg: `audit trail committed · user=u_482 · tenant=icbc` },
  ];
  const lvCol: Record<string, string> = {
    info: "var(--c-ink-2)",
    warn: "oklch(0.5 0.14 75)",
    error: "var(--c-err)",
    debug: "var(--c-ink-4)",
  };
  return (
    <div style={{ padding: 22 }}>
      <DetailCard title="Runtime logs · structured · tail">
        <div
          className="mono text-[11px] rounded-md overflow-auto max-h-[360px]"
          style={{
            background: "oklch(0.22 0.01 260)",
            border: "1px solid oklch(0.28 0.01 260)",
            padding: "10px 12px",
            lineHeight: 1.55,
            color: "oklch(0.85 0.01 260)",
          }}
        >
          {logs.map((l, i) => (
            <div key={i} className="flex gap-2.5">
              <span style={{ color: "oklch(0.6 0.02 260)" }}>{l.t}</span>
              <span
                className="uppercase"
                style={{ width: 44, color: lvCol[l.lv], fontSize: 10 }}
              >
                {l.lv}
              </span>
              <span>{l.msg}</span>
            </div>
          ))}
        </div>
      </DetailCard>
    </div>
  );
}

function EventLiveStream() {
  const { t } = useApp();
  const [paused, setPaused] = React.useState(false);
  const [items, setItems] = React.useState<StreamItem[]>(() => seedStream());

  React.useEffect(() => {
    if (paused) return;
    const id = setInterval(() => {
      setItems((prev) => [randomEvent(), ...prev].slice(0, 20));
    }, 1400);
    return () => clearInterval(id);
  }, [paused]);

  return (
    <aside className="border-l border-line bg-surface flex flex-col min-h-0">
      <div className="border-b border-line flex items-center gap-2" style={{ padding: "12px 14px" }}>
        <div className="text-[13px] font-semibold flex-1">{t("em_stream")}</div>
        <Badge variant="info" dot>{paused ? "paused" : "live"}</Badge>
        <Btn size="sm" variant="ghost" style={{ padding: "0 6px" }} onClick={() => setPaused((p) => !p)}>
          {paused ? <Ic.play /> : <Ic.pause />}
        </Btn>
      </div>
      <div className="border-b border-line flex gap-1.5" style={{ padding: "8px 10px" }}>
        <input
          placeholder="filter: name, job_id…"
          className="flex-1 h-6 border border-line bg-panel rounded-sm mono text-[10.5px] text-ink-1 outline-none"
          style={{ padding: "0 8px" }}
        />
        <Btn size="sm" variant="ghost" style={{ padding: "0 6px" }} title="filter"><Ic.grid /></Btn>
      </div>
      <div className="flex-1 overflow-auto min-h-0">
        {items.map((e, i) => (
          <StreamRow key={e.id} e={e} isNew={i === 0 && !paused} />
        ))}
      </div>
      <div className="border-t border-line flex items-center text-[11px] text-ink-4" style={{ padding: "10px 14px" }}>
        <span className="mono">{items.length} shown · 4,827/min</span>
        <div className="flex-1" />
        <Btn size="sm" variant="ghost" style={{ padding: "0 6px" }}>{t("em_replay")}</Btn>
      </div>
    </aside>
  );
}

type StreamItem = {
  id: string;
  name: string;
  isErr: boolean;
  t: string;
  job: string;
  tenant: string;
  sub: string;
};

function StreamRow({ e, isNew }: { e: StreamItem; isNew: boolean }) {
  const [fresh, setFresh] = React.useState(isNew);
  React.useEffect(() => {
    if (!fresh) return;
    const id = setTimeout(() => setFresh(false), 900);
    return () => clearTimeout(id);
  }, [fresh]);
  const ev = EVENT_CATALOG.find((x) => x.name === e.name);
  const dot = kindDot(ev?.kind || "domain");
  return (
    <div
      className="flex items-start gap-2 border-b border-line transition-colors"
      style={{
        padding: "8px 12px",
        background: fresh ? "color-mix(in oklab, var(--c-accent) 10%, transparent)" : "transparent",
      }}
    >
      <span
        className="w-1.5 h-1.5 rounded-full flex-shrink-0 mt-1.5"
        style={{
          background: dot,
          boxShadow: `0 0 0 3px color-mix(in oklab, ${dot} 18%, transparent)`,
        }}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-0.5">
          <span className="mono text-[10px] text-ink-4">{e.t}</span>
          <span
            className="mono text-[11px] font-semibold"
            style={{ color: e.isErr ? "var(--c-err)" : "var(--c-ink-1)" }}
          >
            {e.name}
          </span>
        </div>
        <div className="mono text-[10px] text-ink-4 overflow-hidden text-ellipsis whitespace-nowrap">
          job={e.job} · tenant={e.tenant} · {e.sub}
        </div>
      </div>
    </div>
  );
}

function seedStream(): StreamItem[] {
  const now = new Date();
  const out: StreamItem[] = [];
  for (let i = 0; i < 16; i++) {
    const d = new Date(now.getTime() - i * 4200);
    out.push(randomEvent(d));
  }
  return out;
}

let _ctr = 1000;
function randomEvent(dateOverride?: Date): StreamItem {
  const d = dateOverride || new Date();
  const pool = EVENT_CATALOG.filter((e) => e.rate > 20);
  const ev = pool[Math.floor(Math.random() * pool.length)];
  const tenants = ["icbc", "ping-an", "weipinhui", "bytedance", "didi", "alibaba"];
  const jobs = ["JD-2041", "JD-2039", "JD-2037", "JD-2033", "JD-2029", "JD-2024"];
  _ctr += 1;
  return {
    id: "evt_" + _ctr,
    name: ev.name,
    isErr: ev.kind === "error" || ev.kind === "gate",
    t: d.toTimeString().slice(0, 8) + "." + String(d.getMilliseconds()).padStart(3, "0"),
    job: jobs[Math.floor(Math.random() * jobs.length)],
    tenant: tenants[Math.floor(Math.random() * tenants.length)],
    sub: ev.subscribers[0],
  };
}
