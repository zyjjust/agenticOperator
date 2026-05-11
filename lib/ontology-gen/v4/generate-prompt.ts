/**
 * `generatePrompt` — canonical async entry for v4 prompt generation.
 *
 * Internally uses the v4-4 assembler (`assembleActionObjectV4_4`) but exposes
 * a clean signature with no `strategy` concept and typed runtime input. Three
 * usage modes:
 *
 *   1. Static snapshot import + later fill (recommended):
 *        import obj from "@/generated/v4/match-resume.action-object";
 *        const ready = fillRuntimeInput(obj, { kind: "matchResume", ... });
 *      → no fetch; use the pre-generated snapshot.
 *
 *   2. Runtime resolve with no input → returns prompt with placeholders:
 *        await generatePrompt({ actionRef: "matchResume", domain: "RAAS-v1" });
 *
 *   3. Runtime resolve with typed input → returns substituted prompt:
 *        await generatePrompt({
 *          actionRef: "matchResume",
 *          domain: "RAAS-v1",
 *          runtimeInput: { kind: "matchResume", client, job, resume },
 *        });
 *
 * The existing strategy router (`resolveActionObjectV4`) and assembler stay
 * untouched. This function lives next to them and is the recommended public
 * surface going forward.
 */

import { fetchAction } from "../fetch";

import { RUNTIME_INPUT_PLACEHOLDER } from "./assemble";
import { assembleActionObjectV4_4 } from "./assemble-v4-4";
import { fillRuntimeInput } from "./fill-runtime-input";
import {
  MATCH_RESUME_HIERARCHY_SENTINEL,
  isMatchResumeAction,
} from "./placeholders";
import type { RuntimeInputV4 } from "./runtime-input.types";
import type { ActionObjectV4, EnrichedAction } from "./types";

export interface GeneratePromptOptions {
  /** Action selector — name (e.g. "matchResume") or id (e.g. "10"). */
  actionRef: string;
  /** Default "RAAS-v1". */
  domain?: string;
  /** Optional client name for rule filtering (passes through to assembler). */
  client?: string;
  /** Runtime input. When omitted, the prompt retains placeholders unchanged. */
  runtimeInput?: RuntimeInputV4;
  /** Override env. */
  apiBase?: string;
  apiToken?: string;
  timeoutMs?: number;
}

const DEFAULT_DOMAIN = "RAAS-v1";

export async function generatePrompt(
  opts: GeneratePromptOptions,
): Promise<ActionObjectV4> {
  const domain = opts.domain ?? DEFAULT_DOMAIN;

  const action = await fetchAction({
    actionRef: opts.actionRef,
    domain,
    apiBase: opts.apiBase,
    apiToken: opts.apiToken ?? process.env["ONTOLOGY_API_TOKEN"] ?? "",
    timeoutMs: opts.timeoutMs,
  });

  const enriched: EnrichedAction = {
    action,
    dataObjectSchemas: {},
    eventSchemas: {},
  };

  // For matchResume: hand the assembler a string sentinel containing three
  // nested `### ` sub-headers and three placeholders. The assembler embeds
  // it verbatim under "## 运行时输入". For other actions: single placeholder.
  const sentinel = isMatchResumeAction(action)
    ? MATCH_RESUME_HIERARCHY_SENTINEL
    : RUNTIME_INPUT_PLACEHOLDER;

  const obj = assembleActionObjectV4_4({
    enriched,
    client: opts.client,
    domain,
    runtimeInput: sentinel,
  });

  return opts.runtimeInput === undefined ? obj : fillRuntimeInput(obj, opts.runtimeInput);
}
