// Function ① — 订阅 RESUME_DOWNLOADED → 持久化简历到 RAAS DB → 发 RESUME_PROCESSED
//
// Workflow A (per agentic-operator-onboarding(3).md + 用户指示 2026-05-08):
//   • Frontend 上传 PDF → RAAS API Server 内部完成 parse-resume + 存 MinIO
//   • RAAS 把 parse 结果 (parsed.data) 直接放进 RESUME_DOWNLOADED 事件 payload
//   • 我们这个 agent 只负责:
//       1) 从事件 payload 读 parsed.data
//       2) 调 POST /api/v1/candidates 持久化 (RAAS DB 写 Candidate / Resume / Application)
//       3) emit RESUME_PROCESSED 触发下游 matcher
//
// 跟之前版本的差别:
//   ❌ 不再连 MinIO (lib/minio.ts 退役)
//   ❌ 不再调 RoboHire /parse-resume (lib/robohire.ts 退役)
//   ❌ 不再做 mapRobohireToRaas 字段重映射 (RAAS 自己处理)
//   ✅ 新增: 调 raas-api-client.saveCandidate

import { NonRetriableError } from 'inngest';
import {
  saveCandidate,
  RaasApiError,
  type RaasParseResumeData,
  type SaveCandidateInput,
} from '../../raas-api-client';
import { inngest, type ResumeProcessedData } from '../client';

export const resumeParserAgent = inngest.createFunction(
  {
    id: 'resume-parser-agent',
    name: 'Resume Parser Agent',
    retries: 0, // RAAS API 失败不自动重试，避免重复扣配额 / 重写 DB
  },
  { event: 'RESUME_DOWNLOADED' },
  async ({ event, step, logger }) => {
    // RESUME_DOWNLOADED 兼容两种 shape:
    //   A) RAAS canonical envelope —
    //      { entity_id, entity_type, event_id, payload: { ... }, trace }
    //   B) Flat (legacy / publish-test) —
    //      { upload_id, bucket, object_key, parsed, ... }
    const raw = unwrapDownloadedEnvelope(event.data);

    // ── 提取 anchor 字段 ──
    const upload_id = raw.upload_id ?? raw.uploadId;
    const bucket = raw.bucket;
    const object_key = raw.object_key ?? raw.objectKey;
    const etag = raw.etag ?? null;
    const filename = raw.filename;
    const employeeId = raw.employee_id ?? raw.employeeId ?? raw.operator_employee_id ?? null;
    const operator_id = raw.operator_id ?? null;
    const client_id = raw.client_id ?? null;
    const job_requisition_id = raw.job_requisition_id ?? null;
    const mime_type = raw.mime_type ?? raw.contentType ?? 'application/pdf';
    const file_size = raw.size ?? raw.file_size ?? null;

    if (!upload_id) {
      throw new NonRetriableError(
        `RESUME_DOWNLOADED missing upload_id — cannot anchor saveCandidate. data keys=${Object.keys(raw).join(',')}`,
      );
    }
    if (!bucket || !object_key) {
      throw new NonRetriableError(
        `RESUME_DOWNLOADED missing bucket/object_key — RAAS 端 saveCandidate 需要这两个字段做 Resume 去重`,
      );
    }

    // ── 读取 parsed.data (Workflow A 假设 RAAS 在 emit 事件前已 parse) ──
    const parsed = pickParsedData(raw);
    if (!parsed) {
      throw new NonRetriableError(
        `RESUME_DOWNLOADED 缺 parsed.data — Workflow A 要求 RAAS 在上传时已 parse-resume 并把结果放进 event payload。检查 frontend 上传链路 / RAAS API Server 的 publish 逻辑。raw keys=${Object.keys(raw).join(',')}`,
      );
    }

    logger.info(
      `[resume-persist] received RESUME_DOWNLOADED · upload_id=${upload_id} ` +
        `bucket=${bucket} object_key=${object_key} filename=${filename ?? '—'} ` +
        `parsed.name="${parsed.name ?? '?'}"`,
    );

    // ── 调 RAAS API: POST /api/v1/candidates ──
    const saveResult = await step.run('save-candidate', async () => {
      const input: SaveCandidateInput = {
        upload_id,
        bucket,
        object_key,
        etag: typeof etag === 'string' ? etag : undefined,
        mime_type,
        file_size: typeof file_size === 'number' ? file_size : undefined,
        original_filename: filename ?? undefined,
        operator_employee_id: employeeId ?? undefined,
        operator_id: operator_id ?? undefined,
        client_id: client_id ?? undefined,
        job_requisition_id: job_requisition_id ?? undefined,
        parsed,
        robohire_request_id: raw.robohire_request_id ?? raw.parser_request_id ?? undefined,
      };

      try {
        const r = await saveCandidate(input, {
          traceId: getTraceId(event.data),
        });
        logger.info(
          `[resume-persist] ✅ saveCandidate OK · candidate_id=${r.candidate_id} ` +
            `resume_id=${r.resume_id ?? '—'} is_new_candidate=${r.is_new_candidate ?? '?'} ` +
            `is_new_resume=${r.is_new_resume ?? '?'}`,
        );
        return r;
      } catch (e) {
        if (e instanceof RaasApiError && e.isClientError) {
          // 4xx (除 429) → agent payload 问题，不重试
          throw new NonRetriableError(
            `RAAS saveCandidate 4xx: ${e.code} ${e.message}`,
          );
        }
        // 5xx / 429 / 网络 → 让 Inngest step.run 重试
        throw e;
      }
    });

    // ── emit RESUME_PROCESSED 触发下游 matcher ──
    // Note: 在 Workflow A 下，RESUME_PROCESSED 的语义从"parse 完了"变成
    // "资料已落 RAAS DB，可以触发匹配"。下游 matcher 只关心 upload_id 跟
    // candidate_id，不再需要 parsed.data 全文 (matcher 自己调 RAAS match-resume
    // 时会用 jd 文本，简历内容可以从 saveCandidate 返回的 candidate_id 反查).
    const processedPayload: ResumeProcessedData = {
      // 透传 transport 字段供下游使用
      bucket,
      objectKey: object_key,
      filename: (filename ?? 'resume.pdf').trim(),
      hrFolder: raw.hr_folder ?? raw.hrFolder ?? null,
      employeeId,
      etag,
      size: typeof file_size === 'number' ? file_size : null,
      sourceEventName: raw.source_event_name ?? raw.sourceEventName ?? null,
      receivedAt: raw.received_at ?? raw.receivedAt ?? new Date().toISOString(),
      // 给 matcher 用的 anchor
      upload_id,
      employee_id: employeeId ?? undefined,
      // parsed.data 透传 (matcher 仍可以用作 resume text 来源)
      parsed: { data: parsed as unknown as Record<string, unknown> },
      // 持久化的产物 — 让下游知道 candidate_id 已经存在
      candidate_id: saveResult.candidate_id,
      resume_id: saveResult.resume_id,
      // 老的 4 对象嵌套字段保留为空 (RAAS 不再要求 agent 转结构)
      candidate: {} as ResumeProcessedData['candidate'],
      candidate_expectation: {} as ResumeProcessedData['candidate_expectation'],
      resume: {} as ResumeProcessedData['resume'],
      runtime: {} as ResumeProcessedData['runtime'],
      parsedAt: new Date().toISOString(),
      parserVersion: 'workflow-a@2026-05-08',
    };

    await step.sendEvent('emit-resume-processed', {
      name: 'RESUME_PROCESSED',
      data: processedPayload,
    });

    logger.info(
      `[resume-persist] ✅ emitted RESUME_PROCESSED · upload_id=${upload_id} ` +
        `candidate_id=${saveResult.candidate_id}`,
    );

    return {
      ok: true,
      upload_id,
      candidate_id: saveResult.candidate_id,
      candidate_name: saveResult.candidate_name,
      resume_id: saveResult.resume_id,
      is_new_candidate: saveResult.is_new_candidate,
      is_new_resume: saveResult.is_new_resume,
    };
  },
);

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * Unwrap RAAS-canonical envelope shape to flat fields.
 *
 * Envelope: { entity_id, entity_type, event_id, payload: {...}, trace }
 * Flat:     { bucket, objectKey, ... }
 */
