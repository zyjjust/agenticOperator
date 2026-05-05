// processResume — workflow node 9-1.
//
// Wire format: RAAS partner spec (docs/raas-alignment-payloads.md +
// 事件对接备忘 §2-§4).
//
// Inbound RESUME_DOWNLOADED:
//   { name: "RESUME_DOWNLOADED",
//     data: { entity_type, entity_id, event_id, payload: { ...snake_case... }, trace } }
//
// Outbound RESUME_PROCESSED — same envelope, payload echoes inbound
// transport fields verbatim and adds **payload.parsed.data with the
// RoboHire `/parse-resume` response `data` field, passed through
// VERBATIM** (spec §4: 不需要任何字段重命名 / 拍扁).
//
// Pipeline (RoboHire-first; LLM fallback if RoboHire is down):
//   MinIO getObject(bucket, object_key) → Buffer
//     ├─ RoboHire /parse-resume   ← preferred
//     └─ unpdf → new-api LLM      ← fallback only when RoboHire fails
//   → emit RESUME_PROCESSED with raw RoboHire-shape data

import { randomUUID } from "node:crypto";
import path from "node:path";
import { inngest } from "../../inngest/client";
import { prisma } from "../../db";
import { isAgenticEnabled } from "../../agentic-state";
import { getMinIOClient, isMinIOConfigured } from "../../llm/minio-client";
import {
  isRoboHireConfigured,
  roboHireParseResume,
  RoboHireError,
} from "../../llm/robohire";
import {
  llmExtractRoboHireShape,
  pdfBufferToText,
} from "../../llm/robohire-shape";
import { forwardToRaas } from "../../inngest/raas-forward";

const AGENT_ID = "9-1";
const AGENT_NAME = "processResume";
const PARSER_VERSION = "ao+robohire@2026-04-28";

// Inbound envelope (RAAS partner contract §3)
type ResumeDownloadedEnvelope = {
  entity_type?: string;
  entity_id?: string | null;
  event_id?: string;
  payload: ResumeDownloadedPayload;
  trace?: {
    trace_id?: string | null;
    request_id?: string | null;
    workflow_id?: string | null;
    parent_trace_id?: string | null;
  };

  // Tolerated for back-compat with the older AO-test trigger that sent
  // canonical fields at the data-root.
  bucket?: string;
  objectKey?: string;
  object_key?: string;
  filename?: string;
  hrFolder?: string | null;
  employeeId?: string | null;
  etag?: string | null;
  size?: number | null;
  sourceEventName?: string | null;
  receivedAt?: string;
  resume_text?: string;
  resume_file_paths?: string[];
};

type ResumeDownloadedPayload = {
  upload_id?: string;
  bucket: string;
  object_key: string;
  filename?: string | null;
  etag?: string | null;
  size?: number | null;
  hr_folder?: string | null;
  employee_id?: string | null;
  source_event_name?: string | null;
  received_at?: string;
  // JD link — partner spec doesn't include yet, but the canonical
  // recruitment events schema has it. We forward it through to match.
  jd_id?: string | null;
  job_requisition_id?: string | null;
  // Bookkeeping IDs (forwarded to RESUME_PROCESSED so matchResume can
  // pick them up without hitting AO's local DB cache).
  // claimer_employee_id is the recruiter who claimed the requisition;
  // matchResume needs it to call RAAS Internal API for the JD payload.
  claimer_employee_id?: string | null;
  hsm_employee_id?: string | null;
  client_id?: string | null;
  source_label?: string | null;
  summary_prefix?: string | null;
  operator_id?: string | null;
  operator_name?: string | null;
  operator_role?: string | null;
  ip_address?: string | null;
  candidate_name?: string | null;
  candidate_id?: string | null;
  resume_file_path?: string | null;

  // Test fixture path — bypasses MinIO + RoboHire if present.
  resume_text?: string;
};

