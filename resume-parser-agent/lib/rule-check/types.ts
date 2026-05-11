// Rule check production module — shared types.
//
// 来源:scripts/rule-check-poc/types.ts(经过 binary PASS/FAIL 简化)
// 边界:这是 matchResumeAgent 在调 RAAS /match-resume 之前的预筛 LLM 评判,
//      不替代 Robohire 的深度打分。

export type Severity = 'terminal' | 'needs_human' | 'flag_only';

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

  /** 由 severity-infer 注入(ontology 暂无显式 gating_severity 字段)。 */
  severity: Severity;
}

export interface OntologyDims {
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

// ─── 5-block input shape (与 docs/yeyang-prompt-adapter-onboarding.md §3.3 对齐) ───

export interface RuleCheckRuntimeContext {
  upload_id: string;
  candidate_id: string;
  resume_id: string;
  employee_id: string;
  filename?: string;
  received_at?: string;
  trace_id?: string | null;
}

export interface RuleCheckInput {
  runtime_context: RuleCheckRuntimeContext;
  resume: Record<string, unknown>;
  job_requisition: Record<string, unknown> & { job_requisition_id: string };
  job_requisition_specification?: Record<string, unknown> | null;
  hsm_feedback?: Record<string, unknown> | null;
}

// ─── LLM output (POC 的 3-state KEEP/DROP/PAUSE,wrapper 层映射为 binary) ───

export interface RuleFlag {
  rule_id: string;
  rule_name: string;
  applicable_client: string;
  severity: Severity;
  applicable: boolean;
  result: 'PASS' | 'FAIL' | 'REVIEW' | 'NOT_APPLICABLE';
  evidence?: string;
  next_action?: string;
}

export interface LlmRuleCheckOutput {
  candidate_id?: string;
  job_requisition_id?: string;
  client_id?: string;
  overall_decision: 'KEEP' | 'DROP' | 'PAUSE';
  drop_reasons?: string[];
  pause_reasons?: string[];
  rule_flags?: RuleFlag[];
  resume_augmentation?: string;
  notifications?: Array<{
    recipient: string;
    channel: string;
    rule_id: string;
    message: string;
  }>;
}

// ─── 给上游 matchResumeAgent 的最终决策(二元化) ───

export interface RuleCheckVerdict {
  /** 二元决策:PASS 推进到 matchResume,FAIL 中止。 */
  decision: 'PASS' | 'FAIL';
  /** LLM 原始 3-state 输出(KEEP/DROP/PAUSE),保留供审计。 */
  llm_decision: 'KEEP' | 'DROP' | 'PAUSE' | 'UNKNOWN';
  /** FAIL 的原因列表(rule_id:short_code 形式)。PASS 时为空。 */
  failure_reasons: string[];
  /** 命中(applicable=true 且 result∈{FAIL,REVIEW})的规则 flag。 */
  hit_flags: RuleFlag[];
  /** 全量 LLM raw output(JSON 解析后)。null = 解析失败。 */
  llm_output: LlmRuleCheckOutput | null;
  /** 观测/审计字段。 */
  audit: {
    rules_evaluated: number;
    rules_total_in_ontology: number;
    dims: OntologyDims;
    llm_model: string;
    llm_duration_ms: number;
    llm_prompt_tokens?: number;
    llm_completion_tokens?: number;
    raw_text_preview: string;
    parse_error?: string;
  };
}
