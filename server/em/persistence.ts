// Persistence helpers for em.publish.
// Single place where Prisma writes happen, so the publish flow stays clean
// and the persistence shape is easy to evolve without grepping the codebase.

import { createHash } from "node:crypto";
import { prisma } from "../db";

const PAYLOAD_SUMMARY_MAX_CHARS = 1000;

export type AcceptedInstanceWrite = {
  id: string;
  name: string;
  source: string;
  externalEventId?: string;
  causedByEventId?: string;
  causedByName?: string;
  schemaVersionUsed: string;
  payloadForSummary: unknown;
};

export type RejectedInstanceWrite = {
  id: string;
  name: string;
  source: string;
  externalEventId?: string;
  status: "rejected_schema" | "rejected_filter" | "duplicate" | "em_degraded";
  rejectionType?: string;
  rejectionReason?: string;
  schemaErrors?: unknown;
  triedVersions?: string[];
  payloadForSummary: unknown;
};

export async function writeAcceptedInstance(w: AcceptedInstanceWrite): Promise<void> {
  await prisma.eventInstance.create({
    data: {
      id: w.id,
      externalEventId: w.externalEventId ?? null,
      name: w.name,
      source: w.source,
      status: "accepted",
      schemaVersionUsed: w.schemaVersionUsed,
      causedByEventId: w.causedByEventId ?? null,
      causedByName: w.causedByName ?? null,
      payloadSummary: summarize(w.payloadForSummary),
    },
  });
}

export async function writeRejectedInstance(w: RejectedInstanceWrite): Promise<void> {
  await prisma.eventInstance.create({
    data: {
      id: w.id,
      externalEventId: w.externalEventId ?? null,
      name: w.name,
      source: w.source,
      status: w.status,
      rejectionType: w.rejectionType ?? null,
      rejectionReason: w.rejectionReason ?? null,
      schemaErrors: w.schemaErrors ? JSON.stringify(w.schemaErrors) : null,
      triedVersions: w.triedVersions ? JSON.stringify(w.triedVersions) : null,
      payloadSummary: summarize(w.payloadForSummary),
    },
  });
}

/**
 * Lookup by external_event_id (for inbound dedup). Returns null when not seen.
 * The unique index on the column makes this an O(1) check.
 */
export async function findInstanceByExternalId(
  externalEventId: string,
): Promise<{ id: string; status: string } | null> {
  const row = await prisma.eventInstance.findUnique({
    where: { externalEventId },
    select: { id: true, status: true },
  });
  return row;
}

/**
 * AuditLog write — one row per em.publish call regardless of accept/reject.
 * AuditLog is append-only and keyed by trace_id for cross-system reconciliation.
 */
export async function writeAudit(input: {
  eventName: string;
  traceId: string;
  source: string;
  payload: unknown;
}): Promise<void> {
  const payloadJson = safeJson(input.payload);
  const digest = createHash("sha256").update(payloadJson).digest("hex").slice(0, 32);
  await prisma.auditLog.create({
    data: {
      eventName: input.eventName,
      traceId: input.traceId,
      payload: payloadJson,
      payloadDigest: digest,
      source: input.source,
    },
  });
}

function summarize(payload: unknown): string {
  const s = safeJson(payload);
  if (s.length <= PAYLOAD_SUMMARY_MAX_CHARS) return s;
  return s.slice(0, PAYLOAD_SUMMARY_MAX_CHARS) + "…";
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "null";
  } catch {
    return "<<unserializable>>";
  }
}
