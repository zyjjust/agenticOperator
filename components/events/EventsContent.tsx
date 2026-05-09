"use client";
import React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useApp } from "@/lib/i18n";
import { Ic } from "@/components/shared/Ic";
import { Badge, Btn, StatusDot, EmptyState } from "@/components/shared/atoms";
import { EVENT_CATALOG, EventDef, kindDot, STAGE_LABELS } from "@/lib/events-catalog";
import { fetchJson } from "@/lib/api/client";
import type { EventsResponse, EventsMeta } from "@/lib/api/types";
import {
  useInngestEvents,
  type InngestEventRow,
  type UseInngestEventsResult,
} from "@/lib/api/inngest-events";
import { useEmHealth, type UseEmHealthResult } from "@/lib/api/em-health";
import { useEventStats, type EventStats } from "@/lib/api/event-stats";
import { EventInstancesTab } from "./EventInstancesTab";
import { EventLogModal } from "./EventLogModal";
import {
  classifyEvent,
  lifecycleBadgeVariant,
  LIFECYCLE_LABEL,
  type EventLifecycle,
} from "@/lib/event-lifecycle";

// Top-level sub-tabs (UX review §A.4). Only "registry" and "stream" are
// fully populated today — DLQ / rejected / instances / causality wait for
// the em.publish library to start writing EventInstance rows. They render
// EmptyState now so the IA is visible from day one.
type TopTab = "registry" | "stream" | "dlq" | "rejected" | "instances" | "causality";
const TOP_TABS: { id: TopTab; label: string; description: string }[] = [
  { id: "registry", label: "注册表", description: "Neo4j 同步的事件契约与 schema" },
  { id: "stream", label: "实时流", description: "Inngest 总线上的实时事件" },
  { id: "dlq", label: "死信", description: "Schema / filter 失败被拒的事件（DLQ）" },
  { id: "rejected", label: "拒绝", description: "网关 filter 拒绝或无订阅者的事件" },
  { id: "instances", label: "实例追踪", description: "按 trace_id 检索单条 EventInstance" },
  { id: "causality", label: "因果链", description: "事件因果图（caused_by 关联）" },
];

function isTopTab(s: string | null): s is TopTab {
  return !!s && TOP_TABS.some((t) => t.id === s);
}

// Convert API EventContract → legacy EventDef shape, preserving provenance
// so the registry can badge each row.
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
    source: c.source,
    syncedAt: c.syncedAt,
    activeVersions: c.activeVersions,
    schemaSource: c.schemaSource,
    versionSources: c.versionSources,
    fields: c.fields,
    mutationsV2: c.mutations,
    sourceAction: c.sourceAction,
    schema: c.schema,
    isBreakingChange: c.isBreakingChange,
    lastChangedAt: c.lastChangedAt,
    retiredAt: c.retiredAt,
    sourceFile: c.sourceFile,
  };
}

export function EventsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // URL state: ?subtab=registry|stream|dlq|... &event=NAME &detailtab=overview|schema|subs|instances
  const topTabParam = searchParams.get("subtab");
  const topTab: TopTab = isTopTab(topTabParam) ? topTabParam : "registry";
  const eventParam = searchParams.get("event");
  const detailTabParam = searchParams.get("detailtab") ?? "overview";
  const queryParam = searchParams.get("q") ?? "";

  const setTopTab = React.useCallback(
    (t: TopTab) => {
      const sp = new URLSearchParams(searchParams.toString());
      sp.set("subtab", t);
      router.replace(`/events?${sp.toString()}`);
    },
    [router, searchParams],
  );
  const setSelectedName = React.useCallback(
    (name: string) => {
      const sp = new URLSearchParams(searchParams.toString());
      sp.set("event", name);
      router.replace(`/events?${sp.toString()}`);
    },
    [router, searchParams],
  );
  const setDetailTab = React.useCallback(
    (t: string) => {
      const sp = new URLSearchParams(searchParams.toString());
      sp.set("detailtab", t);
      router.replace(`/events?${sp.toString()}`);
    },
    [router, searchParams],
  );
  const setQuery = React.useCallback(
    (q: string) => {
      const sp = new URLSearchParams(searchParams.toString());
      if (q) sp.set("q", q);
      else sp.delete("q");
      router.replace(`/events?${sp.toString()}`);
    },
    [router, searchParams],
  );

  const [apiEvents, setApiEvents] = React.useState<EventDef[] | null>(null);
  const [eventsMeta, setEventsMeta] = React.useState<EventsMeta | null>(null);
  const [bulkStats, setBulkStats] = React.useState<Record<string, { rate24h: number; rateLastHour: number; errCount24h: number }>>({});

  // Live Inngest stream — shared between header KPIs and the right sidebar.
  const [streamPaused, setStreamPaused] = React.useState(false);
  const [includeShared, setIncludeShared] = React.useState(false);
  const [streamFilter, setStreamFilter] = React.useState("");
  const stream = useInngestEvents({
    paused: streamPaused,
    intervalMs: 2000,
    limit: 100,
    includeShared,
  });

  // Event Manager health — Neo4j connectivity + sync status + degraded-mode signal.
  const emHealth = useEmHealth();

  // Refetch on mount, and when emHealth.syncNow() succeeds (lastSyncAt advances).
  const lastSeenSync = React.useRef<string | null>(null);
  React.useEffect(() => {
    const syncedAt = emHealth.data?.neo4j.lastSyncAt ?? null;
    const changed = syncedAt !== lastSeenSync.current;
    lastSeenSync.current = syncedAt;
    if (apiEvents !== null && !changed) return;
    fetchJson<EventsResponse>("/api/events")
      .then((res) => {
        setApiEvents(res.events.map(toLegacy));
        setEventsMeta(res.meta);
      })
      .catch(() => {/* keep null → fallback */});
  }, [apiEvents, emHealth.data?.neo4j.lastSyncAt]);

  // Bulk stats poll — keeps RegistryRow's per-row rate honest. 15 s interval
  // is enough; the registry list isn't a real-time view.
  React.useEffect(() => {
    if (!apiEvents || apiEvents.length === 0) return;
    let cancelled = false;
    const tick = () => {
      const names = apiEvents.map((e) => e.name).slice(0, 100);
      fetchJson<{ stats: typeof bulkStats }>(
        `/api/em/event-stats?names=${encodeURIComponent(names.join(","))}`,
      )
        .then((r) => {
          if (!cancelled) setBulkStats(r.stats);
        })
        .catch(() => { /* keep last good */ });
    };
    tick();
    const id = setInterval(tick, 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiEvents?.length]);

  // When apiEvents is null (very first render), synthesize hardcoded entries
  // with source tag so the banner state is correct even pre-fetch.
  const events: EventDef[] = apiEvents ?? EVENT_CATALOG.map((e) => ({ ...e, source: "hardcoded" as const }));
  const selectedName = eventParam ?? events[0]?.name ?? "";
  const selected = events.find((e) => e.name === selectedName) || events[0];

  const grouped = React.useMemo(() => {
    const groups: Record<string, EventDef[]> = {};
    const q = queryParam.trim().toUpperCase();
    for (const e of events) {
      if (q && !e.name.includes(q)) continue;
      (groups[e.stage] ||= []).push(e);
    }
    return groups;
  }, [queryParam, events]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <EMSubHeader stream={stream} emHealth={emHealth} />
      <ProvenanceBanner meta={eventsMeta} emHealth={emHealth} />
      <TopSubTabs current={topTab} onChange={setTopTab} />
      {topTab === "registry" && (
        <div className="flex-1 grid min-h-0" style={{ gridTemplateColumns: "300px 1fr 340px" }}>
          <EventRegistry
            grouped={grouped}
            selectedName={selectedName}
            onSelect={setSelectedName}
            query={queryParam}
            setQuery={setQuery}
            bulkStats={bulkStats}
          />
          <EventDetail event={selected} tab={detailTabParam} setTab={setDetailTab} />
          <EventLiveStream
            stream={stream}
            paused={streamPaused}
            setPaused={setStreamPaused}
            includeShared={includeShared}
            setIncludeShared={setIncludeShared}
            filter={streamFilter}
            setFilter={setStreamFilter}
          />
        </div>
      )}
      {topTab === "stream" && (
        <div className="flex-1 min-h-0 flex">
          <EventLiveStream
            stream={stream}
            paused={streamPaused}
            setPaused={setStreamPaused}
            includeShared={includeShared}
            setIncludeShared={setIncludeShared}
            filter={streamFilter}
            setFilter={setStreamFilter}
            full
          />
        </div>
      )}
      {topTab === "dlq" && (
        <EventInstancesTab mode="dlq" query={{ statusIn: ["rejected_schema"] }} />
      )}
      {topTab === "rejected" && (
        <EventInstancesTab mode="rejected" query={{ statusIn: ["rejected_filter"] }} />
      )}
      {topTab === "instances" && (
        <EventInstancesTab mode="instances" query={{}} />
      )}
      {topTab === "causality" && (
        <CausalityTabRouter searchParams={searchParams} />
      )}
    </div>
  );
}

