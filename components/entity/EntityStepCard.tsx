"use client";
import React from "react";
import { Badge } from "@/components/shared/atoms";
import type { EntityType } from "@/lib/entity-types";
import type { JourneyActivity } from "@/app/api/entities/[type]/[id]/journey/route";

type Density = "compact" | "full";

// One row in EntityTimeline → one AgentActivity. Visual variants:
//   - step.* boundaries → bracket icon, span color
//   - event_received / event_emitted → arrow icon, blue tint  (← user's
//     "emit 事件追踪" requirement: visible as a distinct row type)
//   - tool / decision → wrench / branch glyph
//   - anomaly / agent_error / step.failed → red tint, click expands

export function EntityStepCard({
  activity,
  density,
  highlightEntity,
}: {
  activity: JourneyActivity;
  density: Density;
  highlightEntity: { type: EntityType; id: string };
}) {
  const variant = classify(activity.type);
  const [open, setOpen] = React.useState(density === "full");

  React.useEffect(() => {
    setOpen(density === "full");
  }, [density]);

  const time = new Date(activity.ts).toLocaleTimeString(undefined, { hour12: false });

  // Pull the "important" metadata bits to the inline summary so users
  // don't have to expand to see step name / event name / duration.
  const meta = (activity.metadata ?? {}) as Record<string, unknown>;
  const step = pickString(meta, ["step", "stepName"]);
  const eventName = pickString(meta, ["event_name", "eventName"]);
  const eventId = pickString(meta, ["event_id", "eventId"]);
  const dur = typeof meta.durationMs === "number" ? `${meta.durationMs}ms` : null;
  const toolName = pickString(meta, ["toolName", "tool"]);

  const inlineHint = step ?? eventName ?? toolName ?? null;
  const isThisEntity = activity.entityRefs.some(
    (r) => r.type === highlightEntity.type && r.id === highlightEntity.id,
  );

  return (
    <div
      className="rounded-sm border"
      style={{
        borderColor: variant.borderColor,
        background: variant.bg,
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 cursor-pointer text-left bg-transparent border-0 hover:opacity-90"
        style={{ padding: "5px 9px" }}
      >
        <span
          className="mono text-[10px] inline-block w-12 text-ink-4"
          style={{ flexShrink: 0 }}
        >
          {time}
        </span>
        <span
          className="mono text-[9.5px] uppercase tracking-wider"
          style={{ color: variant.accent, width: 90, flexShrink: 0 }}
        >
          {variant.label}
        </span>
        <span className="text-[12px] font-medium text-ink-1 flex-shrink-0">
          {activity.agent}
        </span>
        {inlineHint && (
          <span className="mono text-[11px] text-ink-3 truncate">
            · {inlineHint}
          </span>
        )}
        <span className="text-[11.5px] text-ink-2 truncate flex-1">
          {activity.narrative}
        </span>
        {dur && (
          <span className="mono text-[10px] text-ink-4 flex-shrink-0">{dur}</span>
        )}
        {isThisEntity && (
          <Badge variant="info" className="text-[9.5px]">关联</Badge>
        )}
        <span className="mono text-[10px] text-ink-4 w-3 text-center">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        <div
          className="border-t mono text-[10.5px]"
          style={{
            borderColor: variant.borderColor,
            padding: "6px 9px 8px",
            color: "var(--c-ink-2)",
          }}
        >
          {eventId && (
            <div className="mb-1">
              <span className="text-ink-4">event_id</span>{" "}
              <span>{eventId}</span>
            </div>
          )}
          <details>
            <summary className="cursor-pointer text-ink-4 select-none mb-1">
              metadata ({byteCount(activity.metadata)})
            </summary>
            <pre
              className="whitespace-pre-wrap m-0"
              style={{
                background: "var(--c-surface)",
                border: "1px solid var(--c-line)",
                borderRadius: 4,
                padding: "6px 8px",
                maxHeight: 360,
                overflow: "auto",
              }}
            >
              {safeStringify(activity.metadata)}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}

type Variant = {
  label: string;
  accent: string;
  bg: string;
  borderColor: string;
};

function classify(type: string): Variant {
  if (type === "event_received" || type === "event_emitted") {
    return {
      label: type === "event_emitted" ? "emit →" : "← recv",
      accent: "var(--c-accent)",
      bg: "var(--c-accent-bg)",
      borderColor: "var(--c-accent-line)",
    };
  }
  if (type.startsWith("step.")) {
    if (type === "step.failed") {
      return {
        label: "step ✗",
        accent: "var(--c-err)",
        bg: "color-mix(in oklab, var(--c-err) 8%, var(--c-surface))",
        borderColor: "color-mix(in oklab, var(--c-err) 30%, transparent)",
      };
    }
    return {
      label: type.replace("step.", "step "),
      accent: "var(--c-ok)",
      bg: "var(--c-surface)",
      borderColor: "var(--c-line)",
    };
  }
  if (type === "tool") {
    return {
      label: "tool",
      accent: "var(--c-info)",
      bg: "var(--c-info-bg)",
      borderColor: "color-mix(in oklab, var(--c-info) 30%, transparent)",
    };
  }
  if (type === "decision") {
    return {
      label: "decision",
      accent: "var(--c-ink-2)",
      bg: "var(--c-surface)",
      borderColor: "var(--c-line)",
    };
  }
  if (type === "anomaly" || type === "hitl") {
    return {
      label: type,
      accent: "oklch(0.5 0.14 75)",
      bg: "var(--c-warn-bg)",
      borderColor: "color-mix(in oklab, var(--c-warn) 35%, transparent)",
    };
  }
  if (type === "agent_error") {
    return {
      label: "error",
      accent: "var(--c-err)",
      bg: "color-mix(in oklab, var(--c-err) 8%, var(--c-surface))",
      borderColor: "color-mix(in oklab, var(--c-err) 35%, transparent)",
    };
  }
  if (type === "agent_complete") {
    return {
      label: "done",
      accent: "var(--c-ok)",
      bg: "var(--c-ok-bg)",
      borderColor: "color-mix(in oklab, var(--c-ok) 30%, transparent)",
    };
  }
  return {
    label: type.slice(0, 14),
    accent: "var(--c-ink-3)",
    bg: "var(--c-surface)",
    borderColor: "var(--c-line)",
  };
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

function safeStringify(v: unknown): string {
  if (v == null) return "null";
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function byteCount(v: unknown): string {
  if (v == null) return "empty";
  try {
    const len = JSON.stringify(v).length;
    if (len < 1024) return `${len}B`;
    return `${(len / 1024).toFixed(1)}KB`;
  } catch {
    return "?";
  }
}
