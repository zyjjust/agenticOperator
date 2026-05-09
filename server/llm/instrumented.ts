// LLM instrumentation helper.
//
// Wraps any OpenAI-style chat call with automatic AgentActivity logging.
// Use this when you can't migrate to `chatComplete()` directly because
// you need response_format / tool_calls / streaming / etc. — i.e. exactly
// the pre-existing LLM call sites in jd-generator.ts and robohire-shape.ts.
//
// Caller pattern:
//
//   const result = await withLlmTelemetry(
//     { logger, toolName: "LLM.generateJD", model: gateway.model },
//     async () => {
//       const completion = await client.chat.completions.create({...});
//       return { result: parsed, usage: completion.usage };
//     },
//   );
//
// On success → writes a `tool` AgentActivity with model / duration /
// promptTokens / completionTokens / totalTokens.
// On failure → writes an `anomaly` AgentActivity and rethrows.

import type { LoggerLike } from "@/server/agent-logger";

export type LlmCallUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

export type LlmCallResult<T> = {
  result: T;
  usage?: LlmCallUsage;
};

export type LlmTelemetryOpts = {
  /** Pass an AgentLogger here; falls back to a no-op when undefined. */
  logger?: LoggerLike;
  /** Label used in the auto-log narrative — e.g. "LLM.generateJD". */
  toolName: string;
  /** Model id; surfaces in metadata. */
  model: string;
  /** Optional extra metadata merged into the tool/anomaly row. */
  meta?: Record<string, unknown>;
};

export async function withLlmTelemetry<T>(
  opts: LlmTelemetryOpts,
  fn: () => Promise<LlmCallResult<T>>,
): Promise<T> {
  const t0 = Date.now();
  try {
    const { result, usage } = await fn();
    const durationMs = Date.now() - t0;
    if (opts.logger) {
      await opts.logger.tool(
        `${opts.toolName} · ${usage?.total_tokens ?? "?"} tokens · ${durationMs}ms`,
        {
          ...opts.meta,
          model: opts.model,
          durationMs,
          promptTokens: usage?.prompt_tokens,
          completionTokens: usage?.completion_tokens,
          totalTokens: usage?.total_tokens,
        },
      );
    }
    return result;
  } catch (e) {
    const durationMs = Date.now() - t0;
    if (opts.logger) {
      await opts.logger.anomaly(
        `${opts.toolName} failed: ${(e as Error).message}`,
        {
          ...opts.meta,
          model: opts.model,
          durationMs,
          error: (e as Error).message,
        },
      );
    }
    throw e;
  }
}
