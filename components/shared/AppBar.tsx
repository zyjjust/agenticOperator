"use client";
import React from "react";
import clsx from "clsx";
import { Ic } from "./Ic";
import { useApp } from "@/lib/i18n";
import { useEmHealth } from "@/lib/api/em-health";

export function AppBar({
  crumbs = [],
  onOpenCmdK,
}: {
  crumbs?: string[];
  onOpenCmdK?: () => void;
}) {
  const { t, lang, setLang, theme, setTheme } = useApp();
  // Global EM health pill — visible from every page so degraded mode
  // (Neo4j unreachable / EM library faulted) is never invisible.
  const emHealth = useEmHealth();
  return (
    <div className="flex items-center h-11 px-3.5 gap-3 border-b border-line bg-surface relative z-10">
      <div className="flex items-center gap-2 font-semibold text-[13px] tracking-tight">
        <div className="w-[18px] h-[18px] rounded relative overflow-hidden"
          style={{
            background: "linear-gradient(135deg, var(--c-ink-1) 0%, var(--c-accent) 120%)",
          }}
        >
          <div
            className="absolute inset-1 rounded-[2px]"
            style={{
              borderTop: "1.5px solid rgba(255,255,255,0.9)",
              borderLeft: "1.5px solid rgba(255,255,255,0.9)",
            }}
          />
        </div>
        <span>{t("brand")}</span>
      </div>
      <div className="flex items-center gap-1.5 text-[12px] text-ink-3">
        {crumbs.map((c, i) => (
          <React.Fragment key={i}>
            {i > 0 && <span className="text-ink-4"><Ic.chev /></span>}
            <span className={i === crumbs.length - 1 ? "text-ink-1 font-medium" : ""}>{c}</span>
          </React.Fragment>
        ))}
      </div>
      <div className="flex-1" />

      <button
        onClick={onOpenCmdK}
        className="flex items-center gap-2 h-7 px-2.5 bg-panel border border-line rounded-md text-ink-3 text-[12px] min-w-[240px] cursor-pointer hover:border-line-strong"
      >
        <Ic.search />
        <span>{t("search_placeholder")}</span>
        <kbd className="ml-auto font-mono text-[10px] bg-surface border border-line rounded-sm px-[5px] py-[1px] text-ink-3">⌘K</kbd>
      </button>

      <div className="inline-flex items-center gap-1.5 h-6 px-2 rounded-full text-[11px] bg-panel border border-line text-ink-2 whitespace-nowrap">
        <span className="w-1.5 h-1.5 rounded-full bg-[color:var(--c-ok)] anim-pulse" style={{ boxShadow: "0 0 0 3px color-mix(in oklab, var(--c-ok) 20%, transparent)" }} />
        {t("realtime")}
      </div>

      <EmStatusPill health={emHealth.data} loading={emHealth.loading} onSync={emHealth.syncNow} />

      {/* Language segmented */}
      <div className="flex items-center h-6 p-[2px] bg-panel border border-line rounded-md">
        <button
          onClick={() => setLang("zh")}
          className={clsx(
            "h-5 px-2 rounded-sm text-[11px] cursor-pointer border-0",
            lang === "zh" ? "bg-surface text-ink-1 shadow-sh-1" : "bg-transparent text-ink-3"
          )}
        >
          中文
        </button>
        <button
          onClick={() => setLang("en")}
          className={clsx(
            "h-5 px-2 rounded-sm text-[11px] cursor-pointer border-0",
            lang === "en" ? "bg-surface text-ink-1 shadow-sh-1" : "bg-transparent text-ink-3"
          )}
        >
          EN
        </button>
      </div>

      {/* Theme toggle */}
      <button
        className="w-7 h-7 grid place-items-center rounded-md border border-transparent text-ink-2 hover:bg-panel hover:border-line"
        onClick={() => setTheme(theme === "light" ? "dark" : "light")}
        title={theme === "light" ? t("theme_dark") : t("theme_light")}
      >
        {theme === "light" ? <Ic.moon /> : <Ic.sun />}
      </button>

      <button className="w-7 h-7 grid place-items-center rounded-md border border-transparent text-ink-2 hover:bg-panel hover:border-line" title="alerts">
        <Ic.bell />
      </button>

      <div
        className="w-[26px] h-[26px] rounded-full grid place-items-center text-white text-[11px] font-semibold"
        style={{ background: "linear-gradient(135deg, oklch(0.72 0.08 25), oklch(0.58 0.13 320))" }}
      >
        Z
      </div>
    </div>
  );
}

// EM dot — three states: healthy (green) / degraded (orange) / down or
// unconfigured (red). Click triggers a manual sync; tooltip explains why.
function EmStatusPill({
  health,
  loading,
  onSync,
}: {
  health: ReturnType<typeof useEmHealth>["data"];
  loading: boolean;
  onSync: () => Promise<void>;
}) {
  const state = health?.state ?? (loading ? "loading" : "unknown");
  const palette: Record<string, { color: string; label: string }> = {
    healthy: { color: "var(--c-ok)", label: "EM 正常" },
    degraded: { color: "var(--c-warn)", label: "EM 降级" },
    down: { color: "var(--c-err)", label: "EM 不可用" },
    unconfigured: { color: "var(--c-ink-3)", label: "EM 未配置" },
    loading: { color: "var(--c-ink-4)", label: "EM 检测中" },
    unknown: { color: "var(--c-ink-3)", label: "EM 状态未知" },
  };
  const p = palette[state] ?? palette.unknown;
  const tooltip = health
    ? [
        `状态：${p.label}`,
        health.neo4j.configured
          ? `Neo4j：${health.neo4j.reachable ? "可达" : "不通"}${health.neo4j.error ? ` · ${health.neo4j.error}` : ""}`
          : "Neo4j：未配置",
        health.neo4j.lastSyncAt
          ? `上次同步：${new Date(health.neo4j.lastSyncAt).toLocaleString(undefined, { hour12: false })}`
          : "尚未成功同步",
        "（点击立即同步）",
      ].join("\n")
    : "EM 健康检查中…";

  return (
    <button
      onClick={() => void onSync()}
      title={tooltip}
      className="inline-flex items-center gap-1.5 h-6 px-2 rounded-full text-[11px] bg-panel border border-line whitespace-nowrap cursor-pointer hover:border-line-strong"
      style={{ color: "var(--c-ink-2)" }}
    >
      <span
        className={state === "healthy" ? "anim-pulse" : ""}
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: p.color,
          boxShadow: `0 0 0 3px color-mix(in oklab, ${p.color} 18%, transparent)`,
        }}
      />
      EM
    </button>
  );
}
