// LLM extractor + matcher that produce the **RoboHire response shape**.
//
// Why this exists:
//   1. RoboHire's hosted /parse-resume + /match-resume are currently broken
//      (their backend uses an OpenRouter model ID that doesn't exist —
//      `openrouter/google/gemini-3.1-pro-preview`). 100% reproducible 500.
//   2. The RAAS team's contract expects RESUME_PROCESSED to carry
//      `payload.parsed.data` *in RoboHire's response shape* (name/email/
//      phone/location/summary/experience[]/education[]/skills/
//      certifications/languages). They consume that field directly.
//
// We use the new-api gateway (gemini-3-flash-preview) as a stand-in for
// RoboHire's LLM. The output schema is RoboHire's, not AO's 4-object
// schema, so the RAAS-side function can ingest it unchanged once RoboHire
// is restored — they swap the upstream call, the wire format is identical.

import OpenAI from "openai";
import { extractText, getDocumentProxy } from "unpdf";

// ─── Types — mirror RoboHire docs §2 + §3 verbatim ────────────────

export type RoboHireExperienceEntry = {
  title?: string;
  company?: string;
  location?: string;
  startDate?: string;
  endDate?: string;
  description?: string;
  highlights?: string[];
};

export type RoboHireEducationEntry = {
  degree?: string;
  field?: string;
  institution?: string;
  graduationYear?: string;
};

export type RoboHireLanguageEntry = {
  language?: string;
  proficiency?: string;
};

// /parse-resume `data` field (RoboHire docs §2)
export type RoboHireParsedData = {
  name: string | null;
  email: string | null;
  phone: string | null;
  location: string | null;
  summary: string | null;
  experience: RoboHireExperienceEntry[];
  education: RoboHireEducationEntry[];
  skills: string[];
  certifications: string[];
  languages: RoboHireLanguageEntry[];
};

// /match-resume `data` field (RoboHire docs §3)
export type RoboHireMatchData = {
  matchScore: number;
  recommendation: "STRONG_MATCH" | "GOOD_MATCH" | "PARTIAL_MATCH" | "WEAK_MATCH";
  summary: string;
  matchAnalysis: {
    technicalSkills: { score: number; matchedSkills: string[]; missingSkills: string[] };
    experienceLevel: { score: number; required: string; candidate: string; assessment: string };
  };
  mustHaveAnalysis: {
    extractedMustHaves: { skills: string[]; experience: string[] };
    candidateMustHaves: { skills: string[]; experience: string[] };
    matchedMustHaves: string[];
  };
  niceToHaveAnalysis: {
    extractedNiceToHaves: { skills: string[]; certifications: string[] };
    matchedNiceToHaves: string[];
  };
};

// ─── PDF → text (no worker — works in Next.js Turbopack) ──────────

export async function pdfBufferToText(buffer: Buffer): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: true });
  return Array.isArray(text) ? text.join("\n") : text;
}

// ─── LLM gateway picker (same as resume-extractor.ts) ─────────────

type GatewayConfig = {
  baseURL: string;
  apiKey: string;
  model: string;
  mode: "new-api" | "openai";
};

function pickGateway(): GatewayConfig {
  if (process.env.AI_BASE_URL && process.env.AI_API_KEY) {
    return {
      baseURL: process.env.AI_BASE_URL,
      apiKey: process.env.AI_API_KEY,
      model: process.env.AI_MODEL || "google/gemini-3-flash-preview",
      mode: "new-api",
    };
  }
  if (process.env.OPENAI_API_KEY) {
    return {
      baseURL: "https://api.openai.com/v1",
      apiKey: process.env.OPENAI_API_KEY,
      model: "gpt-4o-mini",
      mode: "openai",
    };
  }
  throw new Error(
    "No LLM gateway configured. Set AI_BASE_URL+AI_API_KEY (preferred) or OPENAI_API_KEY.",
  );
}

