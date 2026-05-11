"use client";
import React from "react";
import { Ic } from "@/components/shared/Ic";
import { Badge, Btn } from "@/components/shared/atoms";
import { Markdown } from "@/components/shared/Markdown";
import type {
  AgentChatResponse,
  AgentChatSource,
} from "@/app/api/agents/[short]/chat/route";

// Agent-scoped chatbot inside Inspector. Sister to RunChatbot — same
// shape (history, suggestions, citations) but talks to /api/agents/:short/chat,
// which has tools for "find runs / entities / failures BY AGENT" rather
// than the run-scoped tools.
//
// History is persisted to localStorage by `agent:${short}` so switching
// between agents preserves separate conversations.

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  sources?: AgentChatSource[];
  modelUsed?: string;
};

const STORAGE_PREFIX = "ao:agent-chat:";
const MAX_HISTORY = 30;

const SUGGESTIONS = [
  "最近 24h 经手了哪些实例？",
  "失败 / 异常的 run 有哪些？",
  "上一次跑的 JD / 候选人是哪个？",
  "最近一周哪些失败和 RAAS 相关？",
];

function loadHistory(short: string): ChatMessage[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + short);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ChatMessage[];
    return Array.isArray(parsed) ? parsed.slice(-MAX_HISTORY) : [];
  } catch {
    return [];
  }
}

function saveHistory(short: string, history: ChatMessage[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(
      STORAGE_PREFIX + short,
      JSON.stringify(history.slice(-MAX_HISTORY)),
    );
  } catch {
    // localStorage full or disabled — silently skip.
  }
}

export function AgentChatbot({ short }: { short: string }) {
  const [open, setOpen] = React.useState(false);
  const [history, setHistory] = React.useState<ChatMessage[]>([]);
  const [input, setInput] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  // Load history each time the agent changes.
  React.useEffect(() => {
    setHistory(loadHistory(short));
    setErr(null);
  }, [short]);

  React.useEffect(() => {
    saveHistory(short, history);
    // Auto-scroll to bottom when history changes.
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    });
  }, [history, short]);

  const send = React.useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;
      const next: ChatMessage[] = [...history, { role: "user", content: trimmed }];
      setHistory(next);
      setInput("");
      setBusy(true);
      setErr(null);
      try {
        const res = await fetch(`/api/agents/${encodeURIComponent(short)}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: next.map((m) => ({ role: m.role, content: m.content })),
          }),
        });
        const data = (await res.json()) as AgentChatResponse & {
          error?: string;
          message?: string;
        };
        if (!res.ok || data.error) {
          throw new Error(data.message ?? data.error ?? `HTTP ${res.status}`);
        }
        setHistory([
          ...next,
          {
            role: "assistant",
            content: data.reply.content,
            sources: data.sources,
            modelUsed: data.modelUsed,
          },
        ]);
      } catch (e) {
        setErr((e as Error).message ?? "请求失败");
      } finally {
        setBusy(false);
      }
    },
    [busy, history, short],
  );

  const clear = (): void => {
    setHistory([]);
    setErr(null);
  };

  return (
    <div className="border-b border-line" style={{ padding: "10px 16px" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full bg-transparent border-0 cursor-pointer flex items-center"
        style={{ padding: 0 }}
      >
        <div className="text-[10.5px] tracking-[0.06em] uppercase text-ink-4 font-semibold flex-1 text-left">
          问 {short} · CHAT
        </div>
        {history.length > 0 && (
          <span className="mono text-[10px] text-ink-4 mr-2">{history.length} 条</span>
        )}
        <span className="mono text-[10px] text-ink-3">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div
          className="mt-2 border border-line rounded-md overflow-hidden bg-surface flex flex-col"
          style={{ height: 380 }}
        >
          <div ref={scrollRef} className="flex-1 overflow-auto" style={{ padding: "8px 10px" }}>
            {history.length === 0 && (
              <div>
                <div className="text-[11px] text-ink-3 mb-2">
                  问关于 <b>{short}</b> 经手的 run / entity / 失败的问题。
                  AI 会用工具查实数据，不会编造。
                </div>
                <div className="flex flex-col gap-1">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      className="text-left bg-panel border border-line rounded-sm hover:bg-surface text-[11.5px] text-ink-2 cursor-pointer"
                      style={{ padding: "5px 8px" }}
                      onClick={() => void send(s)}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {history.map((m, i) => (
              <MessageBubble key={i} message={m} />
            ))}
            {busy && (
              <div className="text-[11px] text-ink-3 mt-2 flex items-center gap-1.5">
                <span className="animate-pulse">●</span> AI 思考中…
              </div>
            )}
            {err && (
              <div
                className="mt-2 border rounded-sm text-[11px]"
                style={{
                  padding: "6px 8px",
                  background: "var(--c-warn-bg)",
                  borderColor: "color-mix(in oklab, var(--c-warn) 35%, transparent)",
                  color: "oklch(0.45 0.14 75)",
                }}
              >
                ⚠ {err}
              </div>
            )}
          </div>

          <div className="border-t border-line bg-panel" style={{ padding: "6px 8px" }}>
            <div className="flex gap-1.5">
              <input
                className="flex-1 bg-surface border border-line rounded-sm px-2 py-1 text-[12px] outline-none focus:border-[color:var(--c-accent)]"
                placeholder={`问 ${short}…`}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send(input);
                  }
                }}
                disabled={busy}
              />
              <Btn
                size="sm"
                variant="primary"
                onClick={() => void send(input)}
                disabled={busy || !input.trim()}
                title="发送"
              >
                <Ic.arrowR />
              </Btn>
              {history.length > 0 && (
                <Btn size="sm" variant="ghost" onClick={clear} title="清空对话">
                  ×
                </Btn>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  return (
    <div className="mb-2.5 last:mb-0">
      <div
        className="text-[10px] mono mb-0.5"
        style={{ color: isUser ? "var(--c-ink-3)" : "var(--c-accent)" }}
      >
        {isUser ? "你" : `AI${message.modelUsed ? ` · ${message.modelUsed}` : ""}`}
      </div>
      <div
        className={`rounded-md text-[12px] leading-relaxed ${
          isUser ? "bg-panel border border-line" : "bg-accent-bg border border-accent-line"
        }`}
        style={{ padding: "6px 10px" }}
      >
        {isUser ? (
          <div className="whitespace-pre-wrap">{message.content}</div>
        ) : (
          <Markdown compact>{message.content}</Markdown>
        )}
      </div>
      {message.sources && message.sources.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1">
          {message.sources.map((s, i) => (
            <Badge key={i} variant="info" className="text-[9.5px]">
              {s.tool} · {s.label}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
