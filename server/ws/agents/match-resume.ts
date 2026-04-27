// matchResume — workflow node 10, real implementation per spec §6.
//
// Input event:  RESUME_PROCESSED  (emitted by processResume / RAAS pipeline)
// Output event: MATCH_PASSED_NEED_INTERVIEW | MATCH_PASSED_NO_INTERVIEW | MATCH_FAILED
//
// Steps (spec §6.2):
//   1. infer-jd-from-filename — POC fallback: pull jobTitle/city/salary from
//      filename pattern `【职位_城市 薪资】候选人 工作年限.pdf`
//      (production should pass jd_id; we don't have one yet)
//   2. flatten-resume-text    — turn the 4-object payload into plain text
//                               for RoboHire /match-resume
//   3. robohire-match         — POST /api/v1/match-resume
//   4. decide-outcome         — score → 3 outcomes per §6.3 thresholds
//   5. emit                   — step.sendEvent(outcome, MatchEventData)

import { inngest } from "../../inngest/client";
import { prisma } from "../../db";
import {
  flattenParsedResumeForMatch,
  isRoboHireConfigured,
  roboHireMatchResume,
  RoboHireError,
} from "../../llm/robohire";
import type { ParsedResume } from "../../llm/resume-extractor";

const AGENT_ID = "10";
const AGENT_NAME = "matchResume";

// Spec §3.2 RESUME_PROCESSED shape (subset we read)
type ResumeProcessedData = {
  bucket?: string;
  objectKey?: string;
  filename?: string | null;
  etag?: string | null;
  job_requisition_id?: string | null;
  candidate?: ParsedResume["candidate"];
  candidate_expectation?: ParsedResume["candidate_expectation"];
  resume?: ParsedResume["resume"];
  runtime?: ParsedResume["runtime"];
};

type Outcome =
  | "MATCH_PASSED_NEED_INTERVIEW"
  | "MATCH_PASSED_NO_INTERVIEW"
  | "MATCH_FAILED";

// Spec §6.3 thresholds
function scoreToOutcome(score: number): Outcome {
  if (score >= 80) return "MATCH_PASSED_NO_INTERVIEW";
  if (score >= 60) return "MATCH_PASSED_NEED_INTERVIEW";
  return "MATCH_FAILED";
}

// Spec §6.1 filename pattern fallback for JD inference.
// Pattern: `【jobTitle_city salaryRange】candidateName yearsExp.pdf`
function inferJdFromFilename(
  filename: string | null,
): {
  ok: boolean;
  jobTitle?: string;
  city?: string;
  salaryRange?: string;
  candidateName?: string;
  yearsExp?: string;
  jdText: string;
} {
  if (!filename) return { ok: false, jdText: "" };
  const m = filename.match(/^【(.+?)_(.+?)\s+(.+?)】(.+?)\s+(.+?)\.\w+$/);
  if (!m) return { ok: false, jdText: "" };
  const [, jobTitle, city, salaryRange, candidateName, yearsExp] = m;
  return {
    ok: true,
    jobTitle,
    city,
    salaryRange,
    candidateName,
    yearsExp,
    jdText: [
      `职位: ${jobTitle}`,
      `工作地点: ${city}`,
      `薪资范围: ${salaryRange}`,
      `(PoC: 此 JD 由文件名推断；待 RAAS 提供 jd_id 接口替换)`,
    ].join("\n"),
  };
}

