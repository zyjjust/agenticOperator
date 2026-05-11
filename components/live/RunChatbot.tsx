"use client";
import React from "react";
import { Ic } from "@/components/shared/Ic";
import { Badge, Btn } from "@/components/shared/atoms";
import { Markdown } from "@/components/shared/Markdown";

// Run-scoped chatbot. Calls POST /api/runs/:id/chat which routes to a
// tool-using LLM (or a deterministic fallback when no gateway is set).
//
// Constraints baked into the design:
//   - Bound to ONE run (the runId prop). Bot can only fetch data for it.
//   - Citations rendered as chips under each assistant reply.
//   - No streaming this round — keeps the UI simple. Each turn is one
//     POST + one render.
//   - Read-only — no UI affordance to take actions.
//
// Suggestion chips at the start prime users with question shapes that
// actually work well (vs questions where filters/UI would serve better).

type Source = {
  tool: string;
  label: string;
  ref?: string;
};

type ToolEvent = {
  tool: string;
  status: "running" | "done";
  label?: string;
};

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  modelUsed?: string;
  /** Per-message tool execution timeline rendered above the bubble. */
  toolEvents?: ToolEvent[];
};

type ChatResponse = {
  reply: { role: "assistant"; content: string };
  sources?: Source[];
  modelUsed?: string;
  toolCallsExecuted?: number;
  error?: string;
  message?: string;
};

type SseEvent =
  | { type: "tool_call"; tool: string; args?: Record<string, unknown> }
  | { type: "tool_result"; tool: string; label?: string }
  | { type: "text"; delta: string }
  | { type: "done"; sources: Source[]; modelUsed?: string; toolCallsExecuted?: number }
  | { type: "error"; message: string };

const SUGGESTIONS = [
  "为什么这条 run 比以往慢？",
  "Matcher 在这条 run 里给了什么决策？",
  "RAAS 那边对我们的事件做了什么？",
  "这条 run 失败的根因是什么？",
];

// Cap history per run so localStorage doesn't bloat. Older messages
// drop off the front; the model also keeps prompt cost bounded.
const MAX_HISTORY = 40;
const STORAGE_PREFIX = "ao:chat:";

function loadHistory(runId: string): ChatMessage[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + runId);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ChatMessage[];
    return Array.isArray(parsed) ? parsed.slice(-MAX_HISTORY) : [];
  } catch {
    return [];
  }
}

function saveHistory(runId: string, messages: ChatMessage[]): void {
  if (typeof window === "undefined") return;
  try {
    const trimmed = messages.slice(-MAX_HISTORY);
    localStorage.setItem(STORAGE_PREFIX + runId, JSON.stringify(trimmed));
  } catch {
    // Quota exceeded / blocked — silently drop. Chat still works in-memory.
  }
}

function clearHistory(runId: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(STORAGE_PREFIX + runId);
  } catch {
    /* ignore */
  }
}

