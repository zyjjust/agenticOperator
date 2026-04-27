// Sample agent — proof-of-concept for leader's design approval.
// Equivalent to the standalone resume-parser-agent/ POC but lives
// inside Agentic Operator's Next.js framework (P3 chunk 3 architecture).
//
// Pattern: subscribe to event → log → publish event.
//
// Spec (from leader):
//   subscribe to event called "resume.uploaded"
//   on receiving this event, write a log with message "Received the resume"
//   publish a message of event type "resume.parse"
//
// Validates:
//   - WS Workflow agent pattern (every WS agent has this shape)
//   - P3 Inngest serve adapter (server/inngest/client → /api/inngest)
//   - Prisma write path (server/db → ao.db AgentActivity)
//   - Event emission (step.sendEvent → Inngest fans out to subscribers)

import { inngest } from "../../inngest/client";
import { prisma } from "../../db";

const AGENT_ID = "sample-resume-parser";
const AGENT_NAME = "SampleResumeParser";

// Event payload shape co-located with the consumer (Inngest v4 pattern).
type ResumeUploadedData = {
  resume_id: string;
  candidate_name?: string;
  file_url: string;
  uploaded_at: string;
};

export const sampleResumeParserAgent = inngest.createFunction(
  {
    id: AGENT_ID,
    name: "Resume Parser Agent",
    triggers: [{ event: "resume.uploaded" }],
  },
  async ({ event, step, logger }) => {
    const { resume_id, candidate_name, file_url } = event.data as ResumeUploadedData;

    // ── Log: per leader's spec ("Received the resume") ────────────
    logger.info(
      `Received the resume — resume_id=${resume_id} candidate=${candidate_name ?? "unknown"} file=${file_url}`,
    );

    // Phase 1 / 3 — Receipt log. Two sinks: stdout + AgentActivity.
    await step.run("log-received", async () => {
      await prisma.agentActivity.create({
        data: {
          nodeId: AGENT_ID,
          agentName: AGENT_NAME,
          type: "event_received",
          narrative: "Received the resume",
          metadata: JSON.stringify({ trigger: "resume.uploaded", ...event.data }),
        },
      });
    });

    // Phase 2 / 3 — Parse: deterministic stub. No LLM. 250ms simulated work.
    const startedAt = Date.now();
    const parsed = await step.run("parse-resume", async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const fileName = file_url.split("/").pop() ?? "";
      const slug = fileName.replace(/\.[^.]+$/, "");
      return {
        name: candidate_name ?? slug.replace(/[-_]/g, " "),
        email: `${slug.toLowerCase()}@example.com`,
        phone: "+1-555-0100",
        skills: ["typescript", "node.js", "event-driven-architecture"],
        years_of_experience: 5,
      };
    });
    const duration_ms = Date.now() - startedAt;

    await step.run("log-parsed", async () => {
      await prisma.agentActivity.create({
        data: {
          nodeId: AGENT_ID,
          agentName: AGENT_NAME,
          type: "agent_complete",
          narrative: `Parse complete in ${duration_ms}ms · ${parsed.skills.length} skills extracted`,
          metadata: JSON.stringify({
            resume_id,
            duration_ms,
            parsed_fields: parsed,
          }),
        },
      });
    });

    // Phase 3 / 3 — Publish: per leader's spec ("event type resume.parse")
    await step.sendEvent("emit-resume-parse", {
      name: "resume.parse",
      data: {
        resume_id,
        candidate_name: parsed.name,
        parsed_fields: parsed,
        duration_ms,
        parsed_at: new Date().toISOString(),
      },
    });

    await step.run("log-emitted", async () => {
      await prisma.agentActivity.create({
        data: {
          nodeId: AGENT_ID,
          agentName: AGENT_NAME,
          type: "event_emitted",
          narrative: "Published resume.parse",
          metadata: JSON.stringify({
            event_name: "resume.parse",
            resume_id,
            duration_ms,
          }),
        },
      });
    });

    logger.info(
      `[${AGENT_NAME}] published resume.parse — resume_id=${resume_id} skills=${parsed.skills.length} duration=${duration_ms}ms`,
    );

    return { resume_id, parsed_fields: parsed, duration_ms };
  },
);
