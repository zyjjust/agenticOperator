// /api/runs/:id/trace
//
// Run-centric cross-system trace. Aggregates everything we know about a
// single WorkflowRun into one structure suitable for a swimlane:
//
//   - AO local: WorkflowStep + AgentActivity (per-agent lanes)
//   - Local Inngest: events emitted by this run + their function runs
//     (so we can show "JD_GENERATED → 3 functions consumed it")
//   - RAAS Inngest: predeclared lane shape, NOT queried in this round
//     (?includeRaas=1 is reserved for P2)
//
// Different from:
//   - /api/runs/:id/activity → log entries only, no Inngest data
//   - /api/runs/:id/steps    → step list, no activity rollup, no events
//   - /api/correlations/:traceId → joins by traceId across audit/em/ws,
//                                  not run-scoped, doesn't hit Inngest

import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import { normalizeKind } from "@/lib/api/activity-types";

const LOCAL_INNGEST = process.env.INNGEST_LOCAL_URL ?? "http://localhost:8288";
const RAAS_INNGEST = process.env.RAAS_INNGEST_URL ?? "";

type RouteCtx = { params: Promise<{ id: string }> };

export type TraceBlockKind =
  | "step"
  | "tool"
  | "decision"
  | "anomaly"
  | "error"
  | "hitl"
  | "info";

export type TraceBlock = {
  id: string;
  kind: TraceBlockKind;
  /** ms epoch — for swimlane positioning. */
  ts: number;
  /** Optional duration; absent for instantaneous events. */
  durationMs?: number;
  /** Short label rendered inside the block. */
  label: string;
  /** Original message (full narrative). */
  message?: string;
  /** Status hint for color: ok / warn / err / info / muted. */
  status: "ok" | "warn" | "err" | "info" | "muted";
  /** When this block represents a tool call to LLM/HTTP, the model / tool name. */
  toolName?: string;
};

export type AgentLane = {
  agent: string;
  blocks: TraceBlock[];
  errorCount: number;
  toolCount: number;
};

export type EventLaneEntry = {
  /** Inngest event id. */
  eventId: string;
  name: string;
  ts: number;
  source: "local" | "raas";
  /** What functions on the bus consumed this event (best-effort). */
  inngestRuns: Array<{
    runId: string;
    functionId: string;
    status: string;
    startedAt?: number | null;
    endedAt?: number | null;
  }>;
  inngestError?: string;
};

export type RaasLane = {
  functionId: string;
  runs: Array<{
    runId: string;
    status: string;
    startedAt?: number | null;
    endedAt?: number | null;
  }>;
};

export type TraceResponse = {
  run: {
    id: string;
    status: string;
    triggerEvent: string;
    triggerData: { client: string; jdId: string };
    startedAt: string;
    completedAt: string | null;
    lastActivityAt: string;
  };
  span: {
    startMs: number;
    endMs: number;
    durationMs: number;
  };
  agentLanes: AgentLane[];
  eventLane: EventLaneEntry[];
  raasLanes: RaasLane[];
  meta: {
    generatedAt: string;
    raasIncluded: boolean;
    raasError: string | null;
    eventLookupError: string | null;
  };
};

