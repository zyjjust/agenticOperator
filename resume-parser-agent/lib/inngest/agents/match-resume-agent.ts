// matchResume agent — Workflow node 10.
//
// Subscribes RESUME_PROCESSED → 通过 RAAS API Server 取需求列表 → 循环调
// /api/v1/match-resume → 持久化到 RAAS DB (POST /api/v1/match-results) →
// emit MATCH_PASSED_NEED_INTERVIEW (cascade trigger).
//
// 跟之前版本的差别 (Workflow A, 2026-05-08):
//   ❌ 不再调 RoboHire /match-resume 直连 (lib/robohire.ts 退役)
//   ❌ 不再调 lib/raas-internal.ts (老 internal API path 退役)
//   ✅ 通过 raas-api-client 调:
//        - getRequirementsAgentView (列需求)
//        - matchResume               (打分)
//        - saveMatchResults          (持久化, source="need_interview")
//
// Inbound:  RESUME_PROCESSED { upload_id, candidate_id, employee_id, parsed, ... }
// Outbound: MATCH_PASSED_NEED_INTERVIEW (一条/JD)

import { NonRetriableError } from 'inngest';
import {
  RaasApiError,
  getRequirementsAgentView,
  isRaasApiConfigured,
  matchResume,
  saveMatchResults,
  type RaasMatchResumeData,
  type RequirementsAgentViewItem,
} from '../../raas-api-client';
import {
  inngest,
  type MatchPassedNeedInterviewData,
  type ResumeProcessedData,
} from '../client';

const AGENT_ID = 'match-resume-agent';
const AGENT_NAME = 'matchResume';

