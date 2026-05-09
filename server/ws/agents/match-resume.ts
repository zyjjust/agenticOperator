// matchResume — workflow node 10.
//
// RoboHire-first; LLM matcher fallback if RoboHire is down.
//
// Trigger: **RESUME_PROCESSED** — directly subscribe to the canonical event
// AO emits in processResume. Inngest fans out the same event to both AO's
// matchResume and partner's resume-processed-ingest in parallel; they don't
// step on each other (different functions, different side effects). Earlier
// versions used an AO-internal AO_MATCH_REQUESTED middle-hop which is now
// retired — it added a hop without benefit.
//
// Multi-JD fan-out: one candidate can match multiple requirements. We resolve
// 1+ JDs (specific job_requisition_id pinned, OR all requirements claimed by
// the recruiter) and emit ONE MATCH_* event per JD-resume pair. Each event's
// payload carries `upload_id` + `job_requisition_id` so RAAS can correlate
// each outcome to a specific candidate × requirement combo.
//
// Inbound:  RESUME_PROCESSED { payload: { ...transport..., parsed: { data: <RoboHire-shape> } } }
// Outbound: MATCH_PASSED_NEED_INTERVIEW | MATCH_PASSED_NO_INTERVIEW | MATCH_FAILED
//           one event per JD; same envelope; payload spreads RoboHire's
//           `/match-resume` response data VERBATIM at top level.
//
// MATCH_* events are AO-internal (partner spec doesn't define them). Shipped
// on the same envelope shape so future raas-side subscribers can pick them
// up without rework.

import { randomUUID } from "node:crypto";
import { inngest } from "../../inngest/client";
import { prisma } from "../../db";
import { isAgenticEnabled } from "../../agentic-state";
import { createAgentLogger, type AgentLogger } from "../../agent-logger";
import {
  isRoboHireConfigured,
  roboHireMatchResume,
  RoboHireError,
  roboHireDataToResumeText,
} from "../../llm/robohire";
import { llmMatchRoboHireShape } from "../../llm/robohire-shape";
import {
  flattenJdPayloadForMatch,
  type JdGeneratedPayload,
} from "../../llm/jd-generator";
import {
  findRequirementById,
  flattenRequirementForMatch,
  isRaasInternalApiConfigured,
  listAllRequirements,
  type RaasRequirement,
} from "../../raas/internal-client";
import { forwardToRaas } from "../../inngest/raas-forward";

const AGENT_ID = "10";
const AGENT_NAME = "matchResume";
const MATCHER_VERSION = "ao+robohire@2026-04-28";

// Inbound RESUME_PROCESSED envelope (same shape processResume emits).
type ResumeProcessedEnvelope = {
  entity_type?: string;
  entity_id?: string | null;
  event_id?: string;
  payload: ResumeProcessedPayload;
  trace?: {
    trace_id?: string | null;
    request_id?: string | null;
    workflow_id?: string | null;
    parent_trace_id?: string | null;
  };
};

type ResumeProcessedPayload = {
  upload_id?: string;
  bucket?: string;
  object_key?: string;
  filename?: string | null;
  etag?: string | null;
  size?: number | null;
  hr_folder?: string | null;
  employee_id?: string | null;
  source_event_name?: string | null;
  received_at?: string;
  source_label?: string | null;
  summary_prefix?: string | null;
  operator_id?: string | null;
  operator_name?: string | null;
  operator_role?: string | null;
  ip_address?: string | null;
  parsed?: { data?: Record<string, unknown> };
  parser_version?: string;
  parsed_at?: string;
  // Real JD link — partner spec doesn't carry this yet, but the canonical
  // recruitment events schema requires it (events_20260423.json
  // RESUME_DOWNLOADED.payload.jd_id is required). We pick it up here
  // when present; otherwise fall back to "latest JD" lookup so the
  // workflow stays unblocked while RAAS adds the field.
  jd_id?: string | null;
  job_requisition_id?: string | null;
  // Bookkeeping IDs propagated through processResume → matchResume
  // so we don't have to hit the local DB cache to call RAAS API.
  claimer_employee_id?: string | null;
  hsm_employee_id?: string | null;
  client_id?: string | null;
};

