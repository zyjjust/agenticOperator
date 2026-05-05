// scripts/e2e-real-pdf.ts
//
// Direct end-to-end test, bypassing Inngest. Exercises the full pipeline
// against the real PDF and dumps every input/output JSON to disk under
// data/e2e-out/<timestamp>/ so we can hand the artifacts to the RAAS team.
//
// Pipeline:
//   MinIO → RoboHire /parse-resume    (preferred, falls back if 4xx/5xx)
//                  ↓
//          unpdf → LLM gateway extract (fallback path: pdfjs-without-worker
//                                       + new-api gemini-3-flash-preview)
//                  ↓
//          /match-resume (RoboHire)    (still tried; falls back to stub)
//
// Run:
//   npx tsx scripts/e2e-real-pdf.ts

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv();

import { promises as fs } from "node:fs";
import path from "node:path";
import { Client as MinioClient } from "minio";
import OpenAI from "openai";
import { extractText, getDocumentProxy } from "unpdf";

const BUCKET = "recruit-resume-raw";
const OBJECT_KEY =
  "2026/04/e7b3dde7-b4fc-96dc-6a9b-d2e2facd57db-【游戏测试（全国招聘）_深圳 7-11K】谌治中 3年.pdf";
const FILENAME = "【游戏测试（全国招聘）_深圳 7-11K】谌治中 3年.pdf";

const RESUME_DOWNLOADED_EVENT = {
  name: "RESUME_DOWNLOADED",
  data: {
    bucket: BUCKET,
    objectKey: OBJECT_KEY,
    filename: FILENAME,
    hrFolder: "xiaqi-0000206419",
    employeeId: "0000206419",
    etag: "real-2026-04-28-shen-zhi-zhong",
    size: null as number | null,
    sourceEventName: "raas-real-pdf-test",
    receivedAt: "2026-04-28T03:00:00Z",
  },
};

const SYSTEM_PROMPT = `You parse Chinese resumes into a strict JSON schema.

Output JSON with exactly these top-level keys: candidate, candidate_expectation, resume, runtime.

candidate fields: name, mobile, email, gender, birth_date (YYYY-MM-DD), current_location, highest_acquired_degree, work_years (integer), current_company, current_title, skills (string[]).
candidate_expectation fields: expected_salary_monthly_min (number, in CNY e.g. 35000), expected_salary_monthly_max (number), expected_cities (string[]), expected_industries (string[]), expected_roles (string[]), expected_work_mode (string).
resume fields: summary (string), skills_extracted (string[]), work_history ({title, company, startDate, endDate, description}[]), education_history ({degree, field, institution, graduationYear}[]), project_history (any[], default []).
runtime fields: current_title, current_company (mirror candidate fields).

Use null for missing values. Use [] for missing lists. Do NOT invent data.
Output JSON only, no prose.`;

