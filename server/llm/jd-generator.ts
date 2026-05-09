// LLM-based JD generator.
//
// Takes a JobRequisition (raw need from REQUIREMENT_LOGGED) and produces
// the JD_GENERATED.payload shape partner agreed on (2026-04-28):
//
//   {
//     job_requisition_id, client_id,
//     posting_title:        "...",                   // 标准化职位名
//     posting_description:  "...long text/HTML...",  // 完整可发布的 JD 文本
//     city:                 string[],                // 多地点支持
//     salary_range:         "25000-40000",           // 纯数字字符串 min-max
//     interview_mode:       "onsite" | "video" | "phone" | "hybrid",
//     degree_requirement:   "本科" | "硕士" | "博士" | "大专" | "不限",
//     education_requirement:"统招本科" | "计算机相关" | "不限",
//     work_years:           number,                  // 整数
//     recruitment_type:     "social" | "campus" | "intern" | "internal",
//     must_have_skills:     string[],                // 必备技能（硬过滤；3-8 项）
//     nice_to_have_skills:  string[],                // 加分技能
//     negative_requirement: string,                  // 排除项 / "无"
//     language_requirements:string,                  // "英语读写流利" / "普通话" / "无"
//     expected_level:       "junior" | "mid" | "senior" | "principal" | "lead"
//   }
//
// One LLM call (gemini-3-flash-preview, response_format=json_object).

import OpenAI from "openai";
import type { LoggerLike } from "@/server/agent-logger";
import { withLlmTelemetry } from "./instrumented";

export type JdGenInput = {
  client: string;
  title: string;
  jobType?: string | null;
  recruitmentType?: string | null; // 社会全职 / 实习 / 校招
  expectedLevel?: string | null;   // T3-T4 / 中3-高1
  city?: string | null;
  headcount?: number | null;
  salaryRangeMin?: number | null;
  salaryRangeMax?: number | null;
  salaryRangeRaw?: string | null;
  isUrgent?: boolean;
  isExclusive?: boolean;
  priority?: string | null;
  deadline?: string | null;
  startDate?: string | null;
  firstInterviewFormat?: string | null;
  finalInterviewFormat?: string | null;
  responsibilities?: string | null;
  requirements?: string | null;
  niceToHaves?: string | null;
};

/** Final JD_GENERATED.payload — flat shape per partner spec (2026-04-28). */
export type JdGeneratedPayload = {
  posting_title: string;
  posting_description: string;          // long text containing 职责 + 要求 + 福利 + 工作安排 + 公司介绍
  // ── 岗位发布信息：单独抽出来的两段叙事字段（LLM 结合 raw 职责/要求扩写）──
  responsibility: string;               // markdown bullet list of 岗位职责（发布版本）
  requirement: string;                  // markdown bullet list of 任职要求（发布版本）
  city: string[];                       // array — supports multi-city roles
  salary_range: string;                 // "25000-40000" (raw numbers, no "k")
  interview_mode: InterviewMode;
  degree_requirement: string;
  education_requirement: string;
  work_years: number;                   // 0 = 不限
  recruitment_type: RecruitmentType;
  must_have_skills: string[];
  nice_to_have_skills: string[];
  negative_requirement: string;
  language_requirements: string;
  expected_level: ExpectedLevel;
};

export type InterviewMode = "onsite" | "video" | "phone" | "hybrid" | "unspecified";
export type RecruitmentType = "social" | "campus" | "intern" | "internal" | "unspecified";
export type ExpectedLevel = "junior" | "mid" | "senior" | "principal" | "lead" | "unspecified";

export type JdGenResult = {
  payload: JdGeneratedPayload;          // ← 直接塞到 JD_GENERATED.payload 里
  searchKeywords: string[];             // 顺便给 SEO 用，不在 partner spec 里
  qualityScore: number;
  qualitySuggestions: string[];
  marketCompetitiveness: "高" | "中" | "低";
  modelUsed: string;
  durationMs: number;
  rawResponse: string;
};

type GatewayConfig = {
  baseURL: string;
  apiKey: string;
  model: string;
};