// Causality is a roving tab — when a row in another tab links to its
// upstream (?causedByEventId=...), this tab shows the immediate children
// of that event id. Without a focal id it lists every cascade event.
function CausalityTabRouter({ searchParams }: { searchParams: ReturnType<typeof useSearchParams> }) {
  const causedById = searchParams.get("causedByEventId") ?? undefined;
  return (
    <EventInstancesTab
      mode="causality"
      query={
        causedById
          ? { causedByEventId: causedById }
          : {
              // Show every accepted row that DID cause something — i.e. the roots
              // of cascade chains. Approximated as: rows where causedByEventId is null.
              // Better filter once we have indexed counts; good enough for now.
            }
      }
    />
  );
}

function TopSubTabs({ current, onChange }: { current: TopTab; onChange: (t: TopTab) => void }) {
  return (
    <div
      className="border-b border-line bg-surface flex"
      style={{ padding: "0 22px", gap: 0 }}
    >
      {TOP_TABS.map((t) => {
        const active = current === t.id;
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            title={t.description}
            className="bg-transparent border-0 cursor-pointer text-[12.5px]"
            style={{
              padding: "10px 14px",
              color: active ? "var(--c-ink-1)" : "var(--c-ink-3)",
              fontWeight: active ? 600 : 500,
              borderBottom: active ? "2px solid var(--c-accent)" : "2px solid transparent",
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

// Banner — shown only when /api/events served fallback hardcoded data
// instead of the Neo4j-synced cache. Tells ops what to do (connect VPN
// or click "立即同步"). Hidden when source === 'neo4j'.
function ProvenanceBanner({
  meta,
  emHealth,
}: {
  meta: EventsMeta | null;
  emHealth: UseEmHealthResult;
}) {
  if (!meta || meta.source === "neo4j") return null;
  const neo4jReachable = emHealth.data?.neo4j.reachable ?? false;
  const lastSync = meta.lastNeo4jSyncAt
    ? new Date(meta.lastNeo4jSyncAt).toLocaleString(undefined, { hour12: false })
    : "从未同步";
  const reason = !emHealth.data?.neo4j.configured
    ? "Neo4j 未配置（检查 RAAS_LINKS_NEO4J_* 环境变量）"
    : !neo4jReachable
      ? `Neo4j 不可达${meta.lastNeo4jError ? ` · ${meta.lastNeo4jError}` : ""}`
      : `Neo4j 缓存为空（同步未完成或 Neo4j 上无 EventDefinition）`;

  return (
    <div
      className="border-b flex items-center gap-3"
      style={{
        background: "color-mix(in oklab, var(--c-warn) 8%, transparent)",
        borderColor: "color-mix(in oklab, var(--c-warn) 30%, var(--c-line))",
        padding: "8px 22px",
      }}
    >
      <Ic.alert />
      <div className="flex-1 text-[12px]">
        <span className="font-semibold" style={{ color: "var(--c-warn)" }}>
          本地兜底数据
        </span>
        <span className="text-ink-2">
          {" — "}{meta.totalHardcodedRows} 条事件来自 lib/events-catalog.ts，**Neo4j 不是真相**：{reason}。上次成功同步：{lastSync}。
        </span>
      </div>
      <Btn size="sm" onClick={() => void emHealth.syncNow()}>
        <Ic.bolt /> 立即同步
      </Btn>
    </div>
  );
}

function EMSubHeader({ stream, emHealth }: { stream: UseInngestEventsResult; emHealth: UseEmHealthResult }) {
  const { t } = useApp();

  // Real counts derived from the live Inngest poll.
  const oneMinAgo = Date.now() - 60_000;
  const last1m = stream.events.reduce((acc, e) => {
    const ts =
      e.ts ??
      (e.received_at ? new Date(e.received_at).getTime() : 0);
    return ts >= oneMinAgo ? acc + 1 : acc;
  }, 0);

  const inngestOk = stream.connected && !stream.error;
  const inngestValue = !stream.lastFetchAt
    ? "…"
    : stream.error
    ? "ERR"
    : "OK";
  const inngestDelta = stream.lastFetchAt
    ? `${stream.sources.join("+") || "local"} · ${stream.lastFetchAt.toLocaleTimeString(undefined, { hour12: false })}`
    : "connecting…";

  // EM / Neo4j slot — replaces the mock "P95 delivery" cell with real health.
  // healthy → green; degraded → orange; down/unconfigured → red.
  const em = emHealth.data;
  const emState = em?.state ?? (emHealth.loading ? "…" : "unknown");
  const emTone: "up" | "down" | "muted" =
    emState === "healthy" ? "up" : emState === "degraded" || emState === "down" ? "down" : "muted";
  const emValue =
    emState === "healthy"
      ? "OK"
      : emState === "degraded"
        ? "降级"
        : emState === "down"
          ? "DOWN"
          : emState === "unconfigured"
            ? "未配"
            : "…";
  const emDelta = em
    ? em.neo4j.reachable
      ? `Neo4j · ${em.neo4j.lastUpserted} 同步`
      : em.neo4j.configured
        ? `Neo4j 不通${em.neo4j.error ? ` · ${truncate(em.neo4j.error, 24)}` : ""}`
        : "Neo4j 未配置"
    : "正在检查";

  // Only honest signals here. The 3 mock KPIs that used to live here
  // (functions / backlog / DLQ counts) were lying — they didn't read any
  // real source. Removed until em.publish-driven counters are in place.
  const stats = [
    { label: "events · 1m", value: last1m.toLocaleString(), delta: stream.connected ? "live" : "—", tone: stream.connected ? "up" : "muted" },
    { label: "EM · Neo4j", value: emValue, delta: emDelta, tone: emTone, onClick: () => void emHealth.syncNow() },
    { label: "Inngest 连接", value: inngestValue, delta: inngestDelta, tone: inngestOk ? "up" : stream.error ? "down" : "muted" },
  ] as const;
  return (
    <div className="border-b border-line bg-surface flex items-center gap-4.5" style={{ padding: "14px 22px", gap: 18 }}>
      <div>
        <div className="text-[15px] font-semibold tracking-tight">{t("em_title")}</div>
        <div className="text-ink-3 text-[12px] mt-px">{t("em_sub")}</div>
      </div>
      <div className="flex-1 grid pl-4.5 border-l border-line" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 14, paddingLeft: 18 }}>
        {stats.map((s, i) => {
          const onClick = "onClick" in s ? s.onClick : undefined;
          const interactive = !!onClick;
          return (
            <div
              key={i}
              onClick={onClick}
              className={interactive ? "cursor-pointer hover:bg-panel rounded-sm transition-colors" : ""}
              style={interactive ? { padding: 4, margin: -4 } : undefined}
              title={interactive ? "点击立即同步" : undefined}
            >
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
          );
        })}
      </div>
      {/* "新建事件 / 发布事件" 按钮已移除：AO 不做事件定义编辑（v2 §13.1 / Q1 决议）。 */}
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

type BulkStats = Record<string, { rate24h: number; rateLastHour: number; errCount24h: number }>;

function EventRegistry({
  grouped,
  selectedName,
  onSelect,
  query,
  setQuery,
  bulkStats,
}: {
  grouped: Record<string, EventDef[]>;
  selectedName: string;
  onSelect: (n: string) => void;
  query: string;
  setQuery: (s: string) => void;
  bulkStats: BulkStats;
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
                <RegistryRow
                  key={e.name}
                  event={e}
                  active={e.name === selectedName}
                  onClick={() => onSelect(e.name)}
                  liveStats={bulkStats[e.name]}
                />
              ))}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

function RegistryRow({
  event,
  active,
  onClick,
  liveStats,
}: {
  event: EventDef;
  active: boolean;
  onClick: () => void;
  liveStats?: BulkStats[string];
}) {
  const isRetired = !!event.retiredAt;
  const isBreaking = !!event.isBreakingChange;
  // "Recently changed" = lastChangedAt within 24h; advances every time sync
  // sees a content delta from Allmeta.
  const isRecentlyChanged =
    !!event.lastChangedAt &&
    Date.now() - new Date(event.lastChangedAt).getTime() < 24 * 60 * 60 * 1000;
  return (
    <div
      onClick={onClick}
      className="flex items-center gap-2 cursor-pointer border-b border-line"
      style={{
        padding: "8px 14px",
        background: active ? "var(--c-accent-bg)" : "transparent",
        borderLeft: active ? "2px solid var(--c-accent)" : "2px solid transparent",
        opacity: isRetired ? 0.6 : 1,
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
        <div className="flex items-center gap-1.5">
          <div
            className="mono text-[11px] font-semibold whitespace-nowrap overflow-hidden text-ellipsis flex-1"
            style={{
              color: active ? "var(--c-accent)" : "var(--c-ink-1)",
              textDecoration: isRetired ? "line-through" : undefined,
            }}
          >
            {event.name}
          </div>
          {isRetired && (
            <span
              className="mono text-[9px] px-1 rounded-sm flex-shrink-0"
              style={{ background: "var(--c-panel)", color: "var(--c-ink-3)", border: "1px solid var(--c-line)" }}
              title={`Allmeta 已下架 · ${event.retiredAt ? new Date(event.retiredAt).toLocaleString(undefined, { hour12: false }) : ""}`}
            >
              已下架
            </span>
          )}
          {isBreaking && !isRetired && (
            <span
              className="mono text-[9px] px-1 rounded-sm flex-shrink-0"
              style={{
                background: "color-mix(in oklab, var(--c-err) 14%, transparent)",
                color: "var(--c-err)",
              }}
              title="Allmeta 标记为破坏性变更 (is_breaking_change=true)"
            >
              breaking
            </span>
          )}
          {isRecentlyChanged && !isRetired && !isBreaking && (
            <span
              className="mono text-[9px] px-1 rounded-sm flex-shrink-0"
              style={{
                background: "color-mix(in oklab, var(--c-info) 14%, transparent)",
                color: "var(--c-info)",
              }}
              title={`24h 内有更新 · ${event.lastChangedAt ? new Date(event.lastChangedAt).toLocaleString(undefined, { hour12: false }) : ""}`}
            >
              changed
            </span>
          )}
          {event.source === "hardcoded" && (
            <span
              className="mono text-[9px] px-1 rounded-sm flex-shrink-0"
              style={{
                background: "color-mix(in oklab, var(--c-warn) 14%, transparent)",
                color: "var(--c-warn)",
              }}
              title="本地兜底 — Neo4j 缓存为空时 fallback 到 lib/events-catalog.ts"
            >
              fallback
            </span>
          )}
        </div>
        <div className="mono text-[10px] text-ink-4 mt-px">
          {liveStats ? (
            <>
              {liveStats.rate24h.toLocaleString()} / 24h · {event.subscribers.length} sub
              {liveStats.errCount24h > 0 && (
                <span style={{ color: "var(--c-err)" }}> · {liveStats.errCount24h} err</span>
              )}
            </>
          ) : (
            <>
              {event.rate.toLocaleString()}/h · {event.subscribers.length} sub
              {event.err > 0 && <span style={{ color: "var(--c-err)" }}> · {event.err} err</span>}
            </>
          )}
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
        {tab === "instances" && <TabInstances event={event} />}
      </div>
    </div>
  );
}

function EventDetailHeader({ event }: { event: EventDef }) {
  const { t } = useApp();
  const isError = event.kind === "error";
  // Live counters from EventInstance (replaces previous mock numbers).
  const stats = useEventStats(event.name);
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
        {event.source === "neo4j" ? (
          <span title={buildSourceTooltip(event)}>
            <Badge variant={event.schemaSource === "builtin" ? "warn" : "info"} dot>
              {event.schemaSource === "builtin" ? "Neo4j (元数据)" : "Neo4j"}
              {event.activeVersions && event.activeVersions.length > 0 ? ` · v${event.activeVersions[0]}` : ""}
              {event.schemaSource === "builtin" ? " *" : ""}
            </Badge>
          </span>
        ) : event.source === "hardcoded" ? (
          <span title="本地兜底 — 上线前请确保 Neo4j 同步成功">
            <Badge variant="warn" dot>本地兜底</Badge>
          </span>
        ) : (
          <Badge variant="info">v2 · schema</Badge>
        )}
        {stats ? (
          <Badge variant={stats.errCount24h > 0 ? "warn" : "ok"} dot>
            {stats.errCount24h > 0
              ? `${stats.errCount24h} err / 24h`
              : stats.rate24h > 0
                ? `healthy · 24h (${stats.rate24h})`
                : "healthy · 24h"}
          </Badge>
        ) : (
          <Badge variant="default">…</Badge>
        )}
      </div>

      <div className="flex gap-4.5 mt-3" style={{ gap: 18 }}>
        <HeaderStat
          label="24h 发布"
          value={stats ? stats.rate24h.toLocaleString() : "…"}
          tone={stats && stats.rate24h > 0 ? "ok" : undefined}
        />
        <HeaderStat
          label="1h 速率"
          value={stats ? `${stats.rateLastHour}/h` : "…"}
          muted={!stats || stats.rateLastHour === 0}
        />
        <HeaderStat
          label="错误率 24h"
          value={
            stats && stats.rate24h > 0
              ? `${(stats.errRate24h * 100).toFixed(1)}%`
              : "—"
          }
          muted={!stats || stats.errCount24h === 0}
        />
        <HeaderStat label={t("em_subscribers")} value={event.subscribers.length.toString()} />
        <HeaderStat label={t("em_publishers")} value={event.publishers.length.toString()} />
        {event.activeVersions && event.activeVersions.length > 0 && (
          <HeaderStat
            label="活跃版本"
            value={event.activeVersions.join(", ")}
            muted={event.activeVersions.length === 1}
          />
        )}
        {event.syncedAt && (
          <HeaderStat
            label="Neo4j 同步"
            value={relativeTime(event.syncedAt)}
            muted
          />
        )}
        <div className="flex-1" />
      </div>
    </div>
  );
}

// Detailed tooltip for the Neo4j badge — explains the (sometimes mixed)
// provenance: metadata may come from Neo4j while validator falls back to
// builtin if the JSON-Schema couldn't be converted to Zod.
function buildSourceTooltip(event: EventDef): string {
  const lines: string[] = [];
  lines.push(
    `元数据 (publishers / subscribers / desc): ${
      event.source === "neo4j" ? "Neo4j" : "本地"
    }`,
  );
  lines.push(
    `校验器 (Zod schema): ${
      event.schemaSource === "neo4j"
        ? "Neo4j JSON Schema → Zod"
        : event.schemaSource === "builtin"
          ? "builtin (Neo4j schema 转换失败或缺失)"
          : "未注册"
    }`,
  );
  if (event.versionSources?.length) {
    lines.push(
      "版本来源: " +
        event.versionSources
          .map(
            (v) =>
              `${v.version}=${v.source}${v.fallbackReason ? `(${v.fallbackReason})` : ""}`,
          )
          .join(", "),
    );
  }
  if (event.syncedAt) {
    lines.push(
      `Neo4j 同步: ${new Date(event.syncedAt).toLocaleString(undefined, { hour12: false })}`,
    );
  }
  return lines.join("\n");
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s 前`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m 前`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h 前`;
  return `${Math.floor(ms / 86_400_000)}d 前`;
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
  // Collapsed from 7 → 4 (UX review). Dropped:
  //   "runs"     — duplicates the upcoming top-level "实例" sub-tab
  //   "history"  — definition history (AO doesn't edit definitions; Q1 decision)
  //   "logs"     — vague label; covered by Inngest dashboard or upcoming trail page
  //   "firehose" — duplicates the right-rail live stream
  const tabs = [
    { id: "overview", label: t("em_tab_overview") },
    { id: "schema", label: t("em_tab_schema") },
    { id: "subs", label: t("em_tab_subs") },
    { id: "instances", label: t("em_tab_instances") },
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
  const stats = useEventStats(event.name);
  return <TabOverviewInner event={event} stats={stats} t={t} />;
}

function TabOverviewInner({ event, stats, t }: { event: EventDef; stats: EventStats | null; t: (k: string) => string }) {
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

      <DetailCard title="实例分布 · 24h" span>
        {stats ? (
          stats.rate24h === 0 ? (
            <div className="text-ink-3 text-[12.5px] p-2">— 24h 内无实例 —</div>
          ) : (
            <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
              <DistroCell label="accepted" value={stats.acceptedCount24h} total={stats.rate24h} tone="ok" />
              <DistroCell label="schema 失败" value={stats.rejectedSchemaCount24h} total={stats.rate24h} tone="err" />
              <DistroCell label="filter 拒绝" value={stats.rejectedFilterCount24h} total={stats.rate24h} tone="warn" />
              <DistroCell label="duplicate" value={stats.duplicateCount24h} total={stats.rate24h} tone="info" />
            </div>
          )
        ) : (
          <div className="text-ink-3 text-[12.5px] p-2">加载中…</div>
        )}
      </DetailCard>

      <DetailCard title={t("em_triggers_workflow") + " · 下游 (24h)"} count={stats?.downstreamEmits24h.length ?? emitsEvents.length} span>
        <div className="flex flex-col gap-2">
          {stats && stats.downstreamEmits24h.length > 0 ? (
            stats.downstreamEmits24h.map((row) => {
              const target = EVENT_CATALOG.find((x) => x.name === row.name);
              return (
                <a
                  key={row.name}
                  href={`/events?event=${encodeURIComponent(row.name)}`}
                  className="flex items-center gap-2.5 rounded-sm bg-panel border border-line no-underline hover:border-line-strong"
                  style={{ padding: "8px 10px" }}
                >
                  <span className="mono text-[10.5px] text-ink-4">emit →</span>
                  <span
                    className="w-1.5 h-1.5 rounded-full"
                    style={{ background: kindDot(target?.kind || "domain") }}
                  />
                  <span className="mono text-[11.5px] font-semibold text-ink-1">{row.name}</span>
                  <div className="flex-1" />
                  <span className="mono text-[10.5px] text-ink-2">{row.count.toLocaleString()} 次</span>
                </a>
              );
            })
          ) : emitsEvents.length === 0 ? (
            <div className="text-ink-3 text-[12.5px] p-2">— 终端事件 · 无下游 —</div>
          ) : (
            // No EventInstance data yet — show declared (not actual) downstream events
            // from the registry as a hint, with a clear caveat.
            <>
              <div className="text-ink-3 text-[10.5px] mb-1">
                注：尚无实例数据，以下为注册表声明的下游事件（非实际计数）
              </div>
              {emitsEvents.map((ev, i) => {
                const target = EVENT_CATALOG.find((x) => x.name === ev);
                return (
                  <div
                    key={i}
                    className="flex items-center gap-2.5 rounded-sm bg-panel border border-line"
                    style={{ padding: "8px 10px" }}
                  >
                    <span className="mono text-[10.5px] text-ink-4">declared →</span>
                    <span
                      className="w-1.5 h-1.5 rounded-full"
                      style={{ background: kindDot(target?.kind || "domain") }}
                    />
                    <span className="mono text-[11.5px] font-semibold">{ev}</span>
                  </div>
                );
              })}
            </>
          )}
        </div>
      </DetailCard>

      {event.mutations.length > 0 && (
        <DetailCard title={t("em_mutations")} count={event.mutations.length} span>
          <div className="flex flex-wrap gap-1.5">
            {event.mutations.map((m, i) => (
              <Badge key={i} style={{ background: "var(--c-panel)", border: "1px solid var(--c-line)" }}>
                <Ic.db /> {m}
              </Badge>
            ))}
          </div>
        </DetailCard>
      )}

      <DetailCard title={t("em_delivery") + " · Inngest"}>
        <EMKV rows={[
          ["delivery", "at-least-once (Inngest)"],
          ["idempotency", "external_event_id + name"],
          ["dedup", "EventInstance.external_event_id (唯一)"],
          ["retries", "function-level (Inngest 配置)"],
          ["bus", process.env.NEXT_PUBLIC_INNGEST_BASE_URL ?? "http://localhost:8288"],
        ]} />
      </DetailCard>
      <DetailCard title={t("em_persistence")}>
        <EMKV rows={[
          ["audit", "AuditLog (Prisma) · trace_id 索引"],
          ["instance", "EventInstance (Prisma) · name+ts 索引"],
          ["payload_full", "Inngest SQLite (容器持久化)"],
          ["retention", "180 天 (spec v2 §16 Q8)"],
        ]} />
      </DetailCard>
    </div>
  );
}

function DistroCell({
  label,
  value,
  total,
  tone,
}: {
  label: string;
  value: number;
  total: number;
  tone: "ok" | "warn" | "err" | "info";
}) {
  const pct = total > 0 ? (value / total) * 100 : 0;
  const color =
    tone === "ok"
      ? "var(--c-ok)"
      : tone === "warn"
        ? "var(--c-warn)"
        : tone === "err"
          ? "var(--c-err)"
          : "var(--c-info)";
  return (
    <div>
      <div className="hint">{label}</div>
      <div className="text-[16px] font-semibold tracking-tight tabular-nums" style={{ color }}>
        {value.toLocaleString()}
      </div>
      <div className="mono text-[10.5px] text-ink-4">{pct.toFixed(1)}%</div>
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

// Payload tab — three views over the real Neo4j EventField list:
//   1. fields  — table of {name, RAAS type, required, target object}
//   2. schema  — JSON Schema generated by the sync worker (used by em.publish)
//   3. sample  — synthesized example payload generated from the field types
//
// "中/EN" toggles the ORIGINAL field name display style:
//   - 中: shows business semantics inline (RAAS type translated, target object
//     in parentheses)
//   - EN: shows raw protocol-level identifiers (snake_case fields, RAAS types
//     verbatim) — what an agent / API integrator wants to see
function TabSchema({ event }: { event: EventDef }) {
  const { t, lang } = useApp();
  const [view, setView] = React.useState<"fields" | "schema" | "sample">("fields");

  // Prefer Neo4j-sourced fields (real); fallback to legacy hardcoded data.
  const realFields = event.fields ?? [];
  const usingReal = realFields.length > 0;
  const legacyFields: typeof realFields =
    event.data?.map(([n, ty], i) => ({
      name: n,
      type: ty,
      required: i < 2,
      position: i,
      targetObject: null,
    })) ?? [];
  const fields = usingReal ? realFields : legacyFields;

  return (
    <div style={{ padding: 22 }}>
      <div className="flex items-center gap-3 mb-3">
        <div className="text-[12px] font-semibold tracking-tight text-ink-1 flex-1">
          Payload schema · {event.name}
          {usingReal && (
            <span className="mono text-[10.5px] text-ink-3 ml-2">
              {fields.length} fields · from Neo4j
            </span>
          )}
        </div>
        {/* view toggle */}
        <div className="flex items-center h-6 p-[2px] bg-panel border border-line rounded-md">
          {([
            { id: "fields", label: lang === "zh" ? "字段表" : "Fields" },
            { id: "schema", label: "JSON" },
            { id: "sample", label: lang === "zh" ? "示例" : "Sample" },
          ] as const).map((v) => (
            <button
              key={v.id}
              onClick={() => setView(v.id)}
              className="h-5 px-2 rounded-sm text-[11px] cursor-pointer border-0"
              style={{
                background: view === v.id ? "var(--c-surface)" : "transparent",
                color: view === v.id ? "var(--c-ink-1)" : "var(--c-ink-3)",
                fontWeight: view === v.id ? 600 : 500,
                boxShadow: view === v.id ? "var(--sh-1)" : undefined,
              }}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>

      {!usingReal && (
        <div
          className="text-[11.5px] text-ink-3 mb-3"
          style={{
            padding: "8px 10px",
            background: "color-mix(in oklab, var(--c-warn) 8%, transparent)",
            border: "1px solid color-mix(in oklab, var(--c-warn) 25%, var(--c-line))",
            borderRadius: 4,
          }}
        >
          {lang === "zh"
            ? "本地兜底字段（来自 lib/events-catalog.ts）。等 Neo4j 同步成功后会自动替换为真字段。"
            : "Local fallback fields (lib/events-catalog.ts). Will switch to real ones after Neo4j sync."}
        </div>
      )}

      {view === "fields" && <FieldsTable fields={fields} labelLang={lang} />}
      {view === "schema" && <SchemaJsonView event={event} labelLang={lang} />}
      {view === "sample" && <SamplePayloadView event={event} fields={fields} labelLang={lang} />}
    </div>
  );
}

function FieldsTable({
  fields,
  labelLang,
}: {
  fields: NonNullable<EventDef["fields"]>;
  labelLang: "zh" | "en";
}) {
  if (fields.length === 0) {
    return (
      <EmptyState
        icon={<Ic.book />}
        title={labelLang === "zh" ? "无声明字段" : "No declared fields"}
        hint={
          labelLang === "zh"
            ? "Neo4j 上此事件未挂载 EventField 节点；payload 视为任意 object。"
            : "No EventField nodes attached to this Event in Neo4j; payload accepts any object."
        }
      />
    );
  }
  return (
    <table className="tbl">
      <thead>
        <tr>
          <th style={{ width: 60 }}>{labelLang === "zh" ? "顺序" : "pos"}</th>
          <th style={{ width: 220 }}>{labelLang === "zh" ? "字段名" : "field"}</th>
          <th style={{ width: 180 }}>{labelLang === "zh" ? "类型" : "type"}</th>
          <th style={{ width: 60 }}>{labelLang === "zh" ? "必填" : "req"}</th>
          <th>{labelLang === "zh" ? "关联实体" : "target object"}</th>
        </tr>
      </thead>
      <tbody>
        {fields.map((f) => (
          <tr key={f.name}>
            <td className="mono text-[10.5px] text-ink-3">{f.position}</td>
            <td className="mono text-[11.5px] text-ink-1">{f.name}</td>
            <td>
              <FieldTypeBadge type={f.type} labelLang={labelLang} />
            </td>
            <td>
              {f.required ? (
                <Badge variant="warn">{labelLang === "zh" ? "必填" : "required"}</Badge>
              ) : (
                <span className="text-ink-4 mono text-[10.5px]">—</span>
              )}
            </td>
            <td>
              {f.targetObject ? (
                <span className="mono text-[11px] text-ink-2">{f.targetObject}</span>
              ) : (
                <span className="text-ink-4 mono text-[10.5px]">—</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const RAAS_TYPE_ZH: Record<string, string> = {
  String: "字符串",
  Boolean: "布尔",
  Integer: "整数",
  Long: "长整数",
  Float: "浮点",
  Double: "双精度",
  Date: "日期",
  DateTime: "日期时间",
  Object: "对象",
  Json: "JSON",
};

function FieldTypeBadge({ type, labelLang }: { type: string; labelLang: "zh" | "en" }) {
  // List<X> → render with brackets
  const list = type.match(/^List<(.+)>$/i);
  if (list) {
    return (
      <span className="mono text-[10.5px]">
        <span style={{ color: "var(--c-info)" }}>List</span>
        <span className="text-ink-3">&lt;</span>
        <FieldTypeBadge type={list[1]} labelLang={labelLang} />
        <span className="text-ink-3">&gt;</span>
      </span>
    );
  }
  const isPrimitive = !!RAAS_TYPE_ZH[type];
  const display = labelLang === "zh" && isPrimitive ? `${RAAS_TYPE_ZH[type]} (${type})` : type;
  return (
    <span
      className="mono text-[10.5px]"
      style={{
        color: isPrimitive ? "var(--c-info)" : "var(--c-warn)",
        background: isPrimitive ? "var(--c-info-bg)" : "var(--c-warn-bg)",
        padding: "2px 6px",
        borderRadius: 4,
        border: `1px solid color-mix(in oklab, ${isPrimitive ? "var(--c-info)" : "var(--c-warn)"} 25%, transparent)`,
      }}
      title={!isPrimitive ? (labelLang === "zh" ? "业务实体类型 (允许任意对象)" : "Business entity type (any object)") : undefined}
    >
      {display}
    </span>
  );
}

function SchemaJsonView({ event, labelLang }: { event: EventDef; labelLang: "zh" | "en" }) {
  // Reconstruct the original Neo4j payload structure — exactly as stored in
  // the graph, no extra fields added. source_action may be absent for older
  // events that don't carry it; state_mutations omitted when empty.
  const raw: Record<string, unknown> = {};
  if (event.sourceAction) raw.source_action = event.sourceAction;
  raw.event_data = (event.fields ?? []).map((f) => ({
    name: f.name,
    type: f.type,
    ...(f.required ? { required: true } : {}),
    target_object: f.targetObject ?? null,
  }));
  if (event.mutationsV2?.length) {
    raw.state_mutations = event.mutationsV2.map((m) => ({
      target_object: m.targetObject,
      mutation_type: m.mutationType,
      impacted_properties: m.impactedProperties,
    }));
  }

  return (
    <div>
      <div className="text-[11.5px] text-ink-3 mb-2">
        {labelLang === "zh"
          ? "从 Neo4j 同步的原始事件结构（source_action · event_data · state_mutations），字段不增不减。"
          : "Raw event structure synced from Neo4j — source_action, event_data fields, state_mutations. Nothing added."}
      </div>
      <pre
        className="m-0 mono text-[11px] rounded-md overflow-auto"
        style={{
          padding: 14,
          background: "oklch(0.22 0.01 260)",
          color: "oklch(0.92 0.01 260)",
          border: "1px solid oklch(0.28 0.01 260)",
          lineHeight: 1.55,
          maxHeight: 520,
        }}
      >
        {JSON.stringify(raw, null, 2)}
      </pre>
    </div>
  );
}

function SamplePayloadView({
  event,
  fields,
  labelLang,
}: {
  event: EventDef;
  fields: NonNullable<EventDef["fields"]>;
  labelLang: "zh" | "en";
}) {
  const data: Record<string, unknown> = {};
  for (const f of fields) data[f.name] = sampleValueFor(f.type);

  const envelope = {
    entity_type: event.name.split("_")[0]?.toLowerCase() ?? "event",
    event_id: `evt_${Math.random().toString(16).slice(2, 14)}`,
    payload: data,
    trace: { trace_id: "trace_demo_001" },
  };

  return (
    <div>
      <div className="text-[11.5px] text-ink-3 mb-2">
        {labelLang === "zh"
          ? "按字段类型自动生成的示例 payload。可以直接 POST /api/em/publish 触发一次测试。"
          : "Auto-generated example payload from field types. POST it to /api/em/publish for a smoke test."}
      </div>
      <pre
        className="m-0 mono text-[11px] rounded-md overflow-auto"
        style={{
          padding: 14,
          background: "oklch(0.22 0.01 260)",
          color: "oklch(0.92 0.01 260)",
          border: "1px solid oklch(0.28 0.01 260)",
          lineHeight: 1.55,
          maxHeight: 520,
        }}
      >
        {JSON.stringify(envelope, null, 2)}
      </pre>
      <div
        className="mt-3 mono text-[10.5px] text-ink-3 rounded-sm"
        style={{
          background: "var(--c-panel)",
          border: "1px solid var(--c-line)",
          padding: "8px 10px",
        }}
      >
        {labelLang === "zh" ? "复制并测试：" : "Copy & test:"}
        <pre
          className="m-0 mono text-[10px] mt-1.5 overflow-auto"
          style={{ color: "var(--c-ink-2)", padding: 0 }}
        >
{`curl -X POST http://localhost:3002/api/em/publish \\
  -H 'Content-Type: application/json' \\
  -d '${JSON.stringify({ name: event.name, source: "manual-test", externalEventId: `${event.name.toLowerCase()}-test-${Date.now()}`, data: envelope })}'`}
        </pre>
      </div>
    </div>
  );
}

function sampleValueFor(type: string): unknown {
  const list = type.match(/^List<(.+)>$/i);
  if (list) return [sampleValueFor(list[1])];
  switch (type.toLowerCase()) {
    case "string":
    case "text":
    case "uuid":
    case "id":
      return "...";
    case "integer":
    case "int":
    case "long":
      return 0;
    case "number":
    case "float":
    case "double":
    case "decimal":
      return 0;
    case "boolean":
    case "bool":
      return false;
    case "date":
    case "datetime":
    case "timestamp":
      return new Date().toISOString();
    case "object":
    case "json":
      return {};
    default:
      // Business entity — empty object
      return {};
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Subscribers tab — real data from Neo4j (publishers + subscribers + mutations).
// "Subscribers" in RAAS lingo overloads two concepts:
//   1. agents/functions that consume this event (TRIGGERS edges in Neo4j;
//      Inngest functions in our runtime)
//   2. business entities the event mutates (EventMutation nodes)
// We render both in clearly separated cards, not as one fake "Inngest fn" list.
function TabSubscribers({ event }: { event: EventDef }) {
  const stats = useEventStats(event.name);
  const subscribers = event.subscribers ?? [];
  const publishers = event.publishers ?? [];
  const mutations = event.mutationsV2 ?? [];

  return (
    <div className="grid gap-4 items-start" style={{ padding: 22, gridTemplateColumns: "1fr 1fr" }}>
      {/* Publishers — who emits this event */}
      <DetailCard title="发布方 · publishers" count={publishers.length}>
        {event.sourceAction && (
          <div
            className="text-[11.5px] text-ink-3 mb-2"
            style={{
              padding: "6px 8px",
              background: "var(--c-info-bg)",
              border: "1px solid color-mix(in oklab, var(--c-info) 25%, transparent)",
              borderRadius: 4,
            }}
          >
            <span className="mono text-[10.5px] text-ink-4">source.action</span>{" "}
            <span className="mono font-semibold text-ink-1">{event.sourceAction}</span>
          </div>
        )}
        {publishers.length === 0 ? (
          <div className="text-ink-3 text-[12.5px] p-2">
            — 注册表未声明发布方（Neo4j 上无 EMITS 边） —
          </div>
        ) : (
          publishers.map((p, i) => (
            <EntityRow
              key={p}
              icon={<Ic.cpu />}
              name={p}
              meta={i === 0 ? "primary" : "fallback"}
              tone="info"
            />
          ))
        )}
      </DetailCard>

      {/* Subscribers — who consumes this event */}
      <DetailCard title="订阅方 · subscribers" count={subscribers.length}>
        {subscribers.length === 0 ? (
          <div className="text-ink-3 text-[12.5px] p-2">
            — 注册表未声明订阅方（Neo4j 上无 TRIGGERS 边或派生项） —
          </div>
        ) : (
          subscribers.map((s) => (
            <EntityRow
              key={s}
              icon={<Ic.plug />}
              name={s}
              meta="event subscriber"
            />
          ))
        )}
      </DetailCard>

      {/* Mutations — business entities the event modifies */}
      <DetailCard title="状态变更 · state mutations" count={mutations.length} span>
        {mutations.length === 0 ? (
          <div className="text-ink-3 text-[12.5px] p-2">
            — 该事件不修改任何业务实体（pure signal event） —
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {mutations.map((m, i) => (
              <div
                key={`${m.targetObject}-${i}`}
                className="rounded-sm bg-panel border border-line"
                style={{ padding: "10px 12px" }}
              >
                <div className="flex items-center gap-2 mb-1">
                  <Ic.db />
                  <span className="mono text-[12px] font-semibold text-ink-1">{m.targetObject}</span>
                  <Badge variant={m.mutationType === "DELETE" ? "warn" : "info"}>
                    {m.mutationType}
                  </Badge>
                  <div className="flex-1" />
                  <span className="mono text-[10.5px] text-ink-4">
                    {m.impactedProperties.length} fields
                  </span>
                </div>
                {m.impactedProperties.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {m.impactedProperties.map((p) => (
                      <span
                        key={p}
                        className="mono text-[10.5px] text-ink-2 px-1.5 py-px rounded-sm border border-line"
                        style={{ background: "var(--c-surface)" }}
                      >
                        {p}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </DetailCard>

      {/* Live execution counters — only meaningful when something actually runs */}
      <DetailCard title="实际投递 · 24h" span>
        {stats ? (
          stats.rate24h === 0 ? (
            <div className="text-ink-3 text-[12.5px] p-2">
              — 24h 内无投递（事件实例 = 0） —
            </div>
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>下游事件 (caused_by)</th>
                  <th style={{ width: 100, textAlign: "right" }}>24h 计数</th>
                  <th style={{ width: 80, textAlign: "right" }}>占比</th>
                </tr>
              </thead>
              <tbody>
                {stats.downstreamEmits24h.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="text-ink-3 text-[11.5px]" style={{ padding: 12 }}>
                      — 该事件未触发任何下游 emit —
                    </td>
                  </tr>
                ) : (
                  stats.downstreamEmits24h.map((d) => (
                    <tr key={d.name}>
                      <td className="mono text-[11.5px] text-ink-1">{d.name}</td>
                      <td className="mono text-right text-[11.5px]">{d.count.toLocaleString()}</td>
                      <td className="mono text-right text-[10.5px] text-ink-3">
                        {((d.count / stats.rate24h) * 100).toFixed(1)}%
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )
        ) : (
          <div className="text-ink-3 text-[12.5px] p-2">加载中…</div>
        )}
      </DetailCard>
    </div>
  );
}

// Per-event EventInstance list. Reuses the same table component as the
// top-level "实例追踪" sub-tab, but pre-filtered by name so only this
// event's instances show. em.publish populates EventInstance on every
// inbound; row-click opens the full trail page.
function TabInstances({ event }: { event: EventDef }) {
  const { lang } = useApp();
  return (
    <div className="flex flex-col min-h-0">
      <div
        className="text-[11.5px] text-ink-3 shrink-0"
        style={{
          padding: "8px 22px",
          borderBottom: "1px solid var(--c-line)",
          background: "var(--c-panel)",
        }}
      >
        {lang === "zh"
          ? "每条「实例」代表此事件被 em.publish() 触发并落库的一次具体执行记录，包含 trace_id、payload 快照及处理耗时。"
          : "Each instance is one concrete firing of this event — recorded by em.publish() with a trace_id, payload snapshot, and processing duration."}
      </div>
      <div className="flex-1 overflow-auto">
        <EventInstancesTab mode="instances" query={{ name: event.name }} />
      </div>
    </div>
  );
}

type EventLiveStreamProps = {
  stream: UseInngestEventsResult;
  paused: boolean;
  setPaused: (p: boolean | ((prev: boolean) => boolean)) => void;
  includeShared: boolean;
  setIncludeShared: (v: boolean) => void;
  filter: string;
  setFilter: (s: string) => void;
  /** When true, occupy the full content area (used by the "实时流" sub-tab). */
  full?: boolean;
};

type LifecycleFilter = "all" | EventLifecycle;

function EventLiveStream({
  stream,
  paused,
  setPaused,
  includeShared,
  setIncludeShared,
  filter,
  setFilter,
  full,
}: EventLiveStreamProps) {
  const { t } = useApp();
  const [lifecycleFilter, setLifecycleFilter] = React.useState<LifecycleFilter>("all");
  const [modalEvent, setModalEvent] = React.useState<InngestEventRow | null>(null);

  // Annotate every event with its lifecycle once, so badge rendering and
  // filtering both share the same classification (and we don't pay the
  // classification cost twice per row).
  const annotated = React.useMemo(
    () =>
      stream.events.map((e) => ({
        ev: e,
        cls: classifyEvent(e),
      })),
    [stream.events],
  );

  const lifecycleCounts = React.useMemo(() => {
    const c: Record<EventLifecycle, number> = {
      received: 0,
      emitted: 0,
      completed: 0,
      failed: 0,
    };
    for (const a of annotated) c[a.cls.lifecycle]++;
    return c;
  }, [annotated]);

  const filtered = React.useMemo(() => {
    const q = filter.trim().toLowerCase();
    return annotated.filter(({ ev: e, cls }) => {
      if (lifecycleFilter !== "all" && cls.lifecycle !== lifecycleFilter) return false;
      if (!q) return true;
      if (e.name.toLowerCase().includes(q)) return true;
      const d = e.data as { payload?: Record<string, unknown>; entity_id?: unknown } | null;
      const p = d?.payload as Record<string, unknown> | undefined;
      const fields = [
        p?.job_requisition_id,
        p?.client_req_id,
        p?.requirement_id,
        p?.jd_id,
        p?.client_id,
        d?.entity_id,
      ];
      return fields.some((v) => v != null && String(v).toLowerCase().includes(q));
    });
  }, [annotated, filter, lifecycleFilter]);

  // Track which IDs have been rendered before so first-time IDs flash briefly.
  const seenIds = React.useRef<Set<string>>(new Set());
  const [freshIds, setFreshIds] = React.useState<Set<string>>(new Set());
  React.useEffect(() => {
    if (paused) return;
    const fresh = new Set<string>();
    for (const e of stream.events) {
      if (!seenIds.current.has(e.id)) {
        fresh.add(e.id);
        seenIds.current.add(e.id);
      }
    }
    if (fresh.size === 0) return;
    setFreshIds(fresh);
    const tid = setTimeout(() => setFreshIds(new Set()), 900);
    return () => clearTimeout(tid);
  }, [stream.events, paused]);

  const lifecycleChips: Array<{ id: LifecycleFilter; label: string; count: number | null }> = [
    { id: "all", label: "all", count: stream.events.length },
    { id: "received", label: "received", count: lifecycleCounts.received },
    { id: "emitted", label: "emitted", count: lifecycleCounts.emitted },
    { id: "completed", label: "completed", count: lifecycleCounts.completed },
    { id: "failed", label: "failed", count: lifecycleCounts.failed },
  ];

  const stateBadge = paused
    ? { variant: "info" as const, label: "paused" }
    : stream.error
    ? { variant: "warn" as const, label: "error" }
    : stream.connected
    ? { variant: "ok" as const, label: "live" }
    : { variant: "info" as const, label: "connecting…" };

  return (
    <aside
      className={`bg-surface flex flex-col min-h-0 ${full ? "" : "border-l border-line"}`}
      style={full ? { width: "100%" } : undefined}
    >
      <div className="border-b border-line flex items-center gap-2" style={{ padding: "12px 14px" }}>
        <div className="text-[13px] font-semibold flex-1">{t("em_stream")}</div>
        <Badge variant={stateBadge.variant} dot>{stateBadge.label}</Badge>
        <Btn size="sm" variant="ghost" style={{ padding: "0 6px" }} onClick={() => setPaused((p) => !p)}>
          {paused ? <Ic.play /> : <Ic.pause />}
        </Btn>
      </div>

      <div className="border-b border-line flex flex-col gap-1.5" style={{ padding: "8px 10px" }}>
        <div className="flex gap-1.5">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter: name, job_id…"
            className="flex-1 h-6 border border-line bg-panel rounded-sm mono text-[10.5px] text-ink-1 outline-none"
            style={{ padding: "0 8px" }}
          />
          {filter && (
            <Btn size="sm" variant="ghost" style={{ padding: "0 6px" }} onClick={() => setFilter("")} title="clear filter">
              <span className="text-[12px] leading-none">×</span>
            </Btn>
          )}
        </div>
        <div className="flex flex-wrap gap-1">
          {lifecycleChips.map((c) => {
            const active = lifecycleFilter === c.id;
            return (
              <button
                key={c.id}
                onClick={() => setLifecycleFilter(c.id)}
                className="bg-transparent border cursor-pointer mono text-[10px] rounded-sm transition-colors"
                title={
                  c.id === "all"
                    ? "全部事件"
                    : c.id === "received"
                      ? "外部入口事件（webhook / RAAS）"
                      : c.id === "emitted"
                        ? "AO 内部 agent 级联（caused_by）发出的事件"
                        : c.id === "completed"
                          ? "Inngest 函数运行完成信号"
                          : "Inngest 函数运行失败信号"
                }
                style={{
                  padding: "1px 7px",
                  borderColor: active ? "var(--c-accent)" : "var(--c-line)",
                  background: active ? "var(--c-accent-bg)" : "var(--c-panel)",
                  color: active ? "var(--c-accent)" : "var(--c-ink-2)",
                  fontWeight: active ? 600 : 500,
                }}
              >
                {c.label}
                <span className="ml-1 text-ink-4">{c.count ?? 0}</span>
              </button>
            );
          })}
        </div>
        <label className="flex items-center gap-1.5 text-[10.5px] text-ink-3 cursor-pointer mono">
          <input
            type="checkbox"
            checked={includeShared}
            onChange={(e) => setIncludeShared(e.target.checked)}
          />
          include shared bus (RAAS)
        </label>
      </div>

      {stream.error && (
        <div
          className="border-b border-line mono text-[10.5px]"
          style={{ padding: "6px 12px", background: "var(--c-warn-bg)", color: "var(--c-warn)" }}
        >
          ⚠ {stream.error}
        </div>
      )}

      <div className="flex-1 overflow-auto min-h-0">
        {filtered.length === 0 && (
          <div className="text-ink-3 text-[12px]" style={{ padding: 18, textAlign: "center" }}>
            {stream.connected
              ? lifecycleFilter !== "all"
                ? `当前 lifecycle 过滤为 \`${lifecycleFilter}\`，无匹配事件`
                : "无事件 — 触发 /agent-demo 或等 RAAS 推送"
              : "正在连接 Inngest…"}
          </div>
        )}
        {filtered.map(({ ev: e, cls }) => (
          <StreamRow
            key={e.id}
            ev={e}
            lifecycle={cls.lifecycle}
            referencedEventName={cls.referencedEventName}
            fresh={freshIds.has(e.id)}
            onExpand={() => setModalEvent(e)}
          />
        ))}
      </div>

      <div className="border-t border-line flex items-center text-[11px] text-ink-4" style={{ padding: "10px 14px" }}>
        <span className="mono">
          {filtered.length} shown
          {(filter || lifecycleFilter !== "all") && ` · of ${stream.events.length}`}
          {stream.lastFetchAt && ` · ${stream.lastFetchAt.toLocaleTimeString(undefined, { hour12: false })}`}
        </span>
        <div className="flex-1" />
        <Btn size="sm" variant="ghost" style={{ padding: "0 6px" }}>{t("em_replay")}</Btn>
      </div>

      <EventLogModal event={modalEvent} onClose={() => setModalEvent(null)} />
    </aside>
  );
}

function StreamRow({
  ev,
  lifecycle,
  referencedEventName,
  fresh,
  onExpand,
}: {
  ev: InngestEventRow;
  lifecycle: EventLifecycle;
  referencedEventName?: string;
  fresh: boolean;
  onExpand: () => void;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const def = EVENT_CATALOG.find((x) => x.name === ev.name);
  const isErr = def?.kind === "error" || def?.kind === "gate" || lifecycle === "failed";
  const dot = kindDot(def?.kind ?? "domain");

  const tsMs = ev.received_at
    ? new Date(ev.received_at).getTime()
    : ev.ts ?? 0;
  const time = tsMs
    ? new Date(tsMs).toLocaleTimeString(undefined, { hour12: false }) +
      "." +
      String(tsMs % 1000).padStart(3, "0")
    : "—";

  const dataObj = (ev.data ?? {}) as { payload?: Record<string, unknown>; entity_id?: unknown };
  const payload = dataObj.payload ?? {};
  const job =
    (payload.job_requisition_id as string) ??
    (payload.requirement_id as string) ??
    (payload.client_req_id as string) ??
    (payload.jd_id as string) ??
    (dataObj.entity_id as string) ??
    "—";
  const tenant =
    (payload.client_id as string) ??
    (payload.tenant as string) ??
    "—";
  const sub = def?.subscribers?.[0] ?? "—";

  // For inngest/function.* completion signals, the row's "name" is the
  // system event; promote the original domain event name into the metadata
  // line so the human can spot it.
  const isSystem = ev.name.startsWith("inngest/");

  return (
    <div
      onClick={() => setExpanded((v) => !v)}
      className="flex items-start gap-2 border-b border-line transition-colors cursor-pointer"
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
        <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
          <span className="mono text-[10px] text-ink-4">{time}</span>
          <Badge variant={lifecycleBadgeVariant(lifecycle)} dot>
            {LIFECYCLE_LABEL[lifecycle]}
          </Badge>
          <span
            className="mono text-[11px] font-semibold"
            style={{ color: isErr ? "var(--c-err)" : "var(--c-ink-1)" }}
          >
            {ev.name}
          </span>
          {ev._source && ev._source !== "local" && (
            <Badge variant="warn">{ev._source}</Badge>
          )}
        </div>
        <div className="mono text-[10px] text-ink-4 overflow-hidden text-ellipsis whitespace-nowrap">
          {isSystem && referencedEventName ? (
            <>→ {referencedEventName}</>
          ) : (
            <>
              job={String(job).slice(-20)} · tenant={String(tenant).slice(-14)} · {sub}
            </>
          )}
        </div>
        {expanded && (
          <pre
            className="mono text-[10px] mt-1.5 rounded-sm overflow-auto"
            style={{
              padding: 8,
              maxHeight: 200,
              background: "var(--c-panel)",
              border: "1px solid var(--c-line)",
              color: "var(--c-ink-2)",
              lineHeight: 1.4,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {JSON.stringify({ id: ev.id, name: ev.name, ts: ev.ts, received_at: ev.received_at, data: ev.data }, null, 2)}
          </pre>
        )}
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onExpand();
        }}
        title="全屏查看 log"
        className="bg-transparent border-0 text-ink-4 hover:text-ink-1 cursor-pointer"
        style={{ padding: 2, fontSize: 12, lineHeight: 1 }}
      >
        ⛶
      </button>
    </div>
  );
}