export const matchResumeAgent = inngest.createFunction(
  {
    id: AGENT_ID,
    name: 'Match Resume Agent (workflow node 10)',
    retries: 2,
  },
  { event: 'RESUME_PROCESSED' },
  async ({ event, step, logger }) => {
    const data = unwrapResumeProcessedEvent(event.data);
    const traceId = getTraceId(event.data);

    // ── 1. 抽取必要 anchor ─────────────────────────────────
    const uploadId = pickUploadId(data);
    const candidateId = pickCandidateId(data);
    const employeeId = pickEmployeeId(data);

    if (!uploadId && !candidateId) {
      throw new NonRetriableError(
        `[${AGENT_NAME}] RESUME_PROCESSED 缺 upload_id 和 candidate_id — 至少需要其一才能调 saveMatchResults。data keys=${Object.keys(data).join(',')}`,
      );
    }
    if (!employeeId) {
      throw new NonRetriableError(
        `[${AGENT_NAME}] RESUME_PROCESSED 缺 employee_id / claimer_employee_id — 无法定位招聘人员名下的需求`,
      );
    }
    if (!isRaasApiConfigured()) {
      throw new NonRetriableError(
        `[${AGENT_NAME}] RAAS_API_BASE_URL / AGENT_API_KEY env 未配置`,
      );
    }

    logger.info(
      `[${AGENT_NAME}] received RESUME_PROCESSED · upload_id=${uploadId ?? '—'} ` +
        `candidate_id=${candidateId ?? '—'} employee_id=${employeeId}`,
    );

    // ── 2. 构造 resume 文本 (喂给 match-resume) ─────────────
    const resumeText = await step.run('build-resume-text', async () => {
      const text = buildResumeText(data);
      logger.info(`[${AGENT_NAME}] built resume text · ${text.length} chars`);
      return text;
    });

    if (!resumeText.trim()) {
      throw new NonRetriableError(
        `[${AGENT_NAME}] resume text empty — payload.parsed.data 没有可用内容`,
      );
    }

    // ── 3. 调 RAAS API 拿招聘人员的在招需求列表 ──────────────
    //
    // 接口签名 (per partner 2026-05-08):
    //   GET /api/v1/requirements/agent-view?claimer_employee_id=EMP001
    //
    // 只传 claimer_employee_id, 其他过滤逻辑 (scope/status/page_size)
    // 由 partner 端按 agent-view 语义内部决定 (典型: 只返回 claimer 名下
    // 在招的需求, 默认分页). 我们不再传额外参数.
    const requirements = await step.run('list-requirements', async () => {
      try {
        const r = await getRequirementsAgentView(
          { claimer_employee_id: employeeId },
          { traceId },
        );
        const total = r.items?.length ?? 0;
        // 双层过滤:
        //   1) isRecruitingStatus — 只跑招聘中 JD (兜底, 防 partner 返回非 recruiting)
        //   2) hasMatchableContent — 必须有 job_responsibility / job_requirement / must_have_skills
        const recruiting = (r.items ?? []).filter(isRecruitingStatus);
        const matchable = recruiting.filter(hasMatchableContent);
        logger.info(
          `[${AGENT_NAME}] RAAS returned ${total} requirement(s); ` +
            `${recruiting.length} recruiting; ${matchable.length} matchable`,
        );
        return matchable;
      } catch (e) {
        if (e instanceof RaasApiError && e.isClientError) {
          throw new NonRetriableError(
            `RAAS getRequirementsAgentView 4xx: ${e.code} ${e.message}`,
          );
        }
        throw e;
      }
    });

    if (requirements.length === 0) {
      logger.warn(
        `[${AGENT_NAME}] employee_id=${employeeId} 名下 0 条 matchable 需求，不 emit`,
      );
      return {
        ok: true,
        upload_id: uploadId,
        candidate_id: candidateId,
        employee_id: employeeId,
        matched_count: 0,
        emitted_count: 0,
        reason: 'no-matchable-requirements',
      };
    }

    // ── 4. 循环每条需求做匹配 + 持久化 + emit ──────────────
    const summaries: Array<{
      job_requisition_id: string;
      ok: boolean;
      requestId?: string;
      error?: string;
    }> = [];

    for (const req of requirements) {
      const jrid = pickRequisitionId(req);
      if (!jrid) {
        logger.warn(`[${AGENT_NAME}] requirement 没有 job_requisition_id，跳过`);
        continue;
      }

      const stepKey = sanitizeStepKey(jrid);

      // 4a. 调 RAAS /api/v1/match-resume (透传 RoboHire)
      const matchResult = await step.run(
        `match-${stepKey}`,
        async (): Promise<
          | { ok: true; data: RaasMatchResumeData; requestId?: string; savedAs?: string }
          | { ok: false; error: string }
        > => {
          const jdText = flattenRequirementForMatch(req);
          logger.info(
            `[${AGENT_NAME}] calling RAAS /match-resume · job_req=${jrid} jd_chars=${jdText.length}`,
          );
          try {
            const r = await matchResume(
              { resume: resumeText, jd: jdText },
              { traceId },
            );
            logger.info(
              `[${AGENT_NAME}] RAAS match OK · job_req=${jrid} score=${r.data?.matchScore} rec=${r.data?.recommendation} requestId=${r.requestId}`,
            );
            return {
              ok: true as const,
              data: r.data,
              requestId: r.requestId,
              savedAs: r.savedAs,
            };
          } catch (e) {
            if (e instanceof RaasApiError && e.isClientError) {
              // 4xx (除 429) → 跳过这条需求，不影响其他 JD
              logger.error(
                `[${AGENT_NAME}] RAAS match 4xx · job_req=${jrid} code=${e.code} — skipping`,
              );
              return { ok: false as const, error: `${e.code}: ${e.message}` };
            }
            // 5xx / 429 / 网络 → 让 step.run 重试
            throw e;
          }
        },
      );

      if (!matchResult.ok) {
        summaries.push({ job_requisition_id: jrid, ok: false, error: matchResult.error });
        continue;
      }

      // 4b. 调 RAAS /api/v1/match-results 持久化 (source="need_interview")
      //
      // doc §4.6 sync-generated 同样的 spread 写法 — RoboHire /match-resume
      // 实际返回 20+ 字段 (overallMatchScore / skillMatch / experienceMatch /
      // jdAnalysis / candidatePotential / suggestedInterviewQuestions / ...).
      // 直接 ...matchResult.data 整段透传, 让 RAAS 端按 schema 挑字段写库.
      // 不要 cherry-pick (之前漏了 14+ 字段 → match_analysis 列空着的根因).
      await step.run(`save-match-${stepKey}`, async () => {
        try {
          const r = await saveMatchResults(
            {
              // a) RoboHire /match-resume data 整段 spread (camelCase 全字段)
              //    必须放在最前面 — IDs 之类的 anchor 在后面 override,
              //    防 RoboHire 未来加同名字段 (例如 candidate_id) 把
              //    我们的 anchor 覆盖.
              ...(matchResult.data as Record<string, unknown>),
              // b) raas 关联 (必带, 永远以这里为准)
              source: 'need_interview',
              candidate_id: candidateId ?? undefined,
              upload_id: uploadId ?? undefined,
              job_requisition_id: jrid,
              client_id: pickClientId(req),
              // c) 跨服务 trace 透传
              robohire_request_id: matchResult.requestId,
              savedAs: matchResult.savedAs,
            },
            { traceId },
          );
          logger.info(
            `[${AGENT_NAME}] saveMatchResults OK · job_req=${jrid} ` +
              `result=${JSON.stringify(r).slice(0, 120)}`,
          );
          return r;
        } catch (e) {
          if (e instanceof RaasApiError && e.isClientError) {
            throw new NonRetriableError(
              `RAAS saveMatchResults 4xx: ${e.code} ${e.message}`,
            );
          }
          throw e;
        }
      });

      // 4c. emit MATCH_PASSED_NEED_INTERVIEW (cascade)
      const payload: MatchPassedNeedInterviewData = {
        upload_id: uploadId ?? '',
        job_requisition_id: jrid,
        success: true,
        data: matchResult.data as unknown as Record<string, unknown>,
        requestId: matchResult.requestId,
        savedAs: matchResult.savedAs,
      };
      await step.sendEvent(`emit-match-${stepKey}`, {
        name: 'MATCH_PASSED_NEED_INTERVIEW',
        data: payload,
      });

      summaries.push({
        job_requisition_id: jrid,
        ok: true,
        requestId: matchResult.requestId,
      });

      logger.info(
        `[${AGENT_NAME}] ✅ emitted MATCH_PASSED_NEED_INTERVIEW · upload_id=${uploadId} job_req=${jrid}`,
      );
    }

    const emitted = summaries.filter((s) => s.ok).length;
    return {
      ok: true,
      upload_id: uploadId,
      candidate_id: candidateId,
      employee_id: employeeId,
      matched_count: requirements.length,
      emitted_count: emitted,
      summaries,
    };
  },
);

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function unwrapResumeProcessedEvent(raw: unknown): ResumeProcessedData & Record<string, any> {
  if (!raw || typeof raw !== 'object') return raw as ResumeProcessedData;
  const r = raw as Record<string, unknown>;
  if (r.payload && typeof r.payload === 'object' && !Array.isArray(r.payload)) {
    return {
      ...(r.payload as Record<string, unknown>),
      _envelope_entity_id: r.entity_id,
      _envelope_entity_type: r.entity_type,
      _envelope_event_id: r.event_id,
      _envelope_trace: r.trace,
    } as unknown as ResumeProcessedData;
  }
  return raw as ResumeProcessedData;
}