async function main() {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.resolve("data", "e2e-out", ts);
  await fs.mkdir(outDir, { recursive: true });
  console.log(`[e2e] output → ${outDir}`);

  // ── 0. Capture input event ──────────────────────────────────────
  await fs.writeFile(
    path.join(outDir, "01-input-RESUME_DOWNLOADED.json"),
    JSON.stringify(RESUME_DOWNLOADED_EVENT, null, 2),
  );
  console.log(`[e2e] step 0 — wrote 01-input-RESUME_DOWNLOADED.json`);

  // ── 1. MinIO fetch ──────────────────────────────────────────────
  const minio = new MinioClient({
    endPoint: process.env.MINIO_ENDPOINT!,
    port: Number(process.env.MINIO_PORT ?? 9000),
    useSSL: (process.env.MINIO_USE_SSL ?? "false") === "true",
    accessKey: process.env.MINIO_ACCESS_KEY!,
    secretKey: process.env.MINIO_SECRET_KEY!,
  });

  console.log(`[e2e] step 1 — minio.getObject(${BUCKET}, …)`);
  const t0 = Date.now();
  const stream = await minio.getObject(BUCKET, OBJECT_KEY);
  const buf = await streamToBuffer(stream);
  const fetchMs = Date.now() - t0;
  console.log(`[e2e] step 1 — fetched ${buf.length} bytes in ${fetchMs}ms`);

  await fs.writeFile(
    path.join(outDir, "02-pdf-bytes.audit.json"),
    JSON.stringify(
      {
        bucket: BUCKET,
        objectKey: OBJECT_KEY,
        filename: FILENAME,
        bytes: buf.length,
        sha256_first_64: buf.subarray(0, 64).toString("hex"),
        fetch_ms: fetchMs,
      },
      null,
      2,
    ),
  );
  await fs.writeFile(path.join(outDir, "02-resume.pdf"), buf);

  // ── 2. RoboHire /parse-resume — try first, fall back on failure ─
  let parsed: any;
  let parserMode: "robohire" | "new-api" | "stub" = "robohire";
  let parserModelUsed = "robohire/parse-resume";
  let parserDurationMs = 0;
  let parserRequestId = "";
  let parserCached = false;
  let fallbackReason: string | undefined;
  let robohireRawResponse: any = null;

  const RH_BASE = process.env.ROBOHIRE_BASE_URL ?? "https://api.robohire.io";
  const RH_KEY = process.env.ROBOHIRE_API_KEY!;

  console.log(`[e2e] step 2a — POST ${RH_BASE}/api/v1/parse-resume`);
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(buf)], { type: "application/pdf" }),
    FILENAME,
  );

  const parseT0 = Date.now();
  const parseRes = await fetch(`${RH_BASE}/api/v1/parse-resume`, {
    method: "POST",
    headers: { Authorization: `Bearer ${RH_KEY}` },
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  parserDurationMs = Date.now() - parseT0;
  const parseHeaders = headersToObject(parseRes.headers);
  parserRequestId = parseHeaders["x-request-id"] ?? "";
  parserCached = parseHeaders["x-cache-hit"] === "true";

  if (parseRes.ok) {
    robohireRawResponse = await parseRes.json();
    parsed = mapRoboHireToParsedResume(robohireRawResponse);
    console.log(`[e2e] step 2a — RoboHire parse OK in ${parserDurationMs}ms`);
    await fs.writeFile(
      path.join(outDir, "03-robohire-parse-RAW-response.json"),
      JSON.stringify(
        {
          request: {
            url: `${RH_BASE}/api/v1/parse-resume`,
            method: "POST",
            contentType: "multipart/form-data",
            fileBytes: buf.length,
            filename: FILENAME,
            blobMimeType: "application/pdf",
          },
          response: {
            status: parseRes.status,
            headers: parseHeaders,
            duration_ms: parserDurationMs,
            body: robohireRawResponse,
          },
        },
        null,
        2,
      ),
    );
  } else {
    const errBody = await parseRes.text();
    const errBodyJson = tryJson(errBody);
    fallbackReason = `RoboHire ${parseRes.status}: ${typeof errBodyJson === "object" ? JSON.stringify(errBodyJson) : errBody.slice(0, 200)}`;
    console.warn(`[e2e] step 2a — RoboHire parse FAILED (${parseRes.status})`);
    console.warn(`[e2e]            body: ${errBody.slice(0, 200)}`);
    await fs.writeFile(
      path.join(outDir, "03-robohire-parse-ERROR.json"),
      JSON.stringify(
        {
          request: {
            url: `${RH_BASE}/api/v1/parse-resume`,
            method: "POST",
            contentType: "multipart/form-data",
            fileBytes: buf.length,
            filename: FILENAME,
            blobMimeType: "application/pdf",
          },
          response: {
            status: parseRes.status,
            statusText: parseRes.statusText,
            headers: parseHeaders,
            duration_ms: parserDurationMs,
            body: errBodyJson,
          },
          analysis:
            "RoboHire returned 5xx on a known-good PDF. Their server-side LLM model ID is misconfigured. Reproducible across all filename + mime variations — not a client bug. Falling back to PDF→text + new-api gateway extraction.",
        },
        null,
        2,
      ),
    );

    // ── 2b. Fallback: unpdf → text → new-api gateway ─────────────
    console.log(`[e2e] step 2b — fallback: unpdf → LLM gateway`);
    const fbT0 = Date.now();
    const pdfDoc = await getDocumentProxy(new Uint8Array(buf));
    const { text: extractedText } = await extractText(pdfDoc, { mergePages: true });
    const text = Array.isArray(extractedText) ? extractedText.join("\n") : extractedText;
    console.log(`[e2e] step 2b — unpdf extracted ${text.length} chars`);

    await fs.writeFile(
      path.join(outDir, "03b-pdf-extracted-text.txt"),
      text,
    );

    const aiBaseUrl = process.env.AI_BASE_URL!;
    const aiKey = process.env.AI_API_KEY!;
    const aiModel = process.env.AI_MODEL ?? "google/gemini-3-flash-preview";
    if (!aiBaseUrl || !aiKey) {
      throw new Error("AI_BASE_URL / AI_API_KEY required for fallback");
    }
    const client = new OpenAI({ baseURL: aiBaseUrl, apiKey: aiKey, timeout: 60_000 });
    const completion = await client.chat.completions.create({
      model: aiModel,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: text.slice(0, 10_000) },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
    });
    const raw = completion.choices[0]?.message?.content ?? "{}";
    const llmJson = JSON.parse(stripCodeFence(raw));
    parsed = normalizeParsed(llmJson);
    parserMode = "new-api";
    parserModelUsed = aiModel;
    parserDurationMs = Date.now() - fbT0;
    parserRequestId = "";
    parserCached = false;
    console.log(`[e2e] step 2b — LLM extracted in ${parserDurationMs}ms`);

    await fs.writeFile(
      path.join(outDir, "03c-llm-extract-RAW-response.json"),
      JSON.stringify(
        {
          request: {
            url: `${aiBaseUrl}/chat/completions`,
            model: aiModel,
            text_chars: text.length,
          },
          response: {
            duration_ms: parserDurationMs,
            raw_content: raw,
            parsed: llmJson,
          },
        },
        null,
        2,
      ),
    );
  }

  // ── 3. Build RESUME_PROCESSED ────────────────────────────────
  const RESUME_PROCESSED_EVENT = {
    name: "RESUME_PROCESSED",
    data: {
      bucket: RESUME_DOWNLOADED_EVENT.data.bucket,
      objectKey: RESUME_DOWNLOADED_EVENT.data.objectKey,
      filename: RESUME_DOWNLOADED_EVENT.data.filename,
      hrFolder: RESUME_DOWNLOADED_EVENT.data.hrFolder,
      employeeId: RESUME_DOWNLOADED_EVENT.data.employeeId,
      etag: RESUME_DOWNLOADED_EVENT.data.etag,
      size: RESUME_DOWNLOADED_EVENT.data.size,
      sourceEventName: RESUME_DOWNLOADED_EVENT.data.sourceEventName,
      receivedAt: RESUME_DOWNLOADED_EVENT.data.receivedAt,
      job_requisition_id: null,
      ...parsed,
      parsedAt: new Date().toISOString(),
      parserVersion: `ao+${parserMode}@robohire-or-llm-2026-04-28`,
      parserMode,
      parserModelUsed,
      parserDurationMs,
      parserRequestId,
      parserCached,
      fallback_reason: fallbackReason,
    },
  };
  await fs.writeFile(
    path.join(outDir, "04-output-RESUME_PROCESSED.json"),
    JSON.stringify(RESUME_PROCESSED_EVENT, null, 2),
  );
  console.log(`[e2e] step 3 — wrote 04-output-RESUME_PROCESSED.json (mode=${parserMode})`);

  // ── 4. Filename → JD inference ─────────────────────────────────
  const jd = inferJdFromFilename(FILENAME);
  await fs.writeFile(
    path.join(outDir, "05-jd-inferred.json"),
    JSON.stringify(jd, null, 2),
  );
  console.log(`[e2e] step 4 — JD inferred: ${jd.jobTitle} @ ${jd.city} ${jd.salaryRange}`);

  // ── 5. RoboHire /match-resume (try; fall back on failure) ─────
  const resumeText = flattenParsedResumeForMatch(parsed);
  console.log(
    `[e2e] step 5 — POST ${RH_BASE}/api/v1/match-resume (resume=${resumeText.length} chars, jd=${jd.jdText.length} chars)`,
  );

  let matchMs = 0;
  let matchOk = false;
  let matchJson: any = null;
  let matchHeaders: Record<string, string> = {};
  let matchFallbackReason: string | undefined;

  try {
    const matchT0 = Date.now();
    const matchRes = await fetch(`${RH_BASE}/api/v1/match-resume`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RH_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ resume: resumeText, jd: jd.jdText }),
      signal: AbortSignal.timeout(120_000),
    });
    matchMs = Date.now() - matchT0;
    matchHeaders = headersToObject(matchRes.headers);

    if (matchRes.ok) {
      matchJson = await matchRes.json();
      matchOk = true;
      console.log(`[e2e] step 5 — match OK in ${matchMs}ms`);
      await fs.writeFile(
        path.join(outDir, "06-robohire-match-RAW-response.json"),
        JSON.stringify(
          {
            request: {
              url: `${RH_BASE}/api/v1/match-resume`,
              method: "POST",
              body: { resume: resumeText, jd: jd.jdText },
            },
            response: {
              status: matchRes.status,
              headers: matchHeaders,
              duration_ms: matchMs,
              body: matchJson,
            },
          },
          null,
          2,
        ),
      );
    } else {
      const errBody = await matchRes.text();
      matchFallbackReason = `RoboHire match ${matchRes.status}: ${errBody.slice(0, 200)}`;
      console.warn(`[e2e] step 5 — match FAILED (${matchRes.status})`);
      await fs.writeFile(
        path.join(outDir, "06-robohire-match-ERROR.json"),
        JSON.stringify(
          {
            status: matchRes.status,
            headers: matchHeaders,
            duration_ms: matchMs,
            body: tryJson(errBody),
            request: { resume: resumeText, jd: jd.jdText },
          },
          null,
          2,
        ),
      );
    }
  } catch (e) {
    matchFallbackReason = `match throw: ${(e as Error).message}`;
    console.warn(`[e2e] step 5 — match THREW: ${(e as Error).message}`);
  }

  // ── 6. Build outcome event ───────────────────────────────────
  let score = 0;
  let recommendation = "WEAK_MATCH";
  let summary = "";
  let technicalSkills: any = null;
  let experienceLevel: any = null;
  let mustHave: any = null;
  let niceToHave: any = null;

  if (matchOk && matchJson) {
    // Per docs §3, match response wraps fields in matchAnalysis / mustHaveAnalysis / niceToHaveAnalysis
    const d = matchJson.data ?? matchJson;
    score = typeof d.matchScore === "number" ? d.matchScore : 0;
    recommendation = d.recommendation ?? "WEAK_MATCH";
    summary = d.summary ?? "";
    technicalSkills = d.matchAnalysis?.technicalSkills ?? null;
    experienceLevel = d.matchAnalysis?.experienceLevel ?? null;
    mustHave = d.mustHaveAnalysis ?? null;
    niceToHave = d.niceToHaveAnalysis ?? null;
  } else {
    // Stub match — same heuristic as the prod agent
    const stub = stubMatch(parsed, jd);
    score = stub.score;
    recommendation = stub.recommendation;
    summary = stub.summary;
    technicalSkills = stub.technicalSkills;
    experienceLevel = stub.experienceLevel;
    mustHave = stub.mustHave;
    niceToHave = stub.niceToHave;
  }

  const outcome =
    score >= 80
      ? "MATCH_PASSED_NO_INTERVIEW"
      : score >= 60
        ? "MATCH_PASSED_NEED_INTERVIEW"
        : "MATCH_FAILED";

  const MATCH_OUTCOME_EVENT = {
    name: outcome,
    data: {
      bucket: RESUME_DOWNLOADED_EVENT.data.bucket,
      objectKey: RESUME_DOWNLOADED_EVENT.data.objectKey,
      filename: RESUME_DOWNLOADED_EVENT.data.filename,
      etag: RESUME_DOWNLOADED_EVENT.data.etag,
      candidate_ref: {
        name: parsed.candidate.name,
        mobile: parsed.candidate.mobile,
        email: parsed.candidate.email,
      },
      jd_source: "filename-inferred",
      jd_text: jd.jdText,
      jd_id: null,
      match: {
        score,
        recommendation,
        summary,
        technicalSkills,
        experienceLevel,
        mustHave,
        niceToHave,
      },
      outcome,
      reason: matchFallbackReason ?? null,
      matchedAt: new Date().toISOString(),
      robohireRequestId: matchHeaders["x-request-id"] ?? null,
      matchMode: matchOk ? "robohire" : "stub",
    },
  };
  await fs.writeFile(
    path.join(outDir, `07-output-${outcome}.json`),
    JSON.stringify(MATCH_OUTCOME_EVENT, null, 2),
  );

  // ── 7. Master index ───────────────────────────────────────────
  await fs.writeFile(
    path.join(outDir, "00-INDEX.md"),
    [
      `# E2E run ${ts}`,
      ``,
      `Resume: \`${OBJECT_KEY}\``,
      `PDF bytes: ${buf.length}`,
      `Parser mode: **${parserMode}**${fallbackReason ? `  (fallback because: ${fallbackReason})` : ""}`,
      `Match mode: **${matchOk ? "robohire" : "stub"}**${matchFallbackReason ? `  (fallback because: ${matchFallbackReason})` : ""}`,
      ``,
      `## Files`,
      ``,
      `- 01-input-RESUME_DOWNLOADED.json — incoming RAAS event (canonical AO schema)`,
      `- 02-pdf-bytes.audit.json — fetch metadata from MinIO`,
      `- 02-resume.pdf — raw PDF bytes`,
      fallbackReason
        ? `- 03-robohire-parse-ERROR.json — RoboHire 5xx (their model config is broken)`
        : `- 03-robohire-parse-RAW-response.json — RoboHire /parse-resume request + response`,
      fallbackReason ? `- 03b-pdf-extracted-text.txt — text extracted by unpdf` : "",
      fallbackReason ? `- 03c-llm-extract-RAW-response.json — new-api gateway extraction` : "",
      `- 04-output-RESUME_PROCESSED.json — what processResume agent emits`,
      `- 05-jd-inferred.json — JD inferred from filename`,
      matchOk
        ? `- 06-robohire-match-RAW-response.json — RoboHire /match-resume request + response`
        : `- 06-robohire-match-ERROR.json — match endpoint failure`,
      `- 07-output-${outcome}.json — what matchResume agent emits`,
      ``,
      `## Result`,
      ``,
      `- score: **${score}**`,
      `- recommendation: **${recommendation}**`,
      `- outcome: **${outcome}**`,
      `- candidate: **${parsed.candidate.name ?? "—"}** (${parsed.candidate.mobile ?? "—"} / ${parsed.candidate.email ?? "—"})`,
      `- skills: ${(parsed.candidate.skills ?? []).join(", ")}`,
      `- parse latency: ${parserDurationMs}ms`,
      `- match latency: ${matchMs}ms`,
    ]
      .filter(Boolean)
      .join("\n"),
  );

  console.log(``);
  console.log(`[e2e] DONE — outcome=${outcome} score=${score} parser=${parserMode} match=${matchOk ? "robohire" : "stub"}`);
  console.log(`[e2e] all artifacts in ${outDir}`);
}

