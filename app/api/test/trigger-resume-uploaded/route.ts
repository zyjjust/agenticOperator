// Manual trigger endpoint for the leader's design-approval demo.
// POSTing here publishes a `resume.uploaded` event onto the Inngest
// bus, which fans out to sampleResumeParserAgent.
//
// Curl:
//   curl -X POST http://localhost:3002/api/test/trigger-resume-uploaded
//   curl -X POST http://localhost:3002/api/test/trigger-resume-uploaded \
//        -H 'Content-Type: application/json' \
//        -d '{"resume_id":"abc-123","candidate_name":"Yuhan","file_url":"https://example.com/yuhan.pdf"}'
//
// Then watch:
//   - http://localhost:8288 (Inngest dev dashboard) — function run + emitted resume.parse
//   - sqlite3 data/ao.db "SELECT * FROM AgentActivity WHERE agentName='SampleResumeParser' ORDER BY createdAt DESC LIMIT 1"
//
// P3 chunk 4+: this endpoint stays useful as a debug trigger; for
// production the trigger comes from RAAS/EM upstream webhooks.

import { NextResponse } from "next/server";
import { inngest } from "@/server/inngest/client";

type ResumeUploadedInput = Partial<{
  resume_id: string;
  candidate_name: string;
  file_url: string;
  uploaded_at: string;
}>;

export async function POST(req: Request): Promise<Response> {
  let body: ResumeUploadedInput = {};
  try {
    body = await req.json();
  } catch {
    // Empty body is fine — we'll fall back to a demo payload.
  }

  const payload = {
    resume_id: body.resume_id ?? `demo-${Date.now()}`,
    candidate_name: body.candidate_name ?? "Demo Candidate",
    file_url: body.file_url ?? "https://example.com/demo-resume.pdf",
    uploaded_at: body.uploaded_at ?? new Date().toISOString(),
  };

  try {
    const result = await inngest.send({ name: "resume.uploaded", data: payload });
    return NextResponse.json({
      ok: true,
      sent: { name: "resume.uploaded", data: payload },
      inngest_ids: result.ids,
      next_steps: [
        "Open http://localhost:8288 to watch the function run",
        "sqlite3 data/ao.db \"SELECT * FROM AgentActivity WHERE agentName='SampleResumeParser' ORDER BY createdAt DESC LIMIT 5\"",
      ],
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
