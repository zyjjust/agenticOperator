// matchResume agent — Workflow node 10.
//
// Subscribes to RESUME_PROCESSED, fetches every requirement claimed by the
// recruiter (employee_id from the inbound payload) via RAAS Internal API,
// then loops and scores the resume against each via RoboHire /match-resume.
// Each iteration emits a MATCH_PASSED_NEED_INTERVIEW event whose payload is
// `{ upload_id, job_requisition_id, ...full RoboHire response }`.
//
// Inbound:  RESUME_PROCESSED { upload_id, employee_id, parsed: { data }, ... }
// Outbound: MATCH_PASSED_NEED_INTERVIEW (one per matched requirement)
//
// Behavior decisions (locked-in by user):
//   - Single outcome event type (MATCH_PASSED_NEED_INTERVIEW) — no score-
//     based fan-out to MATCH_PASSED_NO_INTERVIEW / MATCH_FAILED.
//   - When the recruiter has 0 matchable requirements → return silently,
//     emit nothing.
//   - JD text comes ONLY from RAAS Internal API. No filename inference,
//     no local DB cache, no LLM fallback.

import { NonRetriableError } from 'inngest';
import { flattenResumeForMatch } from '../../mappers/flatten-resume';
import {
  RaasInternalApiError,
  flattenRequirementForMatch,
  hasMatchableContent,
  isRaasInternalApiConfigured,
  listAllRequirements,
  type RaasRequirement,
} from '../../raas-internal';
import {
  RoboHireNonRetryableError,
  matchResumeToJd,
  type RoboHireMatchResponse,
} from '../../robohire';
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
    // RESUME_PROCESSED 在两种 shape 下都要 work：
    //   A) 平铺 — 我们自己 parser 发出的：{ upload_id, employee_id, parsed, ... }
    //   B) envelope — RAAS-canonical 的：{ entity_id, entity_type, event_id,
    //      payload: { upload_id, employee_id, parsed, ... }, trace }
    // 这里把 envelope 的 payload 拆出来，与平铺字段合并，让下游统一处理。
    const data = unwrapResumeProcessedEvent(event.data);

    // ── 1. 抽取并保存 upload_id / employee_id ──────────────
    // RESUME_PROCESSED 在不同上游版本里 employee_id 可能是 snake_case
    // (RAAS canonical) 或 camelCase (本仓库 parser 历史)，两个都试。
    const uploadId = pickUploadId(data);
    const employeeId = pickEmployeeId(data);

    if (!uploadId) {
      throw new NonRetriableError(
        `[${AGENT_NAME}] RESUME_PROCESSED missing upload_id — cannot anchor MATCH_* events. data keys=${Object.keys(data).join(',')}`,
      );
    }
    if (!employeeId) {
      throw new NonRetriableError(
        `[${AGENT_NAME}] RESUME_PROCESSED missing employee_id / employeeId — cannot resolve recruiter's requirements`,
      );
    }
    if (!isRaasInternalApiConfigured()) {
      throw new NonRetriableError(
        `[${AGENT_NAME}] RAAS_INTERNAL_API_URL / RAAS_AGENT_API_KEY env vars not set`,
      );
    }

    logger.info(
      `[${AGENT_NAME}] received RESUME_PROCESSED · upload_id=${uploadId} employee_id=${employeeId} filename="${data.filename ?? '—'}"`,
    );

    // ── 2. resumeText：优先用 payload.parsed，缺失时回退到结构化字段 ──
    const resumeText = await step.run('build-resume-text', async () => {
      const text = buildResumeText(data);
      logger.info(`[${AGENT_NAME}] built resume text · ${text.length} chars`);
      return text;
    });

    if (!resumeText.trim()) {
      throw new NonRetriableError(
        `[${AGENT_NAME}] resume text is empty — neither parsed nor structured fields had usable content`,
      );
    }

    // ── 3. 拉 RAAS 这位招聘人员名下的全部在招需求 ──────────
    const requirements = await step.run('list-requirements', async () => {
      const all = await listAllRequirements({
        claimerEmployeeId: employeeId,
        scope: 'claimed',
        status: 'recruiting',
        pageSize: 100,
      });
      const matchable = all.filter(hasMatchableContent);
      logger.info(
        `[${AGENT_NAME}] RAAS returned ${all.length} requirement(s); ${matchable.length} matchable`,
      );
      return matchable;
    });

    // 空集 → 不 emit、直接返回 (per user spec Q2 = A)
    if (requirements.length === 0) {
      logger.warn(
        `[${AGENT_NAME}] employee_id=${employeeId} has 0 matchable requirements — emitting nothing`,
      );
      return {
        ok: true,
        upload_id: uploadId,
        employee_id: employeeId,
        matched_count: 0,
        emitted_count: 0,
        reason: 'no-matchable-requirements',
      };
    }

    // ── 4. 循环：每条需求一次 RoboHire match → emit 一条事件 ──
    const summaries: Array<{
      job_requisition_id: string;
      ok: boolean;
      requestId?: string;
      error?: string;
    }> = [];

    for (const req of requirements) {
      const stepKey = sanitizeStepKey(req.job_requisition_id);

      // 单个需求的 match + emit 包成两个 step.run，让 Inngest 的
      // memoization 能在重试时跳过已成功的步骤。
      const matchResult = await step.run(
        `match-${stepKey}`,
        async (): Promise<{ ok: true; response: RoboHireMatchResponse } | { ok: false; error: string }> => {
          const jdText = flattenRequirementForMatch(req);
          logger.info(
            `[${AGENT_NAME}] calling RoboHire /match-resume · job_req=${req.job_requisition_id} title="${req.client_job_title}" jd_chars=${jdText.length}`,
          );
          try {
            const r = await matchResumeToJd({
              resume: resumeText,
              jd: jdText,
            });
            logger.info(
              `[${AGENT_NAME}] RoboHire OK · job_req=${req.job_requisition_id} score=${r.data?.matchScore} rec=${r.data?.recommendation} requestId=${r.requestId}`,
            );
            return { ok: true as const, response: r };
          } catch (e) {
            // Non-retryable (4xx besides 429) → log + skip this JD,
            // continue with the rest. Don't bubble to NonRetriableError
            // because we don't want to abort the whole roster on one
            // bad JD.
            if (e instanceof RoboHireNonRetryableError) {
              logger.error(
                `[${AGENT_NAME}] RoboHire NON-RETRYABLE · job_req=${req.job_requisition_id} status=${e.status} — skipping`,
              );
              return { ok: false as const, error: e.message };
            }
            // Retryable (5xx / 429 / network) → throw inside step.run so
            // Inngest retries this single step (not the whole function).
            throw e;
          }
        },
      );

      if (!matchResult.ok) {
        summaries.push({
          job_requisition_id: req.job_requisition_id,
          ok: false,
          error: matchResult.error,
        });
        continue;
      }

      const response = matchResult.response;

      // payload = { upload_id, job_requisition_id, ...full RoboHire response }
      const payload: MatchPassedNeedInterviewData = {
        upload_id: uploadId,
        job_requisition_id: req.job_requisition_id,
        success: response.success,
        data: response.data as Record<string, unknown> | undefined,
        requestId: response.requestId,
        savedAs: response.savedAs,
        error: response.error,
      };

      await step.sendEvent(`emit-match-${stepKey}`, {
        name: 'MATCH_PASSED_NEED_INTERVIEW',
        data: payload,
      });

      summaries.push({
        job_requisition_id: req.job_requisition_id,
        ok: true,
        requestId: response.requestId,
      });

      logger.info(
        `[${AGENT_NAME}] ✅ emitted MATCH_PASSED_NEED_INTERVIEW · upload_id=${uploadId} job_req=${req.job_requisition_id}`,
      );
    }

    const emitted = summaries.filter((s) => s.ok).length;
    return {
      ok: true,
      upload_id: uploadId,
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

/**
 * RESUME_PROCESSED comes in two shapes:
 *   A) flat — our own parser: { upload_id, employee_id, parsed, ... }
 *   B) envelope — RAAS canonical: { entity_id, entity_type, event_id,
 *      payload: {...flat fields...}, trace }
 * Detect envelope by presence of a `payload` object and return the
 * inner fields merged with envelope-level metadata. Flat input is
 * returned unchanged.
 */
function unwrapResumeProcessedEvent(raw: unknown): ResumeProcessedData {
  if (!raw || typeof raw !== 'object') {
    return raw as ResumeProcessedData;
  }
  const r = raw as Record<string, unknown>;
  if (
    r.payload &&
    typeof r.payload === 'object' &&
    !Array.isArray(r.payload)
  ) {
    // Envelope shape — promote payload fields, keep envelope metadata
    // alongside (in case downstream wants entity_id / trace).
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

/**
 * Pull `upload_id` from the inbound event payload.
 *
 * Try the explicit field first (only present in our own parser's output
 * today), then fall back to RAAS-canonical anchors that uniquely identify
 * the resume-upload row: `etag` and `object_key`. RAAS does NOT include
 * a literal `upload_id` field on RESUME_PROCESSED — they reverse-look up
 * candidate by (bucket, object_key, etag) instead.
 */
function pickUploadId(
  data: ResumeProcessedData & {
    uploadId?: string;
    object_key?: string;
    objectKey?: string;
  },
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

/**
 * Pull recruiter `employee_id`. RAAS canonical uses `claimer_employee_id`
 * (the recruiter who CLAIMED the requirement), distinct from `operator_id`
 * (the human who triggered the action). Order:
 *   1. claimer_employee_id  — RAAS canonical
 *   2. employee_id          — alternative snake_case
 *   3. employeeId           — this repo's historical camelCase
 *   4. operator_id          — fallback to action-triggerer
 *   5. RAAS_DEFAULT_EMPLOYEE_ID env — testing fallback
 */
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

/**
 * Build the `resume` plain-text input for RoboHire /match-resume.
 *
 * Priority:
 *   1. payload.parsed.data — RoboHire-shape JSON, stringified
 *   2. payload.parsed      — already a string OR object
 *   3. flattenResumeForMatch(payload) — derived from candidate / resume /
 *      runtime structured fields (this repo's current parser output)
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
  // Fallback — current parser emits structured fields, no parsed wrapper.
  return flattenResumeForMatch(data);
}

/** Inngest step IDs must be stable; sanitize requisition IDs to be safe. */
function sanitizeStepKey(s: string): string {
  return s.replace(/[^A-Za-z0-9-]/g, '-').slice(0, 80) || 'unknown';
}

// Re-export for tests / other consumers that might want them.
export type { RaasRequirement };
export { RaasInternalApiError };