type Outcome =
  | "MATCH_PASSED_NEED_INTERVIEW"
  | "MATCH_PASSED_NO_INTERVIEW"
  | "MATCH_FAILED";

// Lean MATCH_* payload — only the anchors RAAS needs to correlate the
// match outcome back to a candidate, plus the match result itself.
// Everything else (bucket / object_key / operator_* / etag / size /
// hr_folder / source_label / etc.) is RAAS's own transport metadata —
// it lives in their resume_upload table already, no point echoing it back.
//
// Anchors:
//   upload_id            → RAAS reverses this to candidate_id via resume_upload table
//   job_requisition_id   → which requirement this score is against
//   jd_id                → AO's local JD id (when applicable, else null)
const ECHO_ANCHORS = [
  "upload_id",
  "jd_id",
  "job_requisition_id",
] as const;

// Outcome mapping — temporarily simplified to skip MATCH_FAILED so the
// partner-facing pipeline has a result for every candidate × requirement
// pair. Low-score candidates just go to NEED_INTERVIEW (let partner /
// recruiter make the call). Re-introduce MATCH_FAILED once partner has
// a UI surface for reject decisions.
function scoreToOutcome(score: number): Outcome {
  if (score >= 80) return "MATCH_PASSED_NO_INTERVIEW";
  return "MATCH_PASSED_NEED_INTERVIEW";
}

// JD resolver — fetches the authoritative requirement(s).
//
// Returns an ARRAY because partner doesn't always pin a single
// job_requisition_id in RESUME_DOWNLOADED. Two modes:
//
//   A) payload.job_requisition_id is set → resolve to a single JD
//      (priority: RAAS API → local jd_id cache → local req_id cache → filename hint)
//
//   B) payload.job_requisition_id is null → fan-out: pull ALL active
//      requirements claimed by this recruiter from RAAS Internal API
//      and match the resume against every one. Each requirement
//      produces its own MATCH_* event in the agent body.
//
// Recruiter resolution for mode B:
//   payload.claimer_employee_id → payload.employee_id →
//   payload.operator_id → RAAS_DEFAULT_EMPLOYEE_ID env
//   (partner uses employee_id / operator_id today; claimer_employee_id
//    is the canonical field once they wire it through.)
//
// NO mock JD text. NO filename-only JD synthesis (other than the
// transitional title-hint fallback against the local cache).
type ResolvedJd = {
  ok: boolean;
  jdId?: string;
  requisitionId?: string;
  client?: string;
  title?: string;
  jdText: string;
  source:
    | "raas-internal-api"
    | "by-jd-id"
    | "by-requisition-id"
    | "by-filename-title"
    | "none";
  filenameHint?: { jobTitle?: string; city?: string; salaryRange?: string; candidateName?: string };
  // When source = "raas-internal-api", this holds the full structured payload
  // so downstream / UI can show must_have_skills / nice_to_have_skills /
  // degree_requirement / etc.
  raas?: RaasRequirement;
  // When source = local cache, this holds the structured requisition fields
  // we extracted from the LLM (must_have_skills, work_years, etc.) so the
  // emitted MATCH_* event carries the same structured signals.
  cachedRequisition?: {
    must_have_skills: string[];
    nice_to_have_skills: string[];
    degree_requirement: string;
    education_requirement: string;
    language_requirements: string;
    negative_requirement: string;
    work_years: number;
    expected_level: string;
    interview_mode: string;
  };
};

