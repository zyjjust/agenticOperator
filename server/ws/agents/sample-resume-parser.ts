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
import {
  extractResume,
  extractResumeFromBuffer,
  type ParsedResume,
} from "../../llm/resume-extractor";
import { getMinIOClient, isMinIOConfigured } from "../../llm/minio-client";

const AGENT_ID = "9-1";
const AGENT_NAME = "processResume";
const MAPPING_VERSION = "robohire-or-llm-2026-04-28";

// Inbound — supports BOTH the canonical RAAS schema AND the lighter
// AO-test variant.
//
// Canonical (RAAS handoff §2):
//   { bucket, objectKey, filename, hrFolder, employeeId, etag, size,
//     sourceEventName, receivedAt }
//
// AO-test variant (used by /api/test/trigger-resume-uploaded):
//   { resume_file_paths: [], job_requisition_id, channel, resume_text? }
type ResumeDownloadedData = {
  // Canonical fields
  bucket?: string;
  objectKey?: string;
  filename?: string;
  hrFolder?: string | null;
  employeeId?: string | null;
  etag?: string | null;
  size?: number | null;
  sourceEventName?: string | null;
  receivedAt?: string;

  // AO-test fields
  resume_file_paths?: string[];
  job_requisition_id?: string;
  channel?: string;
  resume_text?: string;
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
    const sourceLabel =
      data.bucket && data.objectKey
        ? `${data.bucket}/${data.objectKey}`
        : data.resume_file_paths?.[0] ??
          (data.resume_text ? "inline text" : "—");
    const jdId = data.job_requisition_id ?? null;

    // ── Step 0 — Receipt log (leader's required line, verbatim) ──
    logger.info(
      `Received the resume — source=${sourceLabel} jd=${jdId ?? "—"} channel=${data.channel ?? "—"}`,
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

    // ── Step 1 — Fetch + parse (single fat step) ─────────────────
    // Combined: Buffer can't cross step.run JSON boundary, so fetch
    // and structured-extract happen in one step, returning only the
    // JSON-serializable parsed result.
    const extracted = await step.run("fetch-and-parse-resume", async () => {
      // a) Inline text (AO test path)
      if (data.resume_text) {
        const r = await extractResume(data.resume_text);
        return {
          ...r,
          sourceDescription: "inline resume_text",
          inputBytes: data.resume_text.length,
        };
      }

      // b) Canonical RAAS path: read from MinIO
      if (data.bucket && data.objectKey) {
        if (!isMinIOConfigured()) {
          throw new Error(
            `RESUME_DOWNLOADED indicates MinIO source ${data.bucket}/${data.objectKey} but MINIO_* env not configured`,
          );
        }
        const minio = getMinIOClient();
        const stream = await minio.getObject(data.bucket, data.objectKey);
        const buf = await streamToBuffer(stream);
        const filename = data.filename ?? path.basename(data.objectKey);
        const r = await extractResumeFromBuffer(buf, filename);
        return {
          ...r,
          sourceDescription: `MinIO ${data.bucket}/${data.objectKey} (${buf.length} bytes)`,
          inputBytes: buf.length,
        };
      }

      // c) AO-test path: local sample file
      const filePath = data.resume_file_paths?.[0];
      if (filePath) {
        const abs = resolveSamplePath(filePath);
        const buf = await fs.readFile(abs);
        const filename = path.basename(filePath);
        const r = filePath.toLowerCase().endsWith(".pdf")
          ? await extractResumeFromBuffer(buf, filename)
          : await extractResume(buf.toString("utf-8"));
        return {
          ...r,
          sourceDescription: `local ${filePath} (${buf.length} bytes)`,
          inputBytes: buf.length,
        };
      }

      throw new Error(
        "RESUME_DOWNLOADED must include {bucket,objectKey} OR resume_text OR resume_file_paths[0]",
      );
    });

    await step.run("log-fetched", async () => {
      await prisma.agentActivity.create({
        data: {
          nodeId: AGENT_ID,
          agentName: AGENT_NAME,
          type: "tool",
          narrative: `Fetched ${extracted.inputBytes} bytes from ${extracted.sourceDescription}`,
          metadata: JSON.stringify({
            chars: extracted.inputBytes,
            source: extracted.sourceDescription,
          }),
        },
      });
    });

    await step.run("log-parsed", async () => {
      const skillCount = extracted.parsed.candidate.skills.length;
      const jobCount = extracted.parsed.resume.work_history.length;
      await prisma.agentActivity.create({
        data: {
          nodeId: AGENT_ID,
          agentName: AGENT_NAME,
          type: "agent_complete",
          narrative: `Parse complete in ${extracted.duration_ms}ms · ${skillCount} skills · ${jobCount} jobs · mode=${extracted.mode}${extracted.cached ? " (cached)" : ""}`,
          metadata: JSON.stringify({
            mode: extracted.mode,
            modelUsed: extracted.modelUsed,
            duration_ms: extracted.duration_ms,
            requestId: extracted.requestId,
            cached: extracted.cached,
            fallback_reason: extracted.fallback_reason,
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
    const payload = buildResumeProcessedPayload(data, extracted);

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

// Stream → Buffer (per resume-agent-engineering-spec §4.2 / §7.1)
async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | Uint8Array>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

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

import type { ExtractResult } from "../../llm/resume-extractor";

function buildResumeProcessedPayload(
  source: ResumeDownloadedData,
  extracted: ExtractResult,
) {
  // Prefer canonical fields from RAAS event when present; otherwise
  // synthesize from the AO-test inputs.
  const objectKey = source.objectKey ?? source.resume_file_paths?.[0] ?? null;
  const filename =
    source.filename ?? (objectKey ? path.basename(objectKey) : null);

  return {
    // Source passthrough (spec §3.2)
    bucket: source.bucket ?? "recruit-resume-raw",
    objectKey,
    filename,
    hrFolder: source.hrFolder ?? null,
    employeeId: source.employeeId ?? null,
    etag: source.etag ?? null,
    size: source.size ?? null,
    sourceEventName: source.sourceEventName ?? null,
    receivedAt: source.receivedAt ?? new Date().toISOString(),
    job_requisition_id: source.job_requisition_id ?? null,

    // 4-object structured payload
    candidate: extracted.parsed.candidate,
    candidate_expectation: extracted.parsed.candidate_expectation,
    resume: extracted.parsed.resume,
    runtime: extracted.parsed.runtime,

    // Audit
    parsedAt: new Date().toISOString(),
    parserVersion: `ao+${extracted.mode}@${MAPPING_VERSION}`,
    parserMode: extracted.mode,
    parserModelUsed: extracted.modelUsed,
    parserDurationMs: extracted.duration_ms,
    parserRequestId: extracted.requestId,
    parserCached: extracted.cached,
  };
}