function pickUploadId(
  data: ResumeProcessedData & { uploadId?: string; object_key?: string; objectKey?: string },
): string | null {
  const candidates: Array<string | null | undefined> = [
    data.upload_id,
    data.uploadId,
    data.etag,
    data.object_key,
    data.objectKey,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) return c.trim();
  }
  return null;
}

function pickCandidateId(data: ResumeProcessedData): string | null {
  if (typeof data.candidate_id === 'string' && data.candidate_id.trim()) {
    return data.candidate_id.trim();
  }
  return null;
}

function pickEmployeeId(
  data: ResumeProcessedData & {
    claimer_employee_id?: string | null;
    operator_id?: string | null;
  },
): string | null {
  const candidates: Array<string | null | undefined> = [
    data.claimer_employee_id,
    data.employee_id,
    data.employeeId,
    data.operator_id,
    process.env.RAAS_DEFAULT_EMPLOYEE_ID,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) return c.trim();
  }
  return null;
}

function pickRequisitionId(req: RequirementsAgentViewItem): string | null {
  const cands: unknown[] = [
    (req as any).job_requisition_id,
    (req as any).requisition_id,
    (req as any).job_id,
    (req as any).id,
  ];
  for (const c of cands) {
    if (typeof c === 'string' && c.trim().length > 0) return c.trim();
  }
  return null;
}

function pickClientId(req: RequirementsAgentViewItem): string | undefined {
  const cands: unknown[] = [(req as any).client_id, (req as any).clientId];
  for (const c of cands) {
    if (typeof c === 'string' && c.trim().length > 0) return c.trim();
  }
  return undefined;
}

/**
 * Build resume text for /match-resume input.
 * Priority: parsed.data (stringify) > parsed (stringify) > "" (empty)
 */