async function resolveJds(
  payload: ResumeProcessedPayload,
): Promise<ResolvedJd[]> {
  // Tease apart filename for the title hint either way (used as last
  // resort + recorded for diagnostics).
  const filename = payload.filename ?? "";
  const fnMatch = filename.match(/^【(.+?)_(.+?)\s+(.+?)】(.+?)\s+(.+?)\.\w+$/);
  const filenameHint = fnMatch
    ? {
        jobTitle: fnMatch[1],
        city: fnMatch[2],
        salaryRange: fnMatch[3],
        candidateName: fnMatch[4],
      }
    : undefined;

  // ── Mode A: specific job_requisition_id pinned ───────────────────
  // 1. RAAS Internal API by exact requisition_id (preferred).
  if (payload.job_requisition_id && isRaasInternalApiConfigured()) {
    const claimer = await pickClaimerEmployeeId(
      payload.job_requisition_id,
      pickClaimerForList(payload),
    );
    if (claimer) {
      try {
        const r = await findRequirementById({
          jobRequisitionId: payload.job_requisition_id,
          claimerEmployeeId: claimer,
        });
        if (r) {
          return [
            {
              ok: true,
              jdId: payload.jd_id ?? undefined,
              requisitionId: r.job_requisition_id,
              client: r.first_level_department || r.client_id,
              title: r.client_job_title,
              jdText: flattenRequirementForMatch(r),
              source: "raas-internal-api",
              filenameHint,
              raas: r,
            },
          ];
        }
      } catch (e) {
        console.warn(
          `[matchResume] RAAS Internal API lookup failed (${(e as Error).message}); falling back to local cache`,
        );
      }
    }
  }

  // 2. local cache by exact jd_id
  if (payload.jd_id) {
    const jd = await prisma.jobDescription.findUnique({
      where: { id: payload.jd_id },
    });
    if (jd) return [jdRowToResolved(jd, "by-jd-id", filenameHint)];
  }

  // 3. local cache by requisition_id (newest JD)
  if (payload.job_requisition_id) {
    const jd = await prisma.jobDescription.findFirst({
      where: { requisitionId: payload.job_requisition_id },
      orderBy: { createdAt: "desc" },
    });
    if (jd) return [jdRowToResolved(jd, "by-requisition-id", filenameHint)];
  }

  // ── Mode B: no requisition pinned → fan-out across claimer's roster ──
  // Pull all active requirements this recruiter has claimed from RAAS
  // and match the resume against every one with content to score.
  if (!payload.job_requisition_id && isRaasInternalApiConfigured()) {
    const claimer = pickClaimerForList(payload);
    if (claimer) {
      try {
        const all = await listAllRequirements({
          claimerEmployeeId: claimer,
          scope: "claimed",
          status: "recruiting",
          pageSize: 100,
        });
        // Drop skeletal entries — RAAS sometimes returns requirements
        // before HSM has filled in responsibility/requirement; nothing
        // to match against, so don't waste a RoboHire call.
        const matchable = all.filter(hasMatchableContent);
        if (matchable.length > 0) {
          return matchable.map((r) => ({
            ok: true,
            jdId: undefined,
            requisitionId: r.job_requisition_id,
            client: r.first_level_department || r.client_id,
            title: r.client_job_title,
            jdText: flattenRequirementForMatch(r),
            source: "raas-internal-api" as const,
            filenameHint,
            raas: r,
          }));
        }
      } catch (e) {
        console.warn(
          `[matchResume] RAAS roster lookup failed (${(e as Error).message}); falling through to filename-title fallback`,
        );
      }
    }
  }

  // 4. filename title hint — purely transitional, single result.
  if (filenameHint?.jobTitle) {
    const jd = await prisma.jobDescription.findFirst({
      where: { title: { contains: filenameHint.jobTitle } },
      orderBy: { createdAt: "desc" },
    });
    if (jd) return [jdRowToResolved(jd, "by-filename-title", filenameHint)];
  }

  return [{ ok: false, jdText: "", source: "none", filenameHint }];
}

/**
 * Pick the recruiter employee_id to call RAAS API with, when the event
 * doesn't pin a specific job_requisition_id. Order:
 *   1. payload.claimer_employee_id  (canonical, once partner wires it)
 *   2. payload.employee_id          (partner's current field)
 *   3. payload.operator_id          (who triggered the action)
 *   4. RAAS_DEFAULT_EMPLOYEE_ID     (env fallback for testing)
 */