export async function GET(req: Request, ctx: RouteCtx): Promise<Response> {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const includeRaas = url.searchParams.get("includeRaas") === "1";

  const run = await prisma.workflowRun.findUnique({ where: { id } });
  if (!run) {
    return NextResponse.json(
      { error: "NOT_FOUND", message: `run ${id} not found` },
      { status: 404 },
    );
  }

  const [steps, activities] = await Promise.all([
    prisma.workflowStep.findMany({
      where: { runId: id },
      orderBy: { startedAt: "asc" },
    }),
    prisma.agentActivity.findMany({
      where: { runId: id },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  // ── Span ─────────────────────────────────────────────────────────
  const startMs = run.startedAt.getTime();
  const endMs = run.completedAt
    ? run.completedAt.getTime()
    : run.lastActivityAt.getTime();
  const durationMs = Math.max(0, endMs - startMs);

  // ── Agent lanes (from activity + steps) ──────────────────────────
  const lanesByAgent = new Map<string, AgentLane>();
  const ensureLane = (agent: string): AgentLane => {
    let l = lanesByAgent.get(agent);
    if (!l) {
      l = { agent, blocks: [], errorCount: 0, toolCount: 0 };
      lanesByAgent.set(agent, l);
    }
    return l;
  };

  // Activity rows → blocks. step.started/completed pairs are merged into
  // a single span block so the swimlane shows continuous bars instead of
  // two zero-width markers.
  const startedAtByStep = new Map<string, { ts: number; agent: string }>();
  for (const a of activities) {
    const agent = a.agentName || a.nodeId || "system";
    const lane = ensureLane(agent);
    const kind = normalizeKind(a.type);
    const meta = parseJson(a.metadata);
    const stepName = (meta?.step as string | undefined) ?? (meta?.stepName as string | undefined);
    const tsMs = a.createdAt.getTime();

    if (kind === "step.started" && stepName) {
      startedAtByStep.set(`${agent}:${stepName}`, { ts: tsMs, agent });
      // Don't push a block yet; we'll push the merged span on completion.
      continue;
    }
    if ((kind === "step.completed" || kind === "step.failed") && stepName) {
      const start = startedAtByStep.get(`${agent}:${stepName}`);
      const startTs = start?.ts ?? tsMs;
      const dur = (meta?.durationMs as number | undefined) ?? Math.max(0, tsMs - startTs);
      lane.blocks.push({
        id: a.id,
        kind: "step",
        ts: startTs,
        durationMs: dur,
        label: stepName,
        message: a.narrative,
        status: kind === "step.failed" ? "err" : "ok",
      });
      if (kind === "step.failed") lane.errorCount += 1;
      startedAtByStep.delete(`${agent}:${stepName}`);
      continue;
    }
    // Other kinds → instant blocks.
    const blockKind: TraceBlockKind =
      kind === "tool" || kind === "decision" || kind === "anomaly" || kind === "error" || kind === "hitl"
        ? kind
        : "info";
    const status =
      kind === "tool"
        ? "info"
        : kind === "decision"
          ? "ok"
          : kind === "anomaly" || kind === "hitl"
            ? "warn"
            : kind === "error"
              ? "err"
              : "muted";
    if (kind === "tool") lane.toolCount += 1;
    if (kind === "error" || kind === "anomaly") lane.errorCount += 1;
    lane.blocks.push({
      id: a.id,
      kind: blockKind,
      ts: tsMs,
      label: shortLabel(a.narrative),
      message: a.narrative,
      status,
      toolName: kind === "tool" ? (meta?.toolName as string | undefined) : undefined,
      durationMs: typeof meta?.durationMs === "number" ? meta.durationMs : undefined,
    });
  }

  // Append any "still running" steps as open-ended bars so the user sees
  // them in the swimlane.
  for (const [, started] of startedAtByStep) {
    const lane = ensureLane(started.agent);
    lane.blocks.push({
      id: `pending-${started.agent}-${started.ts}`,
      kind: "step",
      ts: started.ts,
      durationMs: Math.max(0, Date.now() - started.ts),
      label: "running…",
      status: "info",
    });
  }

  // Synthesize lanes from steps when an agent has steps but no activities
  // (defensive — covers agents that didn't write AgentActivity).
  for (const s of steps) {
    const agent = s.nodeId || "system";
    const lane = ensureLane(agent);
    const hasMatchingActivity = lane.blocks.some(
      (b) => b.kind === "step" && Math.abs(b.ts - s.startedAt.getTime()) < 2000,
    );
    if (hasMatchingActivity) continue;
    const startTs = s.startedAt.getTime();
    const endTs = s.completedAt?.getTime() ?? Date.now();
    lane.blocks.push({
      id: `step-${s.id}`,
      kind: "step",
      ts: startTs,
      durationMs: Math.max(0, endTs - startTs),
      label: s.stepName,
      message: s.error ?? undefined,
      status: s.status === "failed" ? "err" : s.status === "running" ? "info" : "ok",
    });
    if (s.status === "failed") lane.errorCount += 1;
  }

  // Sort blocks by ts within each lane.
  for (const lane of lanesByAgent.values()) {
    lane.blocks.sort((a, b) => a.ts - b.ts);
  }
  const agentLanes = Array.from(lanesByAgent.values()).sort((a, b) => {
    // Lanes with the earliest first-block time go up top.
    const aFirst = a.blocks[0]?.ts ?? Infinity;
    const bFirst = b.blocks[0]?.ts ?? Infinity;
    return aFirst - bFirst;
  });

  // ── Event lane (from activity event_received / event_emitted) ────
  // We collect every event_id surfaced in activity metadata, then ask the
  // local Inngest dev which functions ran for it. This lets the UI plot:
  //   ▼ JD_GENERATED            (event marker)
  //   └─ jd-generated-sync 200ms (function run from /v1/events/x/runs)
  const eventEntries: EventLaneEntry[] = [];
  const seenEventIds = new Set<string>();
  let eventLookupError: string | null = null;

  for (const a of activities) {
    const meta = parseJson(a.metadata);
    if (!meta) continue;
    const eventId = (meta.event_id as string) || (meta.eventId as string);
    const eventName = (meta.event_name as string) || (meta.eventName as string);
    if (!eventId || seenEventIds.has(eventId)) continue;
    seenEventIds.add(eventId);
    eventEntries.push({
      eventId,
      name: eventName || a.type || "event",
      ts: a.createdAt.getTime(),
      source: "local",
      inngestRuns: [],
    });
  }

  // Best-effort: query local Inngest for runs spawned by each event id.
  // Cap parallel calls so we don't hammer the dev server. Errors per-event
  // are captured but don't fail the response.
  await Promise.all(
    eventEntries.map(async (e) => {
      try {
        const r = await fetch(
          `${LOCAL_INNGEST}/v1/events/${encodeURIComponent(e.eventId)}/runs`,
          { signal: AbortSignal.timeout(3_000) },
        );
        if (!r.ok) {
          e.inngestError = `${r.status} ${r.statusText}`;
          return;
        }
        const j = (await r.json()) as { data?: Array<Record<string, unknown>> };
        e.inngestRuns = (j.data ?? []).map((row) => ({
          runId: String(row.run_id ?? ""),
          functionId: String(row.function_id ?? ""),
          status: String(row.status ?? ""),
          startedAt: row.run_started_at ? new Date(String(row.run_started_at)).getTime() : null,
          endedAt: row.ended_at ? new Date(String(row.ended_at)).getTime() : null,
        }));
      } catch (err) {
        e.inngestError = (err as Error).message;
        if (!eventLookupError) eventLookupError = (err as Error).message;
      }
    }),
  );

  eventEntries.sort((a, b) => a.ts - b.ts);

  // ── RAAS lanes (P2 placeholder) ─────────────────────────────────
  const raasLanes: RaasLane[] = [];
  let raasError: string | null = null;
  if (includeRaas) {
    if (!RAAS_INNGEST) {
      raasError = "RAAS_INNGEST_URL not configured";
    } else {
      // P2: query RAAS_INNGEST same way as local. For now just signal.
      raasError = "RAAS lane query not implemented in this slice (P2)";
    }
  }

  const body: TraceResponse = {
    run: {
      id: run.id,
      status: run.status,
      triggerEvent: run.triggerEvent,
      triggerData: parseTriggerData(run.triggerData),
      startedAt: run.startedAt.toISOString(),
      completedAt: run.completedAt?.toISOString() ?? null,
      lastActivityAt: run.lastActivityAt.toISOString(),
    },
    span: { startMs, endMs, durationMs },
    agentLanes,
    eventLane: eventEntries,
    raasLanes,
    meta: {
      generatedAt: new Date().toISOString(),
      raasIncluded: includeRaas,
      raasError,
      eventLookupError,
    },
  };
  return NextResponse.json(body);
}

function parseJson(s: string | null): Record<string, unknown> | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseTriggerData(s: unknown): { client: string; jdId: string } {
  try {
    const o =
      typeof s === "string"
        ? (JSON.parse(s) as Record<string, unknown>)
        : (s as Record<string, unknown> | null) ?? {};
    return {
      client: (o.client as string) ?? "—",
      jdId: ((o.jdId ?? o.requisition_id) as string) ?? "—",
    };
  } catch {
    return { client: "—", jdId: "—" };
  }
}

// Cap labels so swimlane blocks don't overflow visually.
function shortLabel(s: string): string {
  const trimmed = s.trim();
  if (trimmed.length <= 40) return trimmed;
  return trimmed.slice(0, 39) + "…";
}
