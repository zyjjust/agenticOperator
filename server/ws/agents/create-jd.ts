// createJD — workflow node 4.
//
// Spec source:
//   - Action_and_Event_Manager/data/workflow_20260330.json node "[4] createJD"
//   - events_20260423.json schemas for REQUIREMENT_LOGGED + JD_GENERATED
//   - REAL RAAS payload sample (the canonical shape) — see below
//
// Real RAAS REQUIREMENT_LOGGED.payload shape:
//   {
//     client_id: uuid,
//     is_urgent: bool,
//     raw_input_data: { ...28 form fields flat... },   ← actual recruitment form
//     requirement_id: "JRQ-<uuid>-<client_job_id>",
//     source_channel: "dashboard_manual" | ...
//   }
//   raw_input_data fields used by createJD:
//     client_job_title, client_job_type, recruitment_type, expected_level,
//     city, headcount, salary_range (string "14k-15k"),
//     priority, deadline, start_date,
//     first_interview_format, first_interviewer_name,
//     final_interview_format, final_interviewer_name,
//     job_responsibility, job_requirement,
//     sd_org_name, hsm_employee_id, is_exclusive
//
// Trigger:  REQUIREMENT_LOGGED   (RAAS Web Console form submit, or
//                                 our /api/test/trigger-requirement)
//           CLARIFICATION_READY  (downstream of analyzeRequirement)
//           JD_REJECTED          (re-generation after human rejection)
// Output:   JD_GENERATED         (carries jd_id + jd_content for jdReview)
//
// Honors the agentic on/off toggle.

import { randomUUID } from "node:crypto";
import { inngest } from "../../inngest/client";
import { prisma } from "../../db";
import { isAgenticEnabled } from "../../agentic-state";
import { forwardToRaas } from "../../inngest/raas-forward";
import {
  llmGenerateJd,
  parseSalaryRangeChinese,
  type JdGenInput,
} from "../../llm/jd-generator";

const AGENT_ID = "4";
const AGENT_NAME = "createJD";
const GENERATOR_VERSION = "ao-llm@2026-04-28";

// Real RAAS shape — flat form fields under raw_input_data.
type RaasRequirementPayload = {
  client_id?: string;
  is_urgent?: boolean;
  requirement_id?: string;
  source_channel?: string | null;
  raw_input_data?: {
    job_requisition_id?: string;
    client_job_id?: string;
    client_job_title?: string;       // 岗位名称
    client_job_type?: string;        // 岗位类型 (e.g. "前端")
    client_id?: string;
    client_department_id?: string;
    csi_department_id?: string;
    sd_org_name?: string;            // 客户部门名 (人话)
    sd_owner_id?: string;
    hsm_employee_id?: string | null;
    hro_service_contract_id?: string;
    standard_job_role_id?: string;

    city?: string;
    city_id?: string;
    recruitment_type?: string;       // 社会全职 / 实习 / 校招
    expected_level?: string;         // 中3-高1
    priority?: string;               // 高 / 中 / 低
    is_exclusive?: boolean;
    require_foreigner?: boolean;
    headcount?: number;
    number_of_competitors?: number | null;
    salary_range?: string;           // "14k-15k" string

    deadline?: string;               // YYYY-MM-DD
    start_date?: string;
    client_published_at?: string;

    first_interview_format?: string;
    first_interviewer_name?: string;
    final_interview_format?: string;
    final_interviewer_name?: string;

    job_responsibility?: string;     // 原始岗位职责
    job_requirement?: string;        // 原始任职要求
    create_by?: string;
  };

  // Legacy/test shape — kept for back-compat with the older test trigger.
  requisitions?: Array<{
    requisition_id: string;
    title: string;
    client?: string;
    city?: string | null;
    headcount?: number | null;
    salary_range_min?: number | null;
    salary_range_max?: number | null;
    responsibilities?: string | null;
    requirements?: string | null;
    nice_to_haves?: string | null;
  }>;
  client?: string;
  source?: string;
};

type RequirementLoggedEnvelope = {
  entity_type?: string;
  entity_id?: string | null;
  event_id?: string;
  payload: RaasRequirementPayload;
  trace?: Record<string, unknown>;
  source_action?: string | null;
};