function buildResumeText(data: ResumeProcessedData): string {
  const parsed = data.parsed;
  if (parsed && typeof parsed === 'object') {
    if (parsed.data !== undefined) {
      return typeof parsed.data === 'string'
        ? parsed.data
        : JSON.stringify(parsed.data, null, 2);
    }
    return JSON.stringify(parsed, null, 2);
  }
  return '';
}

/**
 * Flatten a RAAS requirement view item into JD text for /match-resume.
 * RequirementsAgentViewItem 字段不固定 (RAAS 可能演进)，用宽松取字段策略。
 */
function flattenRequirementForMatch(req: RequirementsAgentViewItem): string {
  const r = req as Record<string, any>;
  const lines: string[] = [];
  if (r.client_job_title || r.title) {
    lines.push(`职位: ${r.client_job_title ?? r.title}`);
  }
  if (r.expected_level) lines.push(`期望级别: ${r.expected_level}`);
  if (r.work_city || r.city) lines.push(`工作城市: ${r.work_city ?? r.city}`);
  if (r.salary_range) lines.push(`薪资范围: ${r.salary_range}`);
  if (r.recruitment_type) lines.push(`招聘类型: ${r.recruitment_type}`);
  if (r.interview_mode) lines.push(`面试形式: ${r.interview_mode}`);
  if (r.work_years != null) lines.push(`\n工作年限: ${r.work_years} 年`);
  if (r.degree_requirement) lines.push(`学历要求: ${r.degree_requirement}`);
  if (r.education_requirement) lines.push(`专业要求: ${r.education_requirement}`);
  if (r.language_requirements) lines.push(`语言要求: ${r.language_requirements}`);
  if (Array.isArray(r.must_have_skills) && r.must_have_skills.length) {
    lines.push(`\n必备技能:\n  - ${r.must_have_skills.join('\n  - ')}`);
  }
  if (Array.isArray(r.nice_to_have_skills) && r.nice_to_have_skills.length) {
    lines.push(`\n加分技能:\n  - ${r.nice_to_have_skills.join('\n  - ')}`);
  }
  if (r.negative_requirement && r.negative_requirement !== '无') {
    lines.push(`\n排除条件:\n${r.negative_requirement}`);
  }
  if (r.job_responsibility) lines.push(`\n岗位职责:\n${r.job_responsibility}`);
  if (r.job_requirement) lines.push(`\n任职要求:\n${r.job_requirement}`);
  return lines.join('\n');
}

function hasMatchableContent(req: RequirementsAgentViewItem): boolean {
  const r = req as Record<string, any>;
  const hasResp = !!(r.job_responsibility && String(r.job_responsibility).trim());
  const hasReq = !!(r.job_requirement && String(r.job_requirement).trim());
  const hasMustHave = Array.isArray(r.must_have_skills) && r.must_have_skills.length > 0;
  return hasResp || hasReq || hasMustHave;
}

/**
 * 只对"招聘中"状态的 JD 跑 match.
 *
 * agent-view 新签名 (claimer_employee_id 单参数) 把过滤逻辑收回 partner
 * 内部, 我们仍加一道客户端兜底过滤 — 万一 partner 那边返回了非 recruiting
 * 状态的 JD (草稿 / 待发布 / 已关闭), 不浪费 RoboHire match 配额.
 *
 * 状态字段名 partner 文档没明说, 这里覆盖几个常见位:
 *   status / hc_status / requisition_status / spec_status / job_requisition_status
 *
 * 如果 item 完全没有 status 字段 → 默认 include (信任 agent-view 已 curated).
 * 有 status 字段时, 仅 recruiting / 招聘中 / active 才 include.
 */
function isRecruitingStatus(req: RequirementsAgentViewItem): boolean {
  const r = req as Record<string, any>;
  const candidates = [
    r.status,
    r.hc_status,
    r.requisition_status,
    r.spec_status,
    r.job_requisition_status,
  ];
  // 找第一个有值的 status 字段; 全都缺 → 默认 include
  let raw: unknown = undefined;
  for (const c of candidates) {
    if (c != null && String(c).trim() !== '') {
      raw = c;
      break;
    }
  }
  if (raw === undefined) return true;
  const s = String(raw).toLowerCase().trim();
  return s === 'recruiting' || s === '招聘中' || s === 'active' || s === 'open';
}

function sanitizeStepKey(s: string): string {
  return s.replace(/[^A-Za-z0-9-]/g, '-').slice(0, 80) || 'unknown';
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
