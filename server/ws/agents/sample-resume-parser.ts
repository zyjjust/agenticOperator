// processResume — workflow node 9-1, real implementation.
//
// Spec source: docs/resume-agent-engineering-spec.md §3.2 + §4
// Input event:  RESUME_DOWNLOADED { resume_file_paths, job_requisition_id, channel }
// Output event: RESUME_PROCESSED  with full 4-object payload
//
// Steps (per §4.1):
//   1. fetch-resume-bytes  — read from data/sample-resumes/<name> (POC)
//                            or accept inline resume_text in event payload
//   2. extract-text        — pdf-parse for .pdf, raw for .txt
//   3. extract-structured  — OpenAI gpt-4o-mini if key set, else stub
//   4. sanity-check        — hasStructuredResumePayload (spec §4.2)
//   5. emit-resume-processed
//
// All state writes go to AgentActivity (so /agent-demo UI can render them).

import { promises as fs } from "node:fs";
import path from "node:path";
import { inngest } from "../../inngest/client";
import { prisma } from "../../db";
import { extractResume, type ParsedResume } from "../../llm/resume-extractor";

const AGENT_ID = "9-1";
const AGENT_NAME = "processResume";
const MAPPING_VERSION = "stub-or-openai-2026-04-27";

// Inbound (events_20260330 → RESUME_DOWNLOADED.event_data)
type ResumeDownloadedData = {
  resume_file_paths: string[];
  job_requisition_id: string;
  channel?: string;
  resume_text?: string; // POC convenience: pass text inline
};

export const sampleResumeParserAgent = inngest.createFunction(
  {
    id: AGENT_ID,
    name: "processResume (workflow node 9-1)",
    retries: 0,
    triggers: [{ event: "RESUME_DOWNLOADED" }],
  },
  async ({ event, step, logger }) => {
    const data = event.data as ResumeDownloadedData;
    const filePath = data.resume_file_paths?.[0] ?? null;
    const jdId = data.job_requisition_id;

    // ── Step 0 — Receipt log (leader's required line, verbatim) ──
    logger.info(
      `Received the resume — files=${data.resume_file_paths?.length ?? 0} jd=${jdId} channel=${data.channel ?? "—"}`,
    );
    await step.run("log-received", async () => {
      await prisma.agentActivity.create({
        data: {
          nodeId: AGENT_ID,
          agentName: AGENT_NAME,
          type: "event_received",
          narrative: "Received the resume",
          metadata: JSON.stringify({ trigger: "RESUME_DOWNLOADED", ...data }),
        },
      });
    });

    // ── Step 1 — Fetch bytes (or inline text) ──
    const text = await step.run("fetch-and-extract-text", async () => {
      if (data.resume_text) {
        return data.resume_text;
      }
      if (filePath) {
        const abs = resolveSamplePath(filePath);
        const buf = await fs.readFile(abs);
        if (filePath.endsWith(".pdf")) {
          return await extractTextFromPdf(buf);
        }
        return buf.toString("utf-8");
      }
      throw new Error(
        "RESUME_DOWNLOADED event must include either resume_text or a readable resume_file_paths[0]",
      );
    });

    await step.run("log-extracted", async () => {
      await prisma.agentActivity.create({
        data: {
          nodeId: AGENT_ID,
          agentName: AGENT_NAME,
          type: "tool",
          narrative: `Extracted ${text.length} chars from ${filePath ?? "inline text"}`,
          metadata: JSON.stringify({
            chars: text.length,
            preview: text.slice(0, 200),
            source: filePath ?? "inline",
          }),
        },
      });
    });

    // ── Step 2 — Structured extraction (LLM or stub) ──
    const extracted = await step.run("extract-structured", async () => {
      return await extractResume(text);
    });

    await step.run("log-parsed", async () => {
      await prisma.agentActivity.create({
        data: {
          nodeId: AGENT_ID,
          agentName: AGENT_NAME,
          type: "agent_complete",
          narrative: `Parse complete in ${extracted.duration_ms}ms · ${extracted.parsed.candidate.skills.length} skills · ${extracted.parsed.resume.work_history.length} jobs · mode=${extracted.mode}`,
          metadata: JSON.stringify({
            mode: extracted.mode,
            modelUsed: extracted.modelUsed,
            duration_ms: extracted.duration_ms,
            parsed: extracted.parsed,
          }),
        },
      });
    });

    // ── Step 3 — Sanity check (spec §4.2) ──
    if (!hasStructuredResumePayload(extracted.parsed)) {
      await step.run("log-sanity-fail", async () => {
        await prisma.agentActivity.create({
          data: {
            nodeId: AGENT_ID,
            agentName: AGENT_NAME,
            type: "agent_error",
            narrative: "Sanity check failed — no structured fields extracted; not emitting RESUME_PROCESSED",
            metadata: JSON.stringify({ parsed: extracted.parsed }),
          },
        });
      });
      throw new Error("hasStructuredResumePayload returned false");
    }

    // ── Step 4 — Emit RESUME_PROCESSED with full §3.2 schema ──
    const payload = buildResumeProcessedPayload(data, extracted.parsed);

    await step.sendEvent("emit-resume-processed", {
      name: "RESUME_PROCESSED",
      data: payload,
    });

    await step.run("log-emitted", async () => {
      await prisma.agentActivity.create({
        data: {
          nodeId: AGENT_ID,
          agentName: AGENT_NAME,
          type: "event_emitted",
          narrative: `Published RESUME_PROCESSED · candidate=${extracted.parsed.candidate.name ?? "—"} · skills=${extracted.parsed.candidate.skills.length}`,
          metadata: JSON.stringify({
            event_name: "RESUME_PROCESSED",
            parserVersion: payload.parserVersion,
            candidate_name: extracted.parsed.candidate.name,
            duration_ms: extracted.duration_ms,
          }),
        },
      });
    });

    logger.info(
      `[${AGENT_NAME}] published RESUME_PROCESSED — candidate=${extracted.parsed.candidate.name} mode=${extracted.mode}`,
    );

    return payload;
  },
);

