// Manual trigger for the partner-spec RESUME_DOWNLOADED event.
//
// Wraps the canonical fields in the RAAS event envelope (data.payload.*,
// snake_case) per the partner spec "RESUME_DOWNLOADED / RESUME_PROCESSED
// 事件对接备忘". POSTs to the local Inngest dev server (http://localhost:8288)
// via the AO Inngest client.
//
// Body shape (all optional — sensible defaults applied):
//   {
//     "bucket": "recruit-resume-raw",
//     "object_key": "2026/04/.../<file>.pdf",
//     "filename": "<original filename>.pdf",
//     "upload_id": "uuid",
//     "employee_id": "EMP-002",
//     "resume_text": "...inline text..."   // optional fixture path
//   }
//
// Response: { ok, sent, inngest_ids }

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { inngest } from "@/server/inngest/client";

type TriggerInput = Partial<{
  bucket: string;
  object_key: string;
  filename: string;
  upload_id: string;
  etag: string | null;
  size: number | null;
  hr_folder: string | null;
  employee_id: string;
  source_label: string;
  summary_prefix: string;
  operator_id: string;
  operator_name: string;
  operator_role: string;
  ip_address: string;
  candidate_name: string | null;
  candidate_id: string | null;
  resume_text: string;
  // Real JD link — pass this from a prior JD_GENERATED event so
  // matchResume looks up the actual JD instead of falling back to
  // filename inference.
  jd_id: string;
  job_requisition_id: string;
  // Recruiter claimer_employee_id. matchResume needs this to call the
  // RAAS Internal API. If absent, falls back to local JobRequisition
  // cache or RAAS_DEFAULT_EMPLOYEE_ID env.
  claimer_employee_id: string;
  hsm_employee_id: string;
  client_id: string;
}>;

export async function POST(req: Request): Promise<Response> {
  let body: TriggerInput = {};
  try {
    body = await req.json();
  } catch {
    /* empty body OK */
  }

  const uploadId = body.upload_id ?? randomUUID();
  const objectKey =
    body.object_key ??
    "2026/04/e7b3dde7-b4fc-96dc-6a9b-d2e2facd57db-【游戏测试（全国招聘）_深圳 7-11K】谌治中 3年.pdf";
  const filename =
    body.filename ?? "【游戏测试（全国招聘）_深圳 7-11K】谌治中 3年.pdf";

  const envelope = {
    entity_type: "Candidate",
    entity_id: null,
    event_id: randomUUID(),
    payload: {
      upload_id: uploadId,
      bucket: body.bucket ?? "recruit-resume-raw",
      object_key: objectKey,
      filename,
      etag: body.etag ?? null,
      size: body.size ?? null,
      hr_folder: body.hr_folder ?? null,
      employee_id: body.employee_id ?? "EMP-TEST",
      source_event_name: null,
      received_at: new Date().toISOString(),
      source_label: body.source_label ?? "AO Manual Trigger",
      summary_prefix: body.summary_prefix ?? "/api/test/trigger-resume-uploaded",
      operator_id: body.operator_id ?? "EMP-TEST",
      operator_name: body.operator_name ?? "AO Tester",
      operator_role: body.operator_role ?? "recruiter",
      ip_address: body.ip_address ?? "127.0.0.1",
      candidate_name: body.candidate_name ?? null,
      candidate_id: body.candidate_id ?? null,
      resume_file_path: objectKey,
      ...(body.resume_text ? { resume_text: body.resume_text } : {}),
      ...(body.jd_id ? { jd_id: body.jd_id } : {}),
      ...(body.job_requisition_id
        ? { job_requisition_id: body.job_requisition_id }
        : {}),
      ...(body.claimer_employee_id
        ? { claimer_employee_id: body.claimer_employee_id }
        : {}),
      ...(body.hsm_employee_id
        ? { hsm_employee_id: body.hsm_employee_id }
        : {}),
      ...(body.client_id ? { client_id: body.client_id } : {}),
    },
    trace: {
      trace_id: null,
      request_id: null,
      workflow_id: null,
      parent_trace_id: null,
    },
  };

  try {
    const result = await inngest.send({
      name: "RESUME_DOWNLOADED",
      data: envelope,
    });
    return NextResponse.json({
      ok: true,
      sent: { name: "RESUME_DOWNLOADED", data: envelope },
      inngest_ids: result.ids,
    });
  } catch (e) {
    return NextResponse.json(
      {
        error: "INTERNAL",
        message: (e as Error).message,
        hint: "Make sure the Inngest dev server is running: npx inngest-cli@latest dev",
      },
      { status: 500 },
    );
  }
}
