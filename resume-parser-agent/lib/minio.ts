import { Client as MinioClient } from 'minio';

let cached: MinioClient | null = null;

export function getMinioClient(): MinioClient {
  if (cached) return cached;
  cached = new MinioClient({
    endPoint: process.env.MINIO_ENDPOINT!,
    port: Number(process.env.MINIO_PORT ?? 9000),
    useSSL: process.env.MINIO_USE_SSL === 'true',
    accessKey: process.env.MINIO_ACCESS_KEY!,
    secretKey: process.env.MINIO_SECRET_KEY!,
  });
  return cached;
}

export async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function getResumeBuffer(bucket: string, objectKey: string): Promise<Buffer> {
  const client = getMinioClient();
  const stream = await client.getObject(bucket, objectKey);
  return streamToBuffer(stream);
}

export type MinioObjectMeta = {
  bucket: string;
  objectKey: string;
  size: number;
  etag: string | null;
  contentType: string | null;
  lastModified: string;
};

export async function statResume(bucket: string, objectKey: string): Promise<MinioObjectMeta> {
  const client = getMinioClient();
  const stat = await client.statObject(bucket, objectKey);
  return {
    bucket,
    objectKey,
    size: stat.size,
    etag: stat.etag ?? null,
    contentType: (stat.metaData?.['content-type'] as string | undefined) ?? null,
    lastModified: stat.lastModified.toISOString(),
  };
}