// Normalized form passed to the LLM + DB. Decoupled from the wire shape
// so we can support both RAAS-real and legacy-test envelopes.
type Normalized = {
  requisition_id: string;
  client: string;
  title: string;
  jobType: string | null;
  recruitmentType: string | null;
  expectedLevel: string | null;
  city: string | null;
  headcount: number | null;
  salaryRangeMin: number | null;
  salaryRangeMax: number | null;
  salaryRangeRaw: string | null;
  isUrgent: boolean;
  isExclusive: boolean;
  priority: string | null;
  deadline: string | null;
  startDate: string | null;
  firstInterviewFormat: string | null;
  firstInterviewerName: string | null;
  finalInterviewFormat: string | null;
  finalInterviewerName: string | null;
  responsibilities: string | null;
  requirements: string | null;
  niceToHaves: string | null;
  // ── Bookkeeping for downstream events ──
  // Propagated to JD_GENERATED + JD_APPROVED so downstream agents
  // (RAAS jd-generated fn, AO matchResume) can call the RAAS Internal
  // API without going through our local DB cache.
  claimerEmployeeId: string | null;       // raw_input_data.create_by 优先
  hsmEmployeeId: string | null;           // raw_input_data.hsm_employee_id (assigned 招聘专员)
  clientId: string | null;                // raw_input_data.client_id
  clientJobId: string | null;             // raw_input_data.client_job_id
};

