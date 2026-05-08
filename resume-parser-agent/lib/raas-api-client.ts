// RAAS API client for agentic-operator agents.
//
// Wraps every endpoint defined in agentic-operator-onboarding(3).md.
// All agent-side calls to RoboHire / persistence / requirements lookup
// MUST go through this client (never direct to api.robohire.io).
//
// Endpoint catalog (per doc §1):
//   Capability proxies (sync passthrough to RoboHire):
//     POST /api/v1/parse-resume       (multipart)
//     POST /api/v1/match-resume       (json)
//     POST /api/v1/generate-jd        (json)
//     POST /api/v1/invite-interview   (json) — currently 501
//   Persistence (write to raas DB):
//     POST /api/v1/candidates
//     POST /api/v1/jd/sync-generated
//     POST /api/v1/match-results
//   Read-only:
//     GET  /api/v1/requirements/agent-view
//
// Auth: every request carries Authorization: Bearer ${AGENT_API_KEY}.
// Trace: optional X-Trace-Id request header; raas mints one if absent
// and echoes it on response headers (we capture both directions).
//
// Errors: raas returns a uniform envelope on failure
//   { success: false, error, code, requestId, traceId }
// We translate that into RaasApiError carrying status + code so callers
// can branch by code (AGENT_AUTH_INVALID / RATE_LIMITED / etc).

const TIMEOUT_MS_DEFAULT = 120_000; // RoboHire match-resume can take ~120s

// ─── Errors ─────────────────────────────────────────────────────────

/** Thrown for any non-2xx HTTP response or success:false body. */
export class RaasApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestId?: string,
    public traceId?: string,
  ) {
    super(
      `RAAS API ${status} ${code}: ${message}` +
        (requestId ? ` (req=${requestId})` : '') +
        (traceId ? ` (trace=${traceId})` : ''),
    );
    this.name = 'RaasApiError';
  }

  /**
   * Whether retrying with the same body has any chance of succeeding.
   * Per doc §5/§6: 429 + 502 + 504 are network-shaped and retryable;
   * 4xx (auth / payload / quota) are agent's responsibility to fix.
   */
  get isRetryable(): boolean {
    return this.status === 429 || this.status === 502 || this.status === 504;
  }

  /** Doc §5 'INVALID_*' / 'MISSING_FIELD' / 'PROMPT_LENGTH'. agent payload bug. */
  get isClientError(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 429;
  }
}

// ─── Configuration (read lazily so tests can override env) ──────────

function config() {
  const baseUrl = process.env.RAAS_API_BASE_URL?.trim() ?? '';
  const agentKey = process.env.AGENT_API_KEY?.trim() ?? '';
  if (!baseUrl) {
    throw new RaasApiError(0, 'CONFIG', 'RAAS_API_BASE_URL not set in env');
  }
  if (!agentKey) {
    throw new RaasApiError(0, 'CONFIG', 'AGENT_API_KEY not set in env');
  }
  return { baseUrl, agentKey };
}

export function isRaasApiConfigured(): boolean {
  return (
    !!process.env.RAAS_API_BASE_URL?.trim() &&
    !!process.env.AGENT_API_KEY?.trim()
  );
}

// ─── Common types ───────────────────────────────────────────────────

export type CommonOpts = {
  /**
   * Optional X-Trace-Id to propagate. If absent, raas mints one and
   * returns it in the response header (we surface it via the response
   * object so callers can log it).
   */
  traceId?: string;
  /** Per-request timeout. Default 120000 (RoboHire upper bound). */
  timeoutMs?: number;
};

/** What the response wrapper exposes for every call. */
type RaasResponse = {
  /** raas requestId (= RoboHire's upstream requestId for proxy endpoints). */
  requestId?: string;
  /** trace_id from response header — log this for cross-service joins. */
  traceId?: string;
};

// ─── 4.1 parse-resume ───────────────────────────────────────────────

/**
 * RoboHire's parsed-resume `data` shape, kept opaque to tolerate
 * upstream evolution. Real fields documented in api-external-resume-
 * parsing-and-matching.md §2.
 */
export type RaasParseResumeData = {
  name?: string;
  email?: string;
  phone?: string;
  location?: string;
  summary?: string;
  experience?: Array<Record<string, unknown>>;
  education?: Array<Record<string, unknown>>;
  skills?: string[] | Record<string, unknown>;
  languages?: Array<Record<string, unknown>>;
  certifications?: Array<Record<string, unknown>>;
  rawText?: string;
  [k: string]: unknown;
};

