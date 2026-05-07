// EVENT_REJECTED meta-event emitter (spec v2 §6).
//
// When em.publish detects a schema or filter failure, it emits this
// meta-event onto the same Inngest bus. Publishers (RAAS) subscribe to
// receive the NACK and can flag their outbox row.
//
// CRITICAL: this emit path skips the full 5-step EM flow on purpose —
// otherwise an EVENT_REJECTED that itself fails validation would emit a
// new EVENT_REJECTED and recurse. Hardcoded, hardcoded, hardcoded.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma } from "../db";
import { inngest } from "../inngest/client";

export const EVENT_REJECTED_NAME = "EVENT_REJECTED";

export const EVENT_REJECTED_SCHEMA = z.object({
  entity_type: z.literal("EventRejection"),
  entity_id: z.string().nullable().optional(),
  event_id: z.string(),
  payload: z.object({
    original_event_id: z.string().optional(),
    original_event_name: z.string(),
    original_source: z.string(),
    rejection_type: z.enum(["SCHEMA_VALIDATION_FAILED", "FILTER_REJECTED"]),
    rejection_reason: z.string(),
    schema_errors: z
      .array(
        z.object({
          path: z.string(),
          code: z.string(),
          message: z.string(),
        }),
      )
      .optional(),
    tried_versions: z.array(z.string()).optional(),
    payload_sample: z.record(z.string(), z.unknown()).optional(),
    rejected_at: z.string(),
    ingester_id: z.string(),
    retry_guidance: z.string().optional(),
  }),
  trace: z
    .object({
      trace_id: z.string().nullable().optional(),
      request_id: z.string().nullable().optional(),
      workflow_id: z.string().nullable().optional(),
      parent_trace_id: z.string().nullable().optional(),
    })
    .optional(),
});

export type RejectionInput = {
  originalEventName: string;
  originalEventId?: string;
  originalSource: string;
  rejectionType: "SCHEMA_VALIDATION_FAILED" | "FILTER_REJECTED";
  rejectionReason: string;
  schemaErrors?: { path: string; code: string; message: string }[];
  triedVersions?: string[];
  payloadSample?: Record<string, unknown>;
  trace?: {
    trace_id?: string | null;
    request_id?: string | null;
    workflow_id?: string | null;
    parent_trace_id?: string | null;
  };
  retryGuidance?: string;
};

const INGESTER_ID = "ao/em@v1";
const PAYLOAD_SAMPLE_MAX_BYTES = 2_000;

export async function emitRejection(input: RejectionInput): Promise<{
  ok: true;
  eventId: string;
} | { ok: false; error: string }> {
  const eventId = randomUUID();
  const envelope = {
    entity_type: "EventRejection" as const,
    entity_id: input.originalEventId ?? null,
    event_id: eventId,
    payload: {
      original_event_id: input.originalEventId,
      original_event_name: input.originalEventName,
      original_source: input.originalSource,
      rejection_type: input.rejectionType,
      rejection_reason: input.rejectionReason,
      schema_errors: input.schemaErrors,
      tried_versions: input.triedVersions,
      payload_sample: input.payloadSample
        ? truncatePayload(input.payloadSample)
        : undefined,
      rejected_at: new Date().toISOString(),
      ingester_id: INGESTER_ID,
      retry_guidance: input.retryGuidance,
    },
    trace: input.trace,
  };

  // Self-validate. If our hardcoded schema is wrong we'd rather know loudly
  // than ship malformed meta-events to RAAS.
  const checked = EVENT_REJECTED_SCHEMA.safeParse(envelope);
  if (!checked.success) {
    console.error(
      "[em/rejection] hardcoded EVENT_REJECTED schema is broken:",
      checked.error.issues,
    );
    return {
      ok: false,
      error: `EVENT_REJECTED self-validation failed: ${checked.error.issues[0]?.message ?? "unknown"}`,
    };
  }

  // Persist a meta_rejection EventInstance row, with caused_by pointing back
  // to the rejected event when available.
  try {
    await prisma.eventInstance.create({
      data: {
        id: eventId,
        name: EVENT_REJECTED_NAME,
        source: `em-rejection-of:${input.originalSource}`,
        status: "meta_rejection",
        rejectionType: input.rejectionType,
        rejectionReason: input.rejectionReason,
        schemaErrors: input.schemaErrors
          ? JSON.stringify(input.schemaErrors)
          : null,
        causedByEventId: input.originalEventId ?? null,
        causedByName: input.originalEventName,
        payloadSummary: JSON.stringify(envelope.payload).slice(0, 500),
      },
    });
  } catch (err) {
    // Persisting the audit row is best-effort. We continue anyway because
    // the actual NACK to RAAS is far more important than our own audit.
    console.warn(
      "[em/rejection] EventInstance write failed:",
      (err as Error).message,
    );
  }

  // Send. No middleware, no retries-on-fail, no schema lookup — we already
  // own the schema in this file.
  try {
    await inngest.send({
      id: `rejection-${eventId}`,
      name: EVENT_REJECTED_NAME,
      data: envelope,
    });
    return { ok: true, eventId };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

function truncatePayload(p: Record<string, unknown>): Record<string, unknown> {
  const s = JSON.stringify(p);
  if (s.length <= PAYLOAD_SAMPLE_MAX_BYTES) return p;
  // Return a safely truncated mirror — not the full original. We use a
  // single string field rather than a partial object so consumers don't
  // think the truncated subset is the whole payload.
  return { __truncated: s.slice(0, PAYLOAD_SAMPLE_MAX_BYTES) + "…" };
}