export const createJdAgent = inngest.createFunction(
  {
    id: AGENT_ID,
    name: "createJD (workflow node 4)",
    retries: 1,
    triggers: [
      { event: "REQUIREMENT_LOGGED" },
      { event: "CLARIFICATION_READY" },
      { event: "JD_REJECTED" },
    ],
  },
  async ({ event, step, logger }) => {
    const envelope = (event.data ?? {}) as RequirementLoggedEnvelope;
    const payload = envelope.payload ?? (envelope as unknown as RaasRequirementPayload);

    // ── Agentic toggle ──
    const enabled = await step.run("check-agentic-toggle", async () => isAgenticEnabled());
    if (!enabled) {
      logger.info(`[${AGENT_NAME}] agentic OFF — skipping`);
      await step.run("log-skipped", async () => {
        await prisma.agentActivity.create({
          data: {
            nodeId: AGENT_ID,
            agentName: AGENT_NAME,
            type: "event_received",
            narrative: `Skipped (agentic OFF) · ${event.name}`,
            metadata: JSON.stringify({
              event_name: event.name,
              event_id: envelope.event_id,
              entity_id: envelope.entity_id,
              skipped: true,
              reason: "agentic mode disabled",
            }),
          },
        });
      });
      return { skipped: true };
    }

    // Normalize the wire payload (RAAS real OR legacy test) → array of
    // normalized requirements. Usually 1 entry.
    const normalized = normalizeRequirements(envelope, payload);
    if (normalized.length === 0) {
      await step.run("log-no-requisition", async () => {
        await prisma.agentActivity.create({
          data: {
            nodeId: AGENT_ID,
            agentName: AGENT_NAME,
            type: "agent_error",
            narrative: `No requirement found in ${event.name} payload`,
            metadata: JSON.stringify({ payload }),
          },
        });
      });
      throw new Error(
        `${event.name} has no recognizable requirement (need payload.raw_input_data with client_job_title, OR payload.requisitions[], OR payload.requisition_id+title)`,
      );
    }

    const results: Array<{ jd_id: string; requisition_id: string; title: string }> = [];

    for (const req of normalized) {
      logger.info(
        `[${AGENT_NAME}] generating JD for requisition=${req.requisition_id} title="${req.title}"`,
      );

      await step.run(`log-received-${req.requisition_id}`, async () => {
        await prisma.agentActivity.create({
          data: {
            nodeId: AGENT_ID,
            agentName: AGENT_NAME,
            type: "event_received",
            narrative: `createJD invoked · requisition=${req.requisition_id} · title="${req.title}" · ${req.city ?? "—"} · ${req.salaryRangeRaw ?? "—"}`,
            metadata: JSON.stringify({
              event_name: event.name,
              event_id: envelope.event_id,
              entity_id: envelope.entity_id,
              requisition_id: req.requisition_id,
              client: req.client,
              title: req.title,
              normalized: req,
            }),
          },
        });
      });

      // Persist requisition (idempotent upsert) + LLM call atomically.
      const out = await step.run(`generate-${req.requisition_id}`, async () => {
        const t0 = Date.now();

        await prisma.jobRequisition.upsert({
          where: { id: req.requisition_id },
          create: {
            id: req.requisition_id,
            client: req.client,
            title: req.title,
            city: req.city,
            headcount: req.headcount,
            salaryRangeMin: req.salaryRangeMin,
            salaryRangeMax: req.salaryRangeMax,
            responsibilities: req.responsibilities,
            requirements: req.requirements,
            niceToHaves: req.niceToHaves,
            source: payload.source_channel ?? payload.source ?? "manual",
            status: "clarified",
            rawPayload: JSON.stringify(payload),
          },
          update: {
            title: req.title,
            city: req.city ?? undefined,
            headcount: req.headcount ?? undefined,
            salaryRangeMin: req.salaryRangeMin ?? undefined,
            salaryRangeMax: req.salaryRangeMax ?? undefined,
            responsibilities: req.responsibilities ?? undefined,
            requirements: req.requirements ?? undefined,
            niceToHaves: req.niceToHaves ?? undefined,
            status: "clarified",
          },
        });

        const llm = await llmGenerateJd({
          client: req.client,
          title: req.title,
          jobType: req.jobType,
          recruitmentType: req.recruitmentType,
          expectedLevel: req.expectedLevel,
          city: req.city,
          headcount: req.headcount,
          salaryRangeMin: req.salaryRangeMin,
          salaryRangeMax: req.salaryRangeMax,
          isUrgent: req.isUrgent,
          isExclusive: req.isExclusive,
          priority: req.priority,
          deadline: req.deadline,
          startDate: req.startDate,
          firstInterviewFormat: req.firstInterviewFormat,
          finalInterviewFormat: req.finalInterviewFormat,
          responsibilities: req.responsibilities,
          requirements: req.requirements,
          niceToHaves: req.niceToHaves,
        } satisfies JdGenInput);

        const jdId = `jd_${randomUUID().slice(0, 8)}_${Date.now().toString(36)}`;

        await prisma.jobDescription.create({
          data: {
            id: jdId,
            requisitionId: req.requisition_id,
            client: req.client,
            title: llm.payload.posting_title,
            jdContent: llm.payload.posting_description,  // long-form text
            responsibilities: null,
            requirements: null,
            niceToHaves: null,
            searchKeywords: llm.searchKeywords.join(", "),
            qualityScore: llm.qualityScore,
            qualitySuggestions: JSON.stringify(llm.qualitySuggestions),
            marketCompetitiveness: llm.marketCompetitiveness,

            // Structured matching signals (cached for matchResume to use
            // when RAAS Internal API isn't reachable).
            mustHaveSkills: JSON.stringify(llm.payload.must_have_skills),
            niceToHaveSkills: JSON.stringify(llm.payload.nice_to_have_skills),
            degreeRequirement: llm.payload.degree_requirement,
            educationRequirement: llm.payload.education_requirement,
            languageRequirements: llm.payload.language_requirements,
            negativeRequirement: llm.payload.negative_requirement,
            workYears: llm.payload.work_years,
            expectedLevel: llm.payload.expected_level,
            interviewMode: llm.payload.interview_mode,

            status: "ready",
            generatorMode: "llm",
            generatorModel: llm.modelUsed,
            generatorDurationMs: llm.durationMs,
          },
        });

        await prisma.jobRequisition.update({
          where: { id: req.requisition_id },
          data: { status: "jd_ready" },
        });

        return {
          jdId,
          requisitionId: req.requisition_id,
          client: req.client,
          jdPayload: llm.payload,             // ← partner-shape JD_GENERATED payload
          searchKeywords: llm.searchKeywords,
          qualityScore: llm.qualityScore,
          qualitySuggestions: llm.qualitySuggestions,
          marketCompetitiveness: llm.marketCompetitiveness,
          modelUsed: llm.modelUsed,
          durationMs: Date.now() - t0,
          llmDurationMs: llm.durationMs,
          // Bookkeeping IDs to propagate downstream.
          claimerEmployeeId: req.claimerEmployeeId,
          hsmEmployeeId: req.hsmEmployeeId,
          clientId: req.clientId,
          clientJobId: req.clientJobId,
        };
      });

      await step.run(`log-generated-${req.requisition_id}`, async () => {
        await prisma.agentActivity.create({
          data: {
            nodeId: AGENT_ID,
            agentName: AGENT_NAME,
            type: "agent_complete",
            narrative: `JD generated in ${out.durationMs}ms · jd_id=${out.jdId} · quality=${out.qualityScore} · ${out.marketCompetitiveness} 竞争力 · must=[${out.jdPayload.must_have_skills.slice(0, 4).join(", ")}${out.jdPayload.must_have_skills.length > 4 ? "…" : ""}] · model=${out.modelUsed}`,
            metadata: JSON.stringify({
              jd_id: out.jdId,
              requisition_id: out.requisitionId,
              quality_score: out.qualityScore,
              quality_suggestions: out.qualitySuggestions,
              market_competitiveness: out.marketCompetitiveness,
              duration_ms: out.durationMs,
              llm_duration_ms: out.llmDurationMs,
              model_used: out.modelUsed,
              jd_payload: out.jdPayload,
            }),
          },
        });
      });

      // ── JD_GENERATED — single event, partner-spec flat shape (2026-04-28) ──
      const outboundEnvelope = {
        entity_type: "JobDescription",
        entity_id: out.jdId,
        event_id: randomUUID(),
        payload: {
          // ── Spec required fields ──
          job_requisition_id:    out.requisitionId,
          client_id:             out.clientId,
          posting_title:         out.jdPayload.posting_title,
          posting_description:   out.jdPayload.posting_description,
          // ── 岗位发布信息：单独字段，给发布渠道直接渲染 ──
          responsibility:        out.jdPayload.responsibility,
          requirement:           out.jdPayload.requirement,
          city:                  out.jdPayload.city,
          salary_range:          out.jdPayload.salary_range,
          interview_mode:        out.jdPayload.interview_mode,
          degree_requirement:    out.jdPayload.degree_requirement,
          education_requirement: out.jdPayload.education_requirement,
          work_years:            out.jdPayload.work_years,
          recruitment_type:      out.jdPayload.recruitment_type,
          must_have_skills:      out.jdPayload.must_have_skills,
          nice_to_have_skills:   out.jdPayload.nice_to_have_skills,
          negative_requirement:  out.jdPayload.negative_requirement,
          language_requirements: out.jdPayload.language_requirements,
          expected_level:        out.jdPayload.expected_level,

          // ── Bookkeeping IDs (helps RAAS link to recruiter / client_job) ──
          jd_id:                 out.jdId,
          claimer_employee_id:   out.claimerEmployeeId,
          hsm_employee_id:       out.hsmEmployeeId,
          client_job_id:         out.clientJobId,

          // ── Diagnostics (RAAS may ignore) ──
          search_keywords:       out.searchKeywords,
          quality_score:         out.qualityScore,
          quality_suggestions:   out.qualitySuggestions,
          market_competitiveness:out.marketCompetitiveness,
          generator_version:     GENERATOR_VERSION,
          generator_model:       out.modelUsed,
          generated_at:          new Date().toISOString(),
        },
        trace: envelope.trace ?? {
          trace_id: null,
          request_id: null,
          workflow_id: null,
          parent_trace_id: null,
        },
      };

      await step.sendEvent(`emit-jd-generated-${out.requisitionId}`, {
        name: "JD_GENERATED",
        data: outboundEnvelope,
      });

      // Outbound forward to partner Inngest — partner subscribes to
      // JD_GENERATED on their own Inngest instance for jd-generated-sync.
      await step.run(`forward-to-raas-${out.requisitionId}`, async () => {
        return forwardToRaas("JD_GENERATED", outboundEnvelope);
      });

      await step.run(`log-emitted-${out.requisitionId}`, async () => {
        await prisma.agentActivity.create({
          data: {
            nodeId: AGENT_ID,
            agentName: AGENT_NAME,
            type: "event_emitted",
            narrative: `Published JD_GENERATED · jd_id=${out.jdId} · title="${out.jdPayload.posting_title}"`,
            metadata: JSON.stringify({
              event_name: "JD_GENERATED",
              event_id: outboundEnvelope.event_id,
              jd_id: out.jdId,
              job_requisition_id: out.requisitionId,
              posting_title: out.jdPayload.posting_title,
              must_have_skills: out.jdPayload.must_have_skills,
              nice_to_have_skills: out.jdPayload.nice_to_have_skills,
              work_years: out.jdPayload.work_years,
              expected_level: out.jdPayload.expected_level,
              recruitment_type: out.jdPayload.recruitment_type,
              salary_range: out.jdPayload.salary_range,
              quality_score: out.qualityScore,
            }),
          },
        });
      });

      results.push({
        jd_id: out.jdId,
        requisition_id: out.requisitionId,
        title: out.jdPayload.posting_title,
      });
    }

    return { jds: results, count: results.length };
  },
);

