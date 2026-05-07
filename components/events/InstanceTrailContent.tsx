"use client";
import React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Ic } from "@/components/shared/Ic";
import { Badge, Btn, EmptyState } from "@/components/shared/atoms";
import { fetchJson } from "@/lib/api/client";
import type { EventInstanceDetail } from "@/app/api/em/event-instances/[id]/route";

// /events/:name/instances/:id
//
// Two columns:
//   left  — em.publish trail (the 5 steps the library actually ran)
//   right — causality (parent above + children below)
//
// Inngest run output (function-level steps inside subscriber agents) is
// out of scope for now — it lives in Inngest's own SQLite and we'd have
// to query http://localhost:8288/v1/runs?event_id=... to surface it.
// That's a follow-up; the EM-side trail alone already gives ops a much
// better picture than what we had before (zero rows on this page existed).

export function InstanceTrailContent({
  eventName,
  instanceId,
}: {
  eventName: string;
  instanceId: string;
}) {
  const router = useRouter();
  const [data, setData] = React.useState<EventInstanceDetail | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setLoading(true);
    fetchJson<EventInstanceDetail>(`/api/em/event-instances/${instanceId}`)
      .then(setData)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [instanceId]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <span className="text-ink-3 text-[12px]">加载中…</span>
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <EmptyState
          icon={<Ic.alert />}
          title="加载失败"
          hint={error}
          variant="warn"
          action={
            <Btn size="sm" onClick={() => router.refresh()}>
              重试
            </Btn>
          }
        />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <EmptyState
          icon={<Ic.search />}
          title="找不到此事件实例"
          hint={`id ${instanceId} 不存在或已超过 EventInstance 保留期`}
          action={
            <Link href={`/events?event=${encodeURIComponent(eventName)}`}>
              <Btn size="sm">返回 {eventName}</Btn>
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <Header data={data} />
      <div
        className="flex-1 grid min-h-0"
        style={{ gridTemplateColumns: "1fr 360px" }}
      >
        <Trail data={data} />
        <Causality data={data} />
      </div>
    </div>
  );
}

function Header({ data }: { data: EventInstanceDetail }) {
  const ts = new Date(data.ts);
  return (
    <div
      className="border-b border-line bg-surface flex items-center"
      style={{ padding: "14px 22px", gap: 18 }}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 mb-1">
          <Link
            href={`/events?event=${encodeURIComponent(data.name)}`}
            className="mono text-[14px] font-semibold text-ink-1 no-underline hover:underline"
          >
            {data.name}
          </Link>
          <span className="text-ink-3 text-[11.5px]">/</span>
          <span className="mono text-[11.5px] text-ink-3 truncate">
            {data.id.slice(0, 8)}…
          </span>
          <StatusBadge status={data.status} />
          {data.schemaVersionUsed && (
            <Badge variant="info">v{data.schemaVersionUsed}</Badge>
          )}
        </div>
        <div className="text-[11.5px] text-ink-3 mono">
          {ts.toLocaleString(undefined, { hour12: false })} · 来源 {data.source}
          {data.externalEventId && (
            <>
              {" · "}external{" "}
              <span className="text-ink-2">{data.externalEventId}</span>
            </>
          )}
        </div>
      </div>
      <Link href={`/events?subtab=instances&q=${encodeURIComponent(data.name)}`}>
        <Btn size="sm" variant="ghost">
          <Ic.chev /> 返回列表
        </Btn>
      </Link>
    </div>
  );
}

// ── Trail (the em.publish 5 steps) ────────────────────────────────────────

type StepStatus = "ok" | "skip" | "fail" | "pending";

type Step = {
  id: string;
  title: string;
  status: StepStatus;
  detail?: React.ReactNode;
};

