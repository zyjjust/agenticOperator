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
  getRequirementDetail,
  isRaasApiConfigured,
  syncJdGenerated,
  type RaasGenerateJdData,
  type RaasRequirement,
  type RaasRequirementSpecification,
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
    const traceId = getTraceId(event.data);

    // ── 1. 从事件取 entity_id (= job_requisition_id) ──
    // 新流程: RAAS 在事件里只放 entity_id，agent 主动调
    // GET /api/v1/requirements/:id 拉详情。entity_id 缺失时兼容老格式
    // (payload.raw_input_data.job_requisition_id / payload.requirement_id)。
    const requisitionId = pickRequisitionIdFromEnvelope(envelope);
    if (!requisitionId) {
      throw new NonRetriableError(
        `[${AGENT_NAME}] ${event.name} 缺 entity_id / requisition_id —— 无法调 GET /requirements/:id`,
      );
    }

    // ── 2. 调 GET /api/v1/requirements/:id 拉完整需求详情 ──
    const detail = await step.run(`fetch-requirement-${sanitize(requisitionId)}`, async () => {
      try {
        const r = await getRequirementDetail(requisitionId, { traceId });
        logger.info(
          `[${AGENT_NAME}] requirements/:id OK · jrid=${requisitionId} ` +
            `title="${r.requirement.client_job_title ?? '?'}" ` +
            `client_id=${r.requirement.client_id ?? '—'} ` +
            `status=${r.specification?.status ?? '—'}`,
        );
        return r;
      } catch (e) {
        if (e instanceof RaasApiError && e.isClientError) {
          throw new NonRetriableError(
            `RAAS GET /requirements/${requisitionId} 4xx: ${e.code} ${e.message}`,
          );
        }
        throw e;
      }
    });

    const requirement = detail.requirement;
    const specification = detail.specification;
    const clientId = requirement.client_id ?? specification?.client_id;
    if (!clientId) {
      throw new NonRetriableError(
        `[${AGENT_NAME}] requirement ${requisitionId} 缺 client_id — POST /jd/sync-generated 必填`,
      );
    }

    // ── 3. 从详情拼 prompt 给 RAAS /generate-jd ──
    const prompt = buildPromptFromRequirement(requirement, specification);
    if (!prompt || prompt.length < 4) {
      throw new NonRetriableError(
        `[${AGENT_NAME}] 拼不出有效 prompt — requirement ${requisitionId} 关键字段几乎全空`,
      );
    }

    logger.info(
      `[${AGENT_NAME}] received ${event.name} · requisition=${requisitionId} ` +
        `client_id=${clientId} prompt_len=${prompt.length}`,
    );

    // ── 4. 调 RAAS API: POST /api/v1/generate-jd ──
    const generated = await step.run(`generate-${sanitize(requisitionId)}`, async () => {
      try {
        const r = await generateJd(
          {
            prompt,
            language: 'zh',
            // 用 requirement 详情里的 sd_org_name (客户部门) 当 companyName/department 上下文。
            // 没有就交给 RAAS 自己解析。
            companyName: pickStringField(requirement, ['sd_org_name', 'client_name']),
            department: pickStringField(requirement, ['client_department_id', 'department']),
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

    // ── 5. 调 RAAS API: POST /api/v1/jd/sync-generated ──
    //
    // doc v5 §4.6: handler 同时接受 camelCase (RoboHire 原始) 和 snake_case
    // (raas 内部)。最便捷写法 — 直接 spread generate-jd 的 data，
    // 再加上 requirement 详情里 raas snake_case 的增强字段（must-have /
    // nice-to-have / 学历 / 年限 / 面试形式等，generate-jd 不给的）。
    await step.run(`sync-jd-${sanitize(requisitionId)}`, async () => {
      const input: SyncJdInput = {
        job_requisition_id: requisitionId,
        client_id: clientId,
        // a) RoboHire camelCase 整段 spread (title/description/qualifications/
        //    hardRequirements/niceToHave/salaryMin/salaryMax/... 全部带过去)
        ...(jdData as Record<string, unknown>),
        // b) requirement 详情里的 raas 增强字段（generate-jd 没给，但 RAAS
        //    端持久化 JobRequisition 需要）。仅当原 jdData 没覆盖时透传。
        must_have_skills: arrayOrUndefined(requirement.must_have_skills),
        nice_to_have_skills: arrayOrUndefined(requirement.nice_to_have_skills),
        negative_requirement: stringOrUndefined(requirement.negative_requirement),
        language_requirements: stringOrUndefined(requirement.language_requirements),
        expected_level: stringOrUndefined(requirement.expected_level),
        degree_requirement: stringOrUndefined(requirement.degree_requirement),
        education_requirement: stringOrUndefined(requirement.education_requirement),
        work_years:
          typeof requirement.work_years === 'number' ? requirement.work_years : undefined,
        interview_mode: stringOrUndefined(requirement.interview_mode),
        recruitment_type: stringOrUndefined(requirement.recruitment_type),
        // c) city 转 array（RoboHire 给的是 string，RAAS JobPosting 期望 array）
        city: pickCityFromBoth(requirement, jdData),
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

    // ── 6. emit JD_GENERATED (cascade 触发，不再依赖订阅入库) ──
    const outboundEnvelope: JdGeneratedEnvelope = {
      entity_type: 'JobDescription',
      entity_id: jdId,
      event_id: randomUUID(),
      payload: {
        job_requisition_id: requisitionId,
        client_id: clientId,
        posting_title: typeof jdData.title === 'string' ? jdData.title : '未命名岗位',
        posting_description: typeof jdData.description === 'string' ? jdData.description : '',
        city: pickCityFromBoth(requirement, jdData) ?? [],
        salary_range:
          (typeof jdData.salaryText === 'string' && jdData.salaryText.trim())
            ? jdData.salaryText.trim()
            : (jdData.salaryMin != null && jdData.salaryMax != null)
              ? `${jdData.salaryMin}-${jdData.salaryMax}`
              : '',
        interview_mode:
          (requirement.interview_mode as string | undefined) ?? 'unspecified',
        degree_requirement:
          (requirement.degree_requirement as string | undefined) ??
          (typeof jdData.education === 'string' ? jdData.education : ''),
        education_requirement:
          (requirement.education_requirement as string | undefined) ??
          (typeof jdData.education === 'string' ? jdData.education : ''),
        work_years:
          typeof requirement.work_years === 'number' ? requirement.work_years : 0,
        recruitment_type:
          (requirement.recruitment_type as string | undefined) ??
          (typeof jdData.employmentType === 'string' ? jdData.employmentType : 'unspecified'),
        must_have_skills: Array.isArray(requirement.must_have_skills)
          ? (requirement.must_have_skills as string[])
          : [],
        nice_to_have_skills: Array.isArray(requirement.nice_to_have_skills)
          ? (requirement.nice_to_have_skills as string[])
          : [],
        negative_requirement: (requirement.negative_requirement as string | undefined) ?? '',
        language_requirements:
          (requirement.language_requirements as string | undefined) ?? '',
        expected_level:
          (requirement.expected_level as string | undefined) ??
          (typeof jdData.experienceLevel === 'string' ? jdData.experienceLevel : 'unspecified'),
        responsibility:
          typeof jdData.qualifications === 'string' ? jdData.qualifications : '',
        requirement:
          typeof jdData.hardRequirements === 'string' ? jdData.hardRequirements : '',
        jd_id: jdId,
        claimer_employee_id:
          (specification?.recruiter_employee_id as string | undefined) ?? null,
        hsm_employee_id: (specification?.hsm_employee_id as string | undefined) ?? null,
        client_job_id: (requirement.client_job_id as string | undefined) ?? null,
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

    await step.sendEvent(`emit-jd-generated-${sanitize(requisitionId)}`, {
      name: 'JD_GENERATED',
      data: outboundEnvelope,
    });

    logger.info(
      `[${AGENT_NAME}] ✅ emitted JD_GENERATED · jd_id=${jdId} requisition=${requisitionId}`,
    );

    return {
      ok: true,
      jd_id: jdId,
      requisition_id: requisitionId,
      client_id: clientId,
      title: typeof jdData.title === 'string' ? jdData.title : null,
      raas_request_id: generated.requestId,
    };
  },
);

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * 从 REQUIREMENT_LOGGED envelope 取 job_requisition_id.
 *
 * 优先级:
 *   1. event.data.entity_id  ← Workflow A 标准位置 (RAAS canonical)
 *   2. payload.requirement_id / payload.raw_input_data.job_requisition_id
 *      ← 老 envelope 兼容
 */
function pickRequisitionIdFromEnvelope(
  envelope: RequirementLoggedEnvelope,
): string | null {
  if (typeof envelope.entity_id === 'string' && envelope.entity_id.trim()) {
    return envelope.entity_id.trim();
  }
  const payload = envelope.payload ?? (envelope as unknown as RaasRequirementPayload);
  const cands: Array<unknown> = [
    payload?.requirement_id,
    payload?.raw_input_data?.job_requisition_id,
  ];
  for (const c of cands) {
    if (typeof c === 'string' && c.trim().length > 0) return c.trim();
  }
  return null;
}

/**
 * 从 GET /requirements/:id 返回的 requirement + specification 拼一段
 * RAAS /generate-jd 期望的 free-text prompt (4-4000 chars).
 */
function buildPromptFromRequirement(
  requirement: RaasRequirement,
  specification: RaasRequirementSpecification | null,
): string {
  const r = requirement;
  const s: Partial<RaasRequirementSpecification> = specification ?? {};
  const lines: string[] = [];
  // 客户/岗位基础
  if (typeof r.client_job_title === 'string') lines.push(`岗位: ${r.client_job_title}`);
  const jobType = pickStringField(r, ['client_job_type']);
  if (jobType) lines.push(`岗位类型: ${jobType}`);
  if (typeof r.recruitment_type === 'string') lines.push(`招聘类型: ${r.recruitment_type}`);
  if (typeof r.expected_level === 'string') lines.push(`期望级别: ${r.expected_level}`);
  if (typeof r.city === 'string') lines.push(`工作城市: ${r.city}`);
  if (typeof r.headcount === 'number') lines.push(`招聘人数: ${r.headcount}`);
  if (typeof r.salary_range === 'string') lines.push(`薪资范围: ${r.salary_range}`);
  if (typeof r.work_years === 'number') lines.push(`工作年限: ${r.work_years} 年以上`);
  if (typeof r.degree_requirement === 'string') lines.push(`学历要求: ${r.degree_requirement}`);
  if (typeof r.education_requirement === 'string')
    lines.push(`专业要求: ${r.education_requirement}`);
  if (typeof r.language_requirements === 'string')
    lines.push(`语言要求: ${r.language_requirements}`);
  if (typeof r.interview_mode === 'string') lines.push(`面试形式: ${r.interview_mode}`);
  // Spec 上的时间线
  if (typeof s.priority === 'string') lines.push(`优先级: ${s.priority}`);
  if (typeof s.deadline === 'string') lines.push(`截止日期: ${s.deadline}`);
  if (typeof s.start_date === 'string') lines.push(`期望到岗: ${s.start_date}`);
  if (s.is_exclusive) lines.push('独家委托: 是');
  // 长文本
  if (Array.isArray(r.must_have_skills) && r.must_have_skills.length) {
    lines.push(`\n必备技能:\n  - ${(r.must_have_skills as string[]).join('\n  - ')}`);
  }
  if (Array.isArray(r.nice_to_have_skills) && r.nice_to_have_skills.length) {
    lines.push(`\n加分技能:\n  - ${(r.nice_to_have_skills as string[]).join('\n  - ')}`);
  }
  if (typeof r.negative_requirement === 'string' && r.negative_requirement.trim()) {
    lines.push(`\n排除条件: ${r.negative_requirement}`);
  }
  if (typeof r.job_responsibility === 'string' && r.job_responsibility.trim()) {
    lines.push(`\n岗位职责（原始）:\n${r.job_responsibility}`);
  }
  if (typeof r.job_requirement === 'string' && r.job_requirement.trim()) {
    lines.push(`\n任职要求（原始）:\n${r.job_requirement}`);
  }
  return lines.join('\n').slice(0, 4000);
}

function pickStringField(
  obj: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

/** Inngest step IDs 必须稳定且只含安全字符。 */
function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9-]/g, '-').slice(0, 80) || 'unknown';
}

/**
 * city 取值优先级:
 *   1) requirement.city (raas 已知字段，最权威) — 字符串转 array
 *   2) jdData.location (RoboHire 从 prompt 抽出来的)
 *   3) undefined
 */
function pickCityFromBoth(
  requirement: RaasRequirement,
  jdData: RaasGenerateJdData,
): string[] | undefined {
  const reqCity = stringOrUndefined(requirement.city);
  if (reqCity) return [reqCity];
  if (typeof jdData.location === 'string' && jdData.location.trim()) {
    return [jdData.location.trim()];
  }
  return undefined;
}

function arrayOrUndefined(v: unknown): string[] | undefined {
  if (Array.isArray(v) && v.length > 0) {
    return v.filter((x): x is string => typeof x === 'string' && x.length > 0);
  }
  return undefined;
}

function stringOrUndefined(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim().length > 0) return v.trim();
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
