// Function ① — 订阅 RESUME_DOWNLOADED → 解析 → 发 RESUME_PROCESSED
// 路径: MinIO objectKey → getObject → Buffer → multipart Blob → RoboHire /parse-resume

import { NonRetriableError } from 'inngest';
import {
  hasStructuredResumePayload,
  mapRobohireToRaas,
} from '../../mappers/robohire-to-raas';
import { getResumeBuffer, statResume } from '../../minio';
import { parseResumePdf, RoboHireNonRetryableError } from '../../robohire';
import { inngest, PARSER_VERSION, type ResumeProcessedData } from '../client';

export const resumeParserAgent = inngest.createFunction(
  {
    id: 'resume-parser-agent',
    name: 'Resume Parser Agent',
    retries: 0, // D5: LLM 失败不自动重试
  },
  { event: 'RESUME_DOWNLOADED' },
  async ({ event, step, logger }) => {
    // RESUME_DOWNLOADED comes in two shapes:
    //   A) RAAS canonical envelope —
    //      { entity_id, entity_type, event_id, payload: { bucket,
    //        object_key, upload_id, employee_id, filename, etag, ... },
    //        trace }
    //   B) Flat (legacy / publish-test simulation) —
    //      { bucket, objectKey, employeeId, etag, filename, upload_id, ... }
    // Unwrap envelope first, then read fields tolerating snake_case OR
    // camelCase. RAAS canonical uses snake_case.
    const raw = unwrapDownloadedEnvelope(event.data);

    const bucket = raw.bucket;
    const objectKey = raw.object_key ?? raw.objectKey;
    const filename = raw.filename;
    const employeeId = raw.employee_id ?? raw.employeeId ?? null;
    const hrFolder = raw.hr_folder ?? raw.hrFolder ?? null;
    const etag = raw.etag ?? null;
    const upload_id = raw.upload_id ?? raw.uploadId;
    const size = raw.size ?? null;
    const sourceEventName = raw.source_event_name ?? raw.sourceEventName ?? null;
    const receivedAt = raw.received_at ?? raw.receivedAt ?? new Date().toISOString();

    if (!bucket || !objectKey) {
      throw new NonRetriableError(
        `Event missing bucket/object_key after envelope unwrap — raw keys=${Object.keys(raw).join(',')}`
      );
    }
    if (!filename) {
      throw new NonRetriableError(
        `Event missing filename — cannot pick MIME / call RoboHire`
      );
    }

    logger.info(
      `[parser] received bucket=${bucket} key=${objectKey} hr=${hrFolder} employeeId=${employeeId} etag=${etag} upload_id=${upload_id ?? '—'}`
    );

    // 1. MinIO 元数据
    const meta = await step.run('stat-minio-object', async () => {
      const m = await statResume(bucket, objectKey);
      logger.info(`[parser] stat OK size=${m.size} contentType=${m.contentType} etag=${m.etag}`);
      return m;
    });

    // 2. 仅支持 PDF
    if (!filename || !filename.toLowerCase().endsWith('.pdf')) {
      throw new NonRetriableError(`Unsupported file format: ${filename}. RoboHire 只接受 PDF。`);
    }
    if (meta.size > 10 * 1024 * 1024) {
      throw new NonRetriableError(`File too large: ${meta.size} bytes (>10MB).`);
    }

    // 3. 从 MinIO 拉 PDF 字节
    const pdfBase64 = await step.run('fetch-from-minio', async () => {
      const buf = await getResumeBuffer(bucket, objectKey);
      logger.info(`[parser] fetched ${buf.length} bytes from ${bucket}/${objectKey}`);
      return buf.toString('base64');
    });

    // 4. PDF Buffer → Blob → RoboHire /parse-resume
    const robohireResult = await step.run('robohire-parse', async () => {
      const buf = Buffer.from(pdfBase64, 'base64');
      const cleanFilename = filename.trim();
      logger.info(
        `[parser] calling RoboHire /parse-resume buffer=${buf.length}b filename="${cleanFilename}"`
      );
      try {
        const r = await parseResumePdf(buf, cleanFilename);
        logger.info(
          `[parser] RoboHire OK requestId=${r.requestId} cached=${r.cached} ` +
            `name="${r.data?.name ?? '?'}" skills=${r.data?.skills?.length ?? 0}`
        );
        return r;
      } catch (e) {
        if (e instanceof RoboHireNonRetryableError) {
          throw new NonRetriableError(e.message);
        }
        throw e;
      }
    });

    if (!robohireResult.data) {
      throw new NonRetriableError('RoboHire returned success=true but no data');
    }

    // 5. 映射到 RAAS schema (4 对象嵌套)
    const mapped = await step.run('map-to-raas-schema', async () => {
      const m = mapRobohireToRaas(robohireResult.data!);
      logger.info(
        `[parser] mapped: name=${m.candidate.name} mobile=${m.candidate.mobile} ` +
          `email=${m.candidate.email} skills=${m.candidate.skills.length} ` +
          `years=${m.candidate.work_years} cur=${m.runtime.current_title}@${m.runtime.current_company}`
      );
      return m;
    });

    // 6. sanity check
    if (!hasStructuredResumePayload(mapped)) {
      throw new Error('Resume parser returned no structured candidate data (sanity check failed)');
    }

    // 7. 发出 RESUME_PROCESSED
    const processedAt = new Date().toISOString();
    // upload_id：优先用上游带的，缺失时用 etag 兜底（保证 matchResume 一定能拿到 anchor）
    const resolvedUploadId =
      (typeof upload_id === 'string' && upload_id.trim().length > 0 && upload_id.trim()) ||
      (etag && etag.trim().length > 0 && etag.trim()) ||
      undefined;

    const payload: ResumeProcessedData = {
      bucket,
      objectKey,
      filename: filename.trim(),
      hrFolder,
      employeeId,
      etag,
      size,
      sourceEventName,
      receivedAt,
      candidate: mapped.candidate,
      candidate_expectation: mapped.candidate_expectation,
      resume: mapped.resume,
      runtime: mapped.runtime,
      parsedAt: processedAt,
      parserVersion: PARSER_VERSION,
      // ── matchResume 需要的字段 ──
      upload_id: resolvedUploadId,
      // employee_id (snake_case) 与 employeeId (camelCase) 都带上 — 下游
      // matchResume 两个都试，但 RAAS canonical 是 snake_case。
      employee_id: employeeId ?? undefined,
      // 把 RoboHire 解析结果原样塞进 parsed.data，让 matchResume 无须再
      // 反推结构化字段，可以直接 stringify 出 resumeText。
      parsed: { data: robohireResult.data as unknown as Record<string, unknown> },
    };

    await step.sendEvent('emit-resume-processed', {
      name: 'RESUME_PROCESSED',
      data: payload,
    });

    logger.info(
      `[parser] ✅ emitted RESUME_PROCESSED — candidate="${mapped.candidate.name}" ` +
        `requestId=${robohireResult.requestId}`
    );

    return {
      ok: true,
      candidateName: mapped.candidate.name,
      candidateMobile: mapped.candidate.mobile,
      skills: mapped.candidate.skills.length,
      robohireRequestId: robohireResult.requestId ?? null,
      cached: robohireResult.cached ?? false,
    };
  }
);

/**
 * Unwrap RAAS-canonical envelope shape to flat fields.
 *
 * Envelope: { entity_id, entity_type, event_id, payload: {...}, trace }
 * Flat:     { bucket, objectKey, ... }
 *
 * Returns a record with both raw payload fields AND envelope-level metadata
 * available under `_envelope_*` keys. Caller can read snake_case OR
 * camelCase since both shapes coexist.
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
