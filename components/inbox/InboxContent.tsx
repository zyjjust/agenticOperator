"use client";
import React from "react";
import { useApp } from "@/lib/i18n";
import { Ic } from "@/components/shared/Ic";
import { Badge, Btn } from "@/components/shared/atoms";
import { fetchJson, ApiTimeoutError } from "@/lib/api/client";
import type {
  HumanTasksResponse,
  HumanTaskCard,
  HumanTaskDetail,
  HumanTaskActionResult,
  MessagesResponse,
  Message,
} from "@/lib/api/types";

type Facet = "all" | "mine" | "overdue";

export function InboxContent() {
  const { t } = useApp();
  const [facet, setFacet] = React.useState<Facet>("all");
  const [list, setList] = React.useState<HumanTaskCard[]>([]);
  const [total, setTotal] = React.useState(0);
  const [partial, setPartial] = React.useState(false);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<HumanTaskDetail | null>(null);

  const refresh = React.useCallback(async () => {
    try {
      const r = await fetchJson<HumanTasksResponse>("/api/human-tasks");
      setList(r.recent);
      setTotal(r.total);
      if (r.meta.partial?.length) setPartial(true);
      else setPartial(false);
      if (!selectedId && r.recent[0]) setSelectedId(r.recent[0].id);
    } catch {
      setPartial(true);
    }
  }, [selectedId]);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  React.useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    fetchJson<HumanTaskDetail>(`/api/human-tasks/${selectedId}`)
      .then(setDetail)
      .catch(() => setDetail(null));
  }, [selectedId]);

  const visible = React.useMemo(() => {
    if (facet === "overdue") {
      const cutoff = Date.now() + 30 * 60_000;
      return list.filter((c) => c.deadline && new Date(c.deadline).getTime() < cutoff);
    }
    if (facet === "mine") return list.filter((c) => c.assignee);
    return list;
  }, [list, facet]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <SubHeader total={total} partial={partial} />
      <div className="flex-1 grid min-h-0" style={{ gridTemplateColumns: "280px 1fr 320px" }}>
        <FacetRail facet={facet} setFacet={setFacet} list={list} />
        <CardList items={visible} selectedId={selectedId} setSelectedId={setSelectedId} />
        <DetailPane detail={detail} onResolved={refresh} />
      </div>
    </div>
  );
}

function SubHeader({ total, partial }: { total: number; partial: boolean }) {
  const { t } = useApp();
  return (
    <div className="border-b border-line bg-surface flex items-center" style={{ padding: "14px 22px", gap: 18 }}>
      <div>
        <div className="text-[15px] font-semibold tracking-tight flex items-center gap-2">
          {t("inbox_title")}
          <Badge variant="info">{total}</Badge>
          {partial && <Badge variant="warn" dot>{t("ui_partial_data")}</Badge>}
        </div>
        <div className="text-ink-3 text-[12px] mt-px">人工审批 · 多轮对话 · 升级客户</div>
      </div>
    </div>
  );
}

function FacetRail({
  facet,
  setFacet,
  list,
}: {
  facet: Facet;
  setFacet: (f: Facet) => void;
  list: HumanTaskCard[];
}) {
  const { t } = useApp();
  const overdueCount = React.useMemo(() => {
    const cutoff = Date.now() + 30 * 60_000;
    return list.filter((c) => c.deadline && new Date(c.deadline).getTime() < cutoff).length;
  }, [list]);
  const mineCount = list.filter((c) => c.assignee).length;
  const items: { id: Facet; label: string; n: number }[] = [
    { id: "all", label: t("inbox_facet_all"), n: list.length },
    { id: "mine", label: t("inbox_facet_mine"), n: mineCount },
    { id: "overdue", label: t("inbox_facet_overdue"), n: overdueCount },
  ];
  return (
    <aside className="border-r border-line bg-surface overflow-auto" style={{ padding: 12 }}>
      {items.map((it) => {
        const active = facet === it.id;
        return (
          <button
            key={it.id}
            onClick={() => setFacet(it.id)}
            className={`w-full flex items-center gap-2 text-[12px] py-2 px-3 rounded-md mb-1 ${
              active ? "bg-accent-bg text-ink-1" : "text-ink-2 hover:bg-panel"
            }`}
            style={{ border: active ? "1px solid var(--c-accent-line)" : "1px solid transparent" }}
          >
            <span className="flex-1 text-left">{it.label}</span>
            <Badge variant={active ? "info" : "default"}>{it.n}</Badge>
          </button>
        );
      })}
    </aside>
  );
}