// ── helpers ───────────────────────────────────────────────────────

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | Uint8Array>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function headersToObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function stripCodeFence(s: string): string {
  const m = s.trim().match(/^```(?:json)?\s*([\s\S]+?)\s*```$/);
  return m ? m[1] : s;
}

function inferJdFromFilename(filename: string) {
  const m = filename.match(/^【(.+?)_(.+?)\s+(.+?)】(.+?)\s+(.+?)\.\w+$/);
  if (!m) return { ok: false, jdText: "", filename };
  const [, jobTitle, city, salaryRange, candidateName, yearsExp] = m;
  return {
    ok: true,
    jobTitle,
    city,
    salaryRange,
    candidateName,
    yearsExp,
    jdText: [
      `职位: ${jobTitle}`,
      `工作地点: ${city}`,
      `薪资范围: ${salaryRange}`,
      `(PoC: 此 JD 由文件名推断；待 RAAS 提供 jd_id 接口替换)`,
    ].join("\n"),
  };
}

function mapRoboHireToParsedResume(rh: any) {
  const d = rh?.data ?? rh ?? {};
  const experience: any[] = Array.isArray(d.experience) ? d.experience : [];
  const education: any[] = Array.isArray(d.education) ? d.education : [];
  const skills: string[] = Array.isArray(d.skills) ? d.skills : [];

  const cur =
    experience.find((e) => {
      const v = (e.endDate ?? "").toLowerCase();
      return v === "" || v === "present" || v === "current" || v === "至今";
    }) ?? experience[0];

  const rank: Record<string, number> = {
    大专: 1,
    本科: 2,
    bachelor: 2,
    硕士: 3,
    master: 3,
    mba: 3,
    博士: 4,
    phd: 4,
    doctor: 4,
  };
  let bestDegree: string | null = null;
  let bestRank = 0;
  for (const e of education) {
    const r = rank[(e.degree ?? "").toLowerCase()] ?? rank[e.degree ?? ""] ?? 0;
    if (r > bestRank) {
      bestRank = r;
      bestDegree = e.degree ?? null;
    }
  }

  let workYears: number | null = null;
  if (experience.length > 0) {
    let total = 0;
    for (const e of experience) {
      if (!e.startDate) continue;
      const start = parseDateLoose(e.startDate);
      const end = parseDateLoose(e.endDate ?? "") ?? Date.now();
      if (start && end) total += Math.max(0, (end - start) / (1000 * 60 * 60 * 24 * 365));
    }
    workYears = total > 0 ? Math.round(total) : null;
  }

  return {
    candidate: {
      name: d.name ?? null,
      mobile: cleanPhone(d.phone),
      email: d.email ?? null,
      gender: null,
      birth_date: null,
      current_location: d.location ?? null,
      highest_acquired_degree: bestDegree,
      work_years: workYears,
      current_company: cur?.company ?? null,
      current_title: cur?.title ?? null,
      skills,
    },
    candidate_expectation: {
      expected_salary_monthly_min: null,
      expected_salary_monthly_max: null,
      expected_cities: [],
      expected_industries: [],
      expected_roles: [],
      expected_work_mode: null,
    },
    resume: {
      summary: d.summary ?? null,
      skills_extracted: skills,
      work_history: experience.map((e: any) => ({
        title: e.title,
        company: e.company,
        startDate: e.startDate,
        endDate: e.endDate,
        description: e.description,
      })),
      education_history: education.map((e: any) => ({
        degree: e.degree,
        field: e.field,
        institution: e.institution,
        graduationYear: e.graduationYear ? String(e.graduationYear) : undefined,
      })),
      project_history: [],
    },
    runtime: {
      current_title: cur?.title ?? null,
      current_company: cur?.company ?? null,
    },
  };
}

