/**
 * Hierarchical placeholders for the canonical v4 entry.
 *
 * The v4-4 assembler (`assemble-v4-4.ts`) treats a `string` runtimeInput as
 * raw markdown to splice verbatim into the `## 运行时输入` section. We exploit
 * that branch: `generatePrompt` passes `MATCH_RESUME_HIERARCHY_SENTINEL` —
 * a string containing three nested `### ` sub-headers and three placeholders
 * — and the assembler embeds it as-is. No assembler changes needed.
 *
 * `fillRuntimeInput` then substitutes each placeholder independently with
 * rendered content from a `MatchResumeRuntimeInput`.
 */

export const PLACEHOLDER_CLIENT = "{{CLIENT}}";
export const PLACEHOLDER_JOB = "{{JOB}}";
export const PLACEHOLDER_RESUME = "{{RESUME}}";

/**
 * Sentinel string handed to `assembleActionObjectV4_4({ runtimeInput })` for
 * matchResume. The assembler wraps it under `## 运行时输入\n\n<this>`, yielding
 * a prompt section with three `### ` sub-headers and three placeholders ready
 * for `fillRuntimeInput` to substitute.
 */
export const MATCH_RESUME_HIERARCHY_SENTINEL = [
  "### client",
  "",
  PLACEHOLDER_CLIENT,
  "",
  "### 招聘岗位 (Job_Requisition)",
  "",
  PLACEHOLDER_JOB,
  "",
  "### 候选人简历 (Resume)",
  "",
  PLACEHOLDER_RESUME,
].join("\n");

/**
 * Mirrors the predicate `assemble-v4-4.ts` uses internally (id === "10" ||
 * name === "matchResume"). Duplicated here intentionally — `assemble-v4-4.ts`
 * is treated as immutable, so we don't pull from it. If the predicate ever
 * needs to evolve, sync both sites.
 */
export function isMatchResumeAction(action: { id?: string; name?: string }): boolean {
  return action.id === "10" || action.name === "matchResume";
}
