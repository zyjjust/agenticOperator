// Multi-agent rule-check prompt builder POC — shared types。
//
// 这些类型对齐 docs/workflow-agents-inngest-spec.md 中 production agent 看到的真实 schema:
//   - RuntimeContext  ← RESUME_PROCESSED 事件透传的 anchor 字段
//   - ParsedResume    ← RESUME_PROCESSED.parsed.data (RaasParseResumeData,放宽 schema)
//   - JobRequisition  ← RAAS getRequirementDetail.requirement (RaasRequirement)
//   - JobRequisitionSpecification  ← RAAS getRequirementDetail.specification
//
// 所有这些都直接进入 user prompt §2 INPUT 段,跟生产 matchResumeAgent 的入参保持一致。

export type Severity = 'terminal' | 'needs_human' | 'flag_only';

/**
 * Ontology Rule — 字段跟 ontology JSON / Neo4j 节点 1:1 对齐。
 *
 * severity 不是 ontology 的字段(目前 ontology 没有 gating_severity),
 * 而是由 SeverityInferenceAgent 从 standardizedLogicRule 文本里推断出来的。
 */
export interface Rule {
  id: string;
  specificScenarioStage: string;
  businessLogicRuleName: string;
  applicableClient: '通用' | string;
  applicableDepartment: string;
  submissionCriteria: string;
  standardizedLogicRule: string;
  relatedEntities: string[];
  businessBackgroundReason: string;
  ruleSource: string;
  executor: 'Agent' | 'Human';

  // ─── 派生字段(由 SeverityInferenceAgent 注入) ───
  severity: Severity;
}

// ════════════════════════════════════════════════════════════════
//  Runtime context — 从 RESUME_PROCESSED 事件透传给 matchResumeAgent
//  对应 docs/workflow-agents-inngest-spec.md §2.3 ResumeProcessedData
// ════════════════════════════════════════════════════════════════

/**
 * RESUME_PROCESSED 事件中 matchResumeAgent 关心的 anchor / 元数据字段。
 *
 * 这些字段不是简历内容,而是"这次匹配请求的事件上下文"。
 * 在 production 中由 resumeParserAgent 写入 RESUME_PROCESSED.data。
 */
export interface RuntimeContext {
  // ─── 主 anchor (matchResumeAgent 必读) ───
  upload_id: string;
  candidate_id: string;
  resume_id: string;
  employee_id: string;          // claimer_employee_id (招聘专员)

  // ─── transport metadata (RAAS 透传) ───
  bucket?: string;
  object_key?: string;
  filename?: string;
  hr_folder?: string | null;
  etag?: string | null;
  size?: number | null;
  source_event_name?: string | null;
  received_at?: string;

  // ─── parser bookkeeping ───
  parsed_at?: string;
  parser_version?: string;       // 例: "v7-pull-model@2026-05-08"

  // ─── trace (可选,跨服务关联用) ───
  trace_id?: string | null;
  request_id?: string | null;
}

// ════════════════════════════════════════════════════════════════
//  Resume — 对齐 RaasParseResumeData (生产 RoboHire /parse-resume 输出)
//  对应 docs/workflow-agents-inngest-spec.md §5.1
// ════════════════════════════════════════════════════════════════

/**
 * 解析后的简历数据 — 镜像 [resume-parser-agent/lib/raas-api-client.ts:114] 的
 * `RaasParseResumeData` 类型。生产中字段都是 loose typed (Array<Record<string,unknown>>),
 * 这里 POC 用更具体的字段 typing 但保留 [k: string]: unknown 的扩展性。
 *
 * 来源:`RESUME_PROCESSED.parsed.data`
 */
export interface ParsedResume {
  // ─── RaasParseResumeData 已有字段 ───
  name?: string;
  email?: string;
  phone?: string;
  location?: string;
  summary?: string;
  experience?: Array<{
    title?: string;
    company?: string;
    location?: string;
    startDate?: string;
    endDate?: string;
    description?: string;
    highlights?: string[];
    [k: string]: unknown;
  }>;
  education?: Array<{
    degree?: string;
    field?: string;
    institution?: string;
    graduationYear?: string;
    [k: string]: unknown;
  }>;
  skills?: string[];
  certifications?: string[];
  languages?: Array<{ language?: string; proficiency?: string; [k: string]: unknown }>;
  rawText?: string;

