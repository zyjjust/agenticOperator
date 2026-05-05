"use client";

import React from "react";
import { Ic } from "./Ic";

type AgenticState = {
  enabled: boolean;
  updatedAt?: string;
  updatedBy?: string;
  reason?: string;
};

/**
 * AO Agentic Mode toggle.
 *
 * Reads + writes /api/agentic. Auto-refreshes every 3s so multiple
 * tabs / external API flips converge. Disables itself while a flip
 * is in flight to avoid double-clicks.
 */
export function AgenticToggle() {
  const [state, setState] = React.useState<AgenticState>({ enabled: false });
  const [busy, setBusy] = React.useState(false);

  const refresh = React.useCallback(async () => {
    try {
      const res = await fetch("/api/agentic", { cache: "no-store" });
      if (res.ok) setState((await res.json()) as AgenticState);
    } catch {
      /* keep last known */
    }
  }, []);

  React.useEffect(() => {
    refresh();
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, [refresh]);

  const flip = async () => {
    if (busy) return;
    const next = !state.enabled;
    setBusy(true);
    try {
      const res = await fetch("/api/agentic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: next,
          updatedBy: "ui",
          reason: next ? "enabled via /workflow toggle" : "disabled via /workflow toggle",
        }),
      });
      if (res.ok) setState((await res.json()) as AgenticState);
    } finally {
      setBusy(false);
    }
  };

  const on = state.enabled;
  const fg = on ? "var(--c-ok)" : "var(--c-ink-3)";
  const bg = on ? "var(--c-ok-bg, rgba(34,197,94,0.12))" : "transparent";

  return (
    <button
      onClick={flip}
      disabled={busy}
      title={
        on
          ? "点击关闭 — agent 仍订阅事件，但收到后会立即跳过"
          : "点击开启 — agent 开始处理收到的事件"
      }
      className="inline-flex items-center gap-2 text-[12.5px] font-medium px-3 h-7 rounded-md border transition-colors"
      style={{
        borderColor: on ? "var(--c-ok)" : "var(--c-line)",
        background: bg,
        color: fg,
        opacity: busy ? 0.6 : 1,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: 999,
          background: fg,
          boxShadow: on ? `0 0 0 3px ${bg}` : "none",
        }}
      />
      <span style={{ letterSpacing: "0.2px" }}>
        Agentic {on ? "ON" : "OFF"}
      </span>
      <Ic.bolt />
    </button>
  );
}
