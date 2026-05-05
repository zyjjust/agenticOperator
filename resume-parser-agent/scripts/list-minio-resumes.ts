// 列 recruit-resume-raw bucket 里的 PDF 简历

import { Client as MinioClient } from 'minio';

const client = new MinioClient({
  endPoint: process.env.MINIO_ENDPOINT!,
  port: Number(process.env.MINIO_PORT ?? 9000),
  useSSL: process.env.MINIO_USE_SSL === 'true',
  accessKey: process.env.MINIO_ACCESS_KEY!,
  secretKey: process.env.MINIO_SECRET_KEY!,
});

const BUCKET = process.env.MINIO_DEFAULT_BUCKET ?? 'recruit-resume-raw';
const LIMIT = Number(process.argv[2] ?? '20');

(async () => {
  console.log(`[list-minio] bucket=${BUCKET} limit=${LIMIT}\n`);
  const items: { key: string; size: number; modified: string }[] = [];
  const stream = client.listObjectsV2(BUCKET, '', true);

  await new Promise<void>((resolve, reject) => {
    stream.on('data', (obj) => {
      if (!obj.name) return;
      if (!obj.name.toLowerCase().endsWith('.pdf')) return;
      if (items.length < LIMIT) {
        items.push({
          key: obj.name,
          size: obj.size,
          modified: obj.lastModified?.toISOString() ?? '',
        });
      }
    });
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });

  console.log(`找到 ${items.length} 份 PDF（前 ${LIMIT} 条）：\n`);
  for (const item of items) {
    const sizeKb = (item.size / 1024).toFixed(0);
    console.log(`  ${item.key}  (${sizeKb}KB)`);
  }
})().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});
