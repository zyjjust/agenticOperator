// processResume — sample agent aligned with the real recruitment workflow.
//
// Matches workflow node id="9-1" name="processResume" actor="Agent" in
// Action_and_Event_Manager/data/workflow_20260330.json. Event names + payload
// fields follow events_20260330.json verbatim, so the demo uses live business
// vocabulary (Chinese recruitment domain) not generic stand-in data.
//
// Spec mapping (leader → real workflow):
//   "resume uploaded"  → RESUME_DOWNLOADED       (real trigger)
//   "Received the resume" log line               (verbatim, retained)
//   "resume parse"     → RESUME_PROCESSED        (real success emit)
//
// Validates:
//   - WS Workflow agent pattern (this IS one of the 22 real WS agents)
//   - P3 Inngest serve adapter (server/inngest/* → /api/inngest)
//   - Prisma write path (server/db → ao.db AgentActivity)
//   - Event emission (step.sendEvent fans out to subscribers)

import { inngest } from "../../inngest/client";
import { prisma } from "../../db";

// IDs from the canonical workflow JSON.
const AGENT_ID = "9-1";
const AGENT_NAME = "processResume";

// Inbound: events_20260330.json → RESUME_DOWNLOADED.event_data
type ResumeDownloadedData = {
  resume_file_paths: string[];
  job_requisition_id: string;
  channel?: string;
};

export const sampleResumeParserAgent = inngest.createFunction(
  {
    id: AGENT_ID,
    name: "processResume (workflow node 9-1)",
    triggers: [{ event: "RESUME_DOWNLOADED" }],
  },
  async ({ event, step, logger }) => {
    const data = event.data as ResumeDownloadedData;
    const filePath = data.resume_file_paths?.[0] ?? "";
    const jdId = data.job_requisition_id;

    // ── Phase 1 / 3 — Receipt log (leader's required line, verbatim) ──
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
          metadata: JSON.stringify({
            trigger: "RESUME_DOWNLOADED",
            ...data,
          }),
        },
      });
    });

    // ── Phase 2 / 3 — Parse: deterministic stub. No LLM. 250ms. ───────
    // Real production swaps this for parseResumeSkill (Gemini Flash).
    const startedAt = Date.now();
    const parsed = await step.run("parse-resume", async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return mockParse(filePath, jdId);
    });
    const duration_ms = Date.now() - startedAt;

    await step.run("log-parsed", async () => {
      await prisma.agentActivity.create({
        data: {
          nodeId: AGENT_ID,
          agentName: AGENT_NAME,
          type: "agent_complete",
          narrative: `Parse complete in ${duration_ms}ms · ${parsed.skill_tags.length} skill tags · ${parsed.work_experience.length} jobs`,
          metadata: JSON.stringify({
            resume_id: parsed.resume_id,
            candidate_id: parsed.candidate_id,
            duration_ms,
            parsed,
          }),
        },
      });
    });

    // ── Phase 3 / 3 — Publish RESUME_PROCESSED (real success emit) ─────
    await step.sendEvent("emit-resume-processed", {
      name: "RESUME_PROCESSED",
      data: {
        resume_id: parsed.resume_id,
        candidate_id: parsed.candidate_id,
        job_requisition_id: jdId,
        fix_result: "auto_parsed",
        skill_tags: parsed.skill_tags,
        work_experience: parsed.work_experience,
        education_experience: parsed.education_experience,
        parsed_at: new Date().toISOString(),
      },
    });

    await step.run("log-emitted", async () => {
      await prisma.agentActivity.create({
        data: {
          nodeId: AGENT_ID,
          agentName: AGENT_NAME,
          type: "event_emitted",
          narrative: "Published RESUME_PROCESSED",
          metadata: JSON.stringify({
            event_name: "RESUME_PROCESSED",
            resume_id: parsed.resume_id,
            duration_ms,
          }),
        },
      });
    });

    logger.info(
      `[${AGENT_NAME}] published RESUME_PROCESSED — resume_id=${parsed.resume_id} skills=${parsed.skill_tags.length} duration=${duration_ms}ms`,
    );

    return { resume_id: parsed.resume_id, parsed, duration_ms };
  },
);

