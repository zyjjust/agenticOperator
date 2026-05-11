// Rule check orchestrator — single entry for matchResumeAgent.
//
//   buildRuleCheckInput()    -- 组装 5-block input(从 RaasRequirement +
//                               parsed resume + runtime context)
//   runRuleCheck()           -- 跑完整 pipeline:dims → 过滤规则 → 渲染 prompt
//                               → 调 LLM → 折叠成 binary PASS/FAIL verdict
//
// Binary 折叠规则:
//   LLM overall_decision="KEEP"  → PASS    (推进 matchResume)
//   LLM overall_decision="DROP"  → FAIL    (terminal 规则命中,中止)
//   LLM overall_decision="PAUSE" → FAIL    (需 HSM 复核,暂不推进 matchResume)
//   LLM 解析失败                 → FAIL    (安全侧,加 parse_error 标记)

import { classifyRules, extractDims, filterRules } from './ontology';
import { runLlm } from './llm';
import { RULE_CHECK_SYSTEM_PROMPT, composePrompt } from './prompt';
import type {
  LlmRuleCheckOutput,
  RuleCheckInput,
  RuleCheckRuntimeContext,
  RuleCheckVerdict,
  RuleFlag,
} from './types';

export interface BuildInputArgs {
  runtime_context: RuleCheckRuntimeContext;
  parsed_resume: Record<string, unknown> | null | undefined;
  job_requisition: Record<string, unknown>;
  job_requisition_specification?: Record<string, unknown> | null;
  hsm_feedback?: Record<string, unknown> | null;
}

export function buildRuleCheckInput(args: BuildInputArgs): RuleCheckInput {
  const jr = args.job_requisition;
  const jrid =
    typeof jr.job_requisition_id === 'string' && jr.job_requisition_id.trim()
      ? (jr.job_requisition_id as string)
      : '';
  return {
    runtime_context: args.runtime_context,
    resume: args.parsed_resume ?? {},
    job_requisition: { ...jr, job_requisition_id: jrid },
    job_requisition_specification: args.job_requisition_specification ?? null,
    hsm_feedback: args.hsm_feedback ?? null,
  };
}

function safeIsLlmOutput(x: unknown): x is LlmRuleCheckOutput {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  return r.overall_decision === 'KEEP' || r.overall_decision === 'DROP' || r.overall_decision === 'PAUSE';
}

function collectHitFlags(out: LlmRuleCheckOutput | null): RuleFlag[] {
  if (!out || !Array.isArray(out.rule_flags)) return [];
  return out.rule_flags.filter(
    (f) => f.applicable === true && (f.result === 'FAIL' || f.result === 'REVIEW'),
  );
}

function collectFailureReasons(out: LlmRuleCheckOutput | null): string[] {
  if (!out) return [];
  const reasons: string[] = [];
  if (Array.isArray(out.drop_reasons)) reasons.push(...out.drop_reasons);
  if (Array.isArray(out.pause_reasons)) reasons.push(...out.pause_reasons);
  return reasons;
}

export async function runRuleCheck(input: RuleCheckInput): Promise<RuleCheckVerdict> {
  const dims = extractDims(input.job_requisition);
  const { rules: filtered, total } = filterRules(dims);
  const classified = classifyRules(filtered);

  const userPrompt = composePrompt({ input, classified, dims });

  let llmResult;
  try {
    llmResult = await runLlm({
      system: RULE_CHECK_SYSTEM_PROMPT,
      user: userPrompt,
    });
  } catch (err) {
    // LLM gateway misconfigured / network error → FAIL-safe(不让 candidate
    // 偷溜进 matchResume,但保留诊断信息)
    return {
      decision: 'FAIL',
      llm_decision: 'UNKNOWN',
      failure_reasons: [`llm-call-error:${(err as Error).message.slice(0, 120)}`],
      hit_flags: [],
      llm_output: null,
      audit: {
        rules_evaluated: filtered.length,
        rules_total_in_ontology: total,
        dims,
        llm_model: 'unknown',
        llm_duration_ms: 0,
        raw_text_preview: '',
        parse_error: (err as Error).message,
      },
    };
  }

  const parsed = safeIsLlmOutput(llmResult.parsed_json) ? llmResult.parsed_json : null;
  const llm_decision = parsed?.overall_decision ?? 'UNKNOWN';

  let decision: 'PASS' | 'FAIL';
  if (parsed === null) {
    decision = 'FAIL';
  } else if (llm_decision === 'KEEP') {
    decision = 'PASS';
  } else {
    decision = 'FAIL';
  }

  const failure_reasons =
    decision === 'FAIL' && parsed
      ? collectFailureReasons(parsed)
      : decision === 'FAIL'
        ? [`parse-error:${llmResult.parse_error ?? 'no-parsed-json'}`]
        : [];

  return {
    decision,
    llm_decision,
    failure_reasons,
    hit_flags: collectHitFlags(parsed),
    llm_output: parsed,
    audit: {
      rules_evaluated: filtered.length,
      rules_total_in_ontology: total,
      dims,
      llm_model: llmResult.model_used,
      llm_duration_ms: llmResult.duration_ms,
      llm_prompt_tokens: llmResult.prompt_tokens,
      llm_completion_tokens: llmResult.completion_tokens,
      raw_text_preview: llmResult.raw_text.slice(0, 500),
      parse_error: llmResult.parse_error,
    },
  };
}