function stripCodeFence(s: string): string {
  const m = s.trim().match(/^```(?:json)?\s*([\s\S]+?)\s*```$/);
  return m ? m[1] : s;
}

// ─── Parse-resume (LLM emulation) ─────────────────────────────────

const PARSE_PROMPT = `You are an OCR + parser for Chinese/English resumes.

Output JSON matching this exact schema (RoboHire /parse-resume data field):

{
  "name": string | null,
  "email": string | null,
  "phone": string | null,
  "location": string | null,
  "summary": string | null,
  "experience": Array<{
    "title": string,
    "company": string,
    "location": string | null,
    "startDate": string,
    "endDate": string | "present",
    "description": string,
    "highlights": string[]
  }>,
  "education": Array<{
    "degree": string,
    "field": string,
    "institution": string,
    "graduationYear": string
  }>,
  "skills": string[],
  "certifications": string[],
  "languages": Array<{ "language": string, "proficiency": string }>
}

Rules:
- Use null for missing scalar fields. Use [] for missing arrays.
- Preserve Chinese characters as-is. Do not translate.
- experience entries: most recent first. Use "present" / "至今" for current jobs as endDate.
- Date format: prefer YYYY-MM. Accept YYYY-MM-DD and YYYY/MM as input but normalize to YYYY-MM in output.
- Output JSON only, no prose, no code fences.`;

export type LlmExtractResult = {
  parsed: RoboHireParsedData;
  modelUsed: string;
  duration_ms: number;
  prompt_chars: number;
  rawResponse: string;
};

export async function llmExtractRoboHireShape(
  resumeText: string,
): Promise<LlmExtractResult> {
  const gateway = pickGateway();
  const startedAt = Date.now();
  const client = new OpenAI({
    baseURL: gateway.baseURL,
    apiKey: gateway.apiKey,
    timeout: 60_000,
  });
  const trimmed = resumeText.slice(0, 12_000);
  const completion = await client.chat.completions.create({
    model: gateway.model,
    messages: [
      { role: "system", content: PARSE_PROMPT },
      { role: "user", content: trimmed },
    ],
    response_format: { type: "json_object" },
    temperature: 0,
  });
  const raw = completion.choices[0]?.message?.content ?? "{}";
  const json = JSON.parse(stripCodeFence(raw));
  const parsed = normalizeParsedData(json);
  return {
    parsed,
    modelUsed: gateway.model,
    duration_ms: Date.now() - startedAt,
    prompt_chars: trimmed.length,
    rawResponse: raw,
  };
}

function normalizeParsedData(raw: any): RoboHireParsedData {
  return {
    name: nullable(raw?.name),
    email: nullable(raw?.email),
    phone: nullable(raw?.phone),
    location: nullable(raw?.location),
    summary: nullable(raw?.summary),
    experience: Array.isArray(raw?.experience)
      ? raw.experience.map((e: any) => ({
          title: nullable(e?.title) ?? undefined,
          company: nullable(e?.company) ?? undefined,
          location: nullable(e?.location) ?? undefined,
          startDate: nullable(e?.startDate) ?? undefined,
          endDate: nullable(e?.endDate) ?? undefined,
          description: nullable(e?.description) ?? undefined,
          highlights: Array.isArray(e?.highlights) ? e.highlights : [],
        }))
      : [],
    education: Array.isArray(raw?.education)
      ? raw.education.map((e: any) => ({
          degree: nullable(e?.degree) ?? undefined,
          field: nullable(e?.field) ?? undefined,
          institution: nullable(e?.institution) ?? undefined,
          graduationYear: e?.graduationYear ? String(e.graduationYear) : undefined,
        }))
      : [],
    skills: Array.isArray(raw?.skills) ? raw.skills.filter((s: any) => typeof s === "string") : [],
    certifications: Array.isArray(raw?.certifications)
      ? raw.certifications.filter((s: any) => typeof s === "string")
      : [],
    languages: Array.isArray(raw?.languages)
      ? raw.languages.map((l: any) => ({
          language: nullable(l?.language) ?? undefined,
          proficiency: nullable(l?.proficiency) ?? undefined,
        }))
      : [],
  };
}

