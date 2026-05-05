// 从 MinIO 中挑一份匹配 filename 模式的简历，输出可直接喂给 publish:test 的字段

import { Client as MinioClient } from 'minio';
import { inferJdFromFilename } from '../lib/inference/jd-from-filename';

const client = new MinioClient({
  endPoint: process.env.MINIO_ENDPOINT!,
  port: Number(process.env.MINIO_PORT ?? 9000),
  useSSL: process.env.MINIO_USE_SSL === 'true',
  accessKey: process.env.MINIO_ACCESS_KEY!,
  secretKey: process.env.MINIO_SECRET_KEY!,
});

const BUCKET = process.env.MINIO_DEFAULT_BUCKET ?? 'recruit-resume-raw';

(async () => {
  const all: Array<{ key: string; filename: string; size: number; etag?: string }> = [];
  const stream = client.listObjectsV2(BUCKET, '', true);
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (obj) => {
      if (!obj.name?.toLowerCase().endsWith('.pdf')) return;
      const filename = obj.name.split('/').pop() ?? obj.name;
      all.push({
        key: obj.name,
        filename,
        size: obj.size,
        etag: obj.etag,
      });
    });
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });

  // 找符合 filename 模式（【...】姓名 年限.pdf）的
  const matchable = all.filter((it) => inferJdFromFilename(it.filename) !== null);

  if (matchable.length === 0) {
    console.error('没找到符合命名模式的 PDF（应为：【职位_城市 薪资】姓名 年限.pdf）');
    console.error(`在 ${all.length} 份 PDF 里搜过`);
    process.exit(1);
  }

  // 优先选小文件（< 500KB），快
  const small = matchable.filter((it) => it.size < 500_000);
  const candidates = small.length > 0 ? small : matchable;

  // 随机一份
  const picked = candidates[Math.floor(Math.random() * candidates.length)];
  const inferred = inferJdFromFilename(picked.filename)!;

  console.log('━━━ 推荐用作测试的简历 ━━━');
  console.log(`bucket:     ${BUCKET}`);
  console.log(`objectKey:  ${picked.key}`);
  console.log(`filename:   ${picked.filename}`);
  console.log(`size:       ${picked.size} (${(picked.size / 1024).toFixed(0)}KB)`);
  console.log(`etag:       ${picked.etag ?? '(none)'}`);
  console.log('');
  console.log('从 filename 推断出的 JD:');
  console.log(`  jobTitle: ${inferred.jobTitle}`);
  console.log(`  city:     ${inferred.city}`);
  console.log(`  salary:   ${inferred.salaryRange}`);
  console.log(`  candidate (filename 显示的): ${inferred.candidateName}`);
  console.log('');
  console.log('如要直接发测试事件:');
  console.log(`  npm run publish:test -- "${picked.key}"`);
  console.log('');

  // 也输出一份完整 JSON payload 方便手动 copy 进 Inngest UI
  console.log('完整 RESUME_DOWNLOADED payload:');
  console.log(
    JSON.stringify(
      {
        name: 'RESUME_DOWNLOADED',
        data: {
          bucket: BUCKET,
          objectKey: picked.key,
          filename: picked.filename,
          hrFolder: null,
          employeeId: null,
          etag: picked.etag ?? null,
          size: picked.size,
          sourceEventName: null,
          receivedAt: new Date().toISOString(),
        },
      },
      null,
      2
    )
  );
})().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});