export const matchResumeAgent = inngest.createFunction(
  {
    id: AGENT_ID,
    name: "matchResume (workflow node 10)",
    retries: 2,
    triggers: [{ event: "RESUME_PROCESSED" }],
  },
  async ({ event, step, logger }) => {
    const data = event.data as ResumeProcessedData;
    const candidateName = data.candidate?.name ?? "—";
    const filename = data.filename ?? null;

    // ── Step 0 — Receipt log ──
    logger.info(
      `[${AGENT_NAME}] received RESUME_PROCESSED — candidate=${candidateName} jd_id=${data.job_requisition_id ?? "none"}`,
    );
    await step.run("log-received", async () => {
      await prisma.agentActivity.create({
        data: {
          nodeId: AGENT_ID,
          agentName: AGENT_NAME,
          type: "event_received",
          narrative: "Received RESUME_PROCESSED",
          metadata: JSON.stringify({
            trigger: "RESUME_PROCESSED",
            candidate_name: candidateName,
            job_requisition_id: data.job_requisition_id,
            filename,
          }),
        },
      });
    });

    // ── Step 1 — Infer JD ──
    const inferredJd = await step.run("infer-jd-from-filename", async () => {
      return inferJdFromFilename(filename);
    });

    if (!inferredJd.ok) {
      // Spec §6.1: emit MATCH_FAILED with reason early.
      await step.run("log-jd-inference-failed", async () => {
        await prisma.agentActivity.create({
          data: {
            nodeId: AGENT_ID,
            agentName: AGENT_NAME,
            type: "agent_error",
            narrative: `JD inference failed for filename=${filename ?? "—"}; emitting MATCH_FAILED`,
            metadata: JSON.stringify({ filename }),
          },
        });
      });
      const outcome: Outcome = "MATCH_FAILED";
      await step.sendEvent("emit-match-failed-no-jd", {
        name: outcome,
        data: buildMatchPayload(data, null, outcome, "JD inference failed"),
      });
      await step.run("log-emitted-no-jd", async () => {
        await prisma.agentActivity.create({
          data: {
            nodeId: AGENT_ID,
            agentName: AGENT_NAME,
            type: "event_emitted",
            narrative: `Published ${outcome} (reason: JD inference failed)`,
            metadata: JSON.stringify({
              event_name: outcome,
              reason: "JD inference failed",
            }),
          },
        });
      });
      return { outcome, reason: "JD inference failed" };
    }

    // ── Step 2 — Flatten resume → text for /match-resume ──
    const resumeText = await step.run("flatten-resume", async () => {
      if (!data.candidate || !data.resume) {
        throw new Error("RESUME_PROCESSED missing candidate or resume objects");
      }
      return flattenParsedResumeForMatch({
        candidate: data.candidate,
        candidate_expectation:
          data.candidate_expectation ?? emptyExpectation(),
        resume: data.resume,
        runtime: data.runtime ?? { current_title: null, current_company: null },
      });
    });

    // ── Step 3 — RoboHire match (or stub) ──
    type MatchOutcome = {
      score: number;
      recommendation: string;
      summary: string;
      technicalSkills: { score: number; matchedSkills: string[]; missingSkills: string[] };
      experienceLevel: { score: number; required: string; candidate: string; assessment: string };
      mustHave: { extracted: { skills: string[]; experience: string[] }; matched: string[] };
      niceToHave: { extracted: { skills: string[]; certifications: string[] }; matched: string[] };
      requestId: string;
      duration_ms: number;
      mode: "robohire" | "stub";
      fallback_reason?: string;
    };

    const matchResult: MatchOutcome = await step.run("robohire-match", async () => {
      if (isRoboHireConfigured()) {
        try {
          const r = await roboHireMatchResume({
            resumeText,
            jdText: inferredJd.jdText,
          });
          return { ...r, mode: "robohire" as const };
        } catch (e) {
          const reason =
            e instanceof RoboHireError
              ? `${e.status}: ${e.message}`
              : (e as Error).message;
          console.warn(`[${AGENT_NAME}] RoboHire match failed (${reason}); using stub score`);
          return {
            ...stubMatch(data, inferredJd),
            fallback_reason: `robohire: ${reason}`,
          };
        }
      }
      return stubMatch(data, inferredJd);
    });

    await step.run("log-match-complete", async () => {
      await prisma.agentActivity.create({
        data: {
          nodeId: AGENT_ID,
          agentName: AGENT_NAME,
          type: "agent_complete",
          narrative: `Match complete in ${matchResult.duration_ms}ms · score=${matchResult.score} · ${matchResult.recommendation} · mode=${matchResult.mode}`,
          metadata: JSON.stringify({
            score: matchResult.score,
            recommendation: matchResult.recommendation,
            duration_ms: matchResult.duration_ms,
            requestId: matchResult.requestId,
            mode: matchResult.mode,
            fallback_reason: matchResult.fallback_reason,
            jd: inferredJd,
            match: matchResult,
          }),
        },
      });
    });

    // ── Step 4 — Decide outcome ──
    const outcome = scoreToOutcome(matchResult.score);

    // ── Step 5 — Emit ──
    await step.sendEvent("emit-match", {
      name: outcome,
      data: buildMatchPayload(data, { ...inferredJd, ...matchResult }, outcome),
    });

    await step.run("log-emitted", async () => {
      await prisma.agentActivity.create({
        data: {
          nodeId: AGENT_ID,
          agentName: AGENT_NAME,
          type: "event_emitted",
          narrative: `Published ${outcome} · score=${matchResult.score} · ${matchResult.recommendation}`,
          metadata: JSON.stringify({
            event_name: outcome,
            score: matchResult.score,
            recommendation: matchResult.recommendation,
            requestId: matchResult.requestId,
          }),
        },
      });
    });

    logger.info(
      `[${AGENT_NAME}] published ${outcome} — candidate=${candidateName} score=${matchResult.score} mode=${matchResult.mode}`,
    );

    return { outcome, score: matchResult.score, candidateName };
  },
);

