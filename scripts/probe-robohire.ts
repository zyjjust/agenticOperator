// Probe RoboHire /parse-resume with different filename encodings to
// isolate whether the 500 is a payload issue or a server-side issue.

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { promises as fs } from "node:fs";
import path from "node:path";
import { Client as MinioClient } from "minio";

const BUCKET = "recruit-resume-raw";
const OBJECT_KEY =
  "2026/04/e7b3dde7-b4fc-96dc-6a9b-d2e2facd57db-【游戏测试（全国招聘）_深圳 7-11K】谌治中 3年.pdf";

const RH_BASE = process.env.ROBOHIRE_BASE_URL ?? "https://api.robohire.io";
const RH_KEY = process.env.ROBOHIRE_API_KEY!;

async function fetchPdf(): Promise<Buffer> {
  const minio = new MinioClient({
    endPoint: process.env.MINIO_ENDPOINT!,
    port: Number(process.env.MINIO_PORT ?? 9000),
    useSSL: (process.env.MINIO_USE_SSL ?? "false") === "true",
    accessKey: process.env.MINIO_ACCESS_KEY!,
    secretKey: process.env.MINIO_SECRET_KEY!,
  });
  const stream = await minio.getObject(BUCKET, OBJECT_KEY);
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

async function tryUpload(label: string, buf: Buffer, filename: string, mimeType?: string) {
  console.log(`\n=== ${label} ===`);
  console.log(`  filename: ${JSON.stringify(filename)}`);
  console.log(`  bytes:    ${buf.length}`);
  console.log(`  mime:     ${mimeType ?? "(default)"}`);
  const form = new FormData();
  const blob = mimeType
    ? new Blob([new Uint8Array(buf)], { type: mimeType })
    : new Blob([new Uint8Array(buf)]);
  form.append("file", blob, filename);
  const t0 = Date.now();
  try {
    const res = await fetch(`${RH_BASE}/api/v1/parse-resume`, {
      method: "POST",
      headers: { Authorization: `Bearer ${RH_KEY}` },
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
    const ms = Date.now() - t0;
    const txt = await res.text();
    console.log(`  → ${res.status} in ${ms}ms`);
    console.log(`  body: ${txt.slice(0, 300)}`);
    return res.status;
  } catch (e) {
    console.log(`  → THROW: ${(e as Error).message}`);
    return -1;
  }
}

async function main() {
  console.log("Fetching from MinIO...");
  const buf = await fetchPdf();
  console.log(`PDF: ${buf.length} bytes, magic=${buf.subarray(0, 8).toString("hex")}`);

  // Save locally for inspection
  const localPath = "/tmp/probe-resume.pdf";
  await fs.writeFile(localPath, buf);
  console.log(`Saved to ${localPath}`);

  // 1. ASCII-only filename
  await tryUpload("ascii-only filename", buf, "resume.pdf", "application/pdf");

  // 2. ASCII-only, no mime
  await tryUpload("ascii-only filename, no mime", buf, "resume.pdf");

  // 3. Original Chinese filename, with mime
  await tryUpload(
    "original chinese filename, application/pdf",
    buf,
    "【游戏测试（全国招聘）_深圳 7-11K】谌治中 3年.pdf",
    "application/pdf",
  );

  // 4. Latin-1 fallback for filename header (some servers reject UTF-8)
  await tryUpload(
    "ascii safe with original spaces",
    buf,
    "game_tester_shen_3years.pdf",
    "application/pdf",
  );

  // 5. With explicit Content-Type "application/octet-stream"
  await tryUpload(
    "octet-stream mime",
    buf,
    "resume.pdf",
    "application/octet-stream",
  );

  // 6. Tiny PDF stub to confirm endpoint health (negative control)
  const tinyPdf = Buffer.from(
    "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\nxref\n0 1\n0000000000 65535 f\ntrailer<</Size 1>>\nstartxref\n0\n%%EOF\n",
    "ascii",
  );
  await tryUpload("tiny stub PDF (negative control)", tinyPdf, "stub.pdf", "application/pdf");
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