function pickGateway(): GatewayConfig {
  if (process.env.AI_BASE_URL && process.env.AI_API_KEY) {
    return {
      baseURL: process.env.AI_BASE_URL,
      apiKey: process.env.AI_API_KEY,
      model: process.env.AI_MODEL || "google/gemini-3-flash-preview",
    };
  }
  if (process.env.OPENAI_API_KEY) {
    return {
      baseURL: "https://api.openai.com/v1",
      apiKey: process.env.OPENAI_API_KEY,
      model: "gpt-4o-mini",
    };
  }
  throw new Error("LLM gateway not configured (AI_BASE_URL+AI_API_KEY or OPENAI_API_KEY)");
}

const SYSTEM_PROMPT = `You produce a single structured JD_GENERATED.payload
JSON object from raw recruitment requirements. Output STRICT JSON matching
this exact schema (no prose, no fences):

{
  "posting_title":         string,
  "posting_description":   string,                       // long markdown JD text combining 岗位职责 + 任职要求 + 加分项 + 公司介绍 + 薪资福利 + 工作安排 (separated by blank lines / sub-headings)
  "responsibility":        string,                       // 岗位发布信息.岗位职责 — markdown bullet list (4-6 bullets) 扩写自客户原始 job_responsibility，发布到 BOSS / 智联 用
  "requirement":           string,                       // 岗位发布信息.岗位要求 — markdown bullet list (4-6 bullets) 扩写自客户原始 job_requirement
  "city":                  string[],                     // 多地点；至少 1 项
  "salary_range":          string,                       // 纯数字字符串 "25000-40000"。若只有一头，用 "25000-25000"
  "interview_mode":        "onsite" | "video" | "phone" | "hybrid" | "unspecified",
  "degree_requirement":    string,                       // "本科" / "硕士" / "博士" / "大专" / "不限"
  "education_requirement": string,                       // "统招本科" / "计算机相关" / "理工科" / "不限"
  "work_years":            number,                       // 整数；不限填 0
  "recruitment_type":      "social" | "campus" | "intern" | "internal" | "unspecified",
  "must_have_skills":      string[],                     // 3-8 项，原子化（"Go" 不是 "熟悉 Go"）
  "nice_to_have_skills":   string[],                     // 2-6 项
  "negative_requirement":  string,                       // 排除项 / "无"
  "language_requirements": string,                       // "英语读写流利" / "普通话" / "无"
  "expected_level":        "junior" | "mid" | "senior" | "principal" | "lead" | "unspecified",
  "search_keywords":       string[],                     // 5 项 SEO 关键词
  "quality_score":         number,                       // 0-100
  "quality_suggestions":   string[],
  "market_competitiveness":"高" | "中" | "低"
}

Rules:
- Output JSON ONLY. No code fences, no commentary.
- "posting_title" should include level (e.g. "高级前端开发工程师 (T3-T4)").
- "responsibility" 是岗位发布信息中的"岗位职责"段落（独立字段，发布渠道用）。
  从客户的原始 job_responsibility 出发，扩写成 4-6 条专业化的 bullet
  list（markdown，每行 "- "）。要语句完整、动词开头、可直接发布到 BOSS / 智联，不
  要复制原文流水账。
- "requirement" 是岗位发布信息中的"岗位要求"段落（独立字段，发布渠道用）。
  从客户的原始 job_requirement 出发，扩写成 4-6 条 bullet list（markdown），
  涵盖学历 / 年限 / 必备技能 / 软实力 4 个维度。
- "posting_description" 是把 responsibility + requirement + 加分项 + 薪资福利 +
  工作安排 + 公司介绍 拼成的 markdown 长文（带 ## 标题），用来一键发布:
    ## 岗位职责
    {responsibility 内容}
    ## 任职要求
    {requirement 内容}
    ## 加分项
    ...
    ## 薪资福利
    ...
    ## 工作安排
    ...
    ## 公司介绍
    ...
  即 posting_description 包含 responsibility + requirement，不要冲突。
- "city" is an array. Single-city → ["深圳"]. Multi-city → ["深圳","北京"].
- "salary_range" canonical format: "<min>-<max>" with RAW NUMBERS (no
  "k" / "万"). e.g. "7k-11k" → "7000-11000"; "30-50k" → "30000-50000";
  "30000-50000" passes through.
- Map raw Chinese values to canonical English enums:
    interview_mode:   "现场面试"→onsite, "视频面试"→video, "电话面试"→phone, "线上线下结合"→hybrid
    recruitment_type: "社会"/"社招"/"社会全职"→social, "校招"→campus,
                      "实习"→intern, "内推"/"内部转岗"→internal
    expected_level:   T1-T2 / 初级 → junior
                      T3 / 中级 → mid
                      T3-T4 / T4 / 高级 / 中3-高1 → senior
                      T5+ / 资深 / 专家 → principal
                      Lead / Manager / 总监 → lead
                      不明确 → unspecified
- Skills must be CRISP, atomic, industry-canonical:
    GOOD: "Go", "Kubernetes", "MySQL", "React", "微服务架构", "TypeScript"
    BAD:  "熟悉 Go 语言", "5 年 Go 经验", "Go 编程能力"
- "work_years": pick lower bound of "1-3 年" → 1; "5 年以上" → 5; 不限 → 0.
- "negative_requirement": preserve user-stated exclusions verbatim
  (e.g. "无996红线公司背景"); else "无".
- For Chinese roles use Chinese in posting_title/description; English roles can be EN.`;

