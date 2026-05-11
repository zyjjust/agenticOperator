// RuleCheckPromptPipeline — multi-agent orchestrator (4 agents)。
//
// JobRequisition + Resume
//        │
//        ▼
//   extractDimensions()
//        │
//        ▼
//   ┌────────────────────────────┐
//   │ SeverityInferenceAgent      │  从 standardizedLogicRule 推断 severity
//   └─────────────┬──────────────┘
//                 ▼ (注入到所有 rules)
//   ┌────────────────────────────┐
//   │ OntologyQueryAgent          │  Neo4j (or JSON fallback) → filtered Rule[]
//   └─────────────┬──────────────┘
//                 ▼
//   ┌────────────────────────────┐
//   │ RuleClassifierAgent         │  分组 (通用/客户/部门 + by severity)
//   └─────────────┬──────────────┘
//                 ▼
//   ┌────────────────────────────┐
//   │ PromptComposerAgent         │  渲染成 INPUT + RULES + OUTPUT 三段
//   └─────────────┬──────────────┘
//                 ▼ (可选)
//   ┌────────────────────────────┐
//   │ LLMRunnerAgent              │  实际调 LLM,得到 RuleCheckResult JSON
//   └─────────────┬──────────────┘
//                 ▼
//          PipelineResult { prompt_sections, llm_output, ... }

import type {
  JobRequisition,
  OntologyQuery,
  PipelineResult,
  RuleCheckPromptInput,
} from './types';
import { OntologyQueryAgent } from './agents/ontology-query-agent';
import { RuleClassifierAgent } from './agents/rule-classifier-agent';
import { PromptComposerAgent } from './agents/prompt-composer-agent';
import { SeverityInferenceAgent } from './agents/severity-inference-agent';
import { LLMRunnerAgent } from './agents/llm-runner-agent';

export class RuleCheckPromptPipeline {
  constructor(
    private readonly query: OntologyQueryAgent,
    private readonly classifier: RuleClassifierAgent,
    private readonly composer: PromptComposerAgent,
    private readonly llmRunner: LLMRunnerAgent,
  ) {}

  async run(
    args: {
      scenarioName: string;
      input: RuleCheckPromptInput;
      candidateLabel: string;
      jdLabel: string;
    },
    opts: { runLLM?: boolean } = {},
  ): Promise<PipelineResult> {
    const dims = this.extractDimensions(args.input.job_requisition);
    const queryResult = await this.query.query(dims);
    const classified = this.classifier.classify(queryResult.rules);

    const promptSections = this.composer.composeSections({
      inputs: args.input,
      classified,
      dims,
    });
    const expectedOutput = this.composer.expectedOutputSkeleton({
      inputs: args.input,
      classified,
    });

    let llmOutput: PipelineResult['llm_output'];
    if (opts.runLLM) {
      try {
        const result = await this.llmRunner.run({
          system: LLMRunnerAgent.SYSTEM_PROMPT,
          user: promptSections.full,
        });
        llmOutput = {
          raw_text: result.raw_text,
          parsed_json: result.parsed_json,
          parse_error: result.parse_error,
          model_used: result.model_used,
          duration_ms: result.duration_ms,
          prompt_tokens: result.prompt_tokens,
          completion_tokens: result.completion_tokens,
        };
      } catch (err) {
        llmOutput = {
          raw_text: '',
          parsed_json: null,
          parse_error: `LLM call failed: ${(err as Error).message}`,
          model_used: 'unknown',
          duration_ms: 0,
        };
      }
    }

    return {
      scenario_name: args.scenarioName,
      source: queryResult.source,
      candidate_label: args.candidateLabel,
      jd_label: args.jdLabel,
      dims,
      rules_total_in_db: queryResult.total_in_source,
      rules_after_filter: queryResult.rules.length,
      classified,
      prompt_sections: promptSections,
      expected_llm_output: expectedOutput,
      llm_output: llmOutput,
    };
  }

  /**
   * 从 JobRequisition 提取过滤维度。
   *
   * 维度来源 (按优先级):
   *   client_id      ← jr.client_id (production canonical)
   *   business_group ← jr.client_business_group (POC 扩展字段)
   *                   或回退到从 jr.client_department_id 派生
   *   studio         ← jr.client_studio (POC 扩展字段, 仅腾讯 IEG 类有)
   *
   * 生产中 RAAS 应当在 RaasRequirement 上明确这些扩展字段,这里 POC 兜底处理。
   */
  private extractDimensions(jr: JobRequisition): OntologyQuery {
    return {
      client_id: this.normalizeClientId(jr.client_id ?? ''),
      business_group:
        jr.client_business_group ??
        this.deriveBgFromDepartmentId(jr.client_department_id) ??
        null,
      studio: jr.client_studio ?? null,
    };
  }

  /** "CLI_TENCENT" → "腾讯", "CLI_BYTEDANCE" → "字节" — 把 client_id 归一化成 ontology 用的中文名。 */
  private normalizeClientId(id: string): string {
    if (!id) return '';
    if (id === '腾讯' || id === '字节') return id;
    if (id.toUpperCase().includes('TENCENT')) return '腾讯';
    if (id.toUpperCase().includes('BYTEDANCE') || id.toUpperCase().includes('BYTE')) return '字节';
    return id;
  }

  /** "CLI_TENCENT_PCG" / "CLI_TENCENT_IEG_TIANMEI" → 提取 BG ("PCG" / "IEG")。 */
  private deriveBgFromDepartmentId(deptId?: string | null): string | null {
    if (!deptId) return null;
    const upper = deptId.toUpperCase();
    for (const bg of ['IEG', 'PCG', 'WXG', 'CDG', 'CSIG', 'TEG', 'TIKTOK']) {
      if (upper.includes(`_${bg}_`) || upper.endsWith(`_${bg}`)) {
        return bg === 'TIKTOK' ? 'TikTok' : bg;
      }
    }
    return null;
  }
}

export function buildPipeline(): RuleCheckPromptPipeline {
  const severity = new SeverityInferenceAgent();
  const query = new OntologyQueryAgent(severity);
  const classifier = new RuleClassifierAgent();
  const composer = new PromptComposerAgent();
  const llmRunner = new LLMRunnerAgent();
  return new RuleCheckPromptPipeline(query, classifier, composer, llmRunner);
}
