// em.publish — the central gateway.
//
// Every event publish must go through this function. Direct inngest.send()
// calls in app code are an anti-pattern (caught by code review). The flow
// implements spec v2 §8.2:
//
//   0. Self-check: if EM is in degraded mode, fall back to raw inngest.send
//      so business events still flow (we lose the audit/lifecycle row).
//   1. Filter (Phase 3 — currently noop pass-through, hook in place).
//   2. Schema validate via multi-version tryParse (latest first).
//   3. Dedup against EventInstance.external_event_id (uses unique index).
//   4. Persist EventInstance(status=accepted) + AuditLog row.
//   5. inngest.send() with idempotencyKey = external_event_id || event_id
//      so Inngest's built-in idempotency dedups exact replays.
//
// Failures along the way are non-fatal to the caller — the function always
// returns a PublishResult; it never throws unless something deeply wrong
// happens (e.g. Inngest itself is down). EVENT_REJECTED meta-events are
// auto-emitted on filter/schema failure.

import { randomUUID } from "node:crypto";
import { inngest } from "../inngest/client";
import {
  writeAcceptedInstance,
  writeRejectedInstance,
  findInstanceByExternalId,
  writeAudit,
} from "./persistence";
import { tryParse, type TryParseResult } from "./registry";
import * as degradedMode from "./degraded-mode";
import { emitRejection } from "./rejection";

// ── Public types ──────────────────────────────────────────────────────────

export type PublishOpts = {
  /** Free text identifying the caller. e.g. "raas-bridge", "rpa.matchResumeAgent" */
  source: string;
  /** Inbound: id assigned by the upstream publisher (RAAS event_id). */
  externalEventId?: string;
  /** Cascade: id of the event that triggered this publish, for causality. */
  causedBy?: { eventId: string; name: string };
  /** Default true. Set false for replay-from-DLQ flows where you don't want a new EVENT_REJECTED. */
  emitRejectionOnFailure?: boolean;
  /** Override idempotencyKey. Default = externalEventId ?? generated UUID. */
  idempotencyKey?: string;
  /** Trace ID for AuditLog cross-system reconciliation. */
  traceId?: string;
};

export type PublishResult =
  | {
      accepted: true;
      eventId: string;
      schemaVersionUsed: string;
    }
  | {
      accepted: false;
      reason: "filter" | "schema" | "duplicate" | "em_degraded" | "no_schema";
      details: unknown;
    };

// ── Filter (Phase 3 placeholder) ──────────────────────────────────────────

type FilterDecision = { allow: true } | { allow: false; reason: string };
async function filterCheck(_name: string, _data: unknown): Promise<FilterDecision> {
  // Noop in Phase 1. Phase 3 wires up GatewayFilterRule lookups here.
  return { allow: true };
}

// ── Main entry ────────────────────────────────────────────────────────────

export async function publish(
  name: string,
  data: unknown,
  opts: PublishOpts,
): Promise<PublishResult> {
  // Step 0 — self-check. EM already faulted? Skip the audit pipeline and
  // shovel directly to Inngest so the business event still lands.
  if (degradedMode.isDegraded()) {
    const id = opts.idempotencyKey ?? opts.externalEventId ?? randomUUID();
    try {
      await inngest.send({ id, name, data: data as Record<string, unknown> });
    } catch (err) {
      degradedMode.activate(err as Error);
    }
    return {
      accepted: false,
      reason: "em_degraded",
      details: degradedMode.getState().lastError?.message ?? "degraded",
    };
  }

  try {
    return await publishInner(name, data, opts);
  } catch (err) {
    // Anything thrown here is a bug or DB outage. Activate degraded and
    // try to deliver via raw inngest.send so we don't drop the event.
    degradedMode.activate(err as Error);
    const id = opts.idempotencyKey ?? opts.externalEventId ?? randomUUID();
    try {
      await inngest.send({ id, name, data: data as Record<string, unknown> });
    } catch {
      // Inngest also unavailable — at this point we cannot deliver.
      // The caller will see em_degraded and can retry later.
    }
    return {
      accepted: false,
      reason: "em_degraded",
      details: (err as Error).message,
    };
  }
}