// Spec §3 last bullet: 16 transport fields to echo verbatim.
// Plus jd_id + job_requisition_id + claimer_employee_id (when present),
// so matchResume can look up the real JD via RAAS Internal API without
// going through AO's local DB cache.
const TRANSPORT_FIELDS = [
  "upload_id",
  "bucket",
  "object_key",
  "filename",
  "etag",
  "size",
  "hr_folder",
  "employee_id",
  "source_event_name",
  "received_at",
  "source_label",
  "summary_prefix",
  "operator_id",
  "operator_name",
  "operator_role",
  "ip_address",
  "jd_id",
  "job_requisition_id",
  "claimer_employee_id",
  "hsm_employee_id",
  "client_id",
] as const;

export const sampleResumeParserAgent = inngest.createFunction(
  {
    id: AGENT_ID,
    name: "processResume (workflow node 9-1)",
    retries: 0,
    triggers: [{ event: "RESUME_DOWNLOADED" }],
  },
  async ({ event, step, logger }) => {
    const envelope = normalizeInbound(event.data as ResumeDownloadedEnvelope);
    const payload = envelope.payload;
    const sourceLabel = `${payload.bucket}/${payload.object_key}`;

    // ── Agentic on/off toggle (server/agentic-state.ts) ──
    // When OFF, log a single AgentActivity row + return without
    // touching MinIO / RoboHire / emitting events. UI's /workflow
    // toggle controls this in real time.
    const enabled = await step.run("check-agentic-toggle", async () => {
      return await isAgenticEnabled();
    });
    if (!enabled) {
      logger.info(
        `[${AGENT_NAME}] agentic mode is OFF — skipping ${sourceLabel}`,
      );
      await step.run("log-skipped", async () => {
        await prisma.agentActivity.create({
          data: {
            nodeId: AGENT_ID,
            agentName: AGENT_NAME,
            type: "event_received",
            narrative: `Skipped (agentic OFF) · ${sourceLabel}`,
            metadata: JSON.stringify({
              event_name: "RESUME_DOWNLOADED",
              event_id: envelope.event_id,
              upload_id: payload.upload_id,
              skipped: true,
              reason: "agentic mode disabled",
            }),
          },
        });
      });
      return { skipped: true, reason: "agentic mode disabled" };
    }

    logger.info(
      `[${AGENT_NAME}] received RESUME_DOWNLOADED — ${sourceLabel} upload_id=${payload.upload_id ?? "—"}`,
    );

    await step.run("log-received", async () => {
      await prisma.agentActivity.create({
        data: {
          nodeId: AGENT_ID,
          agentName: AGENT_NAME,
          type: "event_received",
          narrative: `Received RESUME_DOWNLOADED · ${sourceLabel}`,
          metadata: JSON.stringify({
            event_name: "RESUME_DOWNLOADED",
            event_id: envelope.event_id,
            payload,
          }),
        },
      });
    });

    // Single fat step — Buffer can't cross step.run JSON boundary.
    const extracted: FetchAndParseResult = await step.run("fetch-and-parse", async (): Promise<FetchAndParseResult> => {
      const t0 = Date.now();

      // ── Inline-text fixture path (test only) ─────────────────────
      if (payload.resume_text) {
        const llm = await llmExtractRoboHireShape(payload.resume_text);
        return {
          parsedData: llm.parsed as unknown as Record<string, unknown>,
          mode: "llm-fixture" as const,
          modelUsed: llm.modelUsed,
          requestId: undefined as string | undefined,
          cached: false,
          documentId: undefined as string | undefined,
          savedAs: undefined as string | undefined,
          durationMs: Date.now() - t0,
          parseDurationMs: llm.duration_ms,
          inputBytes: payload.resume_text.length,
          textChars: payload.resume_text.length,
          sourceDescription: `inline resume_text (${payload.resume_text.length} chars)`,
          fallbackReason: undefined as string | undefined,
        };
      }

      // ── MinIO fetch (real path) ──────────────────────────────────
      if (!isMinIOConfigured()) {
        throw new Error(
          `RESUME_DOWNLOADED indicates MinIO source ${payload.bucket}/${payload.object_key} but MINIO_* env not configured`,
        );
      }
      const minio = getMinIOClient();
      const stream = await minio.getObject(payload.bucket, payload.object_key);
      const chunks: Buffer[] = [];
      for await (const c of stream as AsyncIterable<Buffer | Uint8Array>) {
        chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      }
      const buf = Buffer.concat(chunks);
      const filename = payload.filename ?? path.basename(payload.object_key);
      const sourceDescription = `MinIO ${payload.bucket}/${payload.object_key} (${buf.length} bytes)`;

      // ── RoboHire (preferred) ────────────────────────────────────
      if (isRoboHireConfigured()) {
        try {
          const r = await roboHireParseResume(buf, filename);
          return {
            parsedData: r.data,
            mode: "robohire" as const,
            modelUsed: "robohire/parse-resume",
            requestId: r.requestId,
            cached: r.cached,
            documentId: r.documentId,
            savedAs: r.savedAs,
            durationMs: Date.now() - t0,
            parseDurationMs: r.duration_ms,
            inputBytes: buf.length,
            textChars: 0,
            sourceDescription,
            fallbackReason: undefined as string | undefined,
          };
        } catch (e) {
          const reason =
            e instanceof RoboHireError
              ? `${e.status}: ${e.message}`
              : (e as Error).message;
          console.warn(
            `[${AGENT_NAME}] RoboHire failed (${reason}); falling back to LLM extraction`,
          );
          // fall through to LLM fallback
          const fallbackReason = `robohire: ${reason}`;
          const isPdf = filename.toLowerCase().endsWith(".pdf");
          const text = isPdf ? await pdfBufferToText(buf) : buf.toString("utf-8");
          const llm = await llmExtractRoboHireShape(text);
          return {
            parsedData: llm.parsed as unknown as Record<string, unknown>,
            mode: "llm-fallback",
            modelUsed: llm.modelUsed,
            requestId: undefined,
            cached: false,
            documentId: undefined,
            savedAs: undefined,
            durationMs: Date.now() - t0,
            parseDurationMs: llm.duration_ms,
            inputBytes: buf.length,
            textChars: text.length,
            sourceDescription,
            fallbackReason,
          };
        }
      }

      // ── No RoboHire configured — LLM only ────────────────────────
      const isPdf = filename.toLowerCase().endsWith(".pdf");
      const text = isPdf ? await pdfBufferToText(buf) : buf.toString("utf-8");
      const llm = await llmExtractRoboHireShape(text);
      return {
        parsedData: llm.parsed as unknown as Record<string, unknown>,
        mode: "llm-only",
        modelUsed: llm.modelUsed,
        requestId: undefined,
        cached: false,
        documentId: undefined,
        savedAs: undefined,
        durationMs: Date.now() - t0,
        parseDurationMs: llm.duration_ms,
        inputBytes: buf.length,
        textChars: text.length,
        sourceDescription,
        fallbackReason: undefined,
      };
    });

    await step.run("log-fetched", async () => {
      await prisma.agentActivity.create({
        data: {
          nodeId: AGENT_ID,
          agentName: AGENT_NAME,
          type: "tool",
          narrative: `Fetched ${extracted.inputBytes} bytes · mode=${extracted.mode}${extracted.cached ? " (cached)" : ""}`,
          metadata: JSON.stringify({
            mode: extracted.mode,
            source: extracted.sourceDescription,
            input_bytes: extracted.inputBytes,
            text_chars: extracted.textChars,
            request_id: extracted.requestId,
            cached: extracted.cached,
            fallback_reason: extracted.fallbackReason,
          }),
        },
      });
    });

    await step.run("log-parsed", async () => {
      const d = extracted.parsedData as any;
      const candName = d?.name ?? "—";
      const expCount = Array.isArray(d?.experience) ? d.experience.length : 0;
      const eduCount = Array.isArray(d?.education) ? d.education.length : 0;
      const skillCount = countSkills(d?.skills);
      await prisma.agentActivity.create({
        data: {
          nodeId: AGENT_ID,
          agentName: AGENT_NAME,
          type: "agent_complete",
          narrative: `Parse complete in ${extracted.parseDurationMs}ms · ${skillCount} skills · ${expCount} jobs · ${eduCount} edu · mode=${extracted.mode}${extracted.cached ? " (cached)" : ""}`,
          metadata: JSON.stringify({
            mode: extracted.mode,
            model_used: extracted.modelUsed,
            duration_ms: extracted.durationMs,
            parse_duration_ms: extracted.parseDurationMs,
            request_id: extracted.requestId,
            document_id: extracted.documentId,
            saved_as: extracted.savedAs,
            cached: extracted.cached,
            candidate_name: candName,
            parsed: extracted.parsedData,
          }),
        },
      });
    });

    if (!hasMeaningfulData(extracted.parsedData)) {
      await step.run("log-sanity-fail", async () => {
        await prisma.agentActivity.create({
          data: {
            nodeId: AGENT_ID,
            agentName: AGENT_NAME,
            type: "agent_error",
            narrative: "Sanity check failed — parser returned empty data, not emitting RESUME_PROCESSED",
            metadata: JSON.stringify({ parsed: extracted.parsedData }),
          },
        });
      });
      throw new Error("Parser returned no meaningful fields");
    }

    // ── Emit RESUME_PROCESSED (RAAS-facing) ──
    // Spec §1: "agent → raas（RESUME_PROCESSED）". RAAS subscribes to
    // this event for Candidate / Resume DB inserts. AO must NOT also
    // subscribe to it — see match-resume.ts header.
    const outboundPayload = buildOutboundPayload(payload, extracted);
    const outboundEnvelope = {
      entity_type: "Candidate",
      entity_id: envelope.entity_id ?? null,
      event_id: randomUUID(),
      payload: outboundPayload,
      trace: envelope.trace ?? {
        trace_id: null,
        request_id: null,
        workflow_id: null,
        parent_trace_id: null,
      },
    };

    await step.sendEvent("emit-resume-processed", {
      name: "RESUME_PROCESSED",
      data: outboundEnvelope,
    });

    // matchResume subscribes directly to RESUME_PROCESSED on our local
    // Inngest. Partner's resume-processed-ingest subscribes on theirs.
    // Forward the same event to partner Inngest so both sides fire.
    await step.run("forward-to-raas-resume-processed", async () => {
      return forwardToRaas("RESUME_PROCESSED", outboundEnvelope);
    });

    await step.run("log-emitted-resume-processed", async () => {
      const d = extracted.parsedData as any;
      await prisma.agentActivity.create({
        data: {
          nodeId: AGENT_ID,
          agentName: AGENT_NAME,
          type: "event_emitted",
          narrative: `Published RESUME_PROCESSED · candidate=${d?.name ?? "—"} · upload_id=${payload.upload_id ?? "—"}`,
          metadata: JSON.stringify({
            event_name: "RESUME_PROCESSED",
            event_id: outboundEnvelope.event_id,
            upload_id: payload.upload_id,
            candidate_name: d?.name,
            duration_ms: extracted.durationMs,
            parser_version: PARSER_VERSION,
            mode: extracted.mode,
            request_id: extracted.requestId,
          }),
        },
      });
    });

    logger.info(
      `[${AGENT_NAME}] published RESUME_PROCESSED — candidate=${(extracted.parsedData as any)?.name ?? "—"} mode=${extracted.mode}`,
    );

    return outboundEnvelope;
  },
);