function CardList({
  items,
  selectedId,
  setSelectedId,
}: {
  items: HumanTaskCard[];
  selectedId: string | null;
  setSelectedId: (id: string) => void;
}) {
  const { t } = useApp();
  if (items.length === 0) {
    return (
      <div className="flex items-center justify-center text-ink-3 text-[13px]">
        <div className="flex flex-col items-center gap-2">
          <Ic.check />
          <div>{t("inbox_empty")}</div>
        </div>
      </div>
    );
  }
  return (
    <div className="overflow-auto" style={{ padding: "12px 14px" }}>
      {items.map((c) => (
        <Card key={c.id} card={c} active={c.id === selectedId} onClick={() => setSelectedId(c.id)} />
      ))}
    </div>
  );
}

function Card({ card, active, onClick }: { card: HumanTaskCard; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left mb-2 rounded-md border bg-surface ${
        active ? "border-accent-line" : "border-line"
      } hover:bg-panel`}
      style={{ padding: 12 }}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className="font-mono text-[10.5px] text-ink-3">{card.id.slice(-8)}</span>
        <Slabel agentShort={card.agentShort} />
        <div className="flex-1" />
        <SlaBadge deadline={card.deadline} />
      </div>
      <div className="text-[13px] font-medium text-ink-1 mb-1">{card.title}</div>
      <div className="text-[11.5px] text-ink-3 flex items-center gap-2 flex-wrap">
        <span>run {card.runId.slice(-8)} · {card.assignee ?? "未分配"}</span>
        {card.triggeringEventName && (
          <span
            className="mono text-[10px] px-1.5 py-px rounded-sm"
            style={{
              background: "color-mix(in oklab, var(--c-accent) 8%, transparent)",
              color: "var(--c-accent)",
            }}
            title={
              card.triggeringEventInstanceId
                ? `由事件 ${card.triggeringEventName}（实例 ${card.triggeringEventInstanceId}）触发`
                : `由事件 ${card.triggeringEventName} 触发`
            }
          >
            ← {card.triggeringEventName}
          </span>
        )}
      </div>
    </button>
  );
}

function Slabel({ agentShort }: { agentShort: string }) {
  const { t } = useApp();
  return (
    <Badge variant="default">
      {t(`display_${agentShort.toLowerCase()}`)}
    </Badge>
  );
}

function SlaBadge({ deadline }: { deadline: string | null }) {
  const [, force] = React.useReducer((x) => x + 1, 0);
  React.useEffect(() => {
    const id = setInterval(force, 30_000);
    return () => clearInterval(id);
  }, []);
  if (!deadline) return null;
  const left = new Date(deadline).getTime() - Date.now();
  const minutes = Math.round(left / 60_000);
  if (minutes < 0) {
    return <Badge variant="err">已超时</Badge>;
  }
  if (minutes < 30) {
    return <span style={{ color: "var(--c-timed-out)", fontSize: 11 }}>{minutes}m 截止</span>;
  }
  if (minutes < 120) {
    return <span style={{ color: "var(--c-suspended)", fontSize: 11 }}>{Math.round(minutes / 60)}h 截止</span>;
  }
  return <span className="text-ink-3" style={{ fontSize: 11 }}>{Math.round(minutes / 60)}h 截止</span>;
}

function DetailPane({
  detail,
  onResolved,
}: {
  detail: HumanTaskDetail | null;
  onResolved: () => void;
}) {
  const { t } = useApp();
  if (!detail) {
    return (
      <aside className="border-l border-line bg-surface p-4 text-ink-3 text-[12px]">选中一个任务查看详情</aside>
    );
  }
  return (
    <aside className="border-l border-line bg-surface flex flex-col min-h-0">
      <div className="border-b border-line p-3">
        <div className="text-[13px] font-semibold mb-1">{detail.title}</div>
        <div className="text-[11.5px] text-ink-3 font-mono">{detail.id}</div>
        {detail.triggeringEventName && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11.5px]">
            <span className="text-ink-3">触发事件</span>
            <a
              href={`/events?event=${encodeURIComponent(detail.triggeringEventName)}`}
              className="mono px-1.5 py-px rounded-sm no-underline"
              style={{
                background: "color-mix(in oklab, var(--c-accent) 8%, transparent)",
                color: "var(--c-accent)",
              }}
            >
              {detail.triggeringEventName}
            </a>
            {detail.triggeringEventInstanceId && (
              <span
                className="mono text-[10.5px] text-ink-3"
                title={detail.triggeringEventInstanceId}
              >
                · 实例 {detail.triggeringEventInstanceId.slice(0, 8)}…
              </span>
            )}
          </div>
        )}
      </div>
      {detail.aiOpinion != null && (
        <div className="border-b border-line p-3">
          <div className="hint mb-1">AI 意见</div>
          <div className="text-[12px] text-ink-2 whitespace-pre-wrap">
            {typeof detail.aiOpinion === "string"
              ? detail.aiOpinion
              : JSON.stringify(detail.aiOpinion, null, 2)}
          </div>
        </div>
      )}
      {detail.hasChatbotSession && <ChatPane taskId={detail.id} />}
      <ActionPanel taskId={detail.id} status={detail.status} onResolved={onResolved} />
    </aside>
  );
}

function ChatPane({ taskId }: { taskId: string }) {
  const { t } = useApp();
  const [messages, setMessages] = React.useState<Message[]>([]);
  const [draft, setDraft] = React.useState("");
  const [expired, setExpired] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetchJson<MessagesResponse>(`/api/human-tasks/${taskId}/messages`);
        if (!cancelled) setMessages(r.messages);
      } catch (e: any) {
        if (e?.error === "BAD_REQUEST" && /expired/.test(e?.message ?? "")) setExpired(true);
      }
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [taskId]);

  const send = async () => {
    if (!draft || expired) return;
    const optimistic: Message = { role: "user", content: draft, timestamp: new Date().toISOString() };
    setMessages((prev) => [...prev, optimistic]);
    setDraft("");
    try {
      const r = await fetchJson<MessagesResponse>(`/api/human-tasks/${taskId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: optimistic.content }),
      });
      setMessages(r.messages);
    } catch (e: any) {
      if (e?.error === "BAD_REQUEST" && /expired/.test(e?.message ?? "")) setExpired(true);
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 border-b border-line">
      <div className="flex-1 overflow-auto" style={{ padding: 10 }}>
        {messages.map((m, i) => (
          <div key={i} className={`mb-2 ${m.role === "user" ? "text-right" : ""}`}>
            <div
              className={`inline-block rounded-md px-2.5 py-1.5 text-[12px] ${
                m.role === "user" ? "bg-accent-bg" : "bg-panel"
              }`}
              style={{ maxWidth: 250 }}
            >
              {m.content}
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 p-2 border-t border-line">
        <input
          className="flex-1 bg-panel border border-line rounded-md text-[12px] px-2.5 py-1.5"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder={expired ? t("inbox_chat_expired") : ""}
          disabled={expired}
        />
        <Btn size="sm" onClick={send} variant="primary" disabled={expired}>
          {t("inbox_chat_send")}
        </Btn>
      </div>
    </div>
  );
}

function ActionPanel({
  taskId,
  status,
  onResolved,
}: {
  taskId: string;
  status: string;
  onResolved: () => void;
}) {
  const { t } = useApp();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  if (status !== "pending") {
    return (
      <div className="p-3 border-t border-line text-[12px] text-ink-3">已 {status}</div>
    );
  }

  const act = async (action: "approve" | "reject" | "escalate") => {
    setBusy(true);
    setError(null);
    try {
      let body: Record<string, unknown> = { action };
      if (action === "reject") {
        const reason = window.prompt("退回原因？") ?? "";
        if (!reason) {
          setBusy(false);
          return;
        }
        body.reason = reason;
      }
      if (action === "escalate") {
        const targetClient = window.prompt("上报到哪个客户？") ?? "";
        if (!targetClient) {
          setBusy(false);
          return;
        }
        body.targetClient = targetClient;
      }
      await fetchJson<HumanTaskActionResult>(`/api/human-tasks/${taskId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      onResolved();
    } catch (e: any) {
      if (e instanceof ApiTimeoutError) setError("超时");
      else if (e?.error === "BAD_REQUEST" && /stale/.test(e?.message ?? "")) {
        setError("已被他人处理");
        onResolved();
      } else {
        setError(e?.message ?? "失败");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-3 border-t border-line flex flex-col gap-2">
      {error && <div className="text-[11.5px]" style={{ color: "var(--c-err)" }}>{error}</div>}
      <Btn size="sm" variant="primary" onClick={() => act("approve")} disabled={busy}>
        {t("inbox_action_approve")}
      </Btn>
      <Btn size="sm" onClick={() => act("reject")} disabled={busy}>
        {t("inbox_action_reject")}
      </Btn>
      <Btn size="sm" variant="ghost" onClick={() => act("escalate")} disabled={busy}>
        {t("inbox_action_escalate")}
      </Btn>
    </div>
  );
}
