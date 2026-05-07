"use client";
import React from "react";
import { Ic } from "@/components/shared/Ic";
import { Badge, Btn, EmptyState } from "@/components/shared/atoms";
import { fetchJson } from "@/lib/api/client";
import type {
  EventInstanceRow,
  EventInstancesResponse,
} from "@/app/api/em/event-instances/route";

// Three flavors of the same table — driven by which `query` we send.
// Keeps the rendering / interaction logic in one place; tab pages just
// pass a different status filter.

export type InstancesQuery = {
  statusIn?: string[];        // e.g. ["rejected_schema"]
  name?: string;
  source?: string;
  causedByEventId?: string;
  q?: string;
};

type Mode = "dlq" | "rejected" | "instances" | "causality";

export function EventInstancesTab({
  mode,
  query,
}: {
  mode: Mode;
  query: InstancesQuery;
}) {
  const [data, setData] = React.useState<EventInstancesResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState<string | null>(null);
  const [searchText, setSearchText] = React.useState("");
  const [selected, setSelected] = React.useState<EventInstanceRow | null>(null);

  const refresh = React.useCallback(() => {
    setLoading(true);
    const sp = new URLSearchParams();
    if (query.statusIn?.length) sp.set("statusIn", query.statusIn.join(","));
    if (query.name) sp.set("name", query.name);
    if (query.source) sp.set("source", query.source);
    if (query.causedByEventId) sp.set("causedByEventId", query.causedByEventId);
    if (searchText) sp.set("q", searchText);
    sp.set("limit", "200");
    fetchJson<EventInstancesResponse>(`/api/em/event-instances?${sp.toString()}`)
      .then((r) => {
        setData(r);
        setErr(null);
      })
      .catch((e) => setErr((e as Error).message))
      .finally(() => setLoading(false));
  }, [query.statusIn, query.name, query.source, query.causedByEventId, searchText]);

  React.useEffect(() => {
    refresh();
    const id = setInterval(refresh, 10_000);
    return () => clearInterval(id);
  }, [refresh]);

  const isEmpty = !loading && (!data || data.rows.length === 0);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div
        className="border-b border-line bg-surface flex items-center"
        style={{ padding: "10px 22px", gap: 12 }}
      >
        <input
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          placeholder={
            mode === "instances"
              ? "搜索事件名 / external_event_id…"
              : "筛选事件名…"
          }
          className="h-7 border border-line bg-panel rounded-sm mono text-[11.5px] text-ink-1 outline-none w-[280px]"
          style={{ padding: "0 8px" }}
        />
        <div className="flex-1" />
        <span className="text-[11.5px] text-ink-3 mono">
          {data ? `${data.rows.length} / ${data.total.toLocaleString()}` : "—"}
        </span>
        <Btn size="sm" variant="ghost" onClick={refresh}>
          <Ic.bolt /> 刷新
        </Btn>
      </div>
      {err ? (
        <div className="flex-1 flex items-center justify-center">
          <EmptyState
            icon={<Ic.alert />}
            title="加载失败"
            hint={err}
            variant="warn"
            action={<Btn size="sm" onClick={refresh}>重试</Btn>}
          />
        </div>
      ) : isEmpty ? (
        <EmptyForMode mode={mode} hasFilter={!!searchText} />
      ) : (
        <div className="flex-1 grid min-h-0" style={{ gridTemplateColumns: selected ? "1fr 380px" : "1fr" }}>
          <div className="overflow-auto" style={{ padding: "12px 22px" }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 140 }}>时间</th>
                  <th style={{ width: 200 }}>事件</th>
                  <th style={{ width: 120 }}>来源</th>
                  <th>{modeColumn(mode)}</th>
                  <th style={{ width: 80 }}>状态</th>
                </tr>
              </thead>
              <tbody>
                {data!.rows.map((r) => (
                  <Row
                    key={r.id}
                    row={r}
                    mode={mode}
                    active={selected?.id === r.id}
                    onClick={() => setSelected((s) => (s?.id === r.id ? null : r))}
                  />
                ))}
              </tbody>
            </table>
          </div>
          {selected && (
            <DetailPane row={selected} onClose={() => setSelected(null)} mode={mode} onActioned={refresh} />
          )}
        </div>
      )}
    </div>
  );
}