async function publishInner(
  name: string,
  data: unknown,
  opts: PublishOpts,
): Promise<PublishResult> {
  const eventId = randomUUID();
  const traceId = opts.traceId ?? extractTraceId(data) ?? eventId;
  const emitOnFail = opts.emitRejectionOnFailure ?? true;

  // Step 1 — Filter
  const filterResult = await filterCheck(name, data);
  if (!filterResult.allow) {
    await writeRejectedInstance({
      id: eventId,
      name,
      source: opts.source,
      externalEventId: opts.externalEventId,
      status: "rejected_filter",
      rejectionType: "FILTER_REJECTED",
      rejectionReason: filterResult.reason,
      payloadForSummary: data,
    });
    degradedMode.recordReject();
    if (emitOnFail) {
      await emitRejection({
        originalEventName: name,
        originalEventId: opts.externalEventId,
        originalSource: opts.source,
        rejectionType: "FILTER_REJECTED",
        rejectionReason: filterResult.reason,
        payloadSample: toPlainRecord(data),
      });
    }
    return { accepted: false, reason: "filter", details: filterResult.reason };
  }

  // Step 2 — Schema validate (multi-version).
  //
  // When EM_STRICT_SCHEMA=true (production): unknown or invalid events are
  // rejected and emit EVENT_REJECTED. Default (dev/testing): unregistered
  // events pass through as "unvalidated" so the event stream stays populated
  // while schemas are being defined. Events with a registered schema that fail
  // validation are always rejected regardless of this flag.
  const strictSchema = process.env.EM_STRICT_SCHEMA === "true";

  let acceptedData: unknown = data;
  let schemaVersionUsed: string;

  const parsed: TryParseResult = await tryParse(name, data);
  if (!parsed.ok) {
    if (parsed.error === "no_schema") {
      if (strictSchema) {
        await writeRejectedInstance({
          id: eventId,
          name,
          source: opts.source,
          externalEventId: opts.externalEventId,
          status: "rejected_schema",
          rejectionType: "SCHEMA_VALIDATION_FAILED",
          rejectionReason: `no schema registered for event ${name}`,
          triedVersions: parsed.triedVersions,
          payloadForSummary: data,
        });
        degradedMode.recordReject();
        if (emitOnFail) {
          await emitRejection({
            originalEventName: name,
            originalEventId: opts.externalEventId,
            originalSource: opts.source,
            rejectionType: "SCHEMA_VALIDATION_FAILED",
            rejectionReason: `no schema registered for event ${name}`,
            triedVersions: parsed.triedVersions,
            payloadSample: toPlainRecord(data),
            retryGuidance:
              "register the event in Neo4j or add a builtin schema in server/em/schemas/builtin.ts",
          });
        }
        return { accepted: false, reason: "no_schema", details: parsed };
      }
      // Non-strict: pass through unregistered events so the event stream stays
      // populated during integration testing. Flagged with "unvalidated" so UI
      // can distinguish from properly-validated events.
      schemaVersionUsed = "unvalidated";
    } else {
      // Schema exists but data fails validation — always reject regardless of mode.
      const summarized = parsed.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      await writeRejectedInstance({
        id: eventId,
        name,
        source: opts.source,
        externalEventId: opts.externalEventId,
        status: "rejected_schema",
        rejectionType: "SCHEMA_VALIDATION_FAILED",
        rejectionReason: summarized,
        schemaErrors: parsed.issues.map((i) => ({
          path: i.path.join("."),
          code: i.code,
          message: i.message,
        })),
        triedVersions: parsed.triedVersions,
        payloadForSummary: data,
      });
      degradedMode.recordReject();
      if (emitOnFail) {
        await emitRejection({
          originalEventName: name,
          originalEventId: opts.externalEventId,
          originalSource: opts.source,
          rejectionType: "SCHEMA_VALIDATION_FAILED",
          rejectionReason: summarized,
          schemaErrors: parsed.issues.map((i) => ({
            path: i.path.join("."),
            code: i.code,
            message: i.message,
          })),
          triedVersions: parsed.triedVersions,
          payloadSample: toPlainRecord(data),
        });
      }
      return { accepted: false, reason: "schema", details: parsed.issues };
    }
  } else {
    acceptedData = parsed.data;
    schemaVersionUsed = parsed.version;
  }

  // Step 3 — Dedup (only when caller passed an externalEventId)
  if (opts.externalEventId) {
    const existing = await findInstanceByExternalId(opts.externalEventId);
    if (existing) {
      // Silent. Spec v2 §6.1 — duplicates do not emit EVENT_REJECTED.
      return {
        accepted: false,
        reason: "duplicate",
        details: { existingId: existing.id, status: existing.status },
      };
    }
  }

  // Step 4 — Persist EventInstance + AuditLog
  await writeAcceptedInstance({
    id: eventId,
    name,
    source: opts.source,
    externalEventId: opts.externalEventId,
    causedByEventId: opts.causedBy?.eventId,
    causedByName: opts.causedBy?.name,
    schemaVersionUsed,
    payloadForSummary: acceptedData,
  });
  // Audit is best-effort — we don't want a missing trace_id to block delivery.
  await writeAudit({
    eventName: name,
    traceId,
    source: opts.source,
    payload: acceptedData,
  }).catch(() => {/* fire and forget */});

  // Step 5 — Inngest send (use externalEventId as idempotency key when present
  // so a duplicate from upstream after we accepted will be deduped at the
  // bus level too — belt and suspenders).
  const idempotencyKey =
    opts.idempotencyKey ?? opts.externalEventId ?? eventId;
  await inngest.send({
    id: idempotencyKey,
    name,
    data: acceptedData as Record<string, unknown>,
  });

  degradedMode.recordPublish();
  return {
    accepted: true,
    eventId,
    schemaVersionUsed,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────

function extractTraceId(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const t = (data as { trace?: { trace_id?: unknown } }).trace;
  if (t && typeof t.trace_id === "string") return t.trace_id;
  return undefined;
}

function toPlainRecord(data: unknown): Record<string, unknown> | undefined {
  if (!data || typeof data !== "object") return undefined;
  return data as Record<string, unknown>;
}

