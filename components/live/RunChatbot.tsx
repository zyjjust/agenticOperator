"use client";
import React from "react";
import { Ic } from "@/components/shared/Ic";
import { Badge, Btn } from "@/components/shared/atoms";

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

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  modelUsed?: string;
};

type ChatResponse = {
  reply: { role: "assistant"; content: string };
  sources?: Source[];
  modelUsed?: string;
  toolCallsExecuted?: number;
  error?: string;
  message?: string;
};

const SUGGESTIONS = [
  "为什么这条 run 比以往慢？",
  "Matcher 在这条 run 里给了什么决策？",
  "RAAS 那边对我们的事件做了什么？",
  "这条 run 失败的根因是什么？",
];

export function RunChatbot({ runId }: { runId: string }) {
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  const [input, setInput] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);

  // Reset history when switching runs — chat state from a different run
  // is irrelevant.
  React.useEffect(() => {
    setMessages([]);
    setInput("");
    setError(null);
  }, [runId]);

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
      const next = [...messages, userMsg];
      setMessages(next);
      setInput("");
      setLoading(true);
      setError(null);
      try {
        const r = await fetch(`/api/runs/${encodeURIComponent(runId)}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            // Send role + content only; backend doesn't need our chat-side metadata.
            messages: next.map(({ role, content }) => ({ role, content })),
          }),
        });
        const j = (await r.json()) as ChatResponse;
        if (!r.ok && !j.reply) {
          setError(j.message ?? j.error ?? `${r.status}`);
          // Roll back the user message so they can retry without dupe.
          setMessages(next.slice(0, -1));
          return;
        }
        setMessages([
          ...next,
          {
            role: "assistant",
            content: j.reply.content,
            sources: j.sources,
            modelUsed: j.modelUsed,
          },
        ]);
      } catch (e) {
        setError((e as Error).message);
        setMessages(next.slice(0, -1));
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
            onClick={() => setMessages([])}
            title="清空对话"
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
          <div className="flex flex-col gap-2">
            <div className="text-[12px] text-ink-3 leading-relaxed">
              问任何关于这条 run 的问题。我会调底层 API 取真数据，每条回答都带引用。
              不会胡编 agent 名字 / 数字；不会修改任何状态。
            </div>
            <div className="text-[10.5px] text-ink-4 mb-1 mt-2 tracking-[0.06em] uppercase">
              建议问题
            </div>
            <div className="flex flex-wrap gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => void send(s)}
                  className="bg-panel border border-line rounded-sm cursor-pointer text-[11px] text-ink-2 hover:text-ink-1 hover:border-line-strong"
                  style={{ padding: "3px 8px" }}
                >
                  {s}
                </button>
              ))}
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
    <div className="mb-3" style={{ marginLeft: isUser ? 28 : 0, marginRight: isUser ? 0 : 28 }}>
      <div
        className="text-[10px] text-ink-4 mb-1 mono"
        style={{ textAlign: isUser ? "right" : "left" }}
      >
        {isUser ? "👤 你" : message.modelUsed === "fallback" ? "🤖 AI · fallback" : `🤖 AI${message.modelUsed ? ` · ${message.modelUsed}` : ""}`}
      </div>
      <div
        className="rounded-md text-[12.5px] leading-relaxed"
        style={{
          padding: "8px 10px",
          background: isUser ? "var(--c-accent-bg)" : "var(--c-panel)",
          border: `1px solid ${isUser ? "var(--c-accent-line)" : "var(--c-line)"}`,
          color: "var(--c-ink-1)",
          whiteSpace: "pre-wrap",
        }}
      >
        {message.content}
      </div>
      {!isUser && message.sources && message.sources.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          <span className="text-[9.5px] text-ink-4 mono uppercase tracking-[0.06em] mr-1 leading-loose">
            引用:
          </span>
          {message.sources.map((s, i) => (
            <span
              key={i}
              title={s.ref ?? s.label}
              className="mono text-[9.5px] inline-flex items-center gap-1 rounded-sm border bg-surface"
              style={{ padding: "1px 5px", borderColor: "var(--c-line)", color: "var(--c-ink-3)" }}
            >
              <span style={{ color: "var(--c-accent)" }}>{s.tool}</span>
              <span className="text-ink-4">·</span>
              <span>{s.label}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