function pickClaimerForList(payload: ResumeProcessedPayload): string | null {
  const candidates = [
    payload.claimer_employee_id,
    payload.employee_id,
    payload.operator_id,
    process.env.RAAS_DEFAULT_EMPLOYEE_ID,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c.trim();
  }
  return null;
}

/** True if requirement has enough text/skills for RoboHire to score against. */
function hasMatchableContent(r: RaasRequirement): boolean {
  const hasResp = !!(r.job_responsibility && r.job_responsibility.trim());
  const hasReq = !!(r.job_requirement && r.job_requirement.trim());
  const hasMustHave = Array.isArray(r.must_have_skills) && r.must_have_skills.length > 0;
  return hasResp || hasReq || hasMustHave;
}

function parseJsonStringArray(s: string | null | undefined): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Resolve the claimer (recruiter) employee_id for a requisition.
 *
 * Priority:
 *   1. event payload `claimer_employee_id` (if upstream propagated it)
 *   2. local JobRequisition.rawPayload cache (raw_input_data.create_by /
 *      sd_owner_id) — populated when createJD ran
 *   3. env `RAAS_DEFAULT_EMPLOYEE_ID` — testing fallback so the integration
 *      can be exercised before partner adds claimer_employee_id to
 *      RESUME_DOWNLOADED.payload
 *
 * Returns null if nothing matched — the caller skips RAAS API and falls
 * through to local-cache JD resolution.
 */
async function pickClaimerEmployeeId(
  requisitionId: string,
  fromPayload: string | null | undefined,
): Promise<string | null> {
  // 1. event payload (preferred — works even with no DB cache)
  if (fromPayload && fromPayload.trim().length > 0) return fromPayload;

  // 2. local cache (createJD stashed REQUIREMENT_LOGGED.payload here)
  try {
    const row = await prisma.jobRequisition.findUnique({
      where: { id: requisitionId },
      select: { rawPayload: true },
    });
    if (row?.rawPayload) {
      const parsed = JSON.parse(row.rawPayload) as {
        raw_input_data?: { create_by?: string; sd_owner_id?: string };
      };
      const fromCache =
        parsed.raw_input_data?.create_by ??
        parsed.raw_input_data?.sd_owner_id;
      if (fromCache) return fromCache;
    }
  } catch {
    /* fall through */
  }

  // 3. env fallback (testing only)
  const envFallback = process.env.RAAS_DEFAULT_EMPLOYEE_ID;
  if (envFallback && envFallback.trim().length > 0) return envFallback;

  return null;
}

