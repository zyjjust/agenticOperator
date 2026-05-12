/**
 * v4-4 prompt assembly — Chinese fill-in template with original rule prose.
 *
 * Unlike v4-1/v4-2, this assembler does not consume LLM-generated rule
 * instructions. Rules are rendered as source prose blocks, so the execution
 * agent applies the original policy text directly.
 *
 * Maintenance note: this file was historically treated as immutable. The
 * `## 当前时间` section (rendered with a `{{CURRENT_TIME}}` placeholder, to
 * be substituted at fill time by `fillRuntimeInput`) is the one documented
 * deviation — it's a purely additive section between `## 任务` and `## 运行时
 * 输入` and does not change any pre-existing rendering logic.
 */

import { applyClientFilter } from "../compile/filter";
import type { Action, ActionRule, ActionStep } from "../types.public";

import type {
  ActionObjectMetaV4,
  ActionObjectV4,
  EnrichedAction,
} from "./types";

const RUNTIME_INPUT_PLACEHOLDER = "{{RUNTIME_INPUT}}";
const CURRENT_TIME_PLACEHOLDER = "{{CURRENT_TIME}}";
const STEP_RESULT_STATUS = "not_started|completed|blocked|pending_human";
const MATCH_RESUME_RUNTIME_INPUT_EXAMPLE = `### client

client_name: 腾讯
department: 互动娱乐事业群

### 招聘岗位 (Job_Requisition)

\`\`\`json
{
  "job_requisition_id": "JR-2026-001",
  "title": "高级后端工程师",
  "client": "腾讯",
  "department": "互动娱乐事业群",
  "required_skills": ["Java", "Spring Boot", "MySQL"],
  "preferred_skills": ["Kafka", "Redis"],
  "min_years_experience": 5,
  "education": "本科及以上",
  "age_max": 40,
  "language_requirement": null,
  "gender_requirement": null
}
\`\`\`

### 候选人简历 (Resume)

\`\`\`json
{
  "candidate_id": "C-12345",
  "name": "Alice",
  "date_of_birth": "1990-03-15",
  "gender": "女",
  "highest_education": {
    "school": "复旦大学",
    "degree": "本科",
    "major": "计算机科学与技术",
    "graduation_year": 2012,
    "is_full_time": true
  },
  "work_experience": [
    {
      "company": "字节跳动",
      "title": "后端工程师",
      "start_date": "2022-01",
      "end_date": "2025-12",
      "responsibilities": "负责广告投放系统服务端开发，主导亿级 QPS 接口的性能优化。"
    },
    {
      "company": "华为",
      "title": "软件工程师",
      "start_date": "2014-07",
      "end_date": "2021-12",
      "responsibilities": "终端业务后端开发与维护。"
    }
  ],
  "skill_tags": ["Java", "Spring Boot", "MySQL", "Redis", "Kafka"],
  "language_certifications": [],
  "conflict_of_interest_declaration": "无亲属在腾讯任职。"
}
\`\`\``;

export interface AssembleV4_4Input {
  enriched: EnrichedAction;
  client?: string;
  domain?: string;
  runtimeInput?: string | Record<string, unknown>;
}

export function assembleActionObjectV4_4(input: AssembleV4_4Input): ActionObjectV4 {
  const action = input.client
    ? applyClientFilter(input.enriched.action, { client: input.client })
    : input.enriched.action;

  const sections = [
    renderRole(action),
    renderConstraints(),
    renderTask(action),
    renderCurrentTime(),
    renderRuntimeInput(action, input.runtimeInput),
    renderFinalOutputSchema(action),
    renderProcedureOverview(action),
    ...[...action.actionSteps].sort((a, b) => a.order - b.order).map((step) => renderStep(step)),
    renderFinalConsolidation(action),
    renderBeforeReturn(),
  ];

  const meta: ActionObjectMetaV4 = {
    actionId: action.id,
    actionName: action.name,
    domain: input.domain ?? "RAAS-v1",
    client: input.client,
    compiledAt: new Date().toISOString(),
    templateVersion: "v4",
    promptStrategy: "v4-4",
    validation: {
      driftDetected: false,
      roundTripFailures: [],
      missingInstructions: [],
    },
  };

  return {
    prompt: sections.join("\n\n"),
    meta,
  };
}

function renderRole(action: Action): string {
  return [
    "## 角色",
    "",
    `你是 \`${action.name}\` action 的执行智能体。你会收到运行时输入，并根据本模板中的步骤、输出结构和规则内容，产出一个结构化 JSON 结果。`,
  ].join("\n");
}