function normalizeRequirements(
  envelope: RequirementLoggedEnvelope,
  payload: RaasRequirementPayload,
): Normalized[] {
  // 1. Real RAAS shape — payload.raw_input_data (single requirement per event).
  const r = payload.raw_input_data;
  if (r && (r.client_job_title || r.job_requisition_id)) {
    const requisitionId =
      r.job_requisition_id ??
      payload.requirement_id ??
      envelope.entity_id ??
      `req_${Date.now().toString(36)}`;
    const { min, max } = parseSalaryRangeChinese(r.salary_range);
    return [
      {
        requisition_id: requisitionId,
        client: r.sd_org_name ?? r.client_id ?? payload.client_id ?? "unknown",
        title: r.client_job_title ?? "未命名岗位",
        jobType: r.client_job_type ?? null,
        recruitmentType: r.recruitment_type ?? null,
        expectedLevel: r.expected_level ?? null,
        city: r.city ?? null,
        headcount: typeof r.headcount === "number" ? r.headcount : null,
        salaryRangeMin: min,
        salaryRangeMax: max,
        salaryRangeRaw: r.salary_range ?? null,
        isUrgent: Boolean(payload.is_urgent),
        isExclusive: Boolean(r.is_exclusive),
        priority: r.priority ?? null,
        deadline: r.deadline ?? null,
        startDate: r.start_date ?? null,
        firstInterviewFormat: r.first_interview_format ?? null,
        firstInterviewerName: r.first_interviewer_name ?? null,
        finalInterviewFormat: r.final_interview_format ?? null,
        finalInterviewerName: r.final_interviewer_name ?? null,
        responsibilities: r.job_responsibility ?? null,
        requirements: r.job_requirement ?? null,
        niceToHaves: null,
        claimerEmployeeId: r.create_by ?? r.sd_owner_id ?? null,
        hsmEmployeeId: r.hsm_employee_id ?? null,
        clientId: r.client_id ?? payload.client_id ?? null,
        clientJobId: r.client_job_id ?? null,
      },
    ];
  }

  // 2. Legacy test shape — payload.requisitions[].
  if (Array.isArray(payload.requisitions) && payload.requisitions.length > 0) {
    return payload.requisitions.map((rq) => ({
      requisition_id: rq.requisition_id,
      client: rq.client ?? payload.client ?? "unknown",
      title: rq.title,
      jobType: null,
      recruitmentType: null,
      expectedLevel: null,
      city: rq.city ?? null,
      headcount: rq.headcount ?? null,
      salaryRangeMin: rq.salary_range_min ?? null,
      salaryRangeMax: rq.salary_range_max ?? null,
      salaryRangeRaw:
        rq.salary_range_min || rq.salary_range_max
          ? `${rq.salary_range_min ?? "?"} - ${rq.salary_range_max ?? "?"}`
          : null,
      isUrgent: false,
      isExclusive: false,
      priority: null,
      deadline: null,
      startDate: null,
      firstInterviewFormat: null,
      firstInterviewerName: null,
      finalInterviewFormat: null,
      finalInterviewerName: null,
      responsibilities: rq.responsibilities ?? null,
      requirements: rq.requirements ?? null,
      niceToHaves: rq.nice_to_haves ?? null,
      claimerEmployeeId: null,
      hsmEmployeeId: null,
      clientId: null,
      clientJobId: null,
    }));
  }

  return [];
}
