// LLMRunnerAgent — 把生成好的 user prompt 实际发给 LLM,跑一次预筛。
//
// 逻辑跟 server/llm/gateway.ts 一致(读 AI_BASE_URL+AI_API_KEY 优先,fallback OPENAI_API_KEY),
// 但本 POC 不依赖外部 logger,直接返回 raw + parsed JSON 给 demo 展示。

import OpenAI from 'openai';

export interface LlmRunResult {
  model_used: string;
  duration_ms: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  raw_text: string;
  parsed_json: unknown;
  parse_error?: string;
}

export class LLMRunnerAgent {
  /** 跑一次 LLM 调用,返回原始文本 + 尝试解析的 JSON。 */
  async run(args: {
    system: string;
    user: string;
    model?: string;
    temperature?: number;
    max_tokens?: number;
  }): Promise<LlmRunResult> {
    const cfg = this.pickGateway();
    const client = new OpenAI({ baseURL: cfg.baseURL, apiKey: cfg.apiKey });
    const modelUsed = args.model ?? cfg.model;
    const started = Date.now();

    const completion = await client.chat.completions.create({
      model: modelUsed,
      temperature: args.temperature ?? 0.1,
      max_tokens: args.max_tokens ?? 8000,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: args.system },
        { role: 'user', content: args.user },
      ],
    });

    const duration_ms = Date.now() - started;
    const raw_text = completion.choices[0]?.message?.content?.trim() ?? '';

    let parsed_json: unknown;
    let parse_error: string | undefined;
    try {
      parsed_json = JSON.parse(raw_text);
    } catch (err) {
      parse_error = (err as Error).message;
      parsed_json = null;
    }

    const usage = completion.usage as
      | { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
      | undefined;

    return {
      model_used: modelUsed,
      duration_ms,
      prompt_tokens: usage?.prompt_tokens,
      completion_tokens: usage?.completion_tokens,
      total_tokens: usage?.total_tokens,
      raw_text,
      parsed_json,
      parse_error,
    };
  }

  /** 跟 server/llm/gateway.ts 同款的网关选择逻辑。 */
  private pickGateway(): { baseURL: string; apiKey: string; model: string } {
    if (process.env.AI_BASE_URL && process.env.AI_API_KEY) {
      return {
        baseURL: process.env.AI_BASE_URL,
        apiKey: process.env.AI_API_KEY,
        model: process.env.AI_MODEL || 'google/gemini-3-flash-preview',
      };
    }
    if (process.env.OPENAI_API_KEY) {
      return {
        baseURL: 'https://api.openai.com/v1',
        apiKey: process.env.OPENAI_API_KEY,
        model: 'gpt-4o-mini',
      };
    }
    throw new Error('LLM gateway not configured (set AI_BASE_URL+AI_API_KEY or OPENAI_API_KEY)');
  }

  /** 给 RuleCheckAgent 用的固定 system prompt。 */
  static readonly SYSTEM_PROMPT = `你是一名简历预筛查员。

严格按照 user 消息中的规则评估候选人,输出严格符合 schema 的 JSON。

边界约束:
- 不要给候选人打匹配分数(那是下游 Robohire 的工作)
- 不要超出 user 消息中规定的规则范围进行评估
- 不要在 evidence 里编造简历未提供的信息;缺字段一律标 NOT_APPLICABLE
- 输出必须是合法 JSON,不要在 JSON 外加任何文本`;
}