// ─── Stub parser: deterministic, domain-aligned ──────────────────────
// Routes to a fixture profile based on the file slug so different inputs
// look meaningfully different in the UI, without invoking any LLM.
function mockParse(
  filePath: string,
  jdId: string,
): {
  resume_id: string;
  candidate_id: string;
  name: string;
  mobile: string;
  skill_tags: string[];
  work_experience: { company: string; role: string; years: number }[];
  education_experience: { school: string; degree: string; major: string }[];
} {
  const fileName = filePath.split("/").pop() ?? "unknown.pdf";
  const slug = fileName.replace(/\.[^.]+$/, "").toLowerCase();
  const profile = pickProfile(slug);
  const candidateNumber = Math.abs(hashSlug(slug) % 9000) + 1000;
  const resume_id = `RES-${jdId}-${candidateNumber}`;
  const candidate_id = `CAND-${candidateNumber}`;

  return { resume_id, candidate_id, ...profile };
}

type Profile = {
  name: string;
  mobile: string;
  skill_tags: string[];
  work_experience: { company: string; role: string; years: number }[];
  education_experience: { school: string; degree: string; major: string }[];
};

const PROFILES: Record<string, Profile> = {
  java: {
    name: "王峰",
    mobile: "+86-138-0000-1234",
    skill_tags: ["Java", "Spring Cloud", "MySQL", "分布式架构", "Kafka", "JVM 调优"],
    work_experience: [
      { company: "蚂蚁金服", role: "高级 Java 工程师", years: 4 },
      { company: "美团", role: "Java 后端工程师", years: 2 },
    ],
    education_experience: [
      { school: "浙江大学", degree: "本科", major: "计算机科学与技术" },
    ],
  },
  frontend: {
    name: "李晓红",
    mobile: "+86-139-0000-5678",
    skill_tags: ["React", "TypeScript", "Next.js", "Tailwind CSS", "前端工程化", "Vite"],
    work_experience: [
      { company: "字节跳动", role: "高级前端工程师", years: 3 },
      { company: "腾讯", role: "前端工程师", years: 2 },
    ],
    education_experience: [
      { school: "北京邮电大学", degree: "本科", major: "软件工程" },
    ],
  },
  data: {
    name: "张伟",
    mobile: "+86-137-0000-9012",
    skill_tags: ["Python", "Spark", "Hadoop", "数据建模", "Airflow", "SQL 优化"],
    work_experience: [
      { company: "阿里巴巴", role: "数据科学家", years: 5 },
      { company: "京东", role: "数据分析师", years: 2 },
    ],
    education_experience: [
      { school: "复旦大学", degree: "硕士", major: "统计学" },
    ],
  },
  ue5: {
    name: "刘洋",
    mobile: "+86-136-0000-3456",
    skill_tags: ["Unreal Engine 5", "C++", "技术美术", "Shader", "Houdini"],
    work_experience: [
      { company: "腾讯 IEG", role: "技术美术", years: 4 },
      { company: "网易游戏", role: "高级技术美术", years: 3 },
    ],
    education_experience: [
      { school: "中国传媒大学", degree: "本科", major: "数字媒体技术" },
    ],
  },
};

const DEFAULT_PROFILE: Profile = {
  name: "陈思远",
  mobile: "+86-135-0000-7890",
  skill_tags: ["TypeScript", "Node.js", "事件驱动架构"],
  work_experience: [{ company: "示例公司", role: "高级工程师", years: 5 }],
  education_experience: [{ school: "示例大学", degree: "本科", major: "计算机科学" }],
};

function pickProfile(slug: string): Profile {
  for (const key of Object.keys(PROFILES)) {
    if (slug.includes(key)) return PROFILES[key];
  }
  return DEFAULT_PROFILE;
}

function hashSlug(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
