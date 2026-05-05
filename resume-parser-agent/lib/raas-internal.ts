// RAAS Dashboard Internal API client.
//
// Endpoint: GET {RAAS_INTERNAL_API_URL}/api/v1/internal/requirements
// Auth:     Authorization: Bearer ${RAAS_AGENT_API_KEY}
//
// Used by the matchResume agent to look up all open requirements claimed
// by a recruiter (employee_id from the inbound RESUME_PROCESSED event),
// then loop and match the resume against every one.
//
// Env vars (read lazily at call time so process.env edits in tests apply):
//   RAAS_INTERNAL_API_URL          base URL, e.g. https://raas.example.com
//   RAAS_AGENT_API_KEY             bearer token
//   RAAS_INTERNAL_API_TIMEOUT_MS   per-request timeout, default 30000

const TIMEOUT_MS_DEFAULT = 30_000;

export class RaasInternalApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public hint?: string,
  ) {
    super(`RAAS-internal ${status}: ${message}${hint ? ` (${hint})` : ''}`);
    this.name = 'RaasInternalApiError';
  }
}

export function isRaasInternalApiConfigured(): boolean {
  return (
    !!process.env.RAAS_INTERNAL_API_URL?.trim() &&
    !!process.env.RAAS_AGENT_API_KEY?.trim()
  );
}

// ─── Response shape ────────────────────────────────────────────────

export type RaasRequirement = {
  job_requisition_id: string;
  client_id: string;
  client_job_id: string;
  client_job_title: string;
  client_department_id: string;
  first_level_department: string;
  work_city: string;
  headcount: number;
  status: string;
  priority: string;
  salary_range: string;
  publish_date: string;
  expected_arrival_date: string;

  // ── 简历匹配核心字段 ──
  job_responsibility: string;
  job_requirement: string;
  degree_requirement: string;
  education_requirement: string;
  must_have_skills: string[];
  nice_to_have_skills: string[];
  language_requirements: string;
  negative_requirement: string;
  work_years: number;
  expected_level: string;
  interview_mode: string;
  required_arrival_date: string;
  gender: string | null;
  age_range: string | null;
  recruitment_type: string;

  // ── 进度信息 ──
  our_application_count: number;
  headcount_filled: number;
  hsm_employee_id: string;
  assigned_hsm_name: string;
};

export type ListRequirementsResponse = {
  items: RaasRequirement[];
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
};

export type ListRequirementsParams = {
  /** 必填 — 招聘人员 employee_id */
  claimerEmployeeId: string;
  /** claimed (default) / watched / mine */
  scope?: 'claimed' | 'watched' | 'mine';
  page?: number;
  pageSize?: number;
  /** 需求状态过滤，如 "recruiting" */
  status?: string;
  /** 客户 ID 过滤 */
  clientId?: string;
};

// ─── Public API ────────────────────────────────────────────────────

/** GET /api/v1/internal/requirements — single page */
export async function listRequirements(
  params: ListRequirementsParams,
): Promise<ListRequirementsResponse> {
  const base = process.env.RAAS_INTERNAL_API_URL?.trim() ?? '';
  const key = process.env.RAAS_AGENT_API_KEY?.trim() ?? '';
  if (!base || !key) {
    throw new RaasInternalApiError(
      0,
      'RAAS_INTERNAL_API_URL or RAAS_AGENT_API_KEY not configured',
    );
  }

  const url = new URL('/api/v1/internal/requirements', base);
  url.searchParams.set('claimer_employee_id', params.claimerEmployeeId);
  if (params.scope) url.searchParams.set('scope', params.scope);
  if (params.page) url.searchParams.set('page', String(params.page));
  if (params.pageSize) url.searchParams.set('page_size', String(params.pageSize));
  if (params.status) url.searchParams.set('status', params.status);
  if (params.clientId) url.searchParams.set('client_id', params.clientId);

  const timeoutMs = Number(process.env.RAAS_INTERNAL_API_TIMEOUT_MS ?? TIMEOUT_MS_DEFAULT);

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    let body = res.statusText;
    try {
      body = await res.text();
    } catch {
      /* keep statusText */
    }
    throw new RaasInternalApiError(res.status, body, hintForStatus(res.status));
  }
  return (await res.json()) as ListRequirementsResponse;
}

/** Auto-paginate across all pages for a claimer. */
export async function listAllRequirements(
  params: ListRequirementsParams,
): Promise<RaasRequirement[]> {
  const all: RaasRequirement[] = [];
  let page = params.page ?? 1;
  while (true) {
    const r = await listRequirements({ ...params, page });
    all.push(...r.items);
    if (r.items.length === 0 || page >= r.total_pages) break;
    page += 1;
  }
  return all;
}

/**
 * Flatten a RaasRequirement into plain text suitable for RoboHire
 * `/match-resume`'s `jd` field.
 */
export function flattenRequirementForMatch(r: RaasRequirement): string {
  const lines: string[] = [];
  lines.push(`职位: ${r.client_job_title}`);
  if (r.expected_level) lines.push(`期望级别: ${r.expected_level}`);
  if (r.work_city) lines.push(`工作城市: ${r.work_city}`);
  if (r.salary_range) lines.push(`薪资范围: ${r.salary_range}`);
  if (r.recruitment_type) lines.push(`招聘类型: ${r.recruitment_type}`);
  if (r.interview_mode) lines.push(`面试形式: ${r.interview_mode}`);
  if (r.required_arrival_date) lines.push(`期望到岗: ${r.required_arrival_date}`);

  if (r.work_years != null) lines.push(`\n工作年限: ${r.work_years} 年`);
  if (r.degree_requirement) lines.push(`学历要求: ${r.degree_requirement}`);
  if (r.education_requirement) lines.push(`专业要求: ${r.education_requirement}`);
  if (r.language_requirements) lines.push(`语言要求: ${r.language_requirements}`);

  if (r.must_have_skills?.length) {
    lines.push(`\n必备技能（must-have）:\n  - ${r.must_have_skills.join('\n  - ')}`);
  }
  if (r.nice_to_have_skills?.length) {
    lines.push(`\n加分技能（nice-to-have）:\n  - ${r.nice_to_have_skills.join('\n  - ')}`);
  }
  if (r.negative_requirement && r.negative_requirement !== '无') {
    lines.push(`\n排除条件:\n${r.negative_requirement}`);
  }

  if (r.job_responsibility) lines.push(`\n岗位职责:\n${r.job_responsibility}`);
  if (r.job_requirement) lines.push(`\n任职要求:\n${r.job_requirement}`);

  return lines.join('\n');
}

/** Skeletal entries (no responsibility / requirement / must-have) aren't
 *  worth scoring — RoboHire would just compute against an empty JD. */
export function hasMatchableContent(r: RaasRequirement): boolean {
  const hasResp = !!r.job_responsibility?.trim();
  const hasReq = !!r.job_requirement?.trim();
  const hasMustHave =
    Array.isArray(r.must_have_skills) && r.must_have_skills.length > 0;
  return hasResp || hasReq || hasMustHave;
}

function hintForStatus(s: number): string | undefined {
  if (s === 401) return 'AGENT_API_KEY 不匹配或未带 Authorization header';
  if (s === 400) return 'claimer_employee_id 必填';
  if (s === 503) return 'RAAS 服务未就绪，稍后重试';
  return undefined;
}