function normalizeInbound(d: ResumeDownloadedEnvelope): {
  entity_type?: string;
  entity_id?: string | null;
  event_id?: string;
  payload: ResumeDownloadedPayload;
  trace?: ResumeDownloadedEnvelope["trace"];
} {
  if (d.payload && (d.payload.bucket || d.payload.object_key)) {
    const p = d.payload as Record<string, unknown>;
    if (!p.object_key && (p as any).objectKey) {
      (p as any).object_key = (p as any).objectKey;
    }
    return {
      entity_type: d.entity_type,
      entity_id: d.entity_id ?? null,
      event_id: d.event_id,
      payload: d.payload,
      trace: d.trace,
    };
  }

  // Legacy flat shape (kept for AO-internal test triggers).
  const objectKey = d.objectKey ?? d.object_key ?? d.resume_file_paths?.[0] ?? "";
  if (!d.bucket && !objectKey && !d.resume_text) {
    throw new Error(
      "RESUME_DOWNLOADED missing data.payload.{bucket,object_key} (RAAS envelope) and no fallback fields",
    );
  }
  const filename = d.filename ?? (objectKey ? path.basename(objectKey) : null);
  return {
    entity_type: "Candidate",
    entity_id: null,
    event_id: undefined,
    payload: {
      upload_id: undefined,
      bucket: d.bucket ?? "recruit-resume-raw",
      object_key: objectKey,
      filename,
      etag: d.etag ?? null,
      size: d.size ?? null,
      hr_folder: d.hrFolder ?? null,
      employee_id: d.employeeId ?? null,
      source_event_name: d.sourceEventName ?? null,
      received_at: d.receivedAt ?? new Date().toISOString(),
      source_label: null,
      summary_prefix: null,
      operator_id: null,
      operator_name: null,
      operator_role: null,
      ip_address: null,
      candidate_name: null,
      candidate_id: null,
      resume_file_path: objectKey || null,
      resume_text: d.resume_text,
    },
    trace: undefined,
  };
}