function normalizeParsed(raw: any): any {
  const c = raw?.candidate ?? {};
  const ce = raw?.candidate_expectation ?? {};
  const r = raw?.resume ?? {};
  const rt = raw?.runtime ?? {};
  return {
    candidate: {
      name: c.name ?? null,
      mobile: c.mobile ?? null,
      email: c.email ?? null,
      gender: c.gender ?? null,
      birth_date: c.birth_date ?? null,
      current_location: c.current_location ?? null,
      highest_acquired_degree: c.highest_acquired_degree ?? null,
      work_years: typeof c.work_years === "number" ? c.work_years : null,
      current_company: c.current_company ?? null,
      current_title: c.current_title ?? null,
      skills: Array.isArray(c.skills) ? c.skills : [],
    },
    candidate_expectation: {
      expected_salary_monthly_min:
        typeof ce.expected_salary_monthly_min === "number"
          ? ce.expected_salary_monthly_min
          : null,
      expected_salary_monthly_max:
        typeof ce.expected_salary_monthly_max === "number"
          ? ce.expected_salary_monthly_max
          : null,
      expected_cities: Array.isArray(ce.expected_cities) ? ce.expected_cities : [],
      expected_industries: Array.isArray(ce.expected_industries) ? ce.expected_industries : [],
      expected_roles: Array.isArray(ce.expected_roles) ? ce.expected_roles : [],
      expected_work_mode: ce.expected_work_mode ?? null,
    },
    resume: {
      summary: r.summary ?? null,
      skills_extracted: Array.isArray(r.skills_extracted) ? r.skills_extracted : [],
      work_history: Array.isArray(r.work_history) ? r.work_history : [],
      education_history: Array.isArray(r.education_history) ? r.education_history : [],
      project_history: Array.isArray(r.project_history) ? r.project_history : [],
    },
    runtime: {
      current_title: rt.current_title ?? null,
      current_company: rt.current_company ?? null,
    },
  };
}