function buildSteps(data: EventInstanceDetail): Step[] {
  const isAccepted = data.status === "accepted";
  const rejectedSchema = data.status === "rejected_schema";
  const rejectedFilter = data.status === "rejected_filter";
  const duplicate = data.status === "duplicate";
  const meta = data.status === "meta_rejection";

  // Step 1: filter
  const filterStep: Step = {
    id: "filter",
    title: "① Filter (gateway 规则)",
    status: rejectedFilter ? "fail" : "ok",
    detail: rejectedFilter ? (
      <Plain>{data.rejectionReason ?? "—"}</Plain>
    ) : (
      <Muted>Phase 3 启用真实规则。当前 Phase 1 默认放行所有事件。</Muted>
    ),
  };

  // Step 2: schema validate
  const schemaStep: Step = {
    id: "schema",
    title: "② Schema 校验",
    status: rejectedFilter ? "skip" : rejectedSchema ? "fail" : "ok",
    detail: rejectedSchema ? (
      <div>
        <Plain>{data.rejectionReason}</Plain>
        {Array.isArray(data.schemaErrors) && data.schemaErrors.length > 0 && (
          <ul className="mono text-[10.5px] text-ink-2 leading-relaxed mt-2">
            {(data.schemaErrors as Array<{ path: string; message: string }>)
              .slice(0, 8)
              .map((e, i) => (
                <li key={i}>
                  <span className="text-ink-3">{e.path || "(root)"}</span>{" "}
                  · {e.message}
                </li>
              ))}
          </ul>
        )}
        {data.triedVersions && data.triedVersions.length > 0 && (
          <Muted>尝试版本: {data.triedVersions.join(", ")}</Muted>
        )}
      </div>
    ) : data.schemaVersionUsed ? (
      <Muted>通过 schema v{data.schemaVersionUsed}</Muted>
    ) : null,
  };

  // Step 3: dedup
  const dedupStep: Step = {
    id: "dedup",
    title: "③ Dedup 去重",
    status: rejectedSchema || rejectedFilter ? "skip" : duplicate ? "fail" : "ok",
    detail: duplicate ? (
      <Plain>external_event_id 已存在；静默丢弃（不发 EVENT_REJECTED）</Plain>
    ) : (
      <Muted>
        idempotency key ={" "}
        <span className="mono">{data.externalEventId ?? data.id}</span>
      </Muted>
    ),
  };

  // Step 4: persist
  const persistStep: Step = {
    id: "persist",
    title: "④ 持久化 EventInstance + AuditLog",
    status:
      rejectedSchema || rejectedFilter
        ? "ok" // Even rejected events get an EventInstance row (but no audit row)
        : duplicate
          ? "skip"
          : isAccepted
            ? "ok"
            : "skip",
    detail: <Muted>EventInstance.id = {data.id}</Muted>,
  };

  // Step 5: send to Inngest
  const sendStep: Step = {
    id: "send",
    title: "⑤ inngest.send",
    status: isAccepted
      ? "ok"
      : meta
        ? "ok" // EVENT_REJECTED was sent; that's how we got a meta_rejection row
        : "skip",
    detail: isAccepted ? (
      <Muted>已投递到 Inngest 总线，订阅者函数 fan-out</Muted>
    ) : meta ? (
      <Muted>这是一条 EVENT_REJECTED meta event，已投递</Muted>
    ) : (
      <Muted>事件未通过校验，未投递到 Inngest</Muted>
    ),
  };

  return [filterStep, schemaStep, dedupStep, persistStep, sendStep];
}

function Trail({ data }: { data: EventInstanceDetail }) {
  const steps = buildSteps(data);
  return (
    <div className="overflow-auto" style={{ padding: "16px 22px" }}>
      <div className="text-[12px] font-semibold tracking-tight mb-3 text-ink-1">
        em.publish 流水
      </div>
      <ol className="flex flex-col gap-2">
        {steps.map((s) => (
          <StepRow key={s.id} step={s} />
        ))}
      </ol>

      {data.payloadSummary && (
        <div className="mt-6">
          <div className="text-[12px] font-semibold tracking-tight mb-2 text-ink-1">
            Payload 摘要
          </div>
          <pre
            className="mono text-[10.5px] text-ink-2 bg-panel border border-line rounded-md overflow-auto"
            style={{ padding: 10, maxHeight: 320 }}
          >
            {prettyJson(data.payloadSummary)}
          </pre>
          <Muted className="mt-1">
            完整原文存于 Inngest（
            <a
              href={`http://localhost:8288/stream/${encodeURIComponent(data.externalEventId ?? data.id)}`}
              target="_blank"
              rel="noreferrer"
              className="text-ink-3 underline hover:text-ink-1"
            >
              在 Inngest dashboard 查看
            </a>
            ）
          </Muted>
        </div>
      )}
    </div>
  );
}

