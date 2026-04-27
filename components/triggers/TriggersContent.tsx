"use client";
import React from "react";
import { useApp } from "@/lib/i18n";
import { Ic } from "@/components/shared/Ic";
import { Badge, Btn } from "@/components/shared/atoms";
import { fetchJson } from "@/lib/api/client";
import type { TriggersResponse, TriggerDef, TriggerKind } from "@/lib/api/types";

export function TriggersContent() {
  const { t } = useApp();
  const [tab, setTab] = React.useState<TriggerKind>("cron");
  const [triggers, setTriggers] = React.useState<TriggerDef[] | null>(null);
  const [partial, setPartial] = React.useState(false);
  const [selected, setSelected] = React.useState<TriggerDef | null>(null);

  React.useEffect(() => {
    fetchJson<TriggersResponse>("/api/triggers")
      .then((r) => {
        setTriggers(r.triggers);
        if (r.meta.partial?.length) setPartial(true);
      })
      .catch(() => setPartial(true));
  }, []);

  const counts = React.useMemo(() => {
    const c = { cron: 0, webhook: 0, upstream: 0 };
    if (triggers) for (const t of triggers) c[t.kind]++;
    return c;
  }, [triggers]);

  const visible = (triggers ?? []).filter((t) => t.kind === tab);
  const fire24h = (triggers ?? []).reduce((acc, t) => acc + t.fireCount24h, 0);
  const err24h = (triggers ?? []).reduce((acc, t) => acc + t.errorCount24h, 0);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="border-b border-line bg-surface flex items-center" style={{ padding: "14px 22px", gap: 18 }}>
        <div>
          <div className="text-[15px] font-semibold tracking-tight flex items-center gap-2">
            {t("triggers_title")}
            {partial && <Badge variant="warn" dot>{t("ui_partial_data")}</Badge>}
          </div>
          <div className="text-ink-3 text-[12px] mt-px">
            Cron {counts.cron} · Webhook {counts.webhook} · Upstream {counts.upstream} · 24h 触发{" "}
            {fire24h.toLocaleString()} · 错 {err24h}
          </div>
        </div>
      </div>
      <div className="border-b border-line bg-surface flex" style={{ padding: "0 22px" }}>
        {(["cron", "webhook", "upstream"] as TriggerKind[]).map((k) => {
          const active = tab === k;
          return (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`text-[12px] font-medium ${
                active ? "text-ink-1" : "text-ink-3 hover:text-ink-1"
              }`}
              style={{
                padding: "10px 16px",
                borderBottom: active ? "2px solid var(--c-accent)" : "2px solid transparent",
              }}
            >
              {t(`triggers_tab_${k}`)} <span className="ml-1 text-ink-4">{counts[k]}</span>
            </button>
          );
        })}
      </div>
      <div className="flex-1 grid min-h-0" style={{ gridTemplateColumns: selected ? "1fr 360px" : "1fr" }}>
        <div className="overflow-auto" style={{ padding: "16px 22px" }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>name</th>
                <th>{t("triggers_col_emits")}</th>
                <th>{tab === "cron" ? t("triggers_col_schedule") : tab === "webhook" ? t("triggers_col_endpoint") : "上游事件"}</th>
                <th>{t("triggers_col_last")}</th>
                {tab === "cron" && <th>{t("triggers_col_next")}</th>}
                <th>{t("triggers_col_errors")}</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr>
                  <td colSpan={5} className="text-ink-3 text-[12px] text-center" style={{ padding: 24 }}>
                    {triggers === null ? "加载中…" : "无数据"}
                  </td>
                </tr>
              ) : (
                visible.map((tr) => (
                  <tr key={tr.id} onClick={() => setSelected(tr)} style={{ cursor: "pointer" }}>
                    <td>
                      <div className="font-mono text-[11.5px]">{tr.name}</div>
                      <div className="text-ink-3 text-[10.5px] mt-px">{tr.description}</div>
                    </td>
                    <td className="mono">{tr.emits.join(", ") || "—"}</td>
                    <td className="mono">{tr.schedule ?? tr.endpoint ?? tr.upstreamEvent ?? "—"}</td>
                    <td className="mono">{tr.lastFiredAt ? formatTime(tr.lastFiredAt) : "—"}</td>
                    {tab === "cron" && <td className="mono">{tr.nextFireAt ? formatTime(tr.nextFireAt) : "—"}</td>}
                    <td className={tr.errorCount24h > 0 ? "" : "text-ink-3"}>{tr.errorCount24h}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {selected && (
          <aside className="border-l border-line bg-surface overflow-auto p-4">
            <div className="flex items-center mb-3">
              <div className="text-[13px] font-semibold flex-1">{selected.name}</div>
              <Btn size="sm" variant="ghost" onClick={() => setSelected(null)}>
                <Ic.cross />
              </Btn>
            </div>
            <Section label="kind">{selected.kind}</Section>
            <Section label="emits">
              {selected.emits.length === 0 ? "—" : selected.emits.join(", ")}
            </Section>
            {selected.schedule && <Section label="schedule">{selected.schedule}</Section>}
            {selected.endpoint && <Section label="endpoint">{selected.endpoint}</Section>}
            {selected.upstreamEvent && <Section label="upstream event">{selected.upstreamEvent}</Section>}
            <Section label="24h fires">{selected.fireCount24h.toLocaleString()}</Section>
            <Section label="24h errors">{selected.errorCount24h}</Section>
            <Section label="description">{selected.description}</Section>
          </aside>
        )}
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <div className="hint mb-1">{label}</div>
      <div className="text-[12px] text-ink-1 mono">{children}</div>
    </div>
  );
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  } catch {
    return iso;
  }
}
