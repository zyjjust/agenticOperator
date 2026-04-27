// RoboHire client — production resume parsing & matching SaaS.
// API docs: spec doc resume-agent-engineering-spec.md §7.2
//
// Two endpoints used:
//   POST /api/v1/parse-resume   multipart, body: file=PDF binary, max 10MB
//   POST /api/v1/match-resume   JSON, body: { resume, jd, ... }
//
// Auth: Authorization: Bearer ${ROBOHIRE_API_KEY}
// Latency: parse 3-8s, match 5-15s. Configurable timeout (default 120s).

import type { ParsedResume } from "./resume-extractor";

const BASE = process.env.ROBOHIRE_BASE_URL ?? "https://api.robohire.io";
const KEY = process.env.ROBOHIRE_API_KEY ?? "";
const TIMEOUT_MS = Number(process.env.ROBOHIRE_TIMEOUT_MS ?? 120_000);

export class RoboHireError extends Error {
  constructor(
    public status: number,
    message: string,
    public requestId?: string,
  ) {
    super(`RoboHire ${status}: ${message}${requestId ? ` (req=${requestId})` : ""}`);
    this.name = "RoboHireError";
  }
}

export function isRoboHireConfigured(): boolean {
  return KEY.length > 0;
}

// ─── parse-resume ──────────────────────────────────────────────────
// Accepts a Buffer (PDF, docx, etc.) and returns the structured fields.
// Output is normalized to ParsedResume (the same shape gemini/stub use)
// so the agent doesn't care which path produced the data.

export type RoboHireParseResult = {
  parsed: ParsedResume;
  requestId: string;
  cached: boolean;
  duration_ms: number;
};