function jdRowToResolved(
  jd: {
    id: string;
    requisitionId: string;
    client: string;
    title: string;
    jdContent: string;            // long-form posting_description text
    mustHaveSkills: string | null;
    niceToHaveSkills: string | null;
    degreeRequirement: string | null;
    educationRequirement: string | null;
    languageRequirements: string | null;
    negativeRequirement: string | null;
    workYears: number | null;
    expectedLevel: string | null;
    interviewMode: string | null;
  },
  source: ResolvedJd["source"],
  filenameHint: ResolvedJd["filenameHint"],
): ResolvedJd {
  // Reconstruct a JdGeneratedPayload-shaped record from the DB row so we
  // can call flattenJdPayloadForMatch() like the live emitter does.
  const reconstructed: JdGeneratedPayload = {
    posting_title: jd.title,
    posting_description: jd.jdContent,        // long-form text
    responsibility: "",                        // not cached separately yet
    requirement: "",                           // not cached separately yet
    city: [],                                  // not cached separately
    salary_range: "",                          // not cached separately
    interview_mode: (jd.interviewMode as JdGeneratedPayload["interview_mode"]) ?? "unspecified",
    degree_requirement: jd.degreeRequirement ?? "本科",
    education_requirement: jd.educationRequirement ?? "不限",
    work_years: jd.workYears ?? 0,
    recruitment_type: "unspecified",           // not cached separately
    must_have_skills: parseJsonStringArray(jd.mustHaveSkills),
    nice_to_have_skills: parseJsonStringArray(jd.niceToHaveSkills),
    negative_requirement: jd.negativeRequirement ?? "无",
    language_requirements: jd.languageRequirements ?? "无",
    expected_level: (jd.expectedLevel as JdGeneratedPayload["expected_level"]) ?? "unspecified",
  };

  return {
    ok: true,
    jdId: jd.id,
    requisitionId: jd.requisitionId,
    client: jd.client,
    title: jd.title,
    jdText: flattenJdPayloadForMatch(reconstructed),
    source,
    filenameHint,
    cachedRequisition: {
      must_have_skills: reconstructed.must_have_skills,
      nice_to_have_skills: reconstructed.nice_to_have_skills,
      degree_requirement: reconstructed.degree_requirement,
      education_requirement: reconstructed.education_requirement,
      language_requirements: reconstructed.language_requirements,
      negative_requirement: reconstructed.negative_requirement,
      work_years: reconstructed.work_years,
      expected_level: reconstructed.expected_level,
      interview_mode: reconstructed.interview_mode,
    },
  };
}

