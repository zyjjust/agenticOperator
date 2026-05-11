/**
 * Synchronous runtime-input substitution for v4 ActionObjects.
 *
 * Consumers typically use this with a statically-imported snapshot:
 *   const ready = fillRuntimeInput(matchResumeActionObject, {
 *     kind: "matchResume",
 *     client: { name: "腾讯", department: "互动娱乐事业群" },
 *     job:    { job_requisition_id: "JR-...", ... },
 *     resume: { candidate_id: "C-...", ... },
 *   });
 *
 * Pure, no I/O, returns a new object — never mutates the input.
 */

import { RUNTIME_INPUT_PLACEHOLDER } from "./assemble";
import {
  PLACEHOLDER_CLIENT,
  PLACEHOLDER_JOB,
  PLACEHOLDER_RESUME,
} from "./placeholders";
import {
  isMatchResumeRuntimeInput,
  type RuntimeClient,
  type RuntimeInputV4,
} from "./runtime-input.types";
import type { ActionObjectV4 } from "./types";

export function fillRuntimeInput(
  obj: ActionObjectV4,
  input: RuntimeInputV4,
): ActionObjectV4 {
  let p = obj.prompt;

  if (isMatchResumeRuntimeInput(input)) {
    // Reverse order (RESUME → JOB → CLIENT) so that a value containing the
    // literal "{{CLIENT}}" / "{{JOB}}" inside the resume / job JSON cannot
    // get re-substituted on a later pass.
    p = replaceAll(p, PLACEHOLDER_RESUME, renderJsonBlock(input.resume));
    p = replaceAll(p, PLACEHOLDER_JOB, renderJsonBlock(input.job));
    p = replaceAll(p, PLACEHOLDER_CLIENT, renderClient(input.client));
  } else if (typeof input === "string") {
    p = replaceAll(p, RUNTIME_INPUT_PLACEHOLDER, input);
  } else {
    p = replaceAll(p, RUNTIME_INPUT_PLACEHOLDER, renderJsonBlock(input));
  }

  return { ...obj, prompt: p };
}

function renderClient(c: RuntimeClient): string {
  const lines = [`client_name: ${c.name}`];
  if (c.department) lines.push(`department: ${c.department}`);
  return lines.join("\n");
}

function renderJsonBlock(v: unknown): string {
  return "```json\n" + JSON.stringify(v, null, 2) + "\n```";
}

function replaceAll(s: string, needle: string, replacement: string): string {
  return s.split(needle).join(replacement);
}
