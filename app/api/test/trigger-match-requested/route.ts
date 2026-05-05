// Manual trigger for AO_MATCH_REQUESTED — bypasses processResume.
//
// Useful when you want to test matchResume + RAAS Internal API + RoboHire
// /match-resume in isolation without going through the full
// RESUME_DOWNLOADED → MinIO → RoboHire /parse-resume chain.
//
// You provide: jd_id (or job_requisition_id) + a parsed.data blob
// (RoboHire /parse-resume response shape, or hand-crafted) + optional
// claimer_employee_id.
//
// Body:
//   {
//     "jd_id":               "jd_xxx",                  // optional, takes priority over job_requisition_id
//     "job_requisition_id":  "JRQ-...",                 // optional fallback
//     "claimer_employee_id": "0000199059",              // optional, env fallback applies
//     "filename":            "<...>.pdf",               // optional, for filename-hint fallback
//     "candidate": {                                    // optional, mock candidate ref
//       "name": "测试候选人",
//       "phone": "13800000000",
//       "email": "test@example.com"
//     },
//     "parsed_data": {                                  // optional, RoboHire-shape parsed.data
//       "name": "...", "skills": {...}, "experience": [...], ...
//     }
//   }

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { inngest } from "@/server/inngest/client";

type Body = Partial<{
  jd_id: string;
  job_requisition_id: string;
  claimer_employee_id: string;
  filename: string;
  upload_id: string;
  candidate: { name?: string; phone?: string; email?: string };
  parsed_data: Record<string, unknown>;
}>;

export async function POST(req: Request): Promise<Response> {
  let body: Body = {};
  try {
    body = await req.json();
  } catch {
    /* empty body OK */
  }

  const cand = body.candidate ?? {};
  // A minimal stand-in parsed.data that's enough for matchResume to
  // build a resume text. Real flows use the RoboHire /parse-resume
  // response data field.
  const parsedData =
    body.parsed_data ??
    ({
      name: cand.name ?? "测试候选人",
      email: cand.email ?? "test@example.com",
      phone: cand.phone ?? "13800000000",
      location: null,
      summary: "通过 /api/test/trigger-match-requested 手动构造的测试简历",
      skills: { technical: [], soft: [], languages: [], tools: [], frameworks: [], other: [] },
      experience: [],
      education: [],
      projects: [],
      certifications: [],
      languages: [],
      rawText: "（手动测试 stub — 实际跑通需要真实 RoboHire 解析过的简历）",
    } as Record<string, unknown>);

  const envelope = {
    entity_type: "Candidate",
    entity_id: null,
    event_id: randomUUID(),
    payload: {
      upload_id: body.upload_id ?? randomUUID(),
      bucket: "recruit-resume-raw",
      object_key: "test/manual-match-requested.pdf",
      filename: body.filename ?? "test/manual-match-requested.pdf",
      etag: null,
      size: null,
      hr_folder: null,
      employee_id: "EMP-TEST",
      source_event_name: "manual-trigger-match-requested",
      received_at: new Date().toISOString(),
      source_label: "AO Manual Match Trigger",
      summary_prefix: "/api/test/trigger-match-requested",
      operator_id: "EMP-TEST",
      operator_name: "AO Tester",
      operator_role: "recruiter",
      ip_address: "127.0.0.1",
      ...(body.jd_id ? { jd_id: body.jd_id } : {}),
      ...(body.job_requisition_id
        ? { job_requisition_id: body.job_requisition_id }
        : {}),
      ...(body.claimer_employee_id
        ? { claimer_employee_id: body.claimer_employee_id }
        : {}),
      candidate_name: cand.name ?? null,
      candidate_id: null,
      parsed: { data: parsedData },
      parser_version: "manual-trigger@2026-04-28",
      parser_mode: "manual-stub",
      parsed_at: new Date().toISOString(),
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
      name: "AO_MATCH_REQUESTED",
      data: envelope,
    });
    return NextResponse.json({
      ok: true,
      sent: { name: "AO_MATCH_REQUESTED", data: envelope },
      inngest_ids: result.ids,
    });
  } catch (e) {
    return NextResponse.json(
      {
        error: "INTERNAL",
        message: (e as Error).message,
        hint: "Make sure Inngest dev is reachable on INNGEST_BASE_URL",
      },
      { status: 500 },
    );
  }
}
