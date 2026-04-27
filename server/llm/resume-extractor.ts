// Resume → 4-object structured payload extractor.
//
// Outputs the schema in resume-agent-engineering-spec §3.2 (RESUME_PROCESSED):
//   { candidate, candidate_expectation, resume, runtime }
//
// Mode selection (priority, env-driven):
//   - For binary buffers (PDF): extractResumeFromBuffer()
//     1. RoboHire SaaS — ROBOHIRE_API_KEY set (production resume parser)
//     2. Text fallback — pdf-parse → extractResume(text)
//   - For text:           extractResume()
//     1. new-api gateway — AI_BASE_URL + AI_API_KEY + AI_MODEL
//     2. OpenAI direct   — OPENAI_API_KEY (gpt-4o-mini)
//     3. Deterministic stub — regex over text
//
// Result.mode tags which path produced the data so the UI can show it.

import OpenAI from "openai";
import {
  isRoboHireConfigured,
  roboHireParseResume,
  RoboHireError,
} from "./robohire";

export type ParsedResume = {
  candidate: {
    name: string | null;
    mobile: string | null;
    email: string | null;
    gender: string | null;
    birth_date: string | null;
    current_location: string | null;
    highest_acquired_degree: string | null;
    work_years: number | null;
    current_company: string | null;
    current_title: string | null;
    skills: string[];
  };
  candidate_expectation: {
    expected_salary_monthly_min: number | null;
    expected_salary_monthly_max: number | null;
    expected_cities: string[];
    expected_industries: string[];
    expected_roles: string[];
    expected_work_mode: string | null;
  };
  resume: {
    summary: string | null;
    skills_extracted: string[];
    work_history: Array<{
      title?: string;
      company?: string;
      startDate?: string;
      endDate?: string;
      description?: string;
    }>;
    education_history: Array<{
      degree?: string;
      field?: string;
      institution?: string;
      graduationYear?: string;
    }>;
    project_history: unknown[];
  };
  runtime: {
    current_title: string | null;
    current_company: string | null;
  };
};

export type ExtractResult = {
  parsed: ParsedResume;
  mode: "robohire" | "new-api" | "openai" | "stub";
  modelUsed: string;
  duration_ms: number;
  requestId?: string;       // present for robohire
  cached?: boolean;          // present for robohire
  fallback_reason?: string;  // present only when an LLM was attempted but fell back
};

/**
 * Binary-input extractor — used by the agent when it has the raw PDF
 * bytes from MinIO. Tries RoboHire first (production), falls back to
 * text extraction + LLM/stub if RoboHire isn't configured or fails.
 */
export async function extractResumeFromBuffer(
  buffer: Buffer,
  filename: string,
): Promise<ExtractResult> {
  const startedAt = Date.now();
  if (isRoboHireConfigured()) {
    try {
      const r = await roboHireParseResume(buffer, filename);
      return {
        parsed: r.parsed,
        mode: "robohire",
        modelUsed: "robohire/parse-resume",
        duration_ms: r.duration_ms,
        requestId: r.requestId,
        cached: r.cached,
      };
    } catch (e) {
      const reason =
        e instanceof RoboHireError
          ? `${e.status}: ${e.message}`
          : (e as Error).message;
      console.warn(`[resume-extractor] RoboHire failed (${reason}); falling back to text path`);
      // fall through to text extraction
      const fb = await extractResume(await bufferToText(buffer, filename));
      return {
        ...fb,
        fallback_reason: `robohire: ${reason}`,
        duration_ms: Date.now() - startedAt,
      };
    }
  }
  // No RoboHire configured — text path only
  const text = await bufferToText(buffer, filename);
  return await extractResume(text);
}

async function bufferToText(buffer: Buffer, filename: string): Promise<string> {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".pdf")) {
    const mod = await import("pdf-parse");
    const pdfParse = (mod as any).default ?? (mod as any);
    const result = await pdfParse(buffer);
    return result.text ?? "";
  }
  // .txt / fallback
  return buffer.toString("utf-8");
}

const SYSTEM_PROMPT = `You parse Chinese resumes into a strict JSON schema.

Output JSON with exactly these top-level keys: candidate, candidate_expectation, resume, runtime.

candidate fields: name, mobile, email, gender, birth_date (YYYY-MM-DD), current_location, highest_acquired_degree, work_years (integer), current_company, current_title, skills (string[]).
candidate_expectation fields: expected_salary_monthly_min (number, in CNY e.g. 35000), expected_salary_monthly_max (number), expected_cities (string[]), expected_industries (string[]), expected_roles (string[]), expected_work_mode (string).
resume fields: summary (string), skills_extracted (string[]), work_history ({title, company, startDate, endDate, description}[]), education_history ({degree, field, institution, graduationYear}[]), project_history (any[], default []).
runtime fields: current_title, current_company (mirror candidate fields).

Use null for missing values. Use [] for missing lists. Do NOT invent data.
Output JSON only, no prose.`;