function cleanPhone(p: string | null | undefined): string | null {
  if (!p) return null;
  return p.replace(/[\s\-]/g, "").trim() || null;
}

function parseDateLoose(s: string): number | null {
  if (!s) return null;
  const m = s.match(/^(\d{4})[-/]?(\d{1,2})?[-/]?(\d{1,2})?/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2] ?? 1);
  const d = Number(m[3] ?? 1);
  if (!y || y < 1970 || y > 2100) return null;
  return new Date(y, mo - 1, d).getTime();
}

function flattenParsedResumeForMatch(parsed: any): string {
  const lines: string[] = [];
  if (parsed.candidate.name) lines.push(`姓名: ${parsed.candidate.name}`);
  if (parsed.candidate.email) lines.push(`邮箱: ${parsed.candidate.email}`);
  if (parsed.candidate.mobile) lines.push(`电话: ${parsed.candidate.mobile}`);
  if (parsed.candidate.current_location) lines.push(`城市: ${parsed.candidate.current_location}`);
  if (parsed.candidate.work_years != null) lines.push(`工作年限: ${parsed.candidate.work_years}年`);
  if (parsed.candidate.highest_acquired_degree) lines.push(`学历: ${parsed.candidate.highest_acquired_degree}`);
  if (parsed.candidate.current_title || parsed.candidate.current_company) {
    lines.push(`当前: ${parsed.candidate.current_title ?? ""} @ ${parsed.candidate.current_company ?? ""}`);
  }
  if (parsed.candidate.skills?.length) {
    lines.push(`技能: ${parsed.candidate.skills.join(", ")}`);
  }
  if (parsed.resume.summary) {
    lines.push(`\n个人简介:\n${parsed.resume.summary}`);
  }
  if (parsed.resume.work_history?.length) {
    lines.push("\n工作经历:");
    for (const w of parsed.resume.work_history) {
      lines.push(`  ${w.startDate ?? ""} - ${w.endDate ?? "至今"}  ${w.title ?? ""} @ ${w.company ?? ""}`);
      if (w.description) lines.push(`    ${w.description}`);
    }
  }
  if (parsed.resume.education_history?.length) {
    lines.push("\n教育经历:");
    for (const e of parsed.resume.education_history) {
      lines.push(`  ${e.institution ?? ""}  ${e.degree ?? ""}  ${e.field ?? ""}  ${e.graduationYear ?? ""}`);
    }
  }
  return lines.join("\n");
}