  // ─── 扩展字段(POC 自加,反映生产应当扩的简历字段) ───
  birth_date?: string;
  gender?: '男' | '女' | string;
  nationality?: string;
  marital_status?: '未婚' | '已婚未育' | '已婚已育' | string;
  conflict_of_interest?: Array<{
    relation: string;
    person_name?: string;
    person_employer?: string;
    person_role?: string;
  }>;
  expected_salary_range?: string;
  outsourcing_acceptance?: '接受' | '中立' | '明确排斥' | string;
  labor_form_preference?: '正编' | '实习' | '兼职' | string;
  former_csi_employment?: {
    company: '华腾' | '中软国际' | string;
    start_date: string;
    end_date: string;
    leave_code?: string;
    leave_reason?: string;
  } | null;
  gap_periods?: Array<{
    start: string;
    end: string;
    reason?: string;
  }>;
  former_tencent_employment?: {
    company: string;
    business_group?: string;
    studio?: string;
    employment_type: '正式' | '外包' | string;
    start_date: string;
    end_date: string;
    leave_type: '主动离场' | '淘汰退场' | '被动离场' | '合同到期' | string;
  } | null;

  [k: string]: unknown;
}

// ════════════════════════════════════════════════════════════════
//  Job Requisition — 对齐 RaasRequirement
//  对应 docs/workflow-agents-inngest-spec.md §5.3 + raas-api-client.ts:623
// ════════════════════════════════════════════════════════════════

/**
 * 客户原始招聘需求 — 镜像 [resume-parser-agent/lib/raas-api-client.ts:623]
 * 的 `RaasRequirement` 类型。来源:RAAS `getRequirementDetail` 返回的
 * `.requirement` 字段。
 */
export interface JobRequisition {
  // ─── RaasRequirement canonical 字段 ───
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

  // ─── 扩展字段(rule 维度过滤需要的) ───
  // POC: 这些目前不在 RaasRequirement canonical 里,生产中需要 RAAS 端补
  client_business_group?: string | null;     // 例: "IEG" / "PCG" / "CDG" — 用来对照 ontology rule.applicableDepartment
  client_studio?: string | null;              // 例: "天美" / "光子" — 仅腾讯 IEG 类有
  age_range?: { min?: number; max?: number };
  tags?: string[];                            // 例: ["外语", "海外", "轮班"]

  [k: string]: unknown;
}

/**
 * 招聘需求规约 — 镜像 RaasRequirementSpecification。
 * 来源:RAAS `getRequirementDetail` 返回的 `.specification` 字段(可能为 null)。
 *
 * Rule check 用得上:`priority` / `deadline` / `is_exclusive` 影响规则
 * 优先级判断,`hsm_employee_id` / `recruiter_employee_id` 用于通知路由。
 */
export interface JobRequisitionSpecification {
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
}

export interface HsmFeedback {
  kin_relation_result?: '存在利益冲突' | '无利益冲突-同部门' | '无利益冲突-非同部门' | null;
}

// ════════════════════════════════════════════════════════════════
//  RuleCheckPromptInput — 整段注入到 user prompt §2 的完整数据
// ════════════════════════════════════════════════════════════════

export interface RuleCheckPromptInput {
  /** 来自 RESUME_PROCESSED 事件的 anchor / 元数据(非简历内容)。 */
  runtime_context: RuntimeContext;

  /** 来自 RESUME_PROCESSED.parsed.data。 */
  resume: ParsedResume;

  /** 来自 RAAS getRequirementDetail.requirement。 */
  job_requisition: JobRequisition;

  /** 来自 RAAS getRequirementDetail.specification(可能为 null)。 */
  job_requisition_specification?: JobRequisitionSpecification | null;

  /** 单独从 RAAS getHsmFeedback 拿的历史 HSM 反馈。 */
  hsm_feedback?: HsmFeedback | null;
}

export interface OntologyQuery {
  client_id: string;
  business_group: string | null;
  studio: string | null;
}

export interface ClassifiedRules {
  general: Rule[];
  client_level: Rule[];
  department_level: Rule[];
  by_severity: {
    terminal: Rule[];
    needs_human: Rule[];
    flag_only: Rule[];
  };
}

export interface PromptSections {
  header: string;
  role: string;
  inputs: string;
  rules: string;
  decision_logic: string;
  output_schema: string;
  self_check: string;
  full: string;
}

export interface PipelineResult {
  scenario_name: string;
  source: 'neo4j' | 'json-file';
  candidate_label: string;
  jd_label: string;
  dims: OntologyQuery;
  rules_total_in_db: number;
  rules_after_filter: number;
  classified: ClassifiedRules;
  prompt_sections: PromptSections;
  expected_llm_output: string;
  llm_output?: {
    raw_text: string;
    parsed_json: unknown;
    parse_error?: string;
    model_used: string;
    duration_ms: number;
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}