function modeColumn(mode: Mode): string {
  switch (mode) {
    case "dlq":
      return "失败原因";
    case "rejected":
      return "拒绝原因";
    case "causality":
      return "上游事件";
    default:
      return "external_event_id";
  }
}

function EmptyForMode({ mode, hasFilter }: { mode: Mode; hasFilter: boolean }) {
  if (hasFilter) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <EmptyState title="无匹配项" hint="尝试清空搜索条件" />
      </div>
    );
  }
  switch (mode) {
    case "dlq":
      return (
        <div className="flex-1 flex items-center justify-center">
          <EmptyState
            icon={<Ic.alert />}
            title="暂无死信记录"
            hint="DLQ 由 em.publish 在 schema 校验失败时写入。当前未捕获任何 schema 失败 — 这通常是好事。可用 POST /api/em/publish 故意发坏数据来验证通路。"
            variant="info"
          />
        </div>
      );
    case "rejected":
      return (
        <div className="flex-1 flex items-center justify-center">
          <EmptyState
            icon={<Ic.cross />}
            title="暂无拒绝记录"
            hint="网关拒绝由 em.publish 在 filter 校验失败时写入。Phase 1 filter 默认放行所有事件（spec v2 §1.2.3 / §15 Phase 3 启用真实规则）。"
          />
        </div>
      );
    case "instances":
      return (
        <div className="flex-1 flex items-center justify-center">
          <EmptyState
            icon={<Ic.search />}
            title="暂无事件实例"
            hint="EventInstance 行由 em.publish 写入。raas-bridge 上 VPN 后会自动产生流量；离线时可用 POST /api/em/publish 发测试事件。"
            variant="info"
          />
        </div>
      );
    case "causality":
      return (
        <div className="flex-1 flex items-center justify-center">
          <EmptyState
            icon={<Ic.branch />}
            title="暂无因果链"
            hint="cascade 关联（caused_by_event_id）由 em.publish 在 agent 内部 emit 时写入。需要至少两条相互关联的 EventInstance 才能形成链路。"
            variant="info"
          />
        </div>
      );
  }
}