type FetchAndParseResult = {
  parsedData: Record<string, unknown>;
  mode: "robohire" | "llm-only" | "llm-fallback" | "llm-fixture";
  modelUsed: string;
  requestId?: string;
  cached: boolean;
  documentId?: string;
  savedAs?: string;
  durationMs: number;
  parseDurationMs: number;
  inputBytes: number;
  textChars: number;
  sourceDescription: string;
  fallbackReason?: string;
};

function buildOutboundPayload(
  inbound: ResumeDownloadedPayload,
  extracted: FetchAndParseResult,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // Echo all 16 transport fields verbatim (RAAS contract §3).
  for (const k of TRANSPORT_FIELDS) {
    out[k] = (inbound as Record<string, unknown>)[k] ?? null;
  }
  // Spec §4: payload.parsed.data = RoboHire response data field, verbatim.
  out.parsed = { data: extracted.parsedData };

  // AO diagnostic fields (RAAS ignores).
  out.parser_version = PARSER_VERSION;
  out.parser_mode = extracted.mode;
  out.parser_model_used = extracted.modelUsed;
  out.parser_request_id = extracted.requestId ?? null;
  out.parser_cached = extracted.cached;
  out.parser_document_id = extracted.documentId ?? null;
  out.parser_saved_as = extracted.savedAs ?? null;
  out.parser_duration_ms = extracted.durationMs;
  out.parsed_at = new Date().toISOString();
  if (extracted.fallbackReason) out.parser_fallback_reason = extracted.fallbackReason;
  return out;
}

function hasMeaningfulData(d: Record<string, unknown>): boolean {
  const a = d as any;
  return Boolean(
    (typeof a?.name === "string" && a.name.trim()) ||
      (typeof a?.email === "string" && a.email.trim()) ||
      (typeof a?.phone === "string" && a.phone.trim()) ||
      (Array.isArray(a?.experience) && a.experience.length > 0) ||
      (typeof a?.skills === "object" && a.skills !== null) ||
      (Array.isArray(a?.skills) && a.skills.length > 0),
  );
}

function countSkills(skills: unknown): number {
  if (Array.isArray(skills)) return skills.length;
  if (skills && typeof skills === "object") {
    const s = skills as Record<string, unknown>;
    let total = 0;
    for (const arr of Object.values(s)) {
      if (Array.isArray(arr)) total += arr.length;
    }
    return total;
  }
  return 0;
}