export type ParseResumeResponse = RaasResponse & {
  data: RaasParseResumeData;
  /** RoboHire content-hash cache hit — true means no LLM quota was used. */
  cached: boolean;
  documentId?: string;
  savedAs?: string;
};

export async function parseResume(
  pdfBuffer: Buffer,
  filename: string,
  opts: CommonOpts = {},
): Promise<ParseResumeResponse> {
  const form = new FormData();
  form.append(
    'file',
    new Blob([new Uint8Array(pdfBuffer)], { type: 'application/pdf' }),
    filename || 'resume.pdf',
  );
  const body = await doRequest('POST', '/api/v1/parse-resume', { body: form }, opts);
  return {
    data: body.data ?? {},
    cached: body.cached === true,
    documentId: body.documentId,
    savedAs: body.savedAs,
    requestId: body.requestId,
    traceId: body._traceId,
  };
}

// ─── 4.2 match-resume ───────────────────────────────────────────────

export type RaasMatchResumeData = {
  matchScore: number;
  recommendation: 'STRONG_MATCH' | 'GOOD_MATCH' | 'PARTIAL_MATCH' | 'WEAK_MATCH';
  summary?: string;
  matchAnalysis?: Record<string, unknown>;
  mustHaveAnalysis?: Record<string, unknown>;
  niceToHaveAnalysis?: Record<string, unknown>;
  [k: string]: unknown;
};

export type MatchResumeInput = {
  resume: string;
  jd: string;
  candidatePreferences?: string;
  jobMetadata?: string;
};

export type MatchResumeResponse = RaasResponse & {
  data: RaasMatchResumeData;
  savedAs?: string;
};

export async function matchResume(
  input: MatchResumeInput,
  opts: CommonOpts = {},
): Promise<MatchResumeResponse> {
  const body = await doJsonRequest('POST', '/api/v1/match-resume', input, opts);
  return {
    data: body.data,
    savedAs: body.savedAs,
    requestId: body.requestId,
    traceId: body._traceId,
  };
}

// ─── 4.3 generate-jd ────────────────────────────────────────────────

/**
 * RoboHire-shape generated JD. Numeric-or-string fields (headcount,
 * salaryMin/Max) need defensive parsing on the consumer side per doc.
 */
export type RaasGenerateJdData = {
  title?: string;
  companyName?: string;
  department?: string;
  location?: string;
  workType?: string;
  employmentType?: string;
  experienceLevel?: string;
  education?: string;
  headcount?: number | string;
  salaryMin?: number | string;
  salaryMax?: number | string;
  salaryCurrency?: string;
  salaryPeriod?: string;
  salaryText?: string;
  description?: string;
  qualifications?: string;
  hardRequirements?: string;
  niceToHave?: string;
  benefits?: string;
  interviewRequirements?: string;
  evaluationRules?: string;
  [k: string]: unknown;
};

export type GenerateJdInput = {
  prompt: string;                           // 4-4000 chars
  language?: 'en' | 'zh' | 'zh-TW' | 'ja' | 'es' | 'fr' | 'pt' | 'de';
  companyName?: string;
  department?: string;
};

export type GenerateJdResponse = RaasResponse & {
  data: RaasGenerateJdData;
  meta?: {
    stages?: { parse: 'success' | 'failed'; generate: 'success' | 'failed' };
  };
};

export async function generateJd(
  input: GenerateJdInput,
  opts: CommonOpts = {},
): Promise<GenerateJdResponse> {
  const body = await doJsonRequest('POST', '/api/v1/generate-jd', input, opts);
  return {
    data: body.data,
    meta: body.meta,
    requestId: body.requestId,
    traceId: body._traceId,
  };
}

// ─── 4.4 invite-interview (currently 501) ───────────────────────────

export type InviteInterviewInput = {
  candidate_id: string;
  candidate_name: string;
  candidate_email: string;
  candidate_phone?: string;
  job_requisition_id?: string;
  job_title: string;
  invite_window_days?: number;
};

export async function inviteInterview(
  input: InviteInterviewInput,
  opts: CommonOpts = {},
): Promise<RaasResponse & { data: unknown }> {
  const body = await doJsonRequest('POST', '/api/v1/invite-interview', input, opts);
  return { data: body.data, requestId: body.requestId, traceId: body._traceId };
}

