"use client";
import React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Ic } from "@/components/shared/Ic";
import { Badge, Btn, EmptyState } from "@/components/shared/atoms";
import { fetchJson } from "@/lib/api/client";
import type { AuditResponse, AuditLogRow } from "@/app/api/audit/route";

export function AuditContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const eventName = searchParams.get("eventName") ?? "";
  const traceId = searchParams.get("traceId") ?? "";
  const source = searchParams.get("source") ?? "";

  const [data, setData] = React.useState<AuditResponse | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    setLoading(true);
    const sp = new URLSearchParams();
    if (eventName) sp.set("eventName", eventName);
    if (traceId) sp.set("traceId", traceId);
    if (source) sp.set("source", source);
    const qs = sp.toString();
    fetchJson<AuditResponse>(`/api/audit${qs ? "?" + qs : ""}`)
      .then(setData)
      .finally(() => setLoading(false));
  }, [eventName, traceId, source]);

  const setFilter = (k: "eventName" | "traceId" | "source", v: string) => {
    const sp = new URLSearchParams(searchParams.toString());
    if (v) sp.set(k, v);
    else sp.delete(k);
    router.replace(`/audit?${sp.toString()}`);
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div
        className="border-b border-line bg-surface flex items-center"
        style={{ padding: "14px 22px", gap: 18 }}
      >
        <div>
          <div className="text-[15px] font-semibold tracking-tight">审计日志</div>
          <div className="text-ink-3 text-[12px] mt-px">
            EM 库 publish 调用全量审计 · WORM (write-once)
            {data ? ` · ${data.total.toLocaleString()} 条` : ""}
          </div>
        </div>
        <div className="flex-1" />
        <FilterInput label="事件名" value={eventName} onChange={(v) => setFilter("eventName", v)} placeholder="EVENT_NAME" />
        <FilterInput label="trace_id" value={traceId} onChange={(v) => setFilter("traceId", v)} placeholder="trace-..." />
        <FilterInput label="来源" value={source} onChange={(v) => setFilter("source", v)} placeholder="ws | em | external" />
      </div>
      <div className="flex-1 overflow-auto" style={{ padding: "16px 22px" }}>
        {loading && !data ? (
          <EmptyState title="加载中…" hint="" />
        ) : !data || data.rows.length === 0 ? (
          <EmptyState
            icon={<Ic.book />}
            title={data?.meta.empty ? "暂无审计记录" : "无匹配项"}
            hint={
              data?.meta.empty
                ? "AuditLog 由 EM 库的 em.publish 写入。该库尚未上线，因此当前 0 条记录。spec v2 §11.1 落地后，每次发布都会在此留下不可篡改的审计行。"
                : "尝试清空筛选条件"
            }
            variant={data?.meta.empty ? "info" : "default"}
            action={
              !data?.meta.empty ? (
                <Btn size="sm" onClick={() => router.replace("/audit")}>
                  清空筛选
                </Btn>
              ) : undefined
            }
          />
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 160 }}>时间</th>
                <th style={{ width: 200 }}>事件名</th>
                <th style={{ width: 80 }}>来源</th>
                <th>trace_id</th>
                <th style={{ width: 200 }}>payload digest</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <AuditRow key={r.id} row={r} onCopy={(v) => navigator.clipboard?.writeText(v)} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function FilterInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <label className="flex flex-col gap-px">
      <span className="hint">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-7 border border-line bg-panel rounded-sm mono text-[11.5px] text-ink-1 outline-none w-[180px]"
        style={{ padding: "0 8px" }}
      />
    </label>
  );
}

function AuditRow({ row, onCopy }: { row: AuditLogRow; onCopy: (v: string) => void }) {
  const t = new Date(row.createdAt);
  const time = `${t.toLocaleDateString(undefined, { month: "2-digit", day: "2-digit" })} ${t.toLocaleTimeString(undefined, { hour12: false })}`;
  const sourceVariant: "info" | "warn" | "default" =
    row.source === "ws" ? "info" : row.source === "em" ? "default" : "warn";
  return (
    <tr>
      <td className="mono text-[11px] text-ink-2">{time}</td>
      <td className="mono text-[11.5px] text-ink-1">{row.eventName}</td>
      <td>
        <Badge variant={sourceVariant}>{row.source}</Badge>
      </td>
      <td>
        <button
          onClick={() => onCopy(row.traceId)}
          className="mono text-[11px] text-ink-2 cursor-pointer bg-transparent border-0 hover:text-ink-1"
          title="点击复制"
        >
          {row.traceId}
        </button>
      </td>
      <td className="mono text-[10.5px] text-ink-3">{row.payloadDigest.slice(0, 20)}…</td>
    </tr>
  );
}