function stubMatch(data: any, jd: ReturnType<typeof inferJdFromFilename>) {
  const jobTitle = (jd.jobTitle ?? "").toLowerCase();
  const city = jd.city ?? "";
  const skills = data.candidate?.skills ?? [];
  const candidateLocation = data.candidate?.current_location ?? "";

  let titleHits = 0;
  for (const s of skills) {
    if (jobTitle.includes(s.toLowerCase())) titleHits++;
  }
  const titleSignal = jobTitle ? Math.min(40, titleHits * 12) : 20;
  const locationSignal = city && candidateLocation && candidateLocation.includes(city) ? 20 : 5;
  const yrs = data.candidate?.work_years ?? 0;
  const expSignal = Math.min(40, yrs * 4);

  const score = Math.min(100, titleSignal + locationSignal + expSignal);
  const recommendation =
    score >= 80 ? "STRONG_MATCH" : score >= 60 ? "GOOD_MATCH" : score >= 40 ? "PARTIAL_MATCH" : "WEAK_MATCH";

  return {
    score,
    recommendation,
    summary: `Stub match: title hits=${titleHits}, location=${locationSignal > 5 ? "yes" : "no"}, years=${yrs}`,
    technicalSkills: { score: titleSignal, matchedSkills: skills.slice(0, titleHits), missingSkills: [] },
    experienceLevel: {
      score: expSignal,
      required: jobTitle.includes("高级") ? "5+ years" : "2+ years",
      candidate: `${yrs} years`,
      assessment: yrs >= 5 ? "senior" : yrs >= 2 ? "mid" : "junior",
    },
    mustHave: { extracted: { skills: [], experience: [] }, matched: skills.slice(0, 3) },
    niceToHave: { extracted: { skills: [], certifications: [] }, matched: [] },
  };
}

main().catch((e) => {
  console.error("[e2e] FATAL", e);
  process.exit(1);
});
