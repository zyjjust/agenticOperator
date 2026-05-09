// Lifecycle classification for events on the Inngest bus.
//
// Three distinct lifecycle states a UI viewer cares about:
//   received  — domain event arrived on the bus from outside (RAAS bridge,
//               external webhook, partner publish).
//   emitted   — domain event was published by an AO function as a cascade
//               (carries caused_by_event_id / caused_by linkage).
//   completed — Inngest signalled function completion (`inngest/function.finished`
//               or `.failed` / `.cancelled`). The event itself isn't a domain
//               event — it's a run-end signal that references the original
//               event by id.
//
// This module is pure and runs in both client and server.

export type EventLifecycle = "received" | "emitted" | "completed" | "failed";

export type LifecycleClassification = {
  lifecycle: EventLifecycle;
  /** True if this is one of inngest's internal `inngest/...` system events. */
  isSystem: boolean;
  /** For function.finished/failed events — points back to the source event. */
  referencedEventName?: string;
  referencedEventId?: string;
  /** Inngest run id, if this row is a function-end signal. */
  runId?: string;
  /** caused-by chain id when emitted (ULID of the upstream event). */
  causedByEventId?: string;
};

type RawEvent = {
  id: string;
  name: string;
  data?: unknown;
  ts?: number;
  received_at?: string;
};

// All known caused-by field paths we've seen in event payloads. Different
// agents have used slightly different conventions over time; keep this
// permissive rather than fighting the producers.
const CAUSED_BY_PATHS: Array<(d: Record<string, unknown>) => string | undefined> = [
  (d) => (d._meta as Record<string, unknown> | undefined)?.caused_by_event_id as string | undefined,
  (d) => (d._meta as Record<string, unknown> | undefined)?.causedByEventId as string | undefined,
  (d) => (d.payload as Record<string, unknown> | undefined)?.caused_by_event_id as string | undefined,
  (d) => (d.payload as Record<string, unknown> | undefined)?.causedByEventId as string | undefined,
  (d) => d.caused_by_event_id as string | undefined,
  (d) => d.causedByEventId as string | undefined,
];

export function classifyEvent(ev: RawEvent): LifecycleClassification {
  const name = ev.name;
  const isSystem = name.startsWith("inngest/");

  if (isSystem) {
    // function.finished / .failed / .cancelled are the run-completion signals
    // we care about. Other inngest/* events (e.g. inngest/scheduled) we still
    // flag as "completed" because that's the closest match for the user's
    // mental model — a system bookkeeping event, not domain traffic.
    const data = (ev.data ?? {}) as Record<string, unknown>;
    const inner = (data.event as Record<string, unknown> | undefined) ?? undefined;
    return {
      lifecycle: name === "inngest/function.failed" ? "failed" : "completed",
      isSystem: true,
      referencedEventName: inner?.name as string | undefined,
      referencedEventId: inner?.id as string | undefined,
      runId: data.run_id as string | undefined,
    };
  }

  // Domain event — distinguish received vs emitted by looking for caused_by.
  const data = (ev.data ?? {}) as Record<string, unknown>;
  let causedBy: string | undefined;
  for (const get of CAUSED_BY_PATHS) {
    const v = get(data);
    if (typeof v === "string" && v) {
      causedBy = v;
      break;
    }
  }
  return {
    lifecycle: causedBy ? "emitted" : "received",
    isSystem: false,
    causedByEventId: causedBy,
  };
}

export const LIFECYCLE_LABEL: Record<EventLifecycle, string> = {
  received: "received",
  emitted: "emitted",
  completed: "completed",
  failed: "failed",
};

export const LIFECYCLE_HINT: Record<EventLifecycle, string> = {
  received: "事件从外部进入总线（webhook / 桥接 / 合作方发布）",
  emitted: "AO 内部 agent 作为级联（caused_by）发出的事件",
  completed: "inngest/function.finished — Inngest 函数运行结束信号",
  failed: "inngest/function.failed — Inngest 函数运行失败信号",
};

// Tailwind-ish badge variants tied to atoms.tsx Badge variants.
export function lifecycleBadgeVariant(
  l: EventLifecycle,
): "ok" | "warn" | "err" | "info" | "default" {
  switch (l) {
    case "received":
      return "info";
    case "emitted":
      return "default";
    case "completed":
      return "ok";
    case "failed":
      return "err";
  }
}
