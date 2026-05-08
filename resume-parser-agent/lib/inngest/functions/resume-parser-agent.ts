// Function ① — 订阅 RESUME_DOWNLOADED → download PDF → parse → 持久化 → 发 RESUME_PROCESSED
//
// 流程 (per agentic-operator-onboarding v7 §4.8 + ADR-0011 边界):
//   1. RESUME_DOWNLOADED 事件 payload 只带 transport 元数据
//      (upload_id / bucket / object_key / etag / filename / operator_*).
//      raas **不**预先 parse — parse 是 agent 的职责.
//   2. agent → GET /api/v1/resumes/uploads/<upload_id>/raw  (PDF bytes)
//   3. agent → POST /api/v1/parse-resume   (multipart, file=PDF blob)
//   4. agent → POST /api/v1/candidates     (parsed + transport context)
//   5. raas 自动按规则发 RESUME_PROCESSED 给下游 matcher (我们这边
//      也 emit 一份做 dual-track 兜底 — RAAS 那边某些路径还没接 emit).
//
// Backward compat: 如果事件 payload 已经带 parsed.data (legacy 内部
// 路径或 partner 在 emit 前预 parse 过), 直接用事件里的 parsed,
// 跳过 step 2-3.
//
// etag 兜底: 事件里的 etag 可能是 null (RAAS 手动上传链路目前没填),
// agent 在拿到 PDF 字节后用 MD5 算一个本地 etag 作为 saveCandidate
// 的 dedup key.

import { createHash } from 'node:crypto';
import { NonRetriableError } from 'inngest';
import {
  downloadResumeRaw,
  parseResume,
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
    const eventEtag = raw.etag ?? null; // 可能是 null (RAAS 手动上传链路没填)
    const filename = raw.filename;
    const employeeId = raw.employee_id ?? raw.employeeId ?? raw.operator_employee_id ?? null;
    const operator_id = raw.operator_id ?? null;
    const client_id = raw.client_id ?? null;
    const job_requisition_id = raw.job_requisition_id ?? null;
    const mime_type = raw.mime_type ?? raw.contentType ?? 'application/pdf';
    const file_size = raw.size ?? raw.file_size ?? null;
    const traceId = getTraceId(event.data);

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

    logger.info(
      `[resume-persist] received RESUME_DOWNLOADED · upload_id=${upload_id} ` +
        `bucket=${bucket} object_key=${object_key} filename=${filename ?? '—'} ` +
        `etag=${eventEtag ?? 'null'}`,
    );

    // ── 读取 parsed.data (legacy 路径: 事件 payload 已带 parsed) ──
    const parsedFromEvent = pickParsedData(raw);

    // ── 取 parsed + etag, 两条路径择一 ──
    let parsed: RaasParseResumeData;
    let robohireRequestId: string | undefined;
    let computedEtag: string | undefined;

    if (parsedFromEvent) {
      // Legacy: 事件已带 parsed.data, 跳过 download + parse.
      parsed = parsedFromEvent;
      logger.info(
        `[resume-persist] legacy path · 事件已带 parsed.data, 跳过 download+parse · ` +
          `name="${parsed.name ?? '?'}"`,
      );
    } else {
      // v7 §4.8 标准路径: 自己拉 PDF 字节 + 自己 parse.
      const stepKey = sanitize(String(upload_id));
      const downloadAndParse = await step.run(`download-and-parse-${stepKey}`, async () => {
        // 1) GET /api/v1/resumes/uploads/:upload_id/raw
        let downloaded;
        try {
          downloaded = await downloadResumeRaw(String(upload_id), { traceId });
        } catch (e) {
          if (e instanceof RaasApiError && e.isClientError) {
            throw new NonRetriableError(
              `RAAS GET /resumes/uploads/${upload_id}/raw 4xx: ${e.code} ${e.message}`,
            );
          }
          throw e;
        }
        const pdfBuffer = downloaded.pdf;
        logger.info(
          `[resume-persist] downloaded PDF · upload_id=${upload_id} ` +
            `bytes=${pdfBuffer.length} content-type=${downloaded.contentType} ` +
            `filename="${downloaded.filename ?? filename ?? '—'}"`,
        );

        // 2) POST /api/v1/parse-resume (multipart)
        const pdfFilename = downloaded.filename ?? (filename as string | undefined) ?? 'resume.pdf';
        let parseRes;
        try {
          parseRes = await parseResume(pdfBuffer, pdfFilename, { traceId });
        } catch (e) {
          if (e instanceof RaasApiError && e.isClientError) {
            throw new NonRetriableError(
              `RAAS POST /parse-resume 4xx: ${e.code} ${e.message}`,
            );
          }
          throw e;
        }
        logger.info(
          `[resume-persist] parse-resume OK · cached=${parseRes.cached} ` +
            `name="${parseRes.data?.name ?? '?'}" requestId=${parseRes.requestId}`,
        );

        // 3) 算 MD5 etag 作为 saveCandidate dedup 兜底.
        //    返回 primitive 给下个 step (Buffer 不能跨 step.run 序列化).
        const md5 = createHash('md5').update(pdfBuffer).digest('hex');

        return {
          parsed: parseRes.data,
          robohire_request_id: parseRes.requestId,
          computed_etag: md5,
          cached: parseRes.cached,
        };
      });
      parsed = downloadAndParse.parsed;
      robohireRequestId = downloadAndParse.robohire_request_id;
      computedEtag = downloadAndParse.computed_etag;
    }

    // 最终 etag: 事件里的 (string) > 我们算的 MD5 > undefined
    const finalEtag =
      typeof eventEtag === 'string' && eventEtag.trim() ? eventEtag.trim() : computedEtag;

    // ── 调 RAAS API: POST /api/v1/candidates ──
    const saveResult = await step.run('save-candidate', async () => {
      const input: SaveCandidateInput = {
        upload_id: String(upload_id),
        bucket: String(bucket),
        object_key: String(object_key),
        etag: finalEtag,
        mime_type,
        file_size: typeof file_size === 'number' ? file_size : undefined,
        original_filename: filename ?? undefined,
        operator_employee_id: employeeId ?? undefined,
        operator_id: operator_id ?? undefined,
        client_id: client_id ?? undefined,
        job_requisition_id: job_requisition_id ?? undefined,
        parsed,
        robohire_request_id:
          robohireRequestId ?? raw.robohire_request_id ?? raw.parser_request_id ?? undefined,
      };

      try {
        const r = await saveCandidate(input, { traceId });
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
    // Note: 在 v7 §4.8 下,RAAS 自己在 saveCandidate 后也会按规则发
    // RESUME_PROCESSED 给下游 matching 流程. 我们这里 dual-track 也
    // emit 一份做兜底 — 因为 partner 那边的 auto-emit 不一定全路径覆盖.
    // 等 partner 那边稳定后可以去掉这个 emit (TODO @ partner verify).
    const processedPayload: ResumeProcessedData = {
      // 透传 transport 字段供下游使用
      bucket,
      objectKey: object_key,
      filename: (filename ?? 'resume.pdf').trim(),
      hrFolder: raw.hr_folder ?? raw.hrFolder ?? null,
      employeeId,
      etag: finalEtag ?? null,
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
      parserVersion: 'v7-pull-model@2026-05-08',
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

/**
 * 给 step.run 用的 step key sanitizer — Inngest step key 只能是
 * [A-Za-z0-9-_], 上传 id 里的 UUID 自带连字符没问题, 但兜底兼容.
 */
function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 80) || 'unknown';
}
