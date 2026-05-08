// createJD agent — Workflow node 4.
//
// Subscribes REQUIREMENT_LOGGED → 拼一段 prompt → 调 RAAS API
// /api/v1/generate-jd → 调 /api/v1/jd/sync-generated 持久化 → emit
// JD_GENERATED 事件供下游 cascade.
//
// Workflow A (per agentic-operator-onboarding(3).md, 2026-05-08):
//   ❌ 不再调 OpenAI/LLM gateway 直连 (lib/llm/jd-generator.ts 退役)
//   ❌ 不再自己组装 partner-canonical 15 字段 payload (RAAS 处理)
//   ✅ 调 raas-api-client.generateJd (RAAS 透传 RoboHire /generate-jd)
//   ✅ 调 raas-api-client.syncJdGenerated 持久化到 RAAS DB (写 JobPosting +
//       回填 JobRequisition + 推进 spec.status → pending_publish)
//
// Inbound:  REQUIREMENT_LOGGED { entity_type, payload: { raw_input_data: {...28} } }
// Outbound: JD_GENERATED       JD content + bookkeeping (cascade only)

import { randomUUID } from 'node:crypto';
import { NonRetriableError } from 'inngest';
import {
  RaasApiError,
  generateJd,
  isRaasApiConfigured,
  syncJdGenerated,
  type RaasGenerateJdData,
  type SyncJdInput,
} from '../../raas-api-client';
import { inngest, type JdGeneratedEnvelope } from '../client';

const AGENT_ID = 'create-jd-agent';
const AGENT_NAME = 'createJD';
const GENERATOR_VERSION = 'workflow-a@2026-05-08';

// ─── Inbound envelope shape ─────────────────────────────────────────

