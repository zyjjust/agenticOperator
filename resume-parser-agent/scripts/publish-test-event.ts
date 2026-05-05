// 手动发一条 RESUME_DOWNLOADED 触发完整流程
// 用法:
//   npm run publish:test                 # 自动从 MinIO 选一份匹配命名模式的简历
//   npm run publish:test -- <objectKey>  # 显式指定 MinIO objectKey

import { Client as MinioClient } from 'minio';
import { inferJdFromFilename } from '../lib/inference/jd-from-filename';
import { inngest } from '../lib/inngest/client';

const BUCKET = process.env.MINIO_DEFAULT_BUCKET ?? 'recruit-resume-raw';
const explicitKey = process.argv[2];

const client = new MinioClient({
  endPoint: process.env.MINIO_ENDPOINT!,
  port: Number(process.env.MINIO_PORT ?? 9000),
  useSSL: process.env.MINIO_USE_SSL === 'true',
  accessKey: process.env.MINIO_ACCESS_KEY!,
  secretKey: process.env.MINIO_SECRET_KEY!,
});

async function pickResume() {
  if (explicitKey) {
    const stat = await client.statObject(BUCKET, explicitKey);
    const filename = explicitKey.split('/').pop() ?? explicitKey;
    return {
      key: explicitKey,
      filename,
      size: stat.size,
      etag: stat.etag ?? null,
    };
  }

  const all: Array<{ key: string; filename: string; size: number; etag: string | null }> = [];
  const stream = client.listObjectsV2(BUCKET, '', true);
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (obj) => {
      if (!obj.name?.toLowerCase().endsWith('.pdf')) return;
      const filename = obj.name.split('/').pop() ?? obj.name;
      if (!inferJdFromFilename(filename)) return; // 必须能从 filename 推 JD
      if (obj.size > 500_000) return; // 优先小文件
      all.push({ key: obj.name, filename, size: obj.size, etag: obj.etag ?? null });
    });
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });

  if (all.length === 0) {
    throw new Error('没找到符合命名模式的小 PDF。可手动指定 objectKey。');
  }
  return all[Math.floor(Math.random() * all.length)];
}

(async () => {
  const picked = await pickResume();

  console.log(`[publish] 选定简历：`);
  console.log(`  bucket=${BUCKET}`);
  console.log(`  key=${picked.key}`);
  console.log(`  filename=${picked.filename}`);
  console.log(`  size=${picked.size} bytes`);
  console.log(`  etag=${picked.etag}`);
  console.log('');

  // 本地测试发的事件要和 RAAS canonical envelope 形状一致 — 这样 parser
  // 走的 unwrap 路径和生产环境完全相同，测试就有意义。
  // upload_id 用 etag (or objectKey hash) 兜底；employee_id 走 env
  // RAAS_DEFAULT_EMPLOYEE_ID（matchResume 在缺 employee_id 时也会读这个）。
  const fallbackUploadId = picked.etag ?? `local-${Buffer.from(picked.key).toString('base64url').slice(0, 16)}`;
  const fallbackEmployeeId = process.env.RAAS_DEFAULT_EMPLOYEE_ID ?? 'EMP-TEST';
  const eventId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  const result = await inngest.send({
    name: 'RESUME_DOWNLOADED',
    data: {
      // envelope-level metadata
      entity_id: null,
      entity_type: 'Candidate',
      event_id: eventId,
      // flat fields RAAS puts inside payload
      payload: {
        bucket: BUCKET,
        candidate_id: null,
        candidate_name: null,
        employee_id: fallbackEmployeeId,
        etag: picked.etag,
        filename: picked.filename,
        hr_folder: null,
        ip_address: '127.0.0.1',
        object_key: picked.key,
        operator_id: fallbackEmployeeId,
        operator_name: 'AO Tester (local publish:test)',
        operator_role: 'recruiter',
        received_at: new Date().toISOString(),
        resume_file_path: picked.key,
        size: picked.size,
        source_event_name: null,
        source_label: 'local publish:test',
        summary_prefix: '/scripts/publish-test-event',
        upload_id: fallbackUploadId,
      },
      trace: {
        parent_trace_id: null,
        request_id: null,
        trace_id: null,
        workflow_id: null,
      },
    } as any,  // ResumeDownloadedData type is flat; envelope is for runtime path
  });

  console.log(`[publish] ✅ sent RESUME_DOWNLOADED`);
  console.log(`  inngest event ids: ${JSON.stringify(result.ids)}`);
  console.log('');
  console.log('观察:');
  console.log('  1. 终端 (agent stdout) 看 [parser] / [matcher] 日志');
  console.log('  2. http://10.100.0.70:8288/stream 看事件流');
  console.log('  3. http://10.100.0.70:8288/functions 看 function run 详情');
})().catch((e) => {
  console.error('[publish] FAIL:', e);
  process.exit(1);
});