function nullable(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return String(v);
  const t = v.trim();
  return t.length === 0 ? null : t;
}

// ─── Match-resume (LLM emulation) ─────────────────────────────────

const MATCH_PROMPT = `You score a candidate's resume against a job description and return a structured analysis.

Output JSON matching this exact schema (RoboHire /match-resume data field):

{
  "matchScore": integer 0-100,
  "recommendation": "STRONG_MATCH" | "GOOD_MATCH" | "PARTIAL_MATCH" | "WEAK_MATCH",
  "summary": string (1-2 sentence assessment in Chinese if the resume is Chinese, else English),
  "matchAnalysis": {
    "technicalSkills": {
      "score": integer 0-100,
      "matchedSkills": string[],
      "missingSkills": string[]
    },
    "experienceLevel": {
      "score": integer 0-100,
      "required": string,
      "candidate": string,
      "assessment": string
    }
  },
  "mustHaveAnalysis": {
    "extractedMustHaves": { "skills": string[], "experience": string[] },
    "candidateMustHaves": { "skills": string[], "experience": string[] },
    "matchedMustHaves": string[]
  },
  "niceToHaveAnalysis": {
    "extractedNiceToHaves": { "skills": string[], "certifications": string[] },
    "matchedNiceToHaves": string[]
  }
}

Scoring guide:
- 80-100 STRONG_MATCH: clearly meets/exceeds requirements
- 60-79  GOOD_MATCH:    meets most requirements
- 40-59  PARTIAL_MATCH: some alignment, missing key requirements
- 0-39   WEAK_MATCH:    poor fit

Rules:
- Output JSON only, no prose, no code fences.
- Be honest. Don't inflate scores for a weak fit.
- For Chinese resumes/JDs, write summary and assessment in Chinese.`;

export type LlmMatchResult = {
  match: RoboHireMatchData;
  modelUsed: string;
  duration_ms: number;
  rawResponse: string;
};

export async function llmMatchRoboHireShape(
  resumeText: string,
  jdText: string,
): Promise<LlmMatchResult> {
  const gateway = pickGateway();
  const startedAt = Date.now();
  const client = new OpenAI({
    baseURL: gateway.baseURL,
    apiKey: gateway.apiKey,
    timeout: 60_000,
  });
  const userMsg = `## Job Description\n\n${jdText.slice(0, 4_000)}\n\n## Candidate Resume\n\n${resumeText.slice(0, 8_000)}`;
  const completion = await client.chat.completions.create({
    model: gateway.model,
    messages: [
      { role: "system", content: MATCH_PROMPT },
      { role: "user", content: userMsg },
    ],
    response_format: { type: "json_object" },
    temperature: 0,
  });
  const raw = completion.choices[0]?.message?.content ?? "{}";
  const json = JSON.parse(stripCodeFence(raw));
  const match = normalizeMatchData(json);
  return {
    match,
    modelUsed: gateway.model,
    duration_ms: Date.now() - startedAt,
    rawResponse: raw,
  };
}

