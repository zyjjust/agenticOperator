import { EventSchemas, Inngest } from 'inngest';

// ─── §3.1 输入事件（来自 RAAS）──────────────────────────────
export type ResumeDownloadedData = {
  bucket: string;
  objectKey: string;
  filename: string;
  hrFolder: string | null;
  employeeId: string | null;
  etag: string | null;
  size: number | null;
  sourceEventName: string | null;
  receivedAt: string;
  /**
   * 上游 RAAS 在 RESUME_DOWNLOADED 上挂的 candidate-resume 上传 ID。
   * matchResume 需要把它原样回写到 MATCH_* 事件里供 RAAS 反查 candidate。
   * 本地测试发布时若缺失，可以用 etag 兜底（见 publish-test-event.ts）。
   */
  upload_id?: string;
};

// ─── §3.2 RAAS 期望的解析结果（4 对象嵌套）────────────────
export type CandidateNested = {
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

export type CandidateExpectationNested = {
  expected_salary_monthly_min: number | null;
  expected_salary_monthly_max: number | null;
  expected_cities: string[];
  expected_industries: string[];
  expected_roles: string[];
  expected_work_mode: string | null;
};

export type ResumeNested = {
  summary: string | null;
  skills_extracted: string[];
  work_history: Array<{
    title?: string;
    company?: string;
    startDate?: string;
    endDate?: string;
    description?: string;
  }> | null;
  education_history: Array<{
    degree?: string;
    field?: string;
    institution?: string;
    graduationYear?: string;
  }> | null;
  project_history: unknown[] | null;
};

export type RuntimeNested = {
  current_title: string | null;
  current_company: string | null;
};

export type ResumeProcessedData = {
  // 透传
  bucket: string;
  objectKey: string;
  filename: string;
  hrFolder: string | null;
  employeeId: string | null;
  etag: string | null;
  size: number | null;
  sourceEventName: string | null;
  receivedAt: string;
  // 解析结果
  candidate: CandidateNested;
  candidate_expectation: CandidateExpectationNested;
  resume: ResumeNested;
  runtime: RuntimeNested;
  // 元数据
  parsedAt: string;
  parserVersion: string;
  // ── matchResume agent 用到的字段 ──
  // upload_id 由上游 RAAS 在 RESUME_PROCESSED payload 里带过来，matchResume
  // 需要把它原样回写到 MATCH_* 事件里供 RAAS 反查 candidate。
  upload_id?: string;
  // employee_id 是 RAAS 招聘人员（claimer）的 ID。matchResume 用它去
  // RAAS Internal API 查这个 recruiter 名下所有在招需求。可能是 snake_case
  // (RAAS canonical) 或 camelCase (本仓库历史)，consumer 两个都要试。
  employee_id?: string;
  // parsed.data 是 RoboHire /parse-resume 的原始结构化结果。matchResume
  // 直接把它拼成 resume text 喂给 /match-resume。当 RESUME_PROCESSED
  // 没带 parsed 时，consumer 会回退到 candidate / resume / runtime 嵌套字段。
  parsed?: { data?: Record<string, unknown> };
};

// ─── §3.3 匹配输出事件 ─────────────────────────────────────
//
// 新 shape — 只放 matcher 需要的两个 anchor + RoboHire /match-resume 的
// 完整响应。RoboHire 响应的全部字段（success / data / requestId / savedAs /
// error）都被原样平铺在 payload 顶层。
//
// 旧的 candidate_ref / jd_text / jd_source / 自己重打分的 outcome 等字段
// 已删除：MATCH_* 的事件名本身就承载 outcome；candidate 信息让消费方按
// upload_id 回查；JD 文本不再写出（消费方按 job_requisition_id 查 RAAS）。
export type MatchPassedNeedInterviewData = {
  /** 来自 RESUME_PROCESSED 的 upload_id —— RAAS 用它反查 candidate_id。 */
  upload_id: string;
  /** 当前轮匹配的需求 ID —— RAAS 用它定位是哪条需求的得分。 */
  job_requisition_id: string;

  // ── 以下字段由 RoboHire /match-resume 响应直接平铺 ──
  success?: boolean;
  data?: Record<string, unknown>;
  requestId?: string;
  savedAs?: string;
  error?: string;
};

// ─── §3.4 JD 生成相关事件 ─────────────────────────────────
//
// REQUIREMENT_LOGGED (RAAS → AO)：raw_input_data 28 字段平铺在 payload 里。
// 这里只声明顶层壳；具体 28 字段类型在 createJdAgent 内部定义。
export type RequirementLoggedData = {
  entity_type?: string;
  entity_id?: string | null;
  event_id?: string;
  payload?: Record<string, unknown>;   // 含 raw_input_data 等
  trace?: {
    trace_id?: string | null;
    request_id?: string | null;
    workflow_id?: string | null;
    parent_trace_id?: string | null;
  };
};

// JD_GENERATED (AO → RAAS)：partner-canonical 15 字段 + AO bookkeeping
export type JdGeneratedPayload = {
  // 15 partner spec fields
  job_requisition_id: string;
  client_id: string | null;
  posting_title: string;
  posting_description: string;
  city: string[];
  salary_range: string;
  interview_mode: string;
  degree_requirement: string;
  education_requirement: string;
  work_years: number;
  recruitment_type: string;
  must_have_skills: string[];
  nice_to_have_skills: string[];
  negative_requirement: string;
  language_requirements: string;
  expected_level: string;

  // 发布渠道用的 2 段独立字段
  responsibility: string;
  requirement: string;

  // bookkeeping
  jd_id: string;
  claimer_employee_id: string | null;
  hsm_employee_id: string | null;
  client_job_id: string | null;

  // 诊断字段（RAAS 可忽略）
  search_keywords: string[];
  quality_score: number;
  quality_suggestions: string[];
  market_competitiveness: '高' | '中' | '低';
  generator_version: string;
  generator_model: string;
  generated_at: string;
};

export type JdGeneratedEnvelope = {
  entity_type: 'JobDescription';
  entity_id: string | null;
  event_id: string;
  payload: JdGeneratedPayload;
  trace?: {
    trace_id?: string | null;
    request_id?: string | null;
    workflow_id?: string | null;
    parent_trace_id?: string | null;
  };
};

// ─── EventSchemas ──────────────────────────────────────────
type Events = {
  RESUME_DOWNLOADED: { data: ResumeDownloadedData };
  RESUME_PROCESSED: { data: ResumeProcessedData };
  MATCH_PASSED_NEED_INTERVIEW: { data: MatchPassedNeedInterviewData };
  MATCH_PASSED_NO_INTERVIEW: { data: MatchPassedNeedInterviewData };
  MATCH_FAILED: { data: MatchPassedNeedInterviewData };
  // ── JD 生成链 ──
  REQUIREMENT_LOGGED: { data: RequirementLoggedData };
  CLARIFICATION_READY: { data: RequirementLoggedData };  // 同 shape，下游也是 createJdAgent
  JD_REJECTED: { data: RequirementLoggedData };          // 同 shape
  JD_GENERATED: { data: JdGeneratedEnvelope };
};

export const inngest = new Inngest({
  id: 'agentic-operator',
  schemas: new EventSchemas().fromRecord<Events>(),
});

// 字段映射版本号 (RoboHire output → RAAS schema)
export const MAPPING_VERSION = '2026-04-28';
export const PARSER_VERSION = `robohire@v1+map@${MAPPING_VERSION}`;