type RaasRequirementPayload = {
  client_id?: string;
  is_urgent?: boolean;
  requirement_id?: string;
  source_channel?: string | null;
  /** Free-text 简报 (新格式优先；如缺则从 raw_input_data 拼). */
  requirement_brief?: string;
  raw_input_data?: {
    job_requisition_id?: string;
    client_job_id?: string;
    client_job_title?: string;
    client_job_type?: string;
    client_id?: string;
    client_department_id?: string;
    sd_org_name?: string;
    sd_owner_id?: string;
    hsm_employee_id?: string | null;
    city?: string;
    recruitment_type?: string;
    expected_level?: string;
    priority?: string;
    is_exclusive?: boolean;
    headcount?: number;
    salary_range?: string;
    deadline?: string;
    start_date?: string;
    first_interview_format?: string;
    first_interviewer_name?: string;
    final_interview_format?: string;
    final_interviewer_name?: string;
    job_responsibility?: string;
    job_requirement?: string;
    create_by?: string;
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

export const createJdAgent = inngest.createFunction(
  {
    id: AGENT_ID,
    name: 'Create JD Agent (workflow node 4)',
    retries: 1,
  },
  [
    { event: 'REQUIREMENT_LOGGED' },
    { event: 'CLARIFICATION_READY' },
    { event: 'JD_REJECTED' },
  ],
  async ({ event, step, logger }) => {
    if (!isRaasApiConfigured()) {
      throw new NonRetriableError(
        `[${AGENT_NAME}] RAAS_API_BASE_URL / AGENT_API_KEY env 未配置`,
      );
    }

    const envelope = (event.data ?? {}) as RequirementLoggedEnvelope;
    const payload = envelope.payload ?? (envelope as unknown as RaasRequirementPayload);
    const traceId = getTraceId(event.data);

    // ── 提取关键字段 ──
    const ids = pickIds(envelope, payload);
    if (!ids.requisition_id) {
      throw new NonRetriableError(
        `[${AGENT_NAME}] ${event.name} 缺 requisition_id (raw_input_data.job_requisition_id 或 payload.requirement_id) — 无法关联 JobPosting`,
      );
    }
    if (!ids.client_id) {
      throw new NonRetriableError(
        `[${AGENT_NAME}] ${event.name} 缺 client_id — POST /jd/sync-generated 必须的字段`,
      );
    }

    // ── 拼 prompt 给 RAAS /generate-jd ──
    const prompt = buildPrompt(payload);
    if (!prompt || prompt.length < 4) {
      throw new NonRetriableError(
        `[${AGENT_NAME}] ${event.name} 凑不出有效 prompt (raw_input_data 几乎全空)`,
      );
    }

    logger.info(
      `[${AGENT_NAME}] received ${event.name} · requisition=${ids.requisition_id} ` +
        `client_id=${ids.client_id} prompt_len=${prompt.length}`,
    );

    // ── 调 RAAS API: POST /api/v1/generate-jd ──
    const generated = await step.run(`generate-${ids.requisition_id}`, async () => {
      try {
        const r = await generateJd(
          {
            prompt,
            language: 'zh',
            companyName: payload.raw_input_data?.sd_org_name ?? undefined,
            department: payload.raw_input_data?.client_department_id ?? undefined,
          },
          { traceId },
        );
        logger.info(
          `[${AGENT_NAME}] RAAS generate-jd OK · title="${r.data.title ?? '?'}" ` +
            `parse=${r.meta?.stages?.parse} generate=${r.meta?.stages?.generate} ` +
            `requestId=${r.requestId}`,
        );
        return r;
      } catch (e) {
        if (e instanceof RaasApiError && e.isClientError) {
          throw new NonRetriableError(
            `RAAS generate-jd 4xx: ${e.code} ${e.message}`,
          );
        }
        throw e;
      }
    });

    const jdData = generated.data;
    const jdId = `jd_${randomUUID().slice(0, 8)}_${Date.now().toString(36)}`;

    // ── 调 RAAS API: POST /api/v1/jd/sync-generated ──
    await step.run(`sync-jd-${ids.requisition_id}`, async () => {
      const input: SyncJdInput = {
        job_requisition_id: ids.requisition_id!,
        client_id: ids.client_id!,
        posting_title: typeof jdData.title === 'string' ? jdData.title : undefined,
        posting_description: typeof jdData.description === 'string' ? jdData.description : undefined,
        // RAAS 端可以从 jd_content 里抽 must-have / nice-to-have，所以这里
        // 不重复字段抽取，直接把 jdData 整段塞 jd_content。
        jd_content: jdData as Record<string, unknown>,
        // 这些是 RAAS 用来回填 JobRequisition 的额外信号。
        city: pickCity(jdData),
        salary_range: pickSalaryRange(jdData),
      };
      try {
        const r = await syncJdGenerated(input, { traceId });
        logger.info(
          `[${AGENT_NAME}] sync-generated OK · synced=${r.synced} job_posting_id=${r.job_posting_id}`,
        );
        return r;
      } catch (e) {
        if (e instanceof RaasApiError && e.isClientError) {
          throw new NonRetriableError(
            `RAAS sync-generated 4xx: ${e.code} ${e.message}`,
          );
        }
        throw e;
      }
    });

    // ── emit JD_GENERATED (cascade 触发，不再依赖订阅入库) ──
    const outboundEnvelope: JdGeneratedEnvelope = {
      entity_type: 'JobDescription',
      entity_id: jdId,
      event_id: randomUUID(),
      payload: {
        // 转发 RAAS generate-jd 的核心字段供下游使用
        job_requisition_id: ids.requisition_id,
        client_id: ids.client_id,
        posting_title: typeof jdData.title === 'string' ? jdData.title : '未命名岗位',
        posting_description: typeof jdData.description === 'string' ? jdData.description : '',
        city: pickCity(jdData) ?? [],
        salary_range: pickSalaryRange(jdData) ?? '',
        interview_mode: 'unspecified',
        degree_requirement: typeof jdData.education === 'string' ? jdData.education : '',
        education_requirement: typeof jdData.education === 'string' ? jdData.education : '',
        work_years: 0, // RAAS jd_content 不直接给 work_years，留 0 给后续业务补
        recruitment_type: typeof jdData.employmentType === 'string' ? jdData.employmentType : 'unspecified',
        must_have_skills: [], // workflow A: 这些字段由 RAAS 解析，agent 不重复
        nice_to_have_skills: [],
        negative_requirement: '',
        language_requirements: '',
        expected_level: typeof jdData.experienceLevel === 'string' ? jdData.experienceLevel : 'unspecified',
        responsibility: typeof jdData.qualifications === 'string' ? jdData.qualifications : '',
        requirement: typeof jdData.hardRequirements === 'string' ? jdData.hardRequirements : '',
        jd_id: jdId,
        claimer_employee_id: payload.raw_input_data?.create_by ?? null,
        hsm_employee_id: payload.raw_input_data?.hsm_employee_id ?? null,
        client_job_id: payload.raw_input_data?.client_job_id ?? null,
        search_keywords: [],
        quality_score: 0,
        quality_suggestions: [],
        market_competitiveness: '中',
        generator_version: GENERATOR_VERSION,
        generator_model: 'raas-api/generate-jd',
        generated_at: new Date().toISOString(),
      },
      trace: envelope.trace ?? {
        trace_id: null,
        request_id: null,
        workflow_id: null,
        parent_trace_id: null,
      },
    };

    await step.sendEvent(`emit-jd-generated-${ids.requisition_id}`, {
      name: 'JD_GENERATED',
      data: outboundEnvelope,
    });

    logger.info(
      `[${AGENT_NAME}] ✅ emitted JD_GENERATED · jd_id=${jdId} requisition=${ids.requisition_id}`,
    );

    return {
      ok: true,
      jd_id: jdId,
      requisition_id: ids.requisition_id,
      client_id: ids.client_id,
      title: typeof jdData.title === 'string' ? jdData.title : null,
      raas_request_id: generated.requestId,
    };
  },
);

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function pickIds(
  envelope: RequirementLoggedEnvelope,
  payload: RaasRequirementPayload,
): { requisition_id: string | null; client_id: string | null } {
  const r = payload.raw_input_data;
  const requisition_id =
    r?.job_requisition_id ??
    payload.requirement_id ??
    envelope.entity_id ??
    null;
  const client_id = r?.client_id ?? payload.client_id ?? null;
  return { requisition_id, client_id };
}

/**
 * 把 raw_input_data 28 字段拼成 RAAS /generate-jd 期望的 free-text prompt。
 * 优先用 payload.requirement_brief (如果上游已经准备好)，否则从结构化字段
 * 自己拼一段。
 */
function buildPrompt(payload: RaasRequirementPayload): string {
  if (typeof payload.requirement_brief === 'string' && payload.requirement_brief.trim()) {
    return payload.requirement_brief.trim().slice(0, 4000);
  }
  const r = payload.raw_input_data;
  if (!r) return '';
  const lines: string[] = [];
  if (r.sd_org_name) lines.push(`客户/部门: ${r.sd_org_name}`);
  if (r.client_job_title) lines.push(`岗位: ${r.client_job_title}`);
  if (r.client_job_type) lines.push(`岗位类型: ${r.client_job_type}`);
  if (r.recruitment_type) lines.push(`招聘类型: ${r.recruitment_type}`);
  if (r.expected_level) lines.push(`期望级别: ${r.expected_level}`);
  if (r.city) lines.push(`工作城市: ${r.city}`);
  if (r.headcount != null) lines.push(`招聘人数: ${r.headcount}`);
  if (r.salary_range) lines.push(`薪资范围: ${r.salary_range}`);
  if (r.priority) lines.push(`优先级: ${r.priority}`);
  if (r.deadline) lines.push(`截止日期: ${r.deadline}`);
  if (r.start_date) lines.push(`期望到岗: ${r.start_date}`);
  if (r.first_interview_format || r.final_interview_format) {
    lines.push(
      `面试形式: 初试 ${r.first_interview_format ?? '—'} / 复试 ${r.final_interview_format ?? '—'}`,
    );
  }
  if (r.job_responsibility) lines.push(`\n岗位职责（原始）:\n${r.job_responsibility}`);
  if (r.job_requirement) lines.push(`\n任职要求（原始）:\n${r.job_requirement}`);
  return lines.join('\n').slice(0, 4000);
}

function pickCity(jdData: RaasGenerateJdData): string[] | undefined {
  if (typeof jdData.location === 'string' && jdData.location.trim()) {
    return [jdData.location.trim()];
  }
  return undefined;
}

function pickSalaryRange(jdData: RaasGenerateJdData): string | undefined {
  if (typeof jdData.salaryText === 'string' && jdData.salaryText.trim()) {
    return jdData.salaryText.trim();
  }
  const min = jdData.salaryMin;
  const max = jdData.salaryMax;
  if (min != null && max != null) {
    return `${String(min)}-${String(max)}`;
  }
  return undefined;
}

function getTraceId(eventData: unknown): string | undefined {
  if (!eventData || typeof eventData !== 'object') return undefined;
  const r = eventData as Record<string, any>;
  const t = r.trace;
  if (t && typeof t === 'object' && typeof t.trace_id === 'string' && t.trace_id) {
    return t.trace_id;
  }
  return undefined;
}