function normalizeMatchData(raw: any): RoboHireMatchData {
  const score = clampScore(raw?.matchScore);
  const recommendation = (raw?.recommendation as string) || scoreToRecommendation(score);
  const ma = raw?.matchAnalysis ?? {};
  const ts = ma.technicalSkills ?? {};
  const el = ma.experienceLevel ?? {};
  const mh = raw?.mustHaveAnalysis ?? {};
  const nh = raw?.niceToHaveAnalysis ?? {};
  return {
    matchScore: score,
    recommendation: recommendation as RoboHireMatchData["recommendation"],
    summary: typeof raw?.summary === "string" ? raw.summary : "",
    matchAnalysis: {
      technicalSkills: {
        score: clampScore(ts.score),
        matchedSkills: Array.isArray(ts.matchedSkills) ? ts.matchedSkills : [],
        missingSkills: Array.isArray(ts.missingSkills) ? ts.missingSkills : [],
      },
      experienceLevel: {
        score: clampScore(el.score),
        required: typeof el.required === "string" ? el.required : "",
        candidate: typeof el.candidate === "string" ? el.candidate : "",
        assessment: typeof el.assessment === "string" ? el.assessment : "",
      },
    },
    mustHaveAnalysis: {
      extractedMustHaves: {
        skills: Array.isArray(mh.extractedMustHaves?.skills) ? mh.extractedMustHaves.skills : [],
        experience: Array.isArray(mh.extractedMustHaves?.experience)
          ? mh.extractedMustHaves.experience
          : [],
      },
      candidateMustHaves: {
        skills: Array.isArray(mh.candidateMustHaves?.skills) ? mh.candidateMustHaves.skills : [],
        experience: Array.isArray(mh.candidateMustHaves?.experience)
          ? mh.candidateMustHaves.experience
          : [],
      },
      matchedMustHaves: Array.isArray(mh.matchedMustHaves) ? mh.matchedMustHaves : [],
    },
    niceToHaveAnalysis: {
      extractedNiceToHaves: {
        skills: Array.isArray(nh.extractedNiceToHaves?.skills)
          ? nh.extractedNiceToHaves.skills
          : [],
        certifications: Array.isArray(nh.extractedNiceToHaves?.certifications)
          ? nh.extractedNiceToHaves.certifications
          : [],
      },
      matchedNiceToHaves: Array.isArray(nh.matchedNiceToHaves) ? nh.matchedNiceToHaves : [],
    },
  };
}

function clampScore(n: unknown): number {
  if (typeof n !== "number" || Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function scoreToRecommendation(score: number): RoboHireMatchData["recommendation"] {
  if (score >= 80) return "STRONG_MATCH";
  if (score >= 60) return "GOOD_MATCH";
  if (score >= 40) return "PARTIAL_MATCH";
  return "WEAK_MATCH";
}

// ─── Flatten parsed RoboHire data → plain text for matcher ────────

export function flattenRoboHireParsedForMatch(p: RoboHireParsedData): string {
  const lines: string[] = [];
  if (p.name) lines.push(p.name);
  if (p.summary) lines.push(p.summary);
  if (p.email) lines.push(`邮箱: ${p.email}`);
  if (p.phone) lines.push(`电话: ${p.phone}`);
  if (p.location) lines.push(`所在地: ${p.location}`);
  if (p.skills.length) lines.push(`技能: ${p.skills.join(", ")}`);
  if (p.experience.length) {
    lines.push(``, `工作经历:`);
    for (const e of p.experience) {
      lines.push(
        `  - ${e.startDate ?? ""} ~ ${e.endDate ?? ""}  ${e.title ?? ""} @ ${e.company ?? ""}${e.location ? ` (${e.location})` : ""}`,
      );
      if (e.description) lines.push(`    ${e.description}`);
      if (e.highlights?.length) {
        for (const h of e.highlights) lines.push(`    • ${h}`);
      }
    }
  }
  if (p.education.length) {
    lines.push(``, `教育经历:`);
    for (const e of p.education) {
      lines.push(
        `  - ${e.institution ?? ""} ${e.degree ?? ""} ${e.field ?? ""}${e.graduationYear ? ` (${e.graduationYear})` : ""}`,
      );
    }
  }
  if (p.certifications.length) lines.push(``, `证书: ${p.certifications.join(", ")}`);
  if (p.languages.length) {
    lines.push(``, `语言: ${p.languages.map((l) => `${l.language ?? ""}(${l.proficiency ?? ""})`).join(", ")}`);
  }
  return lines.join("\n");
}
