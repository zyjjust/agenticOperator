// createJD agent — Workflow node 4.
//
// Subscribes to REQUIREMENT_LOGGED (from RAAS, envelope shape) →
// normalizes the 28-field raw_input_data form → calls llmGenerateJd()
// → emits JD_GENERATED with the partner-canonical 15-field payload.
//
// Inbound:  REQUIREMENT_LOGGED  { entity_type, payload: { client_id,
//                                  is_urgent, requirement_id,
//                                  raw_input_data: { ...28 fields... },
//                                  source_channel }, trace }
// Outbound: JD_GENERATED        partner-spec flat payload (job_requisition_id,
//                               client_id, posting_title, ...)
//
// Migration notes (vs old AO-main `server/ws/agents/create-jd.ts`):
//   - NO Prisma DB writes — RPA is stateless. Local JD persistence belongs
//     in RAAS via JD_GENERATED ingest, not here.
//   - NO agentic on/off toggle — RPA is always-on. If you need a kill
//     switch, gate at deploy/process level.
//   - NO forwardToRaas dual-bus push — RAAS subscribes to JD_GENERATED on
//     the same local Inngest, no need to also POST to partner Inngest.
//   - NO test-shape fallback (`payload.requisitions[]`) — RPA only consumes
//     RAAS canonical envelope. If you need a test trigger, send envelope
//     shape from publish-test scripts.
//   - LLM gateway env vars stay the same: AI_BASE_URL + AI_API_KEY (+ AI_MODEL)
//     OR OPENAI_API_KEY — set them in resume-parser-agent/.env.local.

import { randomUUID } from 'node:crypto';
import { NonRetriableError } from 'inngest';
import {
  llmGenerateJd,
  parseSalaryRangeChinese,
  type JdGenInput,
} from '../../llm/jd-generator';
import { inngest, type JdGeneratedEnvelope } from '../client';

const AGENT_ID = 'create-jd-agent';
const AGENT_NAME = 'createJD';
const GENERATOR_VERSION = 'ao-llm@2026-04-28';

// ─── Inbound payload shape (RAAS canonical) ──────────────────────
//
// REQUIREMENT_LOGGED.data.payload — the 28-field flat form RAAS dashboard
// submits live under `raw_input_data`. Wrapped here for type safety.
type RaasRequirementPayload = {
  client_id?: string;
  is_urgent?: boolean;
  requirement_id?: string;          // "JRQ-<client_id>-<client_job_id>"
  source_channel?: string | null;
  raw_input_data?: {
    job_requisition_id?: string;
    client_job_id?: string;
    client_job_title?: string;       // 岗位名称（必有）
    client_job_type?: string;        // 岗位类型 (e.g. "前端")
    client_id?: string;
    client_department_id?: string;
    csi_department_id?: string;
    sd_org_name?: string;            // 客户部门名（人话）
    sd_owner_id?: string;            // claimer fallback
    hsm_employee_id?: string | null; // 招聘专员 (HSM)
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

    create_by?: string;              // claimer_employee_id (canonical)
  };
};

type RequirementLoggedEnvelope = {
  entity_type?: string;
  entity_id?: string | null;
  event_id?: string;
  payload?: RaasRequirementPayload;
  trace?: {
    trace_id?: string | null;
    request_id?: string | null;
    workflow_id?: string | null;
    parent_trace_id?: string | null;
  };
};

// Normalized internal form passed to the LLM. Decoupled from the wire shape
// so we can adjust upstream changes without touching the LLM contract.
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
  finalInterviewFormat: string | null;
  responsibilities: string | null;
  requirements: string | null;
  niceToHaves: string | null;
  // Bookkeeping IDs propagated to JD_GENERATED so downstream RAAS / matcher
  // can correlate without local DB lookups.
  claimerEmployeeId: string | null;
  hsmEmployeeId: string | null;
  clientId: string | null;
  clientJobId: string | null;
};

