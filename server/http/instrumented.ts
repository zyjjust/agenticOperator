// HTTP instrumentation helper.
//
// Mirror of server/llm/instrumented.ts but for plain HTTP calls. Wrap any
// `fetch(...)` site so:
//   - on success → AgentActivity row with kind=tool (status / duration / host+path)
//   - on failure → AgentActivity row with kind=anomaly (error / duration)
//
// Usage:
//   const r = await fetchWithTelemetry(url, init, {
//     logger: log,
//     toolName: "RoboHire.parseResume",
//     meta: { filename },
//   });
//
// The wrapped function returns the original Response; callers retain full
// control over body parsing, error mapping, etc. We don't peek at the body
// (could be bytes/streams/multipart) — only headers + status are visible.

import type { LoggerLike } from "@/server/agent-logger";

export type HttpTelemetryOpts = {
  /** AgentLogger satisfies this. Pass-through if undefined. */
  logger?: LoggerLike;
  /** Label in the auto-log narrative — e.g. "RoboHire.parseResume". */
  toolName: string;
  /** Extra metadata merged into the tool/anomaly row. */
  meta?: Record<string, unknown>;
};

export async function fetchWithTelemetry(
  url: string,
  init: RequestInit | undefined,
  opts: HttpTelemetryOpts,
): Promise<Response> {
  const t0 = Date.now();
  const method = (init?.method ?? "GET").toUpperCase();
  const target = urlSummary(url);
  try {
    const r = await fetch(url, init);
    const durationMs = Date.now() - t0;
    if (opts.logger) {
      const narrative = `${opts.toolName} · ${method} ${target} · ${r.status} · ${durationMs}ms`;
      const meta = {
        ...opts.meta,
        method,
        url: target,
        status: r.status,
        durationMs,
      };
      // 4xx/5xx → anomaly so the UI's "异常" filter group catches them even
      // when the caller swallows the error to do its own fallback.
      if (r.ok) {
        await opts.logger.tool(narrative, meta);
      } else {
        await opts.logger.anomaly(narrative, meta);
      }
    }
    return r;
  } catch (e) {
    const durationMs = Date.now() - t0;
    if (opts.logger) {
      const error = (e as Error).message;
      await opts.logger.anomaly(
        `${opts.toolName} threw · ${method} ${target} · ${durationMs}ms · ${error}`,
        {
          ...opts.meta,
          method,
          url: target,
          durationMs,
          error,
        },
      );
    }
    throw e;
  }
}

function urlSummary(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    // Caller passed a relative URL or something exotic — return as-is.
    return url;
  }
}
