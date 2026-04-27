import type { ApiError } from './types';

export class ApiTimeoutError extends Error {
  constructor() {
    super('Request timed out');
    this.name = 'ApiTimeoutError';
  }
}

const DEFAULT_TIMEOUT_MS = 5000;

export async function fetchJson<T>(
  path: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<T> {
  const timeoutMs = init?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sig = AbortSignal.timeout(timeoutMs);
  const headers = {
    Accept: 'application/json',
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers, signal: sig });
  } catch (e: unknown) {
    if ((e as Error)?.name === 'TimeoutError') throw new ApiTimeoutError();
    throw e;
  }
  if (!res.ok) {
    let body: ApiError | null = null;
    try {
      body = (await res.json()) as ApiError;
    } catch {
      // server returned non-JSON; fall back to statusText
    }
    const err: ApiError =
      body ?? { error: 'INTERNAL', message: res.statusText };
    throw err;
  }
  return res.json() as Promise<T>;
}