type GatewayConfig = {
  baseURL: string;
  apiKey: string;
  model: string;
  mode: "new-api" | "openai";
};

function pickGateway(): GatewayConfig | null {
  // Priority 1: new-api or any OpenAI-compatible gateway
  if (process.env.AI_BASE_URL && process.env.AI_API_KEY) {
    return {
      baseURL: process.env.AI_BASE_URL,
      apiKey: process.env.AI_API_KEY,
      model: process.env.AI_MODEL || "google/gemini-3-flash-preview",
      mode: "new-api",
    };
  }
  // Priority 2: OpenAI direct
  if (process.env.OPENAI_API_KEY) {
    return {
      baseURL: "https://api.openai.com/v1",
      apiKey: process.env.OPENAI_API_KEY,
      model: "gpt-4o-mini",
      mode: "openai",
    };
  }
  return null;
}

export async function extractResume(text: string): Promise<ExtractResult> {
  const startedAt = Date.now();
  const gateway = pickGateway();

  if (gateway) {
    try {
      const client = new OpenAI({
        baseURL: gateway.baseURL,
        apiKey: gateway.apiKey,
        // The new-api gateway can be slow on cold paths; raise timeout.
        timeout: 60_000,
      });
      const completion = await client.chat.completions.create({
        model: gateway.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: text.slice(0, 10_000) },
        ],
        response_format: { type: "json_object" },
        temperature: 0,
      });
      const raw = completion.choices[0]?.message?.content ?? "{}";
      const parsed = normalizeParsed(JSON.parse(stripCodeFence(raw)));
      return {
        parsed,
        mode: gateway.mode,
        modelUsed: gateway.model,
        duration_ms: Date.now() - startedAt,
      };
    } catch (e) {
      const reason = (e as Error).message;
      console.warn(
        `[resume-extractor] ${gateway.mode} (${gateway.model}) failed: ${reason} — falling back to stub`,
      );
      const parsed = extractStub(text);
      return {
        parsed,
        mode: "stub",
        modelUsed: "deterministic-regex",
        duration_ms: Date.now() - startedAt,
        fallback_reason: `${gateway.mode}/${gateway.model}: ${reason}`,
      };
    }
  }

  // Stub: deterministic regex-based extraction. No LLM keys configured.
  const parsed = extractStub(text);
  return {
    parsed,
    mode: "stub",
    modelUsed: "deterministic-regex",
    duration_ms: Date.now() - startedAt,
  };
}

// Some gateways wrap responses in ```json ... ``` even with response_format
// set. Strip it before JSON.parse.
function stripCodeFence(s: string): string {
  const m = s.trim().match(/^```(?:json)?\s*([\s\S]+?)\s*```$/);
  return m ? m[1] : s;
}

// ─── Stub implementation ─────────────────────────────────────────────

function extractStub(text: string): ParsedResume {
  const name = pickFirstLine(text);
  const mobile = matchOne(text, /(?:手机|电话|Mobile)\s*[:：]?\s*([\d\-\s+]{8,})/i);
  const email = matchOne(text, /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  const location = matchOne(text, /(?:^|·|\s|地点[:：]?)\s*([北上广深杭成都南苏州武汉重庆天津西安青岛长沙厦门]京?[京海州圳州都汉庆津京沙岛门]?)/) ??
                   matchOne(text, /(?:期望城市|工作地点|地点)\s*[:：]\s*([^\s\n,，]+)/);
  const skills = extractSkills(text);
  const workHistory = extractWorkHistory(text);
  const educationHistory = extractEducationHistory(text);
  const summary = pickSummary(text);
  const expectedSalary = parseSalaryRange(text);
  const expectedCities = extractExpectedCities(text);
  const workYears = inferWorkYears(workHistory);
  const currentTitle = workHistory[0]?.title ?? null;
  const currentCompany = workHistory[0]?.company ?? null;
  const highestDegree = pickHighestDegree(educationHistory);

  return {
    candidate: {
      name,
      mobile,
      email,
      gender: matchOne(text, /(男|女)/),
      birth_date: matchOne(text, /(\d{4}-\d{2}-\d{2})/),
      current_location: location,
      highest_acquired_degree: highestDegree,
      work_years: workYears,
      current_company: currentCompany,
      current_title: currentTitle,
      skills,
    },
    candidate_expectation: {
      expected_salary_monthly_min: expectedSalary.min,
      expected_salary_monthly_max: expectedSalary.max,
      expected_cities: expectedCities,
      expected_industries: [],
      expected_roles: extractExpectedRoles(text),
      expected_work_mode: matchOne(text, /(现场|远程|混合)/),
    },
    resume: {
      summary,
      skills_extracted: skills,
      work_history: workHistory,
      education_history: educationHistory,
      project_history: [],
    },
    runtime: {
      current_title: currentTitle,
      current_company: currentCompany,
    },
  };
}

function pickFirstLine(text: string): string | null {
  const first = text
    .split(/\n/)
    .map((s) => s.trim())
    .find((s) => s.length > 0 && s.length < 20);
  return first ?? null;
}

function matchOne(text: string, re: RegExp): string | null {
  const m = text.match(re);
  if (!m) return null;
  return (m[1] ?? m[0]).trim();
}

const KNOWN_SKILLS = [
  "Java", "Spring Cloud", "Spring Boot", "Dubbo", "MySQL", "Redis", "Kafka",
  "RocketMQ", "JVM 调优", "JVM", "微服务", "分布式架构", "高并发设计", "Linux", "Git",
  "React", "React 19", "TypeScript", "JavaScript", "Next.js", "Tailwind CSS", "Vite",
  "Turbopack", "前端工程化", "monorepo", "CSS-in-JS", "Vue", "Vue 2/3", "Webpack",
  "Node.js", "Python", "PySpark", "Flink", "Spark", "Hadoop", "Hive", "MaxCompute",
  "数据建模", "风控建模", "机器学习", "实时计算", "Airflow", "SQL 优化", "A/B 测试",
  "Unreal Engine 5", "C++", "技术美术", "Shader", "Houdini",
];

function extractSkills(text: string): string[] {
  const found = new Set<string>();
  for (const skill of KNOWN_SKILLS) {
    if (text.includes(skill)) found.add(skill);
  }
  return [...found];
}

function extractWorkHistory(text: string): ParsedResume["resume"]["work_history"] {
  const lines = text.split("\n");
  const out: ParsedResume["resume"]["work_history"] = [];
  // pattern: "Company · Title · 2020-03 至今"
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^(.+?)\s*[·•]\s*(.+?)\s*[·•]\s*(\d{4}-\d{2})(?:\s*至\s*(\d{4}-\d{2}|今至今|现在|今))?/);
    if (m) {
      out.push({
        company: m[1].trim(),
        title: m[2].trim(),
        startDate: m[3],
        endDate: m[4] ?? "至今",
        description: lines
          .slice(i + 1, Math.min(i + 5, lines.length))
          .filter((l) => l.trim().startsWith("-"))
          .join(" ")
          .slice(0, 240),
      });
    }
  }
  return out;
}

