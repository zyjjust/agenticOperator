// Shared LLM gateway picker. Mirrors the logic that lives inside
// jd-generator.ts / robohire-shape.ts so callers that just need a chat
// completion don't have to copy the env-var dance.
//
// Two modes, in order of preference:
//   1. AI_BASE_URL + AI_API_KEY (+ optional AI_MODEL)  — internal gateway
//   2. OPENAI_API_KEY                                  — direct OpenAI
//
// Throws GatewayUnavailableError when neither is configured. Callers should
// catch that and fall back to a deterministic answer.

import OpenAI from "openai";
import type { LoggerLike } from "@/server/agent-logger";

export class GatewayUnavailableError extends Error {
  constructor() {
    super(
      "LLM gateway not configured (set AI_BASE_URL+AI_API_KEY or OPENAI_API_KEY)",
    );
    this.name = "GatewayUnavailableError";
  }
}

export type GatewayConfig = {
  baseURL: string;
  apiKey: string;
  /** Default model — callers may override per call. */
  model: string;
};

export function pickGateway(): GatewayConfig {
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
  throw new GatewayUnavailableError();
}

export function isGatewayConfigured(): boolean {
  return (
    !!(process.env.AI_BASE_URL && process.env.AI_API_KEY) ||
    !!process.env.OPENAI_API_KEY
  );
}

export type ChatCompleteResult = {
  text: string;
  modelUsed: string;
  durationMs: number;
  /** Token counts when the gateway returns a `usage` block; undefined otherwise. */
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
};

/**
 * One-shot chat completion. Returns the assistant's text content. Throws
 * GatewayUnavailableError if neither env pair is set.
 *
 * When `logger` is supplied, every call automatically writes a `tool`
 * AgentActivity row on success (with model / duration / token counts) and
 * an `anomaly` row on failure. This is how Workflow / Live log streams get
 * fine-grained LLM telemetry "for free" — agents just thread their logger.
 */
export async function chatComplete(opts: {
  system: string;
  user: string;
  /** Override default model from picked gateway. */
  model?: string;
  /** Default 0.2 — keep summaries deterministic. */
  temperature?: number;
  /** Default 800. */
  maxTokens?: number;
  /** Optional instrumentation. Pass an AgentLogger (it satisfies LoggerLike). */
  logger?: LoggerLike;
  /** Label used in the auto-log narrative. Default "LLM.<model>". */
  toolName?: string;
}): Promise<ChatCompleteResult> {
  const cfg = pickGateway();
  const client = new OpenAI({ baseURL: cfg.baseURL, apiKey: cfg.apiKey });
  const modelUsed = opts.model || cfg.model;
  const toolLabel = opts.toolName ?? `LLM.${modelUsed}`;
  const started = Date.now();
  try {
    const completion = await client.chat.completions.create({
      model: modelUsed,
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 800,
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
      ],
    });
    const text = completion.choices[0]?.message?.content?.trim() ?? "";
    const durationMs = Date.now() - started;
    const u = completion.usage as
      | { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
      | undefined;
    const usage = u
      ? {
          promptTokens: u.prompt_tokens,
          completionTokens: u.completion_tokens,
          totalTokens: u.total_tokens,
        }
      : undefined;
    if (opts.logger) {
      await opts.logger.tool(
        `${toolLabel} · ${usage?.totalTokens ?? "?"} tokens · ${durationMs}ms`,
        {
          model: modelUsed,
          durationMs,
          promptTokens: usage?.promptTokens,
          completionTokens: usage?.completionTokens,
          totalTokens: usage?.totalTokens,
          systemSummary: truncate(opts.system, 200),
          userSummary: truncate(opts.user, 400),
        },
      );
    }
    return { text, modelUsed, durationMs, usage };
  } catch (e) {
    const durationMs = Date.now() - started;
    if (opts.logger) {
      await opts.logger.anomaly(`${toolLabel} failed: ${(e as Error).message}`, {
        model: modelUsed,
        durationMs,
        error: (e as Error).message,
      });
    }
    throw e;
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
