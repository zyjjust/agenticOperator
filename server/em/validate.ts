// Pure validation helper — agents can call this in step.run("validate")
// to belt-and-suspenders check incoming events even though em.publish
// already validated on the publish side. Useful for agents that want a
// strongly-typed `data` they can rely on without re-asserting types.

import { tryParse } from "./registry";

export type ValidateResult<T = unknown> =
  | { ok: true; data: T; version: string }
  | { ok: false; errors: { path: string; code: string; message: string }[]; triedVersions: string[] };

export async function validate<T = unknown>(
  name: string,
  data: unknown,
): Promise<ValidateResult<T>> {
  const r = await tryParse<T>(name, data);
  if (r.ok) return { ok: true, data: r.data, version: r.version };
  return {
    ok: false,
    errors: r.issues.map((i) => ({
      path: i.path.join("."),
      code: i.code,
      message: i.message,
    })),
    triedVersions: r.triedVersions,
  };
}
