"use client";
import React from "react";
import clsx from "clsx";

// ---- StatusDot ----
export function StatusDot({ kind = "ok" }: { kind?: "ok" | "warn" | "err" | "info" | "idle" | "paused" }) {
  const color =
    kind === "ok" ? "var(--c-ok)" :
    kind === "warn" ? "var(--c-warn)" :
    kind === "err" ? "var(--c-err)" :
    kind === "info" ? "var(--c-info)" :
    kind === "paused" ? "var(--c-ink-3)" :
    "var(--c-ink-4)";
  const anim = kind === "ok" || kind === "err";
  return (
    <span
      className={anim ? "anim-pulse" : ""}
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: color,
        boxShadow: `0 0 0 3px color-mix(in oklab, ${color} 18%, transparent)`,
      }}
    />
  );
}

// ---- Spark ----
export function Spark({
  data,
  values,
  accent,
  stroke,
  height,
  h,
}: {
  data?: number[];
  values?: number[];
  accent?: string;
  stroke?: string;
  height?: number;
  h?: number;
}) {
  const arr = Array.isArray(data) ? data : Array.isArray(values) ? values : [0];
  const color = accent || stroke || "var(--c-accent)";
  const ht = height ?? h ?? 28;
  const max = Math.max(...arr, 1);
  return (
    <div className="sparkrow" style={{ height: ht }}>
      {arr.map((v, i) => (
        <div
          key={i}
          className={"bar " + (v / max > 0.7 ? "hot" : "")}
          style={{ height: `${(v / max) * 100}%`, background: color }}
        />
      ))}
    </div>
  );
}

// ---- Metric ----
export function Metric({
  label,
  value,
  delta,
  deltaKind = "up",
  sub,
}: {
  label: string;
  value: React.ReactNode;
  delta?: string;
  deltaKind?: "up" | "down" | "flat";
  sub?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[11px] text-ink-3">{label}</div>
      <div className="font-semibold text-[22px] leading-none tabular-nums text-ink-1 tracking-tight">{value}</div>
      {delta && (
        <div
          className="text-[11px] mono"
          style={{ color: deltaKind === "down" ? "var(--c-err)" : deltaKind === "flat" ? "var(--c-ink-3)" : "var(--c-ok)" }}
        >
          {delta}
        </div>
      )}
      {sub && <div className="hint">{sub}</div>}
    </div>
  );
}

// ---- Badge ----
type BadgeVariant = "default" | "ok" | "warn" | "err" | "info";
export function Badge({
  children,
  variant = "default",
  pulse,
  className,
  dot,
  style,
}: {
  children?: React.ReactNode;
  variant?: BadgeVariant;
  pulse?: boolean;
  className?: string;
  dot?: boolean;
  style?: React.CSSProperties;
}) {
  const colorBG = {
    default: "var(--c-panel)",
    ok: "var(--c-ok-bg)",
    warn: "var(--c-warn-bg)",
    err: "var(--c-err-bg)",
    info: "var(--c-info-bg)",
  }[variant];
  const colorFG = {
    default: "var(--c-ink-2)",
    ok: "var(--c-ok)",
    warn: "oklch(0.5 0.14 75)",
    err: "var(--c-err)",
    info: "var(--c-info)",
  }[variant];
  const colorBorder = {
    default: "var(--c-line)",
    ok: "color-mix(in oklab, var(--c-ok) 25%, transparent)",
    warn: "color-mix(in oklab, var(--c-warn) 40%, transparent)",
    err: "color-mix(in oklab, var(--c-err) 25%, transparent)",
    info: "color-mix(in oklab, var(--c-info) 25%, transparent)",
  }[variant];

  return (
    <span
      className={clsx("inline-flex items-center gap-1.5 h-5 px-[7px] rounded font-medium text-[10.5px] whitespace-nowrap border", className)}
      style={{
        background: colorBG,
        color: colorFG,
        borderColor: colorBorder,
        ...style,
      }}
    >
      {dot && (
        <span
          className={clsx("w-[5px] h-[5px] rounded-full bg-current", pulse && "anim-pulse")}
        />
      )}
      {children}
    </span>
  );
}

// ---- Btn ----
type BtnVariant = "default" | "primary" | "accent" | "ghost" | "danger";
type BtnSize = "md" | "sm";
export function Btn({
  variant = "default",
  size = "md",
  children,
  className,
  onClick,
  style,
  disabled,
  type,
  ...rest
}: {
  variant?: BtnVariant;
  size?: BtnSize;
  children?: React.ReactNode;
  className?: string;
  onClick?: (e: React.MouseEvent) => void;
  style?: React.CSSProperties;
  disabled?: boolean;
  type?: "button" | "submit";
} & React.HTMLAttributes<HTMLButtonElement>) {
  const base = "inline-flex items-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors";
  const sz = size === "sm" ? "h-6 px-2 text-[11.5px]" : "h-7 px-3 text-[12px]";
  let cls = "";
  if (variant === "primary") {
    cls = "bg-ink-1 text-[color:var(--c-bg)] border border-[color:var(--c-ink-1)] hover:opacity-90";
  } else if (variant === "accent") {
    cls = "bg-[color:var(--c-accent)] text-white border border-[color:var(--c-accent)] hover:opacity-90";
  } else if (variant === "ghost") {
    cls = "bg-transparent border border-transparent text-ink-1 hover:bg-panel";
  } else if (variant === "danger") {
    cls = "bg-surface border border-line text-[color:var(--c-err)] hover:bg-panel";
  } else {
    cls = "bg-surface border border-line text-ink-1 hover:border-line-strong hover:bg-panel";
  }
  return (
    <button
      type={type || "button"}
      className={clsx(base, sz, cls, className)}
      onClick={onClick}
      style={style}
      disabled={disabled}
      {...rest}
    >
      {children}
    </button>
  );
}

// ---- Card ----
export function Card({
  children,
  className,
  style,
}: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className={clsx("bg-surface border border-line rounded-lg shadow-sh-1 overflow-hidden", className)}
      style={style}
    >
      {children}
    </div>
  );
}

export function CardHead({
  children,
  className,
  style,
}: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className={clsx(
        "flex items-center gap-2.5 px-3.5 py-2.5 border-b border-line bg-surface",
        className
      )}
      style={style}
    >
      {children}
    </div>
  );
}

// ---- EmptyState ----
// Use whenever a list / table / panel has zero rows. Keeps wording uniform
// and prevents the "blank canvas" effect on /events filter, /inbox queue,
// /alerts, /audit, etc.
export function EmptyState({
  icon,
  title,
  hint,
  action,
  variant = "default",
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  hint?: string;
  action?: React.ReactNode;
  variant?: "default" | "info" | "warn";
  className?: string;
}) {
  const tone =
    variant === "warn"
      ? "var(--c-warn)"
      : variant === "info"
        ? "var(--c-info)"
        : "var(--c-ink-3)";
  return (
    <div
      className={clsx(
        "flex flex-col items-center justify-center text-center gap-2 py-10 px-6 text-ink-3",
        className,
      )}
    >
      {icon && (
        <div
          className="w-9 h-9 rounded-full grid place-items-center"
          style={{
            background: `color-mix(in oklab, ${tone} 10%, transparent)`,
            color: tone,
          }}
        >
          {icon}
        </div>
      )}
      <div className="text-[13px] font-semibold text-ink-1">{title}</div>
      {hint && <div className="text-[11.5px] max-w-[360px] leading-relaxed">{hint}</div>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