export const createJdAgent = inngest.createFunction(
  {
    id: AGENT_ID,
    name: 'Create JD Agent (workflow node 4)',
    retries: 1,
  },
  // Per old AO-main createJD, also subscribe to CLARIFICATION_READY (downstream
  // of analyzeRequirement) and JD_REJECTED (re-generation after human
  // rejection). RPA doesn't have those agents yet but keeps the contract.
  [
    { event: 'REQUIREMENT_LOGGED' },
    { event: 'CLARIFICATION_READY' },
    { event: 'JD_REJECTED' },
  ],
  async ({ event, step, logger }) => {
    const envelope = (event.data ?? {}) as RequirementLoggedEnvelope;
    const payload =
      envelope.payload ?? (envelope as unknown as RaasRequirementPayload);

    const normalized = normalizeRequirement(envelope, payload);
    if (!normalized) {
      throw new NonRetriableError(
        `[${AGENT_NAME}] ${event.name} has no recognizable requirement — ` +
          `need payload.raw_input_data with client_job_title (data keys=${Object.keys(envelope).join(',')})`,
      );
    }

    logger.info(
      `[${AGENT_NAME}] received ${event.name} · requisition=${normalized.requisition_id} ` +
        `title="${normalized.title}" city=${normalized.city ?? '—'} salary=${normalized.salaryRangeRaw ?? '—'}`,
    );

    // ── LLM call ───────────────────────────────────────────────────
    // Wrapped in step.run so Inngest can retry just this step on
    // LLM gateway transients without re-doing the (cheap) normalize.
    const out = await step.run(`generate-${normalized.requisition_id}`, async () => {
      const t0 = Date.now();
      const llm = await llmGenerateJd({
        client: normalized.client,
        title: normalized.title,
        jobType: normalized.jobType,
        recruitmentType: normalized.recruitmentType,
        expectedLevel: normalized.expectedLevel,
        city: normalized.city,
        headcount: normalized.headcount,
        salaryRangeMin: normalized.salaryRangeMin,
        salaryRangeMax: normalized.salaryRangeMax,
        salaryRangeRaw: normalized.salaryRangeRaw,
        isUrgent: normalized.isUrgent,
        isExclusive: normalized.isExclusive,
        priority: normalized.priority,
        deadline: normalized.deadline,
        startDate: normalized.startDate,
        firstInterviewFormat: normalized.firstInterviewFormat,
        finalInterviewFormat: normalized.finalInterviewFormat,
        responsibilities: normalized.responsibilities,
        requirements: normalized.requirements,
        niceToHaves: normalized.niceToHaves,
      } satisfies JdGenInput);

      const jdId = `jd_${randomUUID().slice(0, 8)}_${Date.now().toString(36)}`;

      logger.info(
        `[${AGENT_NAME}] LLM done · jd_id=${jdId} model=${llm.modelUsed} ` +
          `quality=${llm.qualityScore} ${llm.marketCompetitiveness}竞争力 ` +
          `must=[${llm.payload.must_have_skills.slice(0, 4).join(', ')}${llm.payload.must_have_skills.length > 4 ? '…' : ''}] ` +
          `${Date.now() - t0}ms`,
      );

      return {
        jdId,
        durationMs: Date.now() - t0,
        llmDurationMs: llm.durationMs,
        modelUsed: llm.modelUsed,
        jdPayload: llm.payload,
        searchKeywords: llm.searchKeywords,
        qualityScore: llm.qualityScore,
        qualitySuggestions: llm.qualitySuggestions,
        marketCompetitiveness: llm.marketCompetitiveness,
      };
    });

    // ── Emit JD_GENERATED ──────────────────────────────────────────
    // Partner-canonical envelope shape (matches RAAS expected for
    // jd-generated-sync ingest fn).
    const outboundEnvelope: JdGeneratedEnvelope = {
      entity_type: 'JobDescription',
      entity_id: out.jdId,
      event_id: randomUUID(),
      payload: {
        // ── 15 canonical fields per partner spec ──
        job_requisition_id: normalized.requisition_id,
        client_id: normalized.clientId,
        posting_title: out.jdPayload.posting_title,
        posting_description: out.jdPayload.posting_description,
        city: out.jdPayload.city,
        salary_range: out.jdPayload.salary_range,
        interview_mode: out.jdPayload.interview_mode,
        degree_requirement: out.jdPayload.degree_requirement,
        education_requirement: out.jdPayload.education_requirement,
        work_years: out.jdPayload.work_years,
        recruitment_type: out.jdPayload.recruitment_type,
        must_have_skills: out.jdPayload.must_have_skills,
        nice_to_have_skills: out.jdPayload.nice_to_have_skills,
        negative_requirement: out.jdPayload.negative_requirement,
        language_requirements: out.jdPayload.language_requirements,
        expected_level: out.jdPayload.expected_level,

        // ── 发布渠道用的 2 段独立字段（partner 没明确要求但建议保留）──
        responsibility: out.jdPayload.responsibility,
        requirement: out.jdPayload.requirement,

        // ── Bookkeeping IDs (RAAS uses these to link JD ↔ recruiter / client_job) ──
        jd_id: out.jdId,
        claimer_employee_id: normalized.claimerEmployeeId,
        hsm_employee_id: normalized.hsmEmployeeId,
        client_job_id: normalized.clientJobId,

        // ── AO diagnostic (RAAS may ignore) ──
        search_keywords: out.searchKeywords,
        quality_score: out.qualityScore,
        quality_suggestions: out.qualitySuggestions,
        market_competitiveness: out.marketCompetitiveness,
        generator_version: GENERATOR_VERSION,
        generator_model: out.modelUsed,
        generated_at: new Date().toISOString(),
      },
      trace: envelope.trace ?? {
        trace_id: null,
        request_id: null,
        workflow_id: null,
        parent_trace_id: null,
      },
    };

    await step.sendEvent(`emit-jd-generated-${normalized.requisition_id}`, {
      name: 'JD_GENERATED',
      data: outboundEnvelope,
    });

    logger.info(
      `[${AGENT_NAME}] ✅ emitted JD_GENERATED · jd_id=${out.jdId} ` +
        `requisition=${normalized.requisition_id} title="${out.jdPayload.posting_title}"`,
    );

    return {
      ok: true,
      jd_id: out.jdId,
      requisition_id: normalized.requisition_id,
      title: out.jdPayload.posting_title,
      duration_ms: out.durationMs,
      llm_duration_ms: out.llmDurationMs,
      model_used: out.modelUsed,
      quality_score: out.qualityScore,
    };
  },
);

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * Map RAAS canonical envelope's `raw_input_data` (28-field form) into the
 * internal `Normalized` shape consumed by llmGenerateJd().
 *
 * Returns null if the requirement payload doesn't carry enough to act on
 * (no client_job_title and no requisition id) — caller should NonRetriable.
 */