export const matchResumeAgent = inngest.createFunction(
  {
    id: AGENT_ID,
    name: "matchResume (workflow node 10)",
    retries: 2,
    // Subscribe directly to RESUME_PROCESSED — Inngest fans out the same
    // event to AO's matchResume and partner's resume-processed-ingest in
    // parallel. They have different side effects (AO scores; partner
    // ingests to its DB) so there's no double-consume hazard.
    triggers: [{ event: "RESUME_PROCESSED" }],
  },
  async ({ event, step, logger }) => {
    const envelope = (event.data ?? {}) as ResumeProcessedEnvelope;
    const payload: ResumeProcessedPayload =
      envelope.payload ?? (envelope as unknown as ResumeProcessedPayload);
    const parsedData = payload.parsed?.data;
    const candidateName = (parsedData as any)?.name ?? "—";
    const filename = payload.filename ?? null;

    // Single logger bound to this agent. Threaded into emitOutcome below
    // so the same instance handles all activity rows for this run.
    const log = createAgentLogger({ agent: AGENT_NAME, nodeId: AGENT_ID });

    // Agentic on/off toggle — same as processResume, short-circuit early.
    const enabled = await step.run("check-agentic-toggle", async () => {
      return await isAgenticEnabled();
    });
    if (!enabled) {
      logger.info(`[${AGENT_NAME}] agentic mode is OFF — skipping`);
      await step.run("log-skipped", () =>
        log.event(
          "event_received",
          `Skipped (agentic OFF) · candidate=${candidateName}`,
          {
            event_name: "RESUME_PROCESSED",
            event_id: envelope.event_id,
            upload_id: payload.upload_id,
            skipped: true,
            reason: "agentic mode disabled",
          },
        ),
      );
      return { skipped: true, reason: "agentic mode disabled" };
    }

    logger.info(
      `[${AGENT_NAME}] received RESUME_PROCESSED — candidate=${candidateName} upload_id=${payload.upload_id ?? "—"}`,
    );

    await step.run("log-received", () =>
      log.event(
        "event_received",
        `Received RESUME_PROCESSED · candidate=${candidateName}`,
        {
          event_name: "RESUME_PROCESSED",
          event_id: envelope.event_id,
          upload_id: payload.upload_id,
          candidate_name: candidateName,
          filename,
        },
      ),
    );

    if (!parsedData) {
      await step.run("log-no-parsed-data", () =>
        log.error("RESUME_PROCESSED missing payload.parsed.data — emitting MATCH_FAILED", {
          payload,
        }),
      );
      return await emitOutcome(
        step,
        log,
        envelope,
        payload,
        null,
        null,
        null,
        "MATCH_FAILED",
        "missing payload.parsed.data",
      );
    }

    // Step 1 — Resolve JDs. Returns 1 (specific req pinned) or N
    // (fan-out across recruiter's full roster).
    const jds = await step.run("resolve-jds", async () => resolveJds(payload));

    // None resolved → emit a single MATCH_FAILED carrying diagnostic context.
    if (jds.length === 1 && !jds[0].ok) {
      const failJd = jds[0];
      const reason =
        `No JD found · jd_id=${payload.jd_id ?? "—"} req=${payload.job_requisition_id ?? "—"} claimer=${pickClaimerForList(payload) ?? "—"} title-hint="${failJd.filenameHint?.jobTitle ?? "—"}" — pass jd_id/job_requisition_id or ensure recruiter has claimed requirements in RAAS`;
      await step.run("log-jd-resolve-failed", () =>
        log.error(reason, {
          jd_id: payload.jd_id,
          job_requisition_id: payload.job_requisition_id,
          claimer: pickClaimerForList(payload),
          filename,
          filename_hint: failJd.filenameHint,
        }),
      );
      return await emitOutcome(
        step,
        log,
        envelope,
        payload,
        failJd,
        null,
        null,
        "MATCH_FAILED",
        reason,
      );
    }

    logger.info(
      `[${AGENT_NAME}] resolved ${jds.length} JD(s) for candidate=${candidateName}`,
    );
    await step.run("log-jds-resolved", () =>
      log.tool(
        jds.length === 1
          ? `Resolved 1 JD · ${jds[0].title ?? jds[0].requisitionId} · source=${jds[0].source}`
          : `Resolved ${jds.length} JDs (fan-out across recruiter roster) · source=${jds[0].source}`,
        {
          count: jds.length,
          jds: jds.map((j) => ({
            source: j.source,
            jd_id: j.jdId,
            job_requisition_id: j.requisitionId,
            client: j.client,
            title: j.title,
          })),
        },
      ),
    );

    // Step 2 — flatten parsed data → resume text once (shared across all JDs).
    const resumeText = await step.run("flatten-resume", async () => {
      return roboHireDataToResumeText(parsedData);
    });

    // Step 3 — RoboHire match per JD, emit one MATCH_* event per JD.
    // Run sequentially so we don't blow up RoboHire's rate limit when the
    // roster is large (16+ requirements is real). Each step.run is its
    // own checkpoint, so a partial failure mid-roster doesn't lose the
    // already-emitted events.
    const summaries: { outcome: Outcome; score: number; requisitionId?: string }[] = [];
    for (const jd of jds) {
      const stepKey = sanitizeStepKey(jd.requisitionId ?? jd.jdId ?? "unknown");
      const match: MatchStepResult = await step.run(`match-${stepKey}`, async (): Promise<MatchStepResult> => {
        const t0 = Date.now();
        if (isRoboHireConfigured()) {
          try {
            const r = await roboHireMatchResume({
              resume: resumeText,
              jd: jd.jdText,
            });
            return {
              data: r.data,
              mode: "robohire",
              modelUsed: "robohire/match-resume",
              requestId: r.requestId,
              savedAs: r.savedAs,
              durationMs: Date.now() - t0,
              matchDurationMs: r.duration_ms,
              fallbackReason: undefined,
            };
          } catch (e) {
            const reason =
              e instanceof RoboHireError
                ? `${e.status}: ${e.message}`
                : (e as Error).message;
            console.warn(
              `[${AGENT_NAME}] RoboHire match failed for ${jd.requisitionId} (${reason}); falling back to LLM matcher`,
            );
            const llm = await llmMatchRoboHireShape(resumeText, jd.jdText, { logger: log });
            return {
              data: { ...llm.match } as unknown as Record<string, unknown>,
              mode: "llm-fallback",
              modelUsed: llm.modelUsed,
              requestId: undefined,
              savedAs: undefined,
              durationMs: Date.now() - t0,
              matchDurationMs: llm.duration_ms,
              fallbackReason: `robohire: ${reason}`,
            };
          }
        }
        const llm = await llmMatchRoboHireShape(resumeText, jd.jdText, { logger: log });
        return {
          data: { ...llm.match } as unknown as Record<string, unknown>,
          mode: "llm-only",
          modelUsed: llm.modelUsed,
          requestId: undefined,
          savedAs: undefined,
          durationMs: Date.now() - t0,
          matchDurationMs: llm.duration_ms,
          fallbackReason: undefined,
        };
      });

      const matchScore = pickScore(match.data);
      const recommendation = pickRecommendation(match.data, matchScore);

      await step.run(`log-match-complete-${stepKey}`, () =>
        log.done(
          `Match · ${jd.title ?? jd.requisitionId} · score=${matchScore} · ${recommendation} · ${match.matchDurationMs}ms · mode=${match.mode}`,
          {
            score: matchScore,
            recommendation,
            duration_ms: match.matchDurationMs,
            mode: match.mode,
            model_used: match.modelUsed,
            request_id: match.requestId,
            fallback_reason: match.fallbackReason,
            jd: jd,
            match: match.data,
          },
        ),
      );

      const outcome = scoreToOutcome(matchScore);
      const result = await emitOutcome(
        step,
        log,
        envelope,
        payload,
        jd,
        match,
        { matchScore, recommendation },
        outcome,
        null,
        stepKey,
      );
      summaries.push({
        outcome: result.outcome as Outcome,
        score: result.score,
        requisitionId: jd.requisitionId,
      });
    }

    return { matched_count: jds.length, summaries };
  },
);