function renderConstraints(): string {
  return [
    "## 重要约束",
    "",
    "- 你只能依据本模板中引用的 action、step 和 rule 原文进行判断。",
    "- 规则部分是原文引用，不是改写后的解释；不得补充、扩展或替换规则中的判断条件。",
    "- 判断规则是否命中时，只能使用“适用条件”和“规则”中的内容；不得添加原文以外的判断条件。",
    "- 按每个步骤下方列出的规则出现顺序处理规则。",
    "- 每个步骤都维护对应的 `step_N_result` 作为本步骤中间结果，并维护 `final_output` 作为最终响应对象。",
    "- 如果根据规则内容判定命中，将规则 ID 写入对应 `step_N_result.fired_rule_ids`。",
    "- 如果规则要求终止、不予录用、停止后续流程或等价阻断动作，将规则 ID 写入对应 `step_N_result.blocking_rule_ids`，并设置 `final_output.terminal = true`。",
    "- 如果规则要求通知、待办、提醒或人工处理，将通知对象写入 `final_output.notifications`，并在 `trigger_rule_id` 中记录规则 ID。",
    "- 如果规则要求终止、暂停、挂起、通知、标记或写入，将对应结果填入 `step_results`、`terminal`、`notifications` 和业务输出字段。",
    "- 每个 Step 完成后，将对应 `step_N_result` 写入 `final_output.step_results.step_N`；如果阻断规则命中，立即返回最终 JSON，不继续后续 Step。",
    "- 你不直接读写数据存储；运行时系统会根据你的 JSON 输出执行写入、通知和流程流转。",
  ].join("\n");
}

function renderTask(action: Action): string {
  return [
    "## 任务",
    "",
    `当前需要执行的 action 是 \`${action.name}\`。你需要读取“运行时输入”中的业务对象，结合 Action 描述，严格按照“执行步骤总览”中的 actionSteps 顺序执行；在每个 Step 内，严格按照“本步骤规则”中的 rules 出现顺序逐条判断，并将判断过程与业务结果汇总为最终 JSON。`,
    "",
    "Action 描述：",
    action.description || "(无描述)",
  ].join("\n");
}

function renderCurrentTime(): string {
  return [
    "## 当前时间",
    "",
    CURRENT_TIME_PLACEHOLDER,
  ].join("\n");
}

function renderRuntimeInput(
  action: Action,
  runtimeInput: string | Record<string, unknown> | undefined,
): string {
  let body: string;
  if (runtimeInput === undefined) {
    body = isMatchResumeAction(action) ? MATCH_RESUME_RUNTIME_INPUT_EXAMPLE : RUNTIME_INPUT_PLACEHOLDER;
  } else if (typeof runtimeInput === "string") {
    body = runtimeInput;
  } else {
    body = "```json\n" + JSON.stringify(runtimeInput, null, 2) + "\n```";
  }

  return [
    "## 运行时输入",
    "",
    body,
  ].join("\n");
}

function renderFinalOutputSchema(action: Action): string {
  const lines = [
    "## 最终输出 JSON 结构",
    "",
    "返回一个 JSON object。除业务输出字段外，必须包含 `step_results`、`notifications` 和 `terminal`，用于保留执行轨迹、通知和终止状态。",
    "",
    "业务输出字段：",
  ];

  if (action.outputs.length === 0) {
    lines.push("- (无业务输出字段)");
  } else {
    for (const output of action.outputs) {
      lines.push(`- \`${output.name}\` (${output.type}): ${output.description || "(无描述)"}`);
    }
  }

  lines.push("", "JSON 骨架：", "", "```json", renderFinalOutputSkeleton(action), "```");
  return lines.join("\n");
}

function renderProcedureOverview(action: Action): string {
  const lines = [
    "## 执行步骤总览",
    "",
    `按顺序执行以下 ${action.actionSteps.length} 个步骤。每个步骤都维护自己的中间结果对象，最后汇总到最终 JSON。`,
    "",
  ];

  for (const step of [...action.actionSteps].sort((a, b) => a.order - b.order)) {
    lines.push(`Step ${step.order}: ${step.name} — ${oneLine(step.description)}`);
  }

  return lines.join("\n");
}

function renderStep(step: ActionStep): string {
  return [
    `## Step ${step.order}: ${step.name} [${step.objectType || "logic"}]`,
    "",
    "### 本步骤规则",
    "",
    renderRules(step),
  ].join("\n");
}