export async function roboHireParseResume(
  fileBuffer: Buffer,
  filename: string,
): Promise<RoboHireParseResult> {
  if (!KEY) throw new RoboHireError(0, "ROBOHIRE_API_KEY not set");

  const startedAt = Date.now();
  const form = new FormData();
  // RoboHire expects field name "file"
  const blob = new Blob([new Uint8Array(fileBuffer)]);
  form.append("file", blob, filename);

  const res = await fetch(`${BASE}/api/v1/parse-resume`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}` },
    body: form,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const requestId = res.headers.get("x-request-id") ?? "";

  if (!res.ok) {
    let msg = res.statusText;
    try {
      const body = await res.json();
      msg = (body as any)?.error ?? (body as any)?.message ?? JSON.stringify(body);
    } catch {
      try {
        msg = await res.text();
      } catch {
        /* keep statusText */
      }
    }
    throw new RoboHireError(res.status, msg, requestId);
  }

  const cached = res.headers.get("x-cache-hit") === "true";
  const json = (await res.json()) as RoboHireParseResponse;
  const parsed = mapRoboHireToParsedResume(json);

  return {
    parsed,
    requestId,
    cached,
    duration_ms: Date.now() - startedAt,
  };
}

// ─── match-resume ──────────────────────────────────────────────────

export type RoboHireMatchInput = {
  resumeText: string; // flattened from parsed-resume payload
  jdText: string;
};

export type RoboHireMatchResult = {
  score: number;
  recommendation: "STRONG_MATCH" | "GOOD_MATCH" | "PARTIAL_MATCH" | "WEAK_MATCH";
  summary: string;
  technicalSkills: { score: number; matchedSkills: string[]; missingSkills: string[] };
  experienceLevel: { score: number; required: string; candidate: string; assessment: string };
  mustHave: { extracted: { skills: string[]; experience: string[] }; matched: string[] };
  niceToHave: { extracted: { skills: string[]; certifications: string[] }; matched: string[] };
  requestId: string;
  duration_ms: number;
};

export async function roboHireMatchResume(
  input: RoboHireMatchInput,
): Promise<RoboHireMatchResult> {
  if (!KEY) throw new RoboHireError(0, "ROBOHIRE_API_KEY not set");

  const startedAt = Date.now();
  const res = await fetch(`${BASE}/api/v1/match-resume`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ resume: input.resumeText, jd: input.jdText }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const requestId = res.headers.get("x-request-id") ?? "";
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = JSON.stringify(await res.json());
    } catch {
      /* ignore */
    }
    throw new RoboHireError(res.status, msg, requestId);
  }
  const json = (await res.json()) as any;
  return {
    score: typeof json.matchScore === "number" ? json.matchScore : 0,
    recommendation: json.recommendation ?? "WEAK_MATCH",
    summary: json.summary ?? "",
    technicalSkills: json.technicalSkills ?? { score: 0, matchedSkills: [], missingSkills: [] },
    experienceLevel: json.experienceLevel ?? {
      score: 0,
      required: "",
      candidate: "",
      assessment: "",
    },
    mustHave: json.mustHave ?? {
      extracted: { skills: [], experience: [] },
      matched: [],
    },
    niceToHave: json.niceToHave ?? {
      extracted: { skills: [], certifications: [] },
      matched: [],
    },
    requestId,
    duration_ms: Date.now() - startedAt,
  };
}

// ─── Response shape (RoboHire /parse-resume) ───────────────────────
// Based on resume-agent-engineering-spec §5.1; tolerant to missing fields.

type RoboHireParseResponse = {
  data?: {
    name?: string | null;
    phone?: string | null;
    email?: string | null;
    location?: string | null;
    summary?: string | null;
    skills?: string[];
    experience?: Array<{
      title?: string;
      company?: string;
      startDate?: string;
      endDate?: string;
      description?: string;
    }>;
    education?: Array<{
      degree?: string;
      field?: string;
      institution?: string;
      graduationYear?: string | number;
    }>;
  };
};

function mapRoboHireToParsedResume(rh: RoboHireParseResponse): ParsedResume {
  const d = rh.data ?? {};
  const experience = Array.isArray(d.experience) ? d.experience : [];
  const education = Array.isArray(d.education) ? d.education : [];
  const skills = Array.isArray(d.skills) ? d.skills : [];

  // Pick "current" job: experience entry whose endDate is undefined / "present"
  const cur = experience.find((e) => {
    const v = (e.endDate ?? "").toLowerCase();
    return v === "" || v === "present" || v === "current" || v === "至今";
  }) ?? experience[0];

  // Highest degree by rank
  const rank: Record<string, number> = {
    大专: 1,
    本科: 2,
    bachelor: 2,
    "本科 (Bachelor)": 2,
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

  // Work years estimate from experience date ranges
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
      work_history: experience.map((e) => ({
        title: e.title,
        company: e.company,
        startDate: e.startDate,
        endDate: e.endDate,
        description: e.description,
      })),
      education_history: education.map((e) => ({
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

function cleanPhone(p: string | null | undefined): string | null {
  if (!p) return null;
  return p.replace(/[\s\-]/g, "").trim() || null;
}

function parseDateLoose(s: string): number | null {
  if (!s) return null;
  // YYYY-MM, YYYY-MM-DD, YYYY/MM, YYYY
  const m = s.match(/^(\d{4})[-/]?(\d{1,2})?[-/]?(\d{1,2})?/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2] ?? 1);
  const d = Number(m[3] ?? 1);
  if (!y || y < 1970 || y > 2100) return null;
  return new Date(y, mo - 1, d).getTime();
}

// ─── Flatten ParsedResume → plain text for /match-resume ─────────

export function flattenParsedResumeForMatch(parsed: ParsedResume): string {
  const lines: string[] = [];
  if (parsed.candidate.name) lines.push(`姓名: ${parsed.candidate.name}`);
  if (parsed.candidate.email) lines.push(`邮箱: ${parsed.candidate.email}`);
  if (parsed.candidate.mobile) lines.push(`电话: ${parsed.candidate.mobile}`);
  if (parsed.candidate.current_location) lines.push(`城市: ${parsed.candidate.current_location}`);
  if (parsed.candidate.work_years != null) lines.push(`工作年限: ${parsed.candidate.work_years}年`);
  if (parsed.candidate.highest_acquired_degree) lines.push(`学历: ${parsed.candidate.highest_acquired_degree}`);
  if (parsed.candidate.current_title || parsed.candidate.current_company) {
    lines.push(
      `当前: ${parsed.candidate.current_title ?? ""} @ ${parsed.candidate.current_company ?? ""}`,
    );
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
      lines.push(
        `  ${w.startDate ?? ""} - ${w.endDate ?? "至今"}  ${w.title ?? ""} @ ${w.company ?? ""}`,
      );
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
