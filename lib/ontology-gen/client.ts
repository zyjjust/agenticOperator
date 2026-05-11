/**
 * Thin HTTP client around Node's native `fetch`. Handles bearer auth,
 * timeout via AbortController, and HTTP-status → typed-error mapping per spec §4.2.
 */

import {
  OntologyAuthError,
  OntologyContractError,
  OntologyNotFoundError,
  OntologyRequestError,
  OntologyServerError,
  OntologyTimeoutError,
  OntologyUpstreamError,
} from "./errors";

const DEFAULT_TIMEOUT_MS = 8000;

export interface ClientCallOptions {
  apiBase: string;
  apiToken: string;
  path: string;
  timeoutMs?: number;
}

/**
 * GET `<apiBase><path>` with bearer auth and timeout. Returns the parsed JSON
 * body on 2xx, throws a typed `OntologyGenError` on any failure.
 */
export async function getJson(opts: ClientCallOptions): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${opts.apiBase.replace(/\/+$/, "")}${opts.path}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${opts.apiToken}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      throw new OntologyTimeoutError(timeoutMs, `Request to ${url} timed out after ${timeoutMs}ms`);
    }
    throw new OntologyUpstreamError(
      `Network error fetching ${url}: ${err instanceof Error ? err.message : String(err)}`,
      { url },
    );
  }
  clearTimeout(timer);

  // Try to read the body — even on errors, the API documents an error envelope.
  const rawText = await response.text();
  let parsed: unknown = null;
  if (rawText.length > 0) {
    try {
      parsed = JSON.parse(rawText);
    } catch {
      throw new OntologyContractError(
        `Response from ${url} is not valid JSON (status ${response.status})`,
        { url, status: response.status, bodySnippet: rawText.slice(0, 200) },
      );
    }
  }

  if (response.ok) {
    return parsed;
  }

  // Error envelope per API doc: { error, message, details? }
  const env = isErrorEnvelope(parsed) ? parsed : null;
  const errCode = env?.error ?? "";
  const errMessage = env?.message ?? `HTTP ${response.status} from ${url}`;
  const errDetails: Record<string, unknown> = {
    url,
    status: response.status,
    ...(env?.details && typeof env.details === "object" ? { upstreamDetails: env.details } : {}),
  };

  switch (response.status) {
    case 400:
      throw new OntologyRequestError(errMessage, { ...errDetails, errorCode: errCode });
    case 401:
      throw new OntologyAuthError(errMessage, { ...errDetails, errorCode: errCode });
    case 404: {
      const resource = errCode === "action-not-found" ? "action" : "node";
      throw new OntologyNotFoundError(resource, errMessage, { ...errDetails, errorCode: errCode });
    }
    case 502:
      throw new OntologyUpstreamError(errMessage, { ...errDetails, errorCode: errCode });
    case 500:
      throw new OntologyServerError(errMessage, { ...errDetails, errorCode: errCode });
    default:
      // Anything else in the 4xx/5xx range we don't have a specific class for.
      // Bucket 4xx as request error and 5xx as server error so callers see a
      // typed error rather than a raw `Error`.
      if (response.status >= 400 && response.status < 500) {
        throw new OntologyRequestError(errMessage, { ...errDetails, errorCode: errCode });
      }
      throw new OntologyServerError(errMessage, { ...errDetails, errorCode: errCode });
  }
}

function isErrorEnvelope(v: unknown): v is { error?: string; message?: string; details?: unknown } {
  return typeof v === "object" && v !== null && ("error" in v || "message" in v);
}