function resolveSamplePath(p: string): string {
  // Accepts:
  //   "wang-feng-java.txt"                                    → data/sample-resumes/wang-feng-java.txt
  //   "data/sample-resumes/wang-feng-java.txt"                → as-is
  //   "/storage/resumes/wang-feng_java_2024.pdf" (legacy)    → reroute to known sample
  if (p.startsWith("/")) {
    // legacy fixture path — swap to the matching sample
    const slug = path.basename(p).toLowerCase();
    if (slug.includes("java") || slug.includes("wang")) return absoluteSample("wang-feng-java.txt");
    if (slug.includes("frontend") || slug.includes("li-xiaohong")) return absoluteSample("li-xiaohong-frontend.txt");
    if (slug.includes("data") || slug.includes("zhang-wei")) return absoluteSample("zhang-wei-data.txt");
    if (slug.includes("ue5") || slug.includes("liu-yang")) return absoluteSample("wang-feng-java.txt"); // no UE5 sample yet
    return absoluteSample(path.basename(p, path.extname(p)) + ".txt");
  }
  if (p.startsWith("data/")) return path.resolve(p);
  return absoluteSample(p);
}

function absoluteSample(name: string): string {
  return path.resolve("data", "sample-resumes", name);
}

async function extractTextFromPdf(buf: Buffer): Promise<string> {
  // pdf-parse expects a Buffer; it's CJS so we dynamic-import to keep ESM happy.
  const mod = await import("pdf-parse");
  const pdfParse = (mod as any).default ?? (mod as any);
  const result = await pdfParse(buf);
  return result.text ?? "";
}

function hasStructuredResumePayload(p: ParsedResume): boolean {
  const nonEmpty = (v: unknown): v is string =>
    typeof v === "string" && v.trim().length > 0;
  return Boolean(
    nonEmpty(p.candidate.name) ||
      nonEmpty(p.candidate.mobile) ||
      nonEmpty(p.candidate.email) ||
      nonEmpty(p.runtime.current_title) ||
      nonEmpty(p.runtime.current_company) ||
      (Array.isArray(p.resume.skills_extracted) && p.resume.skills_extracted.length > 0),
  );
}

function buildResumeProcessedPayload(
  source: ResumeDownloadedData,
  parsed: ParsedResume,
) {
  return {
    // Source passthrough (spec §3.2)
    bucket: "recruit-resume-raw",
    objectKey: source.resume_file_paths?.[0] ?? null,
    filename: source.resume_file_paths?.[0]
      ? path.basename(source.resume_file_paths[0])
      : null,
    hrFolder: null,
    employeeId: null,
    etag: null,
    size: null,
    sourceEventName: null,
    receivedAt: new Date().toISOString(),
    job_requisition_id: source.job_requisition_id,

    // 4-object structured payload
    candidate: parsed.candidate,
    candidate_expectation: parsed.candidate_expectation,
    resume: parsed.resume,
    runtime: parsed.runtime,

    // Audit
    parsedAt: new Date().toISOString(),
    parserVersion: `ao@${MAPPING_VERSION}`,
  };
}
