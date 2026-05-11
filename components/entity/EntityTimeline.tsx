"use client";
import React from "react";
import { Badge } from "@/components/shared/atoms";
import { ENTITY_LABELS, type EntityType } from "@/lib/entity-types";
import type {
  JourneyResponse,
  JourneyActivity,
  JourneyRunSummary,
} from "@/app/api/entities/[type]/[id]/journey/route";
import { EntityStepCard } from "./EntityStepCard";

type Density = "compact" | "full";

// Renders one row per run, with all activities (step.* / event_received /
// event_emitted / tool / decision / anomaly / error) inside the run grouped
// chronologically. Internal step events and emit events are surfaced as
// distinct row types — the user explicitly asked for both to be visible.

export function EntityTimeline({
  type,
  id,
  journey,
  density,
}: {
  type: EntityType;
  id: string;
  journey: JourneyResponse;
  density: Density;
}) {
  if (journey.runs.length === 0) {
    return (
      <div className="p-6 text-ink-3 text-[13px]">
        在过去 {journey.window.days} 天内没有任何 run 经手该 {ENTITY_LABELS[type]}：
        <code className="mx-1">{id}</code>。可以扩大时间窗试试。
      </div>
    );
  }
  // group activities by runId
  const byRun = new Map<string, JourneyActivity[]>();
  for (const a of journey.activities) {
    if (!a.runId) continue;
    let list = byRun.get(a.runId);
    if (!list) {
      list = [];
      byRun.set(a.runId, list);
    }
    list.push(a);
  }
  return (
    <div style={{ padding: "16px 22px 32px" }}>
      <Stats journey={journey} />
      <div className="flex flex-col gap-4 mt-3">
        {journey.runs.map((run) => (
          <RunBlock
            key={run.id}
            run={run}
            activities={byRun.get(run.id) ?? []}
            density={density}
            entityType={type}
            entityId={id}
          />
        ))}
      </div>
      {journey.events.length > 0 && (
        <DetachedEventsBlock events={journey.events} />
      )}
      {journey.meta.truncated && (
        <div className="mt-4 mono text-[11px]" style={{ color: "var(--c-warn)" }}>
          ⚠ 扫描结果已截断，可能漏读早期数据。考虑用更小的时间窗。
        </div>
      )}
    </div>
  );
}

function Stats({ journey }: { journey: JourneyResponse }) {
  const totalActivities = journey.activities.length;
  const emits = journey.activities.filter((a) => a.type === "event_emitted").length;
  const errors = journey.activities.filter(
    (a) => a.type === "agent_error" || a.type === "step.failed",
  ).length;
  return (
    <div className="flex items-center gap-2 flex-wrap text-[11px]">
      <Badge variant="info">{journey.runs.length} runs</Badge>
      <Badge>{totalActivities} 操作</Badge>
      <Badge variant="ok">{emits} emit</Badge>
      {errors > 0 && <Badge variant="err">{errors} error</Badge>}
      <Badge variant="info">{journey.events.length} event 实例</Badge>
      <span className="mono text-ink-4 ml-auto">
        scan: {journey.meta.runScanCount} runs · {journey.meta.activityScanCount} activities
      </span>
    </div>
  );
}

function RunBlock({
  run,
  activities,
  density,
  entityType,
  entityId,
}: {
  run: JourneyRunSummary;
  activities: JourneyActivity[];
  density: Density;
  entityType: EntityType;
  entityId: string;
}) {
  const start = new Date(run.startedAt).toLocaleString(undefined, { hour12: false });
  const dur = run.durationMs != null ? `${(run.durationMs / 1000).toFixed(1)}s` : "—";
  const statusVariant: "ok" | "err" | "warn" | "info" =
    run.status === "completed"
      ? "ok"
      : run.status === "failed"
        ? "err"
        : run.status === "suspended" || run.status === "paused"
          ? "warn"
          : "info";
  return (
    <div className="border border-line rounded-md bg-surface overflow-hidden">
      <div
        className="flex items-center gap-2 border-b border-line bg-panel"
        style={{ padding: "8px 12px" }}
      >
        <Badge variant={statusVariant}>{run.status}</Badge>
        <span className="mono text-[11px] text-ink-2 truncate">
          run · {run.id.slice(0, 14)}
        </span>
        <span className="mono text-[10.5px] text-ink-4">trigger {run.triggerEvent}</span>
        <span className="mono text-[10.5px] text-ink-4 ml-auto">
          {start} · {dur}
        </span>
        <a
          href={`/live?run=${encodeURIComponent(run.id)}`}
          className="text-[11px] text-[color:var(--c-accent)] hover:underline"
        >
          打开 run →
        </a>
      </div>
      <div style={{ padding: "10px 12px" }}>
        {activities.length === 0 ? (
          <div className="text-ink-3 text-[11px]">
            此 run 在窗内没有 AgentActivity 行（agent 可能未接入 logger）。
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {activities.map((a) => (
              <EntityStepCard
                key={a.id}
                activity={a}
                density={density}
                highlightEntity={{ type: entityType, id: entityId }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function DetachedEventsBlock({
  events,
}: {
  events: JourneyResponse["events"];
}) {
  return (
    <div className="mt-4 border border-line rounded-md bg-surface">
      <div className="border-b border-line bg-panel" style={{ padding: "8px 12px" }}>
        <span className="text-[12px] font-semibold">独立 event 实例 (EM)</span>
        <span className="mono text-[10.5px] text-ink-3 ml-2">
          来自 EventInstance · 含未关联 run 的事件
        </span>
      </div>
      <div style={{ padding: "8px 12px" }} className="flex flex-col gap-1">
        {events.map((e) => (
          <div
            key={e.id}
            className="flex items-center gap-2 mono text-[11px] border border-line rounded-sm bg-panel"
            style={{ padding: "4px 8px" }}
          >
            <span className="text-ink-3 w-32 truncate">
              {new Date(e.ts).toLocaleString(undefined, { hour12: false })}
            </span>
            <Badge variant={e.status === "accepted" ? "ok" : e.status === "duplicate" ? "info" : "err"}>
              {e.status}
            </Badge>
            <span className="font-semibold flex-1 truncate">{e.name}</span>
            <span className="text-ink-4">from {e.source}</span>
            {e.causedByName && (
              <span className="text-ink-4">← {e.causedByName}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