// ─── 4.5 candidates persist ─────────────────────────────────────────

export type SaveCandidateInput = {
  upload_id: string;
  bucket: string;
  object_key: string;
  etag?: string;
  mime_type?: string;
  file_size?: number;
  original_filename?: string;
  operator_employee_id?: string;
  operator_id?: string;
  client_id?: string;
  job_requisition_id?: string;
  /** RoboHire /parse-resume `data` payload, spread directly. */
  parsed: RaasParseResumeData;
  /** Upstream RoboHire requestId for cross-service tracing. */
  robohire_request_id?: string;
};

export type SaveCandidateResult = {
  candidate_id: string;
  candidate_name?: string;
  resume_id?: string;
  resume_file_path?: string;
  application_id?: string;
  is_new_candidate?: boolean;
  is_new_resume?: boolean;
};

export async function saveCandidate(
  input: SaveCandidateInput,
  opts: CommonOpts = {},
): Promise<SaveCandidateResult & RaasResponse> {
  const body = await doJsonRequest('POST', '/api/v1/candidates', input, opts);
  return { ...(body.data as SaveCandidateResult), requestId: body.requestId, traceId: body._traceId };
}

// ─── 4.6 jd/sync-generated persist ──────────────────────────────────

export type SyncJdInput = {
  job_requisition_id: string;
  client_id: string;
  posting_title?: string;
  posting_description?: string;
  must_have_skills?: string[];
  nice_to_have_skills?: string[];
  negative_requirement?: string;
  language_requirements?: string;
  expected_level?: string;
  degree_requirement?: string;
  education_requirement?: string;
  work_years?: number;
  interview_mode?: string;
  recruitment_type?: string;
  city?: string[];
  salary_range?: string;
  search_keywords?: string[];
  /** RoboHire /generate-jd `data` payload as fallback for title / salary. */
  jd_content?: Record<string, unknown>;
};

export type SyncJdResult = {
  synced: boolean;
  job_posting_id: string;
  job_requisition_id: string;
};

export async function syncJdGenerated(
  input: SyncJdInput,
  opts: CommonOpts = {},
): Promise<SyncJdResult & RaasResponse> {
  const body = await doJsonRequest('POST', '/api/v1/jd/sync-generated', input, opts);
  return { ...(body.data as SyncJdResult), requestId: body.requestId, traceId: body._traceId };
}

// ─── 4.7 match-results persist ──────────────────────────────────────

export type MatchResultItem = {
  /** Either candidate_id OR upload_id required. */
  candidate_id?: string;
  upload_id?: string;
  /** Either job_requisition_id or job_id (alias). */
  job_requisition_id?: string;
  job_id?: string;
  client_id?: string;
  job_posting_id?: string;
  matchScore?: number;
  matchAnalysis?: Record<string, unknown>;
  mustHaveAnalysis?: Record<string, unknown>;
  niceToHaveAnalysis?: Record<string, unknown>;
  summary?: string;
  recommendation?: string;
  /** Explicit override, otherwise raas dedups on (candidate_id, job_requisition_id). */
  candidate_match_result_id?: string;
};

export type SaveMatchResultsInput =
  | (MatchResultItem & { source: 'need_interview' })
  | { source: 'no_interview'; match_results: MatchResultItem[] };

export type MatchResultsNeedInterviewResponse = {
  upserted: boolean;
  candidate_match_result_id: string;
  source: 'need_interview';
};

export type MatchResultsNoInterviewItem =
  | { upserted: true; candidate_match_result_id: string; source: 'no_interview' }
  | { skipped: true; reason: string; source: 'no_interview' };

export type MatchResultsNoInterviewResponse = {
  count: number;
  results: MatchResultsNoInterviewItem[];
};

export type SaveMatchResultsResponse =
  | MatchResultsNeedInterviewResponse
  | MatchResultsNoInterviewResponse;

export async function saveMatchResults(
  input: SaveMatchResultsInput,
  opts: CommonOpts = {},
): Promise<SaveMatchResultsResponse & RaasResponse> {
  const body = await doJsonRequest('POST', '/api/v1/match-results', input, opts);
  return { ...(body.data as SaveMatchResultsResponse), requestId: body.requestId, traceId: body._traceId };
}