function renderRules(step: ActionStep): string {
  if (step.rules.length === 0) {
    return "本步骤没有业务规则，按步骤描述执行。";
  }

  return step.rules.map((rule, index) => renderRule(rule, index + 1)).join("\n\n");
}

function renderRule(rule: ActionRule, ruleOrder: number): string {
  const standardized = getRuleStandardizedText(rule);
  const description = rule.description || "";
  const shouldRenderDescription =
    !isBlank(description) && normalizeForCompare(description) !== normalizeForCompare(standardized);

  const lines = [
    `#### ${ruleOrder}. [规则 ${rule.id}] ${rule.businessLogicRuleName || "(未命名规则)"}`,
    "",
    "适用条件:",
    plainText(rule.submissionCriteria, "(无适用条件)"),
    "",
    "规则:",
    plainText(standardized, "(无规则)"),
  ];

  if (shouldRenderDescription) {
    lines.push("", "补充描述:", plainText(description, "(无补充描述)"));
  }

  return lines.join("\n");
}

function renderFinalConsolidation(action: Action): string {
  const lines = [
    "## 最终输出汇总",
    "",
    "所有步骤完成后，从各步骤中间结果生成 `final_output`：",
  ];

  for (const output of action.outputs) {
    lines.push(`- \`${output.name}\`: 从相关 step_result 和业务执行结果中汇总。`);
  }
  lines.push(
    "- `notifications`: 汇总所有规则要求产生的通知、待办和人工处理提醒。",
    "- `terminal`: 只要任一规则要求终止/阻断，则为 true；否则为 false。",
    "- `step_results`: 包含每个已执行步骤的中间结果；如果提前终止，只包含已执行步骤。",
  );

  return lines.join("\n");
}

function renderBeforeReturn(): string {
  return [
    "## 返回前检查",
    "",
    "返回最终 JSON 前，逐项确认：",
    "1. 输出符合“最终输出 JSON 结构”，字段名不要随意改写。",
    "2. 每个 `blocking_rule_id` 都能追溯到已命中的规则。",
    "3. 每条通知都能追溯到要求通知、待办、提醒或人工处理的规则。",
    "4. `step_results` 包含所有已执行步骤的中间结果。",
    "5. `terminal` 与规则要求的终止/阻断状态一致。",
  ].join("\n");
}

function renderFinalOutputSkeleton(action: Action): string {
  const skeleton: Record<string, unknown> = {};
  for (const output of action.outputs) {
    skeleton[output.name] = placeholderForType(output.type);
  }
  skeleton.notifications = [
    {
      recipient: "<string>",
      channel: "InApp|Email",
      trigger_rule_id: "<string>",
      reason: "<string>",
    },
  ];
  skeleton.terminal = false;
  skeleton.step_results = Object.fromEntries(
    [...action.actionSteps]
      .sort((a, b) => a.order - b.order)
      .map((step) => [`step_${step.order}`, JSON.parse(renderStepResultSkeleton(step)) as unknown]),
  );
  return JSON.stringify(skeleton, null, 2);
}

function renderStepResultSkeleton(step: ActionStep): string {
  const skeleton: Record<string, unknown> = {
    status: STEP_RESULT_STATUS,
    fired_rule_ids: [],
    blocking_rule_ids: [],
    notifications: [],
  };

  if (step.outputs.length === 0) {
    skeleton.findings = [];
  } else {
    for (const output of step.outputs) {
      skeleton[output.name] = placeholderForType(output.type);
    }
  }

  return JSON.stringify(skeleton, null, 2);
}

function placeholderForType(type: string): unknown {
  const normalized = type.trim();
  const listMatch = /^List<(.+)>$/i.exec(normalized);
  if (listMatch) return [`<${listMatch[1]}>`];
  if (/^JSON$/i.test(normalized)) return {};
  if (/^Map<.+>$/i.test(normalized)) return { "<key>": "<value>" };
  if (/^(Number|Integer|Float)$/i.test(normalized)) return `<${normalized}>`;
  if (/^Boolean$/i.test(normalized)) return "<Boolean>";
  return `<${normalized}>`;
}

function getRuleStandardizedText(rule: ActionRule): string {
  return rule.standardizedLogicRule || rule.description || "";
}

function plainText(text: string | undefined, fallback: string): string {
  const normalized = text?.trim();
  return normalized && normalized.length > 0 ? normalized : fallback;
}

function isMatchResumeAction(action: Action): boolean {
  return action.id === "10" || action.name === "matchResume";
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim() || "(无描述)";
}

function isBlank(text: string | undefined): boolean {
  return !text || text.trim().length === 0;
}

function normalizeForCompare(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