function Row({
  row,
  mode,
  active,
  onClick,
}: {
  row: EventInstanceRow;
  mode: Mode;
  active: boolean;
  onClick: () => void;
}) {
  const ts = new Date(row.ts);
  const time = `${ts.toLocaleDateString(undefined, { month: "2-digit", day: "2-digit" })} ${ts.toLocaleTimeString(undefined, { hour12: false })}`;
  const colCell =
    mode === "dlq" || mode === "rejected"
      ? row.rejectionReason
      : mode === "causality"
        ? row.causedByName ?? "—"
        : row.externalEventId ?? "—";
  return (
    <tr
      onClick={onClick}
      style={{
        cursor: "pointer",
        background: active ? "var(--c-accent-bg)" : undefined,
      }}
    >
      <td className="mono text-[11px] text-ink-2">{time}</td>
      <td className="mono text-[11.5px] text-ink-1">{row.name}</td>
      <td className="text-[11.5px] text-ink-3">{row.source}</td>
      <td className="text-[11.5px] mono text-ink-2 truncate">{colCell}</td>
      <td>
        <StatusBadge status={row.status} />
      </td>
    </tr>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<
    string,
    { variant: "ok" | "warn" | "err" | "info" | "default"; label: string }
  > = {
    accepted: { variant: "ok", label: "accepted" },
    rejected_schema: { variant: "err", label: "schema 失败" },
    rejected_filter: { variant: "warn", label: "filter 拒绝" },
    duplicate: { variant: "info", label: "duplicate" },
    meta_rejection: { variant: "warn", label: "meta-rejection" },
    em_degraded: { variant: "warn", label: "em degraded" },
  };
  const m = map[status] ?? { variant: "default" as const, label: status };
  return <Badge variant={m.variant}>{m.label}</Badge>;
}

function DetailPane({
  row,
  onClose,
  mode,
  onActioned,
}: {
  row: EventInstanceRow;
  onClose: () => void;
  mode: Mode;
  onActioned: () => void;
}) {
  const [busy, setBusy] = React.useState<"replay" | "discard" | null>(null);
  const [actionMsg, setActionMsg] = React.useState<string | null>(null);

  const replay = async () => {
    setBusy("replay");
    setActionMsg(null);
    try {
      const r = await fetch(`/api/em/event-instances/${row.id}/replay`, {
        method: "POST",
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        setActionMsg("已重放");
        onActioned();
      } else {
        setActionMsg(`重放失败：${j.message ?? r.statusText}`);
      }
    } catch (e) {
      setActionMsg(`重放失败：${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <aside className="border-l border-line bg-surface flex flex-col min-h-0 overflow-auto">
      <div className="border-b border-line p-3 flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="mono text-[12px] font-semibold text-ink-1 break-all">{row.name}</div>
          <div className="mono text-[10.5px] text-ink-3 mt-1">id {row.id.slice(0, 8)}…</div>
        </div>
        <a
          href={`/events/${encodeURIComponent(row.name)}/instances/${encodeURIComponent(row.id)}`}
          className="text-ink-3 hover:text-ink-1 text-[10.5px] mr-1 no-underline"
          title="打开完整 trail 页"
        >
          ↗
        </a>
        <button onClick={onClose} className="text-ink-3 hover:text-ink-1 bg-transparent border-0 cursor-pointer text-[14px]">×</button>
      </div>

      <Section label="状态">
        <StatusBadge status={row.status} />
        {row.schemaVersionUsed && (
          <span className="mono text-[10.5px] text-ink-3 ml-2">v{row.schemaVersionUsed}</span>
        )}
      </Section>

      {row.rejectionReason && (
        <Section label="原因">
          <div className="text-[11.5px] text-ink-2 leading-relaxed">{row.rejectionReason}</div>
          {row.triedVersions && row.triedVersions.length > 0 && (
            <div className="mono text-[10.5px] text-ink-4 mt-2">尝试版本：{row.triedVersions.join(", ")}</div>
          )}
        </Section>
      )}

      {Array.isArray(row.schemaErrors) && row.schemaErrors.length > 0 && (
        <Section label="schema 错误">
          <ul className="text-[10.5px] mono text-ink-2 leading-relaxed">
            {(row.schemaErrors as Array<{ path: string; code: string; message: string }>).slice(0, 10).map((e, i) => (
              <li key={i}>
                <span className="text-ink-3">{e.path || "(root)"}</span> · {e.message}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {row.externalEventId && (
        <Section label="external_event_id">
          <span className="mono text-[10.5px] text-ink-2 break-all">{row.externalEventId}</span>
        </Section>
      )}

      {row.causedByEventId && (
        <Section label="上游事件">
          <a
            href={`/events?subtab=causality&causedByEventId=${encodeURIComponent(row.causedByEventId)}`}
            className="mono text-[10.5px] text-ink-2 break-all no-underline hover:text-ink-1"
          >
            {row.causedByName ?? "事件"} · {row.causedByEventId.slice(0, 8)}…
          </a>
        </Section>
      )}

      {row.payloadSummary && (
        <Section label="payload 摘要">
          <pre
            className="mono text-[10px] text-ink-2 bg-panel border border-line rounded-sm overflow-auto"
            style={{ padding: 8, margin: 0, maxHeight: 220 }}
          >
            {prettyJson(row.payloadSummary)}
          </pre>
        </Section>
      )}

      {mode === "dlq" && (
        <div className="border-t border-line p-3 flex flex-col gap-2 mt-auto">
          <Btn size="sm" disabled={busy === "replay"} onClick={replay}>
            <Ic.play /> {busy === "replay" ? "重放中…" : "重放"}
          </Btn>
          {actionMsg && (
            <div className="text-[10.5px] text-ink-3">{actionMsg}</div>
          )}
        </div>
      )}
    </aside>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-line p-3">
      <div className="hint mb-1">{label}</div>
      {children}
    </div>
  );
}

function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}
