// Manual trigger endpoint for the leader's design-approval demo.
//
// Publishes RESUME_DOWNLOADED onto the Inngest bus, which fans out to
// processResume (workflow node 9-1). Aligned with the real recruitment
// workflow schema in Action_and_Event_Manager/data/events_20260330.json:
//
//   {
//     "name": "RESUME_DOWNLOADED",
//     "event_data": [
//       { "name": "resume_file_paths", "type": "List<String>" },
//       { "name": "job_requisition_id", "type": "String" }
//     ]
//   }
//
// Curl:
//   curl -X POST http://localhost:3002/api/test/trigger-resume-uploaded
//   curl -X POST http://localhost:3002/api/test/trigger-resume-uploaded \
//        -H 'Content-Type: application/json' \
//        -d '{"resume_file_paths":["/storage/wang-feng_2024.pdf"],
//             "job_requisition_id":"JR-ICBC-2024-0042","channel":"BOSS直聘"}'
//
// (URL keeps the ".../trigger-resume-uploaded" path for backwards
// compatibility with the UI; the *event* it sends is RESUME_DOWNLOADED.)

import { NextResponse } from "next/server";
import { inngest } from "@/server/inngest/client";

type ResumeDownloadedInput = Partial<{
  resume_file_paths: string[];
  job_requisition_id: string;
  channel: string;
}>;

export async function POST(req: Request): Promise<Response> {
  let body: ResumeDownloadedInput = {};
  try {
    body = await req.json();
  } catch {
    // Empty body is fine — fall back to a demo payload.
  }

  const payload = {
    resume_file_paths: body.resume_file_paths ?? [
      "/storage/resumes/wang-feng_java_2024.pdf",
    ],
    job_requisition_id: body.job_requisition_id ?? `JR-ICBC-2024-${pad4(Date.now() % 10000)}`,
    channel: body.channel ?? "BOSS直聘",
  };

  try {
    const result = await inngest.send({ name: "RESUME_DOWNLOADED", data: payload });
    return NextResponse.json({
      ok: true,
      sent: { name: "RESUME_DOWNLOADED", data: payload },
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

function pad4(n: number): string {
  return String(n).padStart(4, "0");
}
