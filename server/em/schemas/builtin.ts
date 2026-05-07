// Hardcoded fallback schemas for the 8 core events.
//
// Source-of-truth contract: when EventDefinition table has a row from Neo4j,
// the registry uses that row. When it doesn't (cold start / off-VPN / event
// not in Neo4j), we fall through to these. They're intentionally permissive
// (most fields optional) — RAAS payloads vary; tightening happens later
// once we have real fixtures.

import { z } from "zod";
import type { EventSchemaRegistration } from "./types";

// ── Common envelope sub-schemas ───────────────────────────────────────────

const TraceSchema = z
  .object({
    trace_id: z.string().nullable().optional(),
    request_id: z.string().nullable().optional(),
    workflow_id: z.string().nullable().optional(),
    parent_trace_id: z.string().nullable().optional(),
  })
  .partial()
  .optional();

// Most RAAS events are wrapped in an envelope:
//   { entity_type, entity_id?, event_id, payload: {...}, trace? }
// Permissive base — individual events tighten the payload.
function envelope(payload: z.ZodType) {
  return z.object({
    entity_type: z.string().optional(),
    entity_id: z.union([z.string(), z.null()]).optional(),
    event_id: z.string().optional(),
    payload,
    trace: TraceSchema,
  });
}

// ── Event schemas ─────────────────────────────────────────────────────────

const REQUIREMENT_LOGGED_v1 = envelope(
  z.object({
    requirement_id: z.string(),
    client_id: z.string().optional(),
    job_requisition_id: z.string().optional(),
    title: z.string().optional(),
  }).passthrough(),
);

const RESUME_DOWNLOADED_v1 = envelope(
  z.object({
    upload_id: z.string().min(1),
    bucket: z.string().min(1),
    object_key: z.string().min(1),
    filename: z.string().nullable().optional(),
    etag: z.string().nullable().optional(),
    size: z.number().nullable().optional(),
    employee_id: z.string().nullable().optional(),
    job_requisition_id: z.string().optional(),
    received_at: z.string().optional(),
  }).passthrough(),
);

const RESUME_PROCESSED_v1 = envelope(
  z.object({
    upload_id: z.string().min(1),
    parsed: z
      .object({
        data: z.record(z.string(), z.unknown()),
      })
      .optional(),
    job_requisition_id: z.string().optional(),
  }).passthrough(),
);

const JD_GENERATED_v1 = envelope(
  z.object({
    requirement_id: z.string().optional(),
    job_requisition_id: z.string().optional(),
    jd_id: z.string().optional(),
    title: z.string().optional(),
    summary: z.string().optional(),
  }).passthrough(),
);

// MATCH_PASSED_NEED_INTERVIEW / MATCH_PASSED_NO_INTERVIEW / MATCH_FAILED
// share the same shape — a flattened RoboHire response payload. We mirror
// what server/ws/agents/match-resume.ts emits today.
const MATCH_PAYLOAD_v1 = z
  .object({
    upload_id: z.string().optional(),
    job_requisition_id: z.string().optional(),
    jd_id: z.string().optional(),
    score: z.number().optional(),
    decision: z.string().optional(),
    reason: z.string().optional(),
  })
  .passthrough();

const MATCH_PASSED_NEED_INTERVIEW_v1 = envelope(MATCH_PAYLOAD_v1);
const MATCH_PASSED_NO_INTERVIEW_v1 = envelope(MATCH_PAYLOAD_v1);
const MATCH_FAILED_v1 = envelope(MATCH_PAYLOAD_v1);

// JD_REJECTED — when JD generation hits a business reject (unclear req etc.)
const JD_REJECTED_v1 = envelope(
  z.object({
    requirement_id: z.string().optional(),
    reason: z.string(),
  }).passthrough(),
);

// ── Registrations ─────────────────────────────────────────────────────────

export const BUILTIN_SCHEMAS: EventSchemaRegistration[] = [
  {
    name: "REQUIREMENT_LOGGED",
    description: "客户提交了一条招聘需求；触发 JD 生成",
    versions: [{ version: "1.0", schema: REQUIREMENT_LOGGED_v1 }],
    publishers: ["raas-dashboard", "raas-bridge"],
    subscribers: ["createJdAgent"],
  },
  {
    name: "RESUME_DOWNLOADED",
    description: "MinIO 收到一份新简历；触发解析",
    versions: [{ version: "1.0", schema: RESUME_DOWNLOADED_v1 }],
    publishers: ["raas-bridge"],
    subscribers: ["resumeParserAgent"],
  },
  {
    name: "RESUME_PROCESSED",
    description: "简历解析完成（RoboHire / LLM）",
    versions: [{ version: "1.0", schema: RESUME_PROCESSED_v1 }],
    publishers: ["rpa.resumeParserAgent"],
    subscribers: [
      "rpa.matchResumeAgent",
      "ao.matchResumeAgent",
      "raas-backend.resume-processed-ingest",
    ],
  },
  {
    name: "JD_GENERATED",
    description: "createJdAgent 输出的 JD",
    versions: [{ version: "1.0", schema: JD_GENERATED_v1 }],
    publishers: ["createJdAgent"],
    subscribers: ["raas-backend.jd-generated-sync"],
  },
  {
    name: "JD_REJECTED",
    description: "JD 生成被业务拒绝（需澄清等）",
    versions: [{ version: "1.0", schema: JD_REJECTED_v1 }],
    publishers: ["createJdAgent"],
    subscribers: ["raas-backend"],
  },
  {
    name: "MATCH_PASSED_NEED_INTERVIEW",
    description: "候选人 × JD 匹配通过，需面试",
    versions: [{ version: "1.0", schema: MATCH_PASSED_NEED_INTERVIEW_v1 }],
    publishers: ["rpa.matchResumeAgent"],
    subscribers: ["raas-backend.match-result-ingest-need-interview"],
  },
  {
    name: "MATCH_PASSED_NO_INTERVIEW",
    description: "候选人 × JD 匹配通过，免面试",
    versions: [{ version: "1.0", schema: MATCH_PASSED_NO_INTERVIEW_v1 }],
    publishers: ["rpa.matchResumeAgent"],
    subscribers: ["raas-backend.match-result-ingest-no-interview"],
  },
  {
    name: "MATCH_FAILED",
    description: "候选人 × JD 匹配失败",
    versions: [{ version: "1.0", schema: MATCH_FAILED_v1 }],
    publishers: ["rpa.matchResumeAgent"],
    subscribers: ["raas-backend.match-result-ingest-failed"],
  },
];

export const BUILTIN_SCHEMAS_BY_NAME = new Map(
  BUILTIN_SCHEMAS.map((r) => [r.name, r] as const),
);