function extractEducationHistory(
  text: string,
): ParsedResume["resume"]["education_history"] {
  const out: ParsedResume["resume"]["education_history"] = [];
  // pattern: "Institution · Major · 学位 · 2014-2018"
  const re = /(.+大学|.+学院|.+大学校)\s*[·•]\s*(.+?)\s*[·•]\s*(本科|硕士|博士|大专|MBA)\s*[·•]\s*(\d{4})-(\d{4})/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push({
      institution: m[1].trim(),
      field: m[2].trim(),
      degree: m[3],
      graduationYear: m[5],
    });
  }
  return out;
}

function pickSummary(text: string): string | null {
  const m = text.match(/【(?:个人简介|简介|Summary)】\s*\n([\s\S]+?)(?:\n\s*【|\n\n)/);
  if (m) return m[1].trim().replace(/\s+/g, " ").slice(0, 240);
  return null;
}

function parseSalaryRange(
  text: string,
): { min: number | null; max: number | null } {
  // 30-40K, 30K-40K, 35-45K
  const m = text.match(/(\d{1,3})K?\s*-\s*(\d{1,3})\s*K/);
  if (m) return { min: Number(m[1]) * 1000, max: Number(m[2]) * 1000 };
  return { min: null, max: null };
}

function extractExpectedCities(text: string): string[] {
  const m = text.match(/期望城市\s*[:：]\s*([^\n]+)/);
  if (!m) return [];
  return m[1]
    .split(/[、,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function extractExpectedRoles(text: string): string[] {
  const m = text.match(/期望职位\s*[:：]\s*([^\n]+)/);
  if (!m) return [];
  return m[1]
    .split(/[\/、,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function inferWorkYears(
  hist: ParsedResume["resume"]["work_history"],
): number | null {
  if (hist.length === 0) return null;
  let total = 0;
  for (const w of hist) {
    if (!w.startDate) continue;
    const start = new Date(w.startDate + "-01").getTime();
    const endStr = w.endDate ?? "至今";
    const end = /\d{4}-\d{2}/.test(endStr)
      ? new Date(endStr + "-01").getTime()
      : Date.now();
    total += Math.max(0, end - start) / (1000 * 60 * 60 * 24 * 365);
  }
  return Math.round(total);
}

function pickHighestDegree(
  edu: ParsedResume["resume"]["education_history"],
): string | null {
  const rank: Record<string, number> = { 大专: 1, 本科: 2, MBA: 3, 硕士: 3, 博士: 4 };
  let best: string | null = null;
  let bestRank = 0;
  for (const e of edu) {
    const r = rank[e.degree ?? ""] ?? 0;
    if (r > bestRank) {
      bestRank = r;
      best = e.degree ?? null;
    }
  }
  return best;
}

function normalizeParsed(raw: any): ParsedResume {
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
      expected_industries: Array.isArray(ce.expected_industries)
        ? ce.expected_industries
        : [],
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
