// GET /api/correlations/:traceId
//
// Cross-system timeline for a trace_id (or correlationId / runId — we
// match all reasonable identifiers). Joins:
//   - AuditLog (em.publish call audit; one row per publish)
//   - EventInstance (em-side persistence)
//   - WorkflowRun  (Inngest function runs that the events triggered)
//   - HumanTask    (HITL escalations)
//
// Returns a sorted timeline (ascending by ts). The UI renders this as a
// vertical lane. We deliberately don't try to be clever about matching —
// the same id might appear as trace_id / correlationId / runId in different
// tables. We just OR them all and dedupe by source+id.

import { NextResponse } from "next/server";
import { prisma } from "@/server/db";

export const dynamic = "force-dynamic";

export type TimelineEntry = {
  ts: string;
  source: "audit" | "event_instance" | "workflow_run" | "workflow_step" | "human_task";
  kind: string;       // free text: "publish" | "accepted" | "rejected_schema" | "run_started" | ...
  title: string;
  detail?: string;
  refType?: string;   // e.g. "EventInstance", "WorkflowRun", "HumanTask"
  refId?: string;
  // Optional links the UI uses to make rows clickable.
  link?: string;
};

export type CorrelationsResponse = {
  traceId: string;
  totals: {
    auditLog: number;
    eventInstance: number;
    workflowRun: number;
    humanTask: number;
  };
  timeline: TimelineEntry[];
  meta: { generatedAt: string };
};

type RouteCtx = { params: Promise<{ traceId: string }> };

export async function GET(_req: Request, ctx: RouteCtx): Promise<Response> {
  const { traceId: rawTraceId } = await ctx.params;
  const traceId = decodeURIComponent(rawTraceId);
  const timeline: TimelineEntry[] = [];

  // 1. AuditLog — one entry per publish
  let auditCount = 0;
  try {
    const rows = await prisma.auditLog.findMany({
      where: { traceId },
      orderBy: { createdAt: "asc" },
      take: 200,
    });
    auditCount = rows.length;
    for (const r of rows) {
      timeline.push({
        ts: r.createdAt.toISOString(),
        source: "audit",
        kind: "publish",
        title: `${r.eventName} 发布`,
        detail: `来源 ${r.source}`,
        refType: "AuditLog",
        refId: r.id,
      });
    }
  } catch { /* table missing → skip */ }

  // 2. EventInstance — find rows whose external_event_id == traceId OR rows
  // related to a publishing trace via AuditLog. The simplest match: by
  // external_event_id direct OR id direct. (When trace_id is encoded in
  // payload.trace.trace_id and we don't index that, we miss those — but
  // trace_id and external_event_id are usually the same id at the bridge
  // boundary, so this catches the common case.)
  let eventInstanceCount = 0;
  try {
    const rows = await prisma.eventInstance.findMany({
      where: {
        OR: [
          { id: traceId },
          { externalEventId: traceId },
          { causedByEventId: traceId },
        ],
      },
      orderBy: { ts: "asc" },
      take: 200,
    });
    eventInstanceCount = rows.length;
    for (const r of rows) {
      timeline.push({
        ts: r.ts.toISOString(),
        source: "event_instance",
        kind: r.status,
        title: `${r.name} · ${labelStatus(r.status)}`,
        detail:
          r.rejectionReason ??
          (r.schemaVersionUsed ? `schema v${r.schemaVersionUsed}` : undefined),
        refType: "EventInstance",
        refId: r.id,
        link: `/events/${encodeURIComponent(r.name)}/instances/${encodeURIComponent(r.id)}`,
      });
    }
  } catch { /* skip */ }

  // 3. WorkflowRun — by id
  let workflowRunCount = 0;
  try {
    const run = await prisma.workflowRun.findUnique({
      where: { id: traceId },
      include: {
        steps: { orderBy: { startedAt: "asc" }, take: 100 },
      },
    });
    if (run) {
      workflowRunCount = 1;
      timeline.push({
        ts: run.startedAt.toISOString(),
        source: "workflow_run",
        kind: "run_started",
        title: `Workflow run ${run.id.slice(0, 10)}…`,
        detail: `trigger ${run.triggerEvent}`,
        refType: "WorkflowRun",
        refId: run.id,
        link: `/live`,
      });
      if (run.completedAt) {
        timeline.push({
          ts: run.completedAt.toISOString(),
          source: "workflow_run",
          kind: `run_${run.status}`,
          title: `Workflow run ${labelRunStatus(run.status)}`,
          refType: "WorkflowRun",
          refId: run.id,
          link: `/live`,
        });
      }
      for (const s of run.steps) {
        timeline.push({
          ts: s.startedAt.toISOString(),
          source: "workflow_step",
          kind: `step_${s.status}`,
          title: `${s.stepName} · ${s.status}`,
          detail: s.error ?? undefined,
          refType: "WorkflowStep",
          refId: s.id,
        });
      }
    }
  } catch { /* skip */ }

  // 4. HumanTask — by runId or triggeringEventInstanceId
  let humanTaskCount = 0;
  try {
    const tasks = await prisma.humanTask.findMany({
      where: {
        OR: [
          { runId: traceId },
          { triggeringEventInstanceId: traceId },
        ],
      },
      orderBy: { createdAt: "asc" },
      take: 50,
    });
    humanTaskCount = tasks.length;
    for (const t of tasks) {
      timeline.push({
        ts: t.createdAt.toISOString(),
        source: "human_task",
        kind: `hitl_${t.status}`,
        title: `HITL · ${t.title}`,
        detail: `assigned ${t.assignee ?? "未分配"} · status ${t.status}`,
        refType: "HumanTask",
        refId: t.id,
        link: `/inbox`,
      });
      if (t.completedAt) {
        timeline.push({
          ts: t.completedAt.toISOString(),
          source: "human_task",
          kind: `hitl_resolved_${t.status}`,
          title: `HITL · ${t.title} → ${t.status}`,
          detail: t.resolvedBy ? `处理人 ${t.resolvedBy}` : undefined,
          refType: "HumanTask",
          refId: t.id,
          link: `/inbox`,
        });
      }
    }
  } catch { /* skip */ }

  timeline.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

  const body: CorrelationsResponse = {
    traceId,
    totals: {
      auditLog: auditCount,
      eventInstance: eventInstanceCount,
      workflowRun: workflowRunCount,
      humanTask: humanTaskCount,
    },
    timeline,
    meta: { generatedAt: new Date().toISOString() },
  };
  return NextResponse.json(body);
}

function labelStatus(s: string): string {
  switch (s) {
    case "accepted":
      return "已接受";
    case "rejected_schema":
      return "schema 失败";
    case "rejected_filter":
      return "filter 拒绝";
    case "duplicate":
      return "重复";
    case "meta_rejection":
      return "EVENT_REJECTED meta";
    case "em_degraded":
      return "EM 降级旁路";
    default:
      return s;
  }
}
function labelRunStatus(s: string): string {
  switch (s) {
    case "completed":
      return "完成";
    case "failed":
      return "失败";
    case "timed_out":
      return "超时";
    case "interrupted":
      return "中断";
    default:
      return s;
  }
}
