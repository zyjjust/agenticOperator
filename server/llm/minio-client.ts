// MinIO client singleton — used by processResume agent to read PDFs from
// the canonical bucket (recruit-resume-raw) when RAAS publishes a
// RESUME_DOWNLOADED event.
//
// All env vars (MINIO_ENDPOINT, _PORT, _USE_SSL, _ACCESS_KEY, _SECRET_KEY)
// are loaded by Next.js at boot.

import { Client as MinioClient } from "minio";

let _client: MinioClient | null = null;

export function isMinIOConfigured(): boolean {
  return Boolean(
    process.env.MINIO_ENDPOINT &&
      process.env.MINIO_ACCESS_KEY &&
      process.env.MINIO_SECRET_KEY,
  );
}

export function getMinIOClient(): MinioClient {
  if (_client) return _client;
  if (!isMinIOConfigured()) {
    throw new Error(
      "MinIO not configured: need MINIO_ENDPOINT, MINIO_ACCESS_KEY, MINIO_SECRET_KEY",
    );
  }
  _client = new MinioClient({
    endPoint: process.env.MINIO_ENDPOINT!,
    port: Number(process.env.MINIO_PORT ?? 9000),
    useSSL: process.env.MINIO_USE_SSL === "true",
    accessKey: process.env.MINIO_ACCESS_KEY!,
    secretKey: process.env.MINIO_SECRET_KEY!,
  });
  return _client;
}