function sanitizeStepKey(s: string): string {
  return s.replace(/[^A-Za-z0-9-]/g, "-").slice(0, 80) || "unknown";
}

type MatchStepResult = {
  data: Record<string, unknown>;
  mode: "robohire" | "llm-only" | "llm-fallback";
  modelUsed: string;
  requestId?: string;
  savedAs?: string;
  durationMs: number;
  matchDurationMs: number;
  fallbackReason?: string;
};

async function emitOutcome(
  step: Parameters<Parameters<typeof inngest.createFunction>[1]>[0]["step"],
  log: AgentLogger,
  envelope: ResumeProcessedEnvelope,
  payload: ResumeProcessedPayload,
  jd: ResolvedJd | null,
  matchResult: MatchStepResult | null,
  scoreInfo: { matchScore: number; recommendation: string } | null,
  outcome: Outcome,
  reason: string | null,
  stepKey?: string,
) {
  const suffix = stepKey ? `-${stepKey}` : "";

  // ── Final RAAS payload contract ─────────────────────────────────────
  // Per partner spec (match-result-ingest correlation), payload must carry:
  //   1. upload_id          — RAAS reverse-looks up candidate_id from this
  //   2. job_requisition_id — which requirement this match scored against
  //   3. matchScore         — flat number 0-100, normalized from RoboHire
  //   4. recommendation     — flat enum string, normalized from RoboHire
  // Plus the full RoboHire `/match-resume` response data spread at top level
  // for richer downstream consumption (overallFit, mustHaveAnalysis, etc.).
  //
  // Event name (MATCH_PASSED_NO_INTERVIEW / MATCH_PASSED_NEED_INTERVIEW /
  // MATCH_FAILED) carries the outcome — no need to echo it inside payload.
  const outboundPayload: Record<string, unknown> = {
    upload_id: (payload as Record<string, unknown>).upload_id ?? null,
    job_requisition_id:
      jd?.requisitionId ?? (payload as Record<string, unknown>).job_requisition_id ?? null,
  };

  // Spread RoboHire response data fields (overallMatchScore, overallFit,
  // matchAnalysis, mustHaveAnalysis, niceToHaveAnalysis, etc.).
  if (matchResult?.data && typeof matchResult.data === "object") {
    Object.assign(outboundPayload, matchResult.data);
  }

  // Flat normalized fields — set AFTER the spread so they always win,
  // regardless of what RoboHire's nested shape happened to put there.
  // RAAS reads `matchScore` and `recommendation` directly without traversing
  // RoboHire's overallMatchScore/overallFit nesting.
  outboundPayload.matchScore = scoreInfo?.matchScore ?? null;
  outboundPayload.recommendation = scoreInfo?.recommendation ?? null;

  const outboundEnvelope = {
    entity_type: "Candidate",
    entity_id: envelope.entity_id ?? null,
    event_id: randomUUID(),
    payload: outboundPayload,
    trace: envelope.trace ?? {
      trace_id: null,
      request_id: null,
      workflow_id: null,
      parent_trace_id: null,
    },
  };

  // Local emit — lands in our own Inngest dev (localhost:8288).
  await step.sendEvent(`emit-match-outcome${suffix}`, {
    name: outcome,
    data: outboundEnvelope,
  });

  // Outbound forward to partner's Inngest. step.run wrap gives retry
  // idempotency — already-forwarded events are cached, won't double-emit.
  await step.run(`forward-to-raas${suffix}`, async () => {
    return forwardToRaas(outcome, outboundEnvelope);
  });

  await step.run(`log-emitted${suffix}`, () =>
    log.event(
      "event_emitted",
      scoreInfo
        ? `Published ${outcome} · score=${scoreInfo.matchScore} · ${scoreInfo.recommendation}`
        : `Published ${outcome} · ${reason ?? "(no match data)"}`,
      {
        event_name: outcome,
        event_id: outboundEnvelope.event_id,
        upload_id: payload.upload_id,
        score: scoreInfo?.matchScore,
        recommendation: scoreInfo?.recommendation,
        reason,
        matcher_request_id: matchResult?.requestId,
      },
    ),
  );

  return { outcome, score: scoreInfo?.matchScore ?? 0 };
}