// ─── Read-only: requirements/:id (单条详情) ─────────────────────────
//
// 跟 agent-view (list) 不同的是这条返回**单条 requisition 的全部字段** +
// specification + siblings + latest_task / analysis 等一坨上下文。agent
// 在 REQUIREMENT_LOGGED 事件里只拿到 entity_id (= job_requisition_id)，
// 后续详情全部走这条 GET 拉取，RAAS 不再 push 到 event payload 里。

/** Job_Requisition 主对象，全字段。RAAS 端字段较多，这里给常用字段 + 兜底 [k:string]. */
export type RaasRequirement = {
  job_requisition_id: string;
  job_requisition_specification_id?: string;
  client_id?: string;
  client_department_id?: string;
  client_job_id?: string;
  client_job_title?: string;
  job_responsibility?: string;
  job_requirement?: string;
  must_have_skills?: string[];
  nice_to_have_skills?: string[];
  negative_requirement?: string;
  language_requirements?: string;
  city?: string;
  salary_range?: string;
  headcount?: number;
  work_years?: number;
  degree_requirement?: string;
  education_requirement?: string;
  interview_mode?: string;
  expected_level?: string;
  recruitment_type?: string;
  [k: string]: unknown;
};

/** Job_Requisition_Specification 全字段 (priority / deadline / hsm_employee_id 等). */
export type RaasRequirementSpecification = {
  job_requisition_specification_id: string;
  hro_service_contract_id?: string;
  client_id?: string;
  start_date?: string;
  deadline?: string;
  priority?: string;
  is_exclusive?: boolean;
  number_of_competitors?: number;
  status?: string;
  hsm_employee_id?: string;
  recruiter_employee_id?: string;
  [k: string]: unknown;
};

export type RaasRequirementSibling = {
  job_requisition_id: string;
  client_job_id?: string;
  client_job_title?: string;
  headcount?: number;
  hc_status?: string;
  competitor_application_count?: number;
  [k: string]: unknown;
};

export type RequirementDetailResponse = RaasResponse & {
  requirement: RaasRequirement;
  specification: RaasRequirementSpecification | null;
  siblings: RaasRequirementSibling[];
  latest_task: Record<string, unknown> | null;
  latest_analysis: Record<string, unknown> | null;
  analysis_history: Array<Record<string, unknown>>;
  clarification_rounds: Array<Record<string, unknown>>;
  manual_override_history: Array<Record<string, unknown>>;
  can_trigger_analysis: boolean;
};

/**
 * GET /api/v1/requirements/:id — 拉单条需求的全字段详情 + spec + siblings.
 *
 * agent 拿到 REQUIREMENT_LOGGED 事件后，从 event.data.entity_id 取出
 * job_requisition_id 直接调这条 endpoint 取完整数据，不再依赖 RAAS 在
 * event payload 里塞 raw_input_data。
 *
 * 注意:
 *  - id 必须 URL-encode（agent 这层用 encodeURIComponent 做，对当前
 *    JR_xxx 形式无影响，但加上更稳）
 *  - 鉴权: Bearer ${AGENT_API_KEY} (与其他 endpoint 一致)
 *  - 返回 200，body 直接是 { requirement, specification, ... } —
 *    不是 { success, data } 包装。我们的 doRequest 对没有 success 字段的
 *    body 不抛错（只在 success:false 时抛），所以这里直接 cast。
 */
export async function getRequirementDetail(
  jobRequisitionId: string,
  opts: CommonOpts = {},
): Promise<RequirementDetailResponse> {
  if (!jobRequisitionId || !jobRequisitionId.trim()) {
    throw new RaasApiError(
      0,
      'CLIENT',
      'getRequirementDetail: jobRequisitionId required',
    );
  }
  const path = `/api/v1/requirements/${encodeURIComponent(jobRequisitionId.trim())}`;
  const body = await doRequest('GET', path, {}, opts);
  return {
    requirement: (body.requirement ?? {}) as RaasRequirement,
    specification:
      (body.specification as RaasRequirementSpecification | null | undefined) ?? null,
    siblings: Array.isArray(body.siblings) ? (body.siblings as RaasRequirementSibling[]) : [],
    latest_task: (body.latest_task as Record<string, unknown> | null | undefined) ?? null,
    latest_analysis:
      (body.latest_analysis as Record<string, unknown> | null | undefined) ?? null,
    analysis_history: Array.isArray(body.analysis_history)
      ? (body.analysis_history as Array<Record<string, unknown>>)
      : [],
    clarification_rounds: Array.isArray(body.clarification_rounds)
      ? (body.clarification_rounds as Array<Record<string, unknown>>)
      : [],
    manual_override_history: Array.isArray(body.manual_override_history)
      ? (body.manual_override_history as Array<Record<string, unknown>>)
      : [],
    can_trigger_analysis: body.can_trigger_analysis === true,
    requestId: body.requestId,
    traceId: body._traceId,
  };
}