export function RunChatbot({ runId }: { runId: string }) {
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  const [input, setInput] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);

  // Restore from localStorage when switching runs (or on mount). Each run
  // has its own conversation thread that survives page reload.
  React.useEffect(() => {
    setMessages(loadHistory(runId));
    setInput("");
    setError(null);
  }, [runId]);

  // Persist on every change. Cheap — JSON serialize ~40 short strings.
  React.useEffect(() => {
    saveHistory(runId, messages);
  }, [runId, messages]);

  // Auto-scroll on new messages.
  React.useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, loading]);

  const send = React.useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || loading) return;
      const userMsg: ChatMessage = { role: "user", content: trimmed };
      const baseHistory = [...messages, userMsg];
      // Push a placeholder assistant bubble that we'll fill as deltas arrive.
      setMessages([...baseHistory, { role: "assistant", content: "", sources: [] }]);
      setInput("");
      setLoading(true);
      setError(null);

      try {
        const r = await fetch(
          `/api/runs/${encodeURIComponent(runId)}/chat?stream=1`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              messages: baseHistory.map(({ role, content }) => ({ role, content })),
            }),
          },
        );
        if (!r.ok || !r.body) {
          // Fall back to non-streaming JSON parse.
          const j = (await r.json().catch(() => ({}))) as ChatResponse;
          if (j.reply) {
            setMessages([
              ...baseHistory,
              {
                role: "assistant",
                content: j.reply.content,
                sources: j.sources,
                modelUsed: j.modelUsed,
              },
            ]);
          } else {
            setError(j.message ?? j.error ?? `${r.status}`);
            setMessages(baseHistory.slice(0, -1));
          }
          return;
        }

        // Stream parser: read SSE `data: {...}\n\n` chunks, split into events.
        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let assistantText = "";
        let assistantSources: Source[] = [];
        let assistantModel: string | undefined;
        const toolEvents: Array<{ tool: string; status: "running" | "done"; label?: string }> = [];

        const updateBubble = () => {
          setMessages([
            ...baseHistory,
            {
              role: "assistant",
              content: assistantText,
              sources: assistantSources,
              modelUsed: assistantModel,
              toolEvents: [...toolEvents],
            },
          ]);
        };

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          // Process complete SSE messages (terminated by \n\n).
          let sep: number;
          while ((sep = buffer.indexOf("\n\n")) !== -1) {
            const raw = buffer.slice(0, sep).trim();
            buffer = buffer.slice(sep + 2);
            if (!raw.startsWith("data:")) continue;
            const json = raw.slice(5).trim();
            if (!json) continue;
            try {
              const ev = JSON.parse(json) as SseEvent;
              if (ev.type === "text") {
                assistantText += ev.delta;
                updateBubble();
              } else if (ev.type === "tool_call") {
                toolEvents.push({ tool: ev.tool, status: "running" });
                updateBubble();
              } else if (ev.type === "tool_result") {
                // Mark the most recent matching running tool as done.
                // Manual loop — findLast() isn't in all target libs.
                for (let i = toolEvents.length - 1; i >= 0; i--) {
                  if (toolEvents[i].tool === ev.tool && toolEvents[i].status === "running") {
                    toolEvents[i] = { ...toolEvents[i], status: "done", label: ev.label };
                    break;
                  }
                }
                updateBubble();
              } else if (ev.type === "done") {
                assistantSources = ev.sources;
                assistantModel = ev.modelUsed;
                updateBubble();
              } else if (ev.type === "error") {
                setError(ev.message);
              }
            } catch {/* malformed event — skip */}
          }
        }
      } catch (e) {
        setError((e as Error).message);
        setMessages(baseHistory.slice(0, -1));
      } finally {
        setLoading(false);
      }
    },
    [loading, messages, runId],
  );

  return (
    <div className="border border-line rounded-md bg-surface flex flex-col" style={{ minHeight: 380 }}>
      <div
        className="border-b border-line flex items-center gap-2"
        style={{ padding: "10px 12px" }}
      >
        <span className="text-[13px] font-semibold flex-1">AI 助手</span>
        <Badge variant="info">作用域 · 仅这条 run</Badge>
        <Badge variant="default">tool-using · 只读</Badge>
        {messages.length > 0 && (
          <Btn
            size="sm"
            variant="ghost"
            onClick={() => {
              setMessages([]);
              clearHistory(runId);
            }}
            title="清空对话（同时清 localStorage）"
            style={{ padding: "0 6px" }}
          >
            <Ic.cross />
          </Btn>
        )}
      </div>

      <div
        ref={scrollRef}
        className="flex-1 overflow-auto"
        style={{ padding: "12px", maxHeight: 480 }}
      >
        {messages.length === 0 && (
          <div className="flex flex-col gap-3">
            <div
              className="border border-line rounded-md text-[12px] text-ink-2 leading-relaxed"
              style={{
                padding: "10px 12px",
                background: "color-mix(in oklab, var(--c-info) 5%, transparent)",
              }}
            >
              <div className="flex items-center gap-1.5 mb-1">
                <span style={{ color: "var(--c-info)" }}>✨</span>
                <span className="font-semibold text-ink-1 text-[12.5px]">
                  scope · 仅这条 run
                </span>
              </div>
              <div className="text-[11.5px] text-ink-3">
                问关于这条 run 的任何问题。AI 会调底层 API 取真数据，每条回答带引用，
                不会编造数字 / agent 名字，也不会修改任何状态。
              </div>
            </div>
            <div>
              <div className="text-[10.5px] text-ink-4 mb-1.5 tracking-[0.06em] uppercase">
                建议问题（点击直接发送）
              </div>
              <div className="grid gap-1.5" style={{ gridTemplateColumns: "1fr 1fr" }}>
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => void send(s)}
                    className="bg-panel border border-line rounded-sm cursor-pointer text-[11.5px] text-ink-2 hover:text-ink-1 hover:border-line-strong text-left"
                    style={{ padding: "6px 10px", lineHeight: 1.4 }}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <Bubble key={i} message={m} />
        ))}

        {loading && (
          <div className="flex items-center gap-2 mt-2 text-[11.5px] text-ink-3 mono">
            <span className="anim-pulse" style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: "var(--c-accent)" }} />
            AI 正在调工具 + 思考…
          </div>
        )}

        {error && (
          <div
            className="mt-2 mono text-[11.5px] rounded-sm"
            style={{
              padding: "6px 10px",
              background: "var(--c-warn-bg)",
              color: "oklch(0.5 0.14 75)",
            }}
          >
            ⚠ {error}
          </div>
        )}
      </div>

      <div className="border-t border-line flex items-center gap-1.5" style={{ padding: "8px 10px" }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(input);
            }
          }}
          placeholder={loading ? "等回答中…" : "问一个关于这条 run 的问题…"}
          disabled={loading}
          className="flex-1 border border-line bg-panel rounded-sm text-ink-1 outline-none mono text-[12px]"
          style={{ height: 28, padding: "0 10px" }}
        />
        <Btn size="sm" variant="primary" onClick={() => void send(input)} disabled={loading || !input.trim()}>
          <Ic.arrowR /> 发送
        </Btn>
      </div>
    </div>
  );
}

function Bubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  return (
    <div className="mb-3" style={{ marginLeft: isUser ? 32 : 0, marginRight: isUser ? 0 : 32 }}>
      <div
        className="text-[10px] text-ink-4 mb-1 mono flex items-center gap-1.5"
        style={{ justifyContent: isUser ? "flex-end" : "flex-start" }}
      >
        <span>
          {isUser
            ? "👤 你"
            : message.modelUsed === "fallback"
              ? "🤖 AI · fallback (无 LLM 网关)"
              : `🤖 AI${message.modelUsed ? ` · ${message.modelUsed}` : ""}`}
        </span>
      </div>
      {/* Tool-call status strip (streaming only) — shows what the bot is
          fetching, in real time. Helps the user trust the answer. */}
      {!isUser && message.toolEvents && message.toolEvents.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-1.5">
          {message.toolEvents.map((t, i) => (
            <span
              key={i}
              className="mono text-[9.5px] inline-flex items-center gap-1 rounded-sm border bg-surface"
              style={{
                padding: "1px 6px",
                borderColor: t.status === "done" ? "var(--c-line)" : "var(--c-accent-line)",
                color: t.status === "done" ? "var(--c-ink-3)" : "var(--c-accent)",
              }}
            >
              <span>
                {t.status === "running" ? "⏳" : "✓"}
              </span>
              <span style={{ fontWeight: 600 }}>{t.tool}</span>
              {t.label && <span className="text-ink-4">· {t.label}</span>}
            </span>
          ))}
        </div>
      )}
      <div
        className="rounded-md"
        style={{
          padding: isUser ? "8px 10px" : "10px 12px",
          background: isUser ? "var(--c-accent-bg)" : "var(--c-panel)",
          border: `1px solid ${isUser ? "var(--c-accent-line)" : "var(--c-line)"}`,
          color: "var(--c-ink-1)",
          // Subtle visual cue while content is still arriving.
          minHeight: !isUser && !message.content ? 36 : undefined,
        }}
      >
        {isUser ? (
          // Don't markdown-render user input — they typed plain text and
          // we don't want their punctuation hijacked by inline formatting.
          <div
            className="text-[12.5px] leading-relaxed"
            style={{ whiteSpace: "pre-wrap" }}
          >
            {message.content}
          </div>
        ) : message.content ? (
          <Markdown compact>{message.content}</Markdown>
        ) : (
          // Empty AI bubble = stream just started, tools running.
          <span className="text-[11.5px] text-ink-4 mono">
            {message.toolEvents && message.toolEvents.some((t) => t.status === "running")
              ? "调工具中…"
              : "AI 正在思考…"}
          </span>
        )}
      </div>
      {!isUser && message.sources && message.sources.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1 items-center">
          <span className="text-[9.5px] text-ink-4 mono uppercase tracking-[0.06em] mr-0.5">
            引用
          </span>
          {message.sources.map((s, i) => (
            <span
              key={i}
              title={s.ref ?? s.label}
              className="mono text-[9.5px] inline-flex items-center gap-1 rounded-sm border bg-surface"
              style={{ padding: "1px 6px", borderColor: "var(--c-line)", color: "var(--c-ink-3)" }}
            >
              <span style={{ color: "var(--c-accent)", fontWeight: 600 }}>{s.tool}</span>
              <span className="text-ink-4">·</span>
              <span>{s.label}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