// RoboHire's live response varies from their public docs. We probe both
// shapes:
//   - Docs (§3 example):       data.matchScore, data.recommendation
//   - Live (richer schema):    data.overallMatchScore.score,
//                              data.overallFit.verdict / .hiringRecommendation
function pickScore(data: Record<string, unknown>): number {
  const d = data as any;
  const candidates: unknown[] = [
    d?.matchScore,
    d?.overallMatchScore?.score,
    d?.overallMatchScore,
    d?.skillMatchScore?.score,
  ];
  for (const v of candidates) {
    if (typeof v === "number" && Number.isFinite(v)) {
      return Math.max(0, Math.min(100, Math.round(v)));
    }
  }
  return 0;
}

function pickRecommendation(data: Record<string, unknown>, score: number): string {
  const d = data as any;
  // Docs shape uses uppercase enum strings — normalize live "Strong Match" / "Strongly Recommend" too.
  const raw =
    (typeof d?.recommendation === "string" && d.recommendation) ||
    (typeof d?.overallFit?.verdict === "string" && d.overallFit.verdict) ||
    (typeof d?.overallFit?.hiringRecommendation === "string" && d.overallFit.hiringRecommendation);
  if (typeof raw === "string" && raw.length > 0) {
    const norm = raw.toUpperCase().replace(/\s+/g, "_");
    // Map common live phrasings onto the canonical enum.
    if (norm.includes("STRONG")) return "STRONG_MATCH";
    if (norm.includes("GOOD") || norm.includes("RECOMMEND")) return "GOOD_MATCH";
    if (norm.includes("PARTIAL") || norm.includes("WEAK") || norm.includes("CONSIDER")) {
      return norm.includes("WEAK") ? "WEAK_MATCH" : "PARTIAL_MATCH";
    }
    return norm;
  }
  if (score >= 80) return "STRONG_MATCH";
  if (score >= 60) return "GOOD_MATCH";
  if (score >= 40) return "PARTIAL_MATCH";
  return "WEAK_MATCH";
}