function emptyExpectation(): ParsedResume["candidate_expectation"] {
  return {
    expected_salary_monthly_min: null,
    expected_salary_monthly_max: null,
    expected_cities: [],
    expected_industries: [],
    expected_roles: [],
    expected_work_mode: null,
  };
}

// Deterministic match heuristic — used when RoboHire isn't configured.
// Score blends: skill overlap, experience years, location match.
function stubMatch(
  data: ResumeProcessedData,
  jd: ReturnType<typeof inferJdFromFilename>,
): {
  score: number;
  recommendation: string;
  summary: string;
  technicalSkills: { score: number; matchedSkills: string[]; missingSkills: string[] };
  experienceLevel: { score: number; required: string; candidate: string; assessment: string };
  mustHave: { extracted: { skills: string[]; experience: string[] }; matched: string[] };
  niceToHave: { extracted: { skills: string[]; certifications: string[] }; matched: string[] };
  requestId: string;
  duration_ms: number;
  mode: "stub";
} {
  const jobTitle = (jd.jobTitle ?? "").toLowerCase();
  const city = jd.city ?? "";
  const skills = data.candidate?.skills ?? [];
  const candidateLocation = data.candidate?.current_location ?? "";

  // Skill overlap with title keywords
  let titleHits = 0;
  for (const s of skills) {
    if (jobTitle.includes(s.toLowerCase())) titleHits++;
  }
  const titleSignal = jobTitle ? Math.min(40, titleHits * 12) : 20;

  // Location match
  const locationSignal = city && candidateLocation && candidateLocation.includes(city) ? 20 : 5;

  // Experience signal
  const yrs = data.candidate?.work_years ?? 0;
  const expSignal = Math.min(40, yrs * 4);

  const score = Math.min(100, titleSignal + locationSignal + expSignal);
  const recommendation =
    score >= 80
      ? "STRONG_MATCH"
      : score >= 60
        ? "GOOD_MATCH"
        : score >= 40
          ? "PARTIAL_MATCH"
          : "WEAK_MATCH";

  return {
    score,
    recommendation,
    summary: `Stub match: title hits=${titleHits}, location=${locationSignal > 5 ? "yes" : "no"}, years=${yrs}`,
    technicalSkills: {
      score: titleSignal,
      matchedSkills: skills.slice(0, titleHits),
      missingSkills: [],
    },
    experienceLevel: {
      score: expSignal,
      required: jobTitle.includes("高级") ? "5+ years" : "2+ years",
      candidate: `${yrs} years`,
      assessment:
        yrs >= 5 ? "senior" : yrs >= 2 ? "mid" : "junior",
    },
    mustHave: { extracted: { skills: [], experience: [] }, matched: skills.slice(0, 3) },
    niceToHave: { extracted: { skills: [], certifications: [] }, matched: [] },
    requestId: "stub",
    duration_ms: 1,
    mode: "stub",
  };
}

function buildMatchPayload(
  source: ResumeProcessedData,
  enriched:
    | (ReturnType<typeof inferJdFromFilename> & {
        score: number;
        recommendation: string;
        summary: string;
        technicalSkills: any;
        experienceLevel: any;
        mustHave: any;
        niceToHave: any;
        requestId: string;
      })
    | null,
  outcome: Outcome,
  reason?: string,
) {
  const candidate = source.candidate ?? {
    name: null,
    mobile: null,
    email: null,
  };
  return {
    bucket: source.bucket,
    objectKey: source.objectKey,
    filename: source.filename,
    etag: source.etag ?? null,

    candidate_ref: {
      name: candidate.name,
      mobile: candidate.mobile,
      email: candidate.email,
    },

    jd_source: "filename-inferred" as const,
    jd_text: enriched?.jdText ?? "",
    jd_id: source.job_requisition_id ?? null,

    match: enriched
      ? {
          score: enriched.score,
          recommendation: enriched.recommendation,
          summary: enriched.summary,
          technicalSkills: enriched.technicalSkills,
          experienceLevel: enriched.experienceLevel,
          mustHave: enriched.mustHave,
          niceToHave: enriched.niceToHave,
        }
      : null,

    outcome,
    reason: reason ?? null,
    matchedAt: new Date().toISOString(),
    robohireRequestId: enriched?.requestId ?? null,
  };
}