// ─── Read-only: requirements/agent-view (list) ──────────────────────

export type RequirementsAgentViewItem = Record<string, unknown>;

export type GetRequirementsQuery = {
  claimer_employee_id?: string;
  scope?: 'claimed' | 'watched' | 'mine';
  status?: string;
  client_id?: string;
  page?: number;
  page_size?: number;
};

export type GetRequirementsResponse = RaasResponse & {
  items: RequirementsAgentViewItem[];
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
};

export async function getRequirementsAgentView(
  query: GetRequirementsQuery,
  opts: CommonOpts = {},
): Promise<GetRequirementsResponse> {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v != null && v !== '') search.set(k, String(v));
  }
  const path = '/api/v1/requirements/agent-view' + (search.toString() ? `?${search.toString()}` : '');
  const body = await doRequest('GET', path, {}, opts);
  // Endpoint shape is { items, page, page_size, total, total_pages } at top level
  // (not wrapped in .data per doc convention).
  return {
    items: (body.items as RequirementsAgentViewItem[]) ?? [],
    page: typeof body.page === 'number' ? body.page : 1,
    page_size: typeof body.page_size === 'number' ? body.page_size : 20,
    total: typeof body.total === 'number' ? body.total : 0,
    total_pages: typeof body.total_pages === 'number' ? body.total_pages : 0,
    requestId: body.requestId,
    traceId: body._traceId,
  };
}

// ─── Internal: HTTP plumbing ────────────────────────────────────────

// `any` value type is intentional: the JSON body shape varies per endpoint
// and the public-API typed wrappers do the picking + casting. RawBody is
// just a transport vehicle out of doRequest into each public function.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RawBody = Record<string, any> & {
  /** trace_id captured from response header (synthetic key, not from body). */
  _traceId?: string;
};

async function doJsonRequest(
  method: string,
  path: string,
  jsonBody: unknown,
  opts: CommonOpts,
): Promise<RawBody> {
  return doRequest(
    method,
    path,
    {
      body: JSON.stringify(jsonBody),
      headers: { 'Content-Type': 'application/json' },
    },
    opts,
  );
}

async function doRequest(
  method: string,
  path: string,
  init: { body?: BodyInit; headers?: Record<string, string> },
  opts: CommonOpts,
): Promise<RawBody> {
  const { baseUrl, agentKey } = config();

  const headers: Record<string, string> = {
    Authorization: `Bearer ${agentKey}`,
    ...(init.headers ?? {}),
  };
  if (opts.traceId) headers['X-Trace-Id'] = opts.traceId;

  const url = path.startsWith('http') ? path : `${baseUrl}${path}`;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS_DEFAULT;

  const res = await fetch(url, {
    method,
    headers,
    body: init.body,
    signal: AbortSignal.timeout(timeoutMs),
  });

  // Capture trace headers regardless of success/failure.
  const responseTraceId =
    res.headers.get('x-trace-id') ?? res.headers.get('X-Trace-Id') ?? undefined;
  const responseRequestId =
    res.headers.get('x-request-id') ?? res.headers.get('X-Request-Id') ?? undefined;

  let body: RawBody | null = null;
  try {
    body = (await res.json()) as RawBody;
    body._traceId = responseTraceId;
  } catch {
    body = { _traceId: responseTraceId };
  }

  // Both transport (non-2xx) and application (success:false) failures
  // become RaasApiError with the same shape.
  if (!res.ok || (body && (body as { success?: boolean }).success === false)) {
    const code = (body?.code as string | undefined) ?? `HTTP_${res.status}`;
    const message =
      (body?.error as string | undefined) ??
      (typeof body === 'object' && body !== null
        ? JSON.stringify(body).slice(0, 200)
        : res.statusText);
    throw new RaasApiError(
      res.status,
      code,
      message,
      (body?.requestId as string | undefined) ?? responseRequestId,
      (body?.traceId as string | undefined) ?? responseTraceId,
    );
  }

  return body ?? {};
}
