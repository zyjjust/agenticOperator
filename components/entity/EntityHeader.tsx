"use client";
import React from "react";
import { Badge, Btn } from "@/components/shared/atoms";
import { ENTITY_LABELS, type EntityType } from "@/lib/entity-types";
import type { EntitySummaryResponse } from "@/app/api/entities/[type]/[id]/route";

type Density = "compact" | "full";

export function EntityHeader({
  type,
  id,
  summary,
  days,
  density,
  onDaysChange,
  onDensityChange,
}: {
  type: EntityType;
  id: string;
  summary: EntitySummaryResponse | null;
  days: number;
  density: Density;
  onDaysChange: (d: number) => void;
  onDensityChange: (d: Density) => void;
}) {
  const displayName = summary?.displayName ?? null;
  const lastSeen = summary?.lastSeenAt
    ? new Date(summary.lastSeenAt).toLocaleString(undefined, { hour12: false })
    : null;
  return (
    <div
      className="flex items-center gap-4 border-b border-line bg-surface"
      style={{ padding: "14px 22px" }}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <Badge variant="info">{ENTITY_LABELS[type]}</Badge>
          <div className="text-[15px] font-semibold tracking-tight truncate">
            {displayName ?? id}
          </div>
        </div>
        <div className="mono text-[11px] text-ink-3 mt-px truncate">
          {type} · {id}
          {summary && (
            <>
              {" · "}
              {summary.runCount} runs
              {lastSeen && <> · 最近 {lastSeen}</>}
            </>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        <span className="text-ink-3 text-[11px]">时间窗</span>
        {[1, 7, 30, 90].map((d) => (
          <Btn
            key={d}
            size="sm"
            variant={d === days ? "primary" : "ghost"}
            onClick={() => onDaysChange(d)}
            style={{ padding: "0 8px" }}
          >
            {d}d
          </Btn>
        ))}
      </div>

      <div className="w-px h-5 bg-line" />

      <div className="flex items-center gap-1.5">
        <span className="text-ink-3 text-[11px]">详细度</span>
        <Btn
          size="sm"
          variant={density === "compact" ? "primary" : "ghost"}
          onClick={() => onDensityChange("compact")}
          style={{ padding: "0 8px" }}
        >
          紧凑
        </Btn>
        <Btn
          size="sm"
          variant={density === "full" ? "primary" : "ghost"}
          onClick={() => onDensityChange("full")}
          style={{ padding: "0 8px" }}
        >
          全展开
        </Btn>
      </div>
    </div>
  );
}