function StepRow({ step }: { step: Step }) {
  const palette: Record<StepStatus, { color: string; icon: React.ReactNode }> = {
    ok: { color: "var(--c-ok)", icon: "✓" },
    fail: { color: "var(--c-err)", icon: "✗" },
    skip: { color: "var(--c-ink-4)", icon: "—" },
    pending: { color: "var(--c-ink-3)", icon: "·" },
  };
  const p = palette[step.status];
  return (
    <li className="flex gap-3" style={{ padding: "10px 12px", borderRadius: 6, background: "var(--c-surface)", border: "1px solid var(--c-line)" }}>
      <span
        className="w-5 h-5 rounded-full grid place-items-center mono text-[11px] font-semibold flex-shrink-0"
        style={{
          color: "white",
          background: p.color,
        }}
      >
        {p.icon}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[12.5px] font-medium text-ink-1">{step.title}</div>
        {step.detail && <div className="mt-1">{step.detail}</div>}
      </div>
    </li>
  );
}

// ── Causality (parent + children + jump-to-correlation) ──────────────────

function Causality({ data }: { data: EventInstanceDetail }) {
  return (
    <aside
      className="border-l border-line bg-surface overflow-auto flex flex-col gap-3"
      style={{ padding: 16 }}
    >
      <div className="text-[12px] font-semibold tracking-tight text-ink-1">
        因果链
      </div>

      {/* Parent */}
      <div>
        <div className="hint mb-1">上游</div>
        {data.parent ? (
          <RelLink instance={data.parent} />
        ) : (
          <Muted>这是因果链的根</Muted>
        )}
      </div>

      {/* Self */}
      <div>
        <div className="hint mb-1">本事件</div>
        <div
          className="mono text-[11px] text-ink-1 px-2 py-1.5 border border-line rounded-sm"
          style={{ background: "color-mix(in oklab, var(--c-accent) 5%, transparent)" }}
        >
          {data.name} · {data.id.slice(0, 8)}…
        </div>
      </div>

      {/* Children */}
      <div>
        <div className="hint mb-1">下游 {data.children.length > 0 && `(${data.children.length})`}</div>
        {data.children.length === 0 ? (
          <Muted>尚无下游事件</Muted>
        ) : (
          <div className="flex flex-col gap-1">
            {data.children.map((c) => (
              <RelLink key={c.id} instance={c} />
            ))}
          </div>
        )}
      </div>

      {/* Jump out */}
      <Muted className="mt-2">
        想看完整跨系统时间线？
        {data.externalEventId && (
          <Link
            href={`/correlations/${encodeURIComponent(data.externalEventId)}`}
            className="ml-1 text-ink-2 underline hover:text-ink-1 no-underline"
          >
            打开 /correlations/{data.externalEventId.slice(0, 8)}…
          </Link>
        )}
      </Muted>
    </aside>
  );
}

function RelLink({ instance }: { instance: { id: string; name: string; status: string } }) {
  const url = `/events/${encodeURIComponent(instance.name)}/instances/${encodeURIComponent(instance.id)}`;
  return (
    <Link
      href={url}
      className="block px-2 py-1.5 border border-line rounded-sm hover:bg-panel no-underline"
    >
      <div className="flex items-center gap-2">
        <span className="mono text-[11px] text-ink-1 flex-1 min-w-0 truncate">
          {instance.name}
        </span>
        <StatusBadge status={instance.status} compact />
      </div>
      <div className="mono text-[10px] text-ink-3 mt-0.5">{instance.id.slice(0, 12)}…</div>
    </Link>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────

function StatusBadge({ status, compact }: { status: string; compact?: boolean }) {
  const map: Record<string, { variant: "ok" | "warn" | "err" | "info" | "default"; label: string }> = {
    accepted: { variant: "ok", label: "accepted" },
    rejected_schema: { variant: "err", label: "schema 失败" },
    rejected_filter: { variant: "warn", label: "filter 拒绝" },
    duplicate: { variant: "info", label: "duplicate" },
    meta_rejection: { variant: "warn", label: "meta-rejection" },
    em_degraded: { variant: "warn", label: "em degraded" },
  };
  const m = map[status] ?? { variant: "default" as const, label: status };
  return <Badge variant={m.variant}>{compact ? m.label.split(" ")[0] : m.label}</Badge>;
}

function Plain({ children }: { children: React.ReactNode }) {
  return <div className="text-[11.5px] text-ink-2 leading-relaxed">{children}</div>;
}
function Muted({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`text-[10.5px] text-ink-3 ${className ?? ""}`}>{children}</div>
  );
}
function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}