export async function llmGenerateJd(
  input: JdGenInput,
  opts?: { logger?: LoggerLike },
): Promise<JdGenResult> {
  const gateway = pickGateway();
  const startedAt = Date.now();
  const client = new OpenAI({
    baseURL: gateway.baseURL,
    apiKey: gateway.apiKey,
    timeout: 60_000,
  });

  const lines = [
    `客户/部门: ${input.client}`,
    `原始岗位名称: ${input.title}`,
  ];
  if (input.jobType) lines.push(`岗位类型: ${input.jobType}`);
  if (input.recruitmentType) lines.push(`招聘类型: ${input.recruitmentType}`);
  if (input.expectedLevel) lines.push(`期望级别: ${input.expectedLevel}`);
  if (input.city) lines.push(`工作城市: ${input.city}`);
  if (input.headcount) lines.push(`招聘人数: ${input.headcount}`);
  if (input.salaryRangeMin || input.salaryRangeMax) {
    lines.push(
      `薪资范围 (CNY/月): ${input.salaryRangeMin ?? "?"} - ${input.salaryRangeMax ?? "?"}${input.salaryRangeRaw ? ` (raw: ${input.salaryRangeRaw})` : ""}`,
    );
  } else if (input.salaryRangeRaw) {
    lines.push(`薪资范围 (raw): ${input.salaryRangeRaw}`);
  }
  if (input.priority) lines.push(`优先级: ${input.priority}`);
  if (input.isUrgent) lines.push(`紧急: 是`);
  if (input.isExclusive) lines.push(`独家委托: 是`);
  if (input.deadline) lines.push(`截止日期: ${input.deadline}`);
  if (input.startDate) lines.push(`期望到岗: ${input.startDate}`);
  if (input.firstInterviewFormat || input.finalInterviewFormat) {
    lines.push(
      `面试形式: 初试 ${input.firstInterviewFormat ?? "—"} / 复试 ${input.finalInterviewFormat ?? "—"}`,
    );
  }
  if (input.responsibilities) lines.push(`\n岗位职责（原始）:\n${input.responsibilities}`);
  if (input.requirements) lines.push(`\n任职要求（原始）:\n${input.requirements}`);
  if (input.niceToHaves) lines.push(`\n加分项（原始）:\n${input.niceToHaves}`);

  // withLlmTelemetry auto-writes a `tool` AgentActivity (with token counts /
  // duration) on success and an `anomaly` row on failure when a logger is
  // supplied. Pass-through otherwise.
  const { raw, parsed } = await withLlmTelemetry(
    {
      logger: opts?.logger,
      toolName: "LLM.generateJD",
      model: gateway.model,
      meta: { client: input.client, title: input.title },
    },
    async () => {
      const completion = await client.chat.completions.create({
        model: gateway.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: lines.join("\n") },
        ],
        response_format: { type: "json_object" },
        temperature: 0.2,
      });
      const raw = completion.choices[0]?.message?.content ?? "{}";
      const parsed = JSON.parse(stripCodeFence(raw));
      return { result: { raw, parsed }, usage: completion.usage };
    },
  );

  // Build canonical fallbacks from input when LLM misses the mapping.
  const fallbackSalary =
    input.salaryRangeMin && input.salaryRangeMax
      ? `${input.salaryRangeMin}-${input.salaryRangeMax}`
      : input.salaryRangeRaw
        ? normalizeSalaryString(input.salaryRangeRaw)
        : "";

  const responsibilityFromLlm = stringOr(parsed?.responsibility, input.responsibilities ?? "");
  const requirementFromLlm = stringOr(parsed?.requirement, input.requirements ?? "");
  const payload: JdGeneratedPayload = {
    posting_title: stringOr(parsed?.posting_title, input.title),
    posting_description: stringOr(
      parsed?.posting_description,
      [
        responsibilityFromLlm ? `## 岗位职责\n${responsibilityFromLlm}` : "",
        requirementFromLlm ? `## 任职要求\n${requirementFromLlm}` : "",
        input.niceToHaves ? `## 加分项\n${input.niceToHaves}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    ),
    responsibility: responsibilityFromLlm,
    requirement: requirementFromLlm,
    city: arr(parsed?.city, 6).filter((s): s is string => typeof s === "string" && s.length > 0).length
      ? (arr(parsed.city, 6).filter((s) => typeof s === "string") as string[])
      : input.city
        ? [input.city]
        : [],
    salary_range: stringOr(parsed?.salary_range, fallbackSalary),
    interview_mode: enumOr<InterviewMode>(
      parsed?.interview_mode,
      ["onsite", "video", "phone", "hybrid", "unspecified"],
      mapInterviewMode(input.firstInterviewFormat ?? input.finalInterviewFormat),
    ),
    degree_requirement: stringOr(parsed?.degree_requirement, "本科"),
    education_requirement: stringOr(parsed?.education_requirement, "不限"),
    work_years:
      typeof parsed?.work_years === "number" && Number.isFinite(parsed.work_years)
        ? Math.max(0, Math.round(parsed.work_years))
        : 0,
    recruitment_type: enumOr<RecruitmentType>(
      parsed?.recruitment_type,
      ["social", "campus", "intern", "internal", "unspecified"],
      mapRecruitmentType(input.recruitmentType),
    ),
    must_have_skills: arr(parsed?.must_have_skills, 12).filter(
      (s): s is string => typeof s === "string" && s.trim().length > 0,
    ) as string[],
    nice_to_have_skills: arr(parsed?.nice_to_have_skills, 12).filter(
      (s): s is string => typeof s === "string" && s.trim().length > 0,
    ) as string[],
    negative_requirement: stringOr(parsed?.negative_requirement, "无"),
    language_requirements: stringOr(parsed?.language_requirements, "无"),
    expected_level: enumOr<ExpectedLevel>(
      parsed?.expected_level,
      ["junior", "mid", "senior", "principal", "lead", "unspecified"],
      mapExpectedLevel(input.expectedLevel),
    ),
  };

  return {
    payload,
    searchKeywords: arr(parsed?.search_keywords, 8).filter(
      (s): s is string => typeof s === "string",
    ) as string[],
    qualityScore: clampScore(parsed?.quality_score),
    qualitySuggestions: arr(parsed?.quality_suggestions, 12).filter(
      (s): s is string => typeof s === "string",
    ) as string[],
    marketCompetitiveness: ["高", "中", "低"].includes(parsed?.market_competitiveness)
      ? (parsed.market_competitiveness as "高" | "中" | "低")
      : "中",
    modelUsed: gateway.model,
    durationMs: Date.now() - startedAt,
    rawResponse: raw,
  };
}

/** Plain-text version for RoboHire /match-resume.
 *  Structured fields go first (matcher locks onto these), prose follows. */
export function flattenJdPayloadForMatch(p: JdGeneratedPayload): string {
  const lines: string[] = [];
  lines.push(`职位: ${p.posting_title}`);
  if (p.city.length) lines.push(`工作城市: ${p.city.join(" / ")}`);
  if (p.salary_range) lines.push(`薪资范围: ${p.salary_range} CNY/月`);
  lines.push(`招聘类型: ${p.recruitment_type}`);
  lines.push(`职级: ${p.expected_level}`);
  lines.push(`面试形式: ${p.interview_mode}`);

  if (p.work_years > 0) lines.push(`\n工作年限: ${p.work_years} 年以上`);
  if (p.degree_requirement) lines.push(`学历要求: ${p.degree_requirement}`);
  if (p.education_requirement && p.education_requirement !== "不限") {
    lines.push(`专业要求: ${p.education_requirement}`);
  }
  if (p.language_requirements && p.language_requirements !== "无") {
    lines.push(`语言要求: ${p.language_requirements}`);
  }
  if (p.must_have_skills.length) {
    lines.push(`\n必备技能（must-have）:\n  - ${p.must_have_skills.join("\n  - ")}`);
  }
  if (p.nice_to_have_skills.length) {
    lines.push(`\n加分技能（nice-to-have）:\n  - ${p.nice_to_have_skills.join("\n  - ")}`);
  }
  if (p.negative_requirement && p.negative_requirement !== "无") {
    lines.push(`\n排除条件: ${p.negative_requirement}`);
  }
  if (p.posting_description) {
    lines.push(`\n${p.posting_description}`);
  }
  return lines.join("\n");
}

// ─── helpers ──────────────────────────────────────────────────────

function stripCodeFence(s: string): string {
  const m = s.trim().match(/^```(?:json)?\s*([\s\S]+?)\s*```$/);
  return m ? m[1] : s;
}

function stringOr(v: unknown, fallback: string): string {
  if (typeof v === "string" && v.trim().length > 0) return v;
  return fallback;
}

function enumOr<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  if (typeof v === "string" && (allowed as readonly string[]).includes(v)) return v as T;
  return fallback;
}

function clampScore(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function arr(v: unknown, max: number): unknown[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, max);
}

function mapInterviewMode(v: string | null | undefined): InterviewMode {
  if (!v) return "unspecified";
  if (v.includes("现场")) return "onsite";
  if (v.includes("视频") || v.toLowerCase().includes("video")) return "video";
  if (v.includes("电话") || v.toLowerCase().includes("phone")) return "phone";
  if (v.includes("混合") || v.toLowerCase().includes("hybrid")) return "hybrid";
  return "unspecified";
}

function mapRecruitmentType(v: string | null | undefined): RecruitmentType {
  if (!v) return "unspecified";
  if (v.includes("社会") || v.includes("社招")) return "social";
  if (v.includes("校招") || v.includes("校园")) return "campus";
  if (v.includes("实习")) return "intern";
  if (v.includes("内推") || v.includes("内部")) return "internal";
  return "unspecified";
}

function mapExpectedLevel(v: string | null | undefined): ExpectedLevel {
  if (!v) return "unspecified";
  const l = v.toLowerCase();
  if (l.includes("初") || l.includes("junior") || /t1|t2/.test(l)) return "junior";
  if (l.includes("中") || l.includes("mid") || /t3(?!.*高)/.test(l)) return "mid";
  if (l.includes("高") || l.includes("senior") || /t3.*4|t4/.test(l)) return "senior";
  if (l.includes("资深") || l.includes("专家") || l.includes("principal") || /t5/.test(l))
    return "principal";
  if (l.includes("lead") || l.includes("manager") || l.includes("总监")) return "lead";
  return "unspecified";
}

function normalizeSalaryString(s: string): string {
  // "7k-11k" → "7000-11000"; "30-50k" → "30000-50000"; "30000-50000" passes
  const m = s.trim().match(/(\d+(?:\.\d+)?)\s*([Kk万w]?)\s*[-~–到至]\s*(\d+(?:\.\d+)?)\s*([Kk万w]?)/);
  if (!m) return s;
  const mul = (token: string) => {
    if (!token) return 1;
    const t = token.toLowerCase();
    if (t === "k") return 1000;
    if (t === "万" || t === "w") return 10000;
    return 1;
  };
  const left = Math.round(Number(m[1]) * mul(m[2] || m[4]));
  const right = Math.round(Number(m[3]) * mul(m[4] || m[2]));
  return `${Math.min(left, right)}-${Math.max(left, right)}`;
}

/** kept for back-compat with parseSalaryRangeChinese callers (none right now) */
export function parseSalaryRangeChinese(
  s: string | null | undefined,
): { min: number | null; max: number | null } {
  if (!s) return { min: null, max: null };
  const m = s.trim().match(/(\d+(?:\.\d+)?)\s*([Kk万w]?)\s*[-~–到至]\s*(\d+(?:\.\d+)?)\s*([Kk万w]?)/);
  if (!m) return { min: null, max: null };
  const mul = (token: string) => {
    if (!token) return 1;
    const t = token.toLowerCase();
    if (t === "k") return 1000;
    if (t === "万" || t === "w") return 10000;
    return 1;
  };
  const left = Number(m[1]) * mul(m[2] || m[4]);
  const right = Number(m[3]) * mul(m[4] || m[2]);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return { min: null, max: null };
  return { min: Math.round(Math.min(left, right)), max: Math.round(Math.max(left, right)) };
}
