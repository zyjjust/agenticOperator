// LLM gateway picker + chat completion call for rule-check.
//
// 与 scripts/rule-check-poc/agents/llm-runner-agent.ts 同款逻辑,
// 但去掉 POC 的 console.error 噪声;由调用方(runner.ts)做 logging。

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

function pickGateway(): { baseURL: string; apiKey: string; model: string } {
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
  throw new Error(
    '[rule-check] LLM gateway not configured (set AI_BASE_URL+AI_API_KEY or OPENAI_API_KEY)',
  );
}

export async function runLlm(args: {
  system: string;
  user: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
}): Promise<LlmRunResult> {
  const cfg = pickGateway();
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