function unwrapDownloadedEnvelope(raw: unknown): Record<string, any> {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, any>;
  if (r.payload && typeof r.payload === 'object' && !Array.isArray(r.payload)) {
    return {
      ...(r.payload as Record<string, any>),
      _envelope_entity_id: r.entity_id,
      _envelope_entity_type: r.entity_type,
      _envelope_event_id: r.event_id,
      _envelope_trace: r.trace,
    };
  }
  return r;
}

/**
 * 多种 shape 兼容地提取 RoboHire parsed.data:
 *   A) raw.parsed.data         — 标准 (RoboHire data spread under .parsed)
 *   B) raw.parsed              — RoboHire data 直接放在 .parsed
 *   C) raw.parsed_data         — snake_case 变体
 *   D) raw.parser.data         — 偶发的 .parser 包装
 */
function pickParsedData(raw: Record<string, any>): RaasParseResumeData | null {
  if (raw.parsed && typeof raw.parsed === 'object') {
    if (raw.parsed.data && typeof raw.parsed.data === 'object') {
      return raw.parsed.data as RaasParseResumeData;
    }
    // 直接是 parsed object 本身
    if (typeof raw.parsed.name === 'string' || Array.isArray(raw.parsed.experience)) {
      return raw.parsed as RaasParseResumeData;
    }
  }
  if (raw.parsed_data && typeof raw.parsed_data === 'object') {
    return raw.parsed_data as RaasParseResumeData;
  }
  if (raw.parser && typeof raw.parser === 'object' && raw.parser.data) {
    return raw.parser.data as RaasParseResumeData;
  }
  return null;
}

/** 提取 trace_id 给 RAAS API X-Trace-Id header 用 */
function getTraceId(eventData: unknown): string | undefined {
  if (!eventData || typeof eventData !== 'object') return undefined;
  const r = eventData as Record<string, any>;
  const t = r.trace;
  if (t && typeof t === 'object' && typeof t.trace_id === 'string' && t.trace_id) {
    return t.trace_id;
  }
  return undefined;
}