function normalizeRequirement(
  envelope: RequirementLoggedEnvelope,
  payload: RaasRequirementPayload,
): Normalized | null {
  const r = payload.raw_input_data;
  if (!r || (!r.client_job_title && !r.job_requisition_id)) {
    return null;
  }

  const requisitionId =
    r.job_requisition_id ??
    payload.requirement_id ??
    envelope.entity_id ??
    `req_${Date.now().toString(36)}`;

  const { min, max } = parseSalaryRangeChinese(r.salary_range);

  return {
    requisition_id: requisitionId,
    client: r.sd_org_name ?? r.client_id ?? payload.client_id ?? 'unknown',
    title: r.client_job_title ?? '未命名岗位',
    jobType: r.client_job_type ?? null,
    recruitmentType: r.recruitment_type ?? null,
    expectedLevel: r.expected_level ?? null,
    city: r.city ?? null,
    headcount: typeof r.headcount === 'number' ? r.headcount : null,
    salaryRangeMin: min,
    salaryRangeMax: max,
    salaryRangeRaw: r.salary_range ?? null,
    isUrgent: Boolean(payload.is_urgent),
    isExclusive: Boolean(r.is_exclusive),
    priority: r.priority ?? null,
    deadline: r.deadline ?? null,
    startDate: r.start_date ?? null,
    firstInterviewFormat: r.first_interview_format ?? null,
    finalInterviewFormat: r.final_interview_format ?? null,
    responsibilities: r.job_responsibility ?? null,
    requirements: r.job_requirement ?? null,
    niceToHaves: null,
    // claimer_employee_id 候选顺序：raw_input_data.create_by 优先
    // (canonical claimer)，其次 sd_owner_id (deal owner)
    claimerEmployeeId: r.create_by ?? r.sd_owner_id ?? null,
    hsmEmployeeId: r.hsm_employee_id ?? null,
    clientId: r.client_id ?? payload.client_id ?? null,
    clientJobId: r.client_job_id ?? null,
  };
}
