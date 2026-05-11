# V4 `generatePrompt` ↔ AO `matchResumeAgent` 适配规约

> **致叶洋**:这份文档说明你的 `generatePrompt` / `fillRuntimeInput` 要做哪些调整,才能直接被我们 AO 的 `matchResumeAgent` workflow agent 调用。
>
> **现状**:你的 v4 codegen 架构很扎实(snapshot + sync fill + property-bag input),我们(AO/Agentic Operator)这边想直接采用,但有 **3 处必须改的差距** + **2 处建议优化**。改完之后,我们这边可以一天内把 `fillRuntimeInput()` 直接嵌入 `RuleCheckAgent.evaluate()` 内部。
>
> ---
>
> ## ⚠️ 边界澄清(2026-05-11 追加)
>
> 你的产出 = **1 个完整的 user prompt 字符串**(含 INPUT + RULES + OUTPUT 三段),直接喂给 LLM 的 user message。我们 AO 这边拿到后**不解析、不修改、不补充、不拼接**:
>
> ```
> 叶洋(拼 prompt)  →  完整 user prompt (string)  →  AO/雨函  →  llm.complete({ user: <这段> })
>                                                       │
>                                                       ▼
>                                              ruleCheckAgent 判定
>                                              KEEP/DROP/PAUSE
>                                                       │
>                                                       ▼ KEEP
>                                              call RAAS API Server
>                                              (RAAS 内部调 Robohire 深度匹配)
> ```
>
> **关键含义**:
> 1. **OUTPUT 段(JSON schema + 决策逻辑 + 自检)必须在你的 snapshot 里**。我们这边没有兜底机制可以 append。如果 snapshot 缺这段,整条链路废。
> 2. **OUTPUT schema 字段必须能无损映射到下游事件 payload**(`RESUME_RULE_CHECK_REJECTED` / `_NEEDS_REVIEW` / `_RESOLVED`,详见 [docs/rule-check-end-to-end-workflow.md](rule-check-end-to-end-workflow.md))。LLM 输出的 `drop_reasons` / `pause_reasons` / `rule_flags` 字段会直接进事件 payload。
> 3. **任何 prompt bug 都是单点**。我们 AO 这边不能 hotfix,必须由你重新 gen snapshot 或扩展 fill 逻辑修复。
>
> ⟶ 这意味着 §3「OUTPUT 段在 snapshot 里」是**所有 P0 中最阻塞的一项**。开工前请第一时间 grep 验证。
>
> **参考文档**:
> - 你的产物入口:`GENERATE-PROMPT-USER-GUIDE.md`(由你维护)
> - 我们的 workflow 设计:[docs/rule-check-prompt-pipeline.md](rule-check-prompt-pipeline.md)
> - 我们的事件设计:[docs/rule-check-end-to-end-workflow.md](rule-check-end-to-end-workflow.md)
> - 我们的 POC 实现:[scripts/rule-check-poc/](../scripts/rule-check-poc/)

---

## 0. 你的产出在我们工作流里的位置

```
RESUME_PROCESSED 事件
      │
      ▼
matchResumeAgent (Inngest workflow function, AO/我们)
      │
      ├─ Step A: 准备 input
      │     ├─ resume = 从事件 parsed.data 取
      │     ├─ jr = 调 RAAS getRequirementDetail(jr_id)
      │     ├─ spec = getRequirementDetail.specification
      │     └─ hsm_feedback = getHsmFeedback(...)  [可选,PAUSE 回流时非 null]
      │
      ├─ Step B: ★★★ 你的代码在这里 ★★★
      │     ├─ runtimeInput = 把 Step A 数据拼成 MatchResumeRuntimeInput
      │     ├─ ready = fillRuntimeInput(matchResumeActionObject, runtimeInput)  ← 你的
      │     │     ↓
      │     │     ready.prompt = 完整 markdown user prompt
      │     │
      │     ├─ response = llmGateway.complete({ system, user: ready.prompt, ... })
      │     └─ result = JSON.parse(response.text) as RuleCheckResult         ← 输出契约见 §3
      │
      └─ Step C: 按 result.overall_decision 走分支
            ├─ KEEP  → 调 Robohire matchResume(原始 resume + jd) + emit MATCH_PASSED_NEED_INTERVIEW
            ├─ DROP  → 写 blacklist + emit RESUME_RULE_CHECK_REJECTED
            └─ PAUSE → 创建 humanTask × N + emit RESUME_RULE_CHECK_NEEDS_REVIEW
```

**核心契约边界**:
- **你负责**:接收 `MatchResumeRuntimeInput` → 输出能让 LLM 产生合法 `RuleCheckResult` JSON 的 prompt
- **我们 (AO) 负责**:把 RESUME_PROCESSED 数据组装成 `MatchResumeRuntimeInput`、调 LLM、解析 JSON、按 LLM 决策调 RAAS API Server (KEEP) / 写 blacklist (DROP) / 创建 humanTask (PAUSE)、emit 事件
- **完全不交叉**:你不需要碰 LLM 调用 / Inngest / RAAS API;我们不需要碰 ontology / 占位符 / prompt 渲染逻辑

---

## 1. 现状对照表(差距一览)

| 维度 | 你现在有 | 我们需要 | 状态 |
|------|---------|---------|------|
| **input.client** | `{ name, department? }` | + `business_group_code` / `department_display` | ⚠️ 需扩展 |
| **input.job** | property-bag `{ job_requisition_id, ... }` | 同样 property-bag,但建议 snake_case 命名对齐生产 schema | 🟡 兼容,建议优化 |
| **input.resume** | property-bag `{ candidate_id, ... }` | 同上 | 🟡 兼容,建议优化 |
| **input.runtime_context** | ❌ 无 | ✅ **必填**(RESUME_PROCESSED 事件 anchor,trace_id 跨服务追踪用) | 🔴 缺失 |
| **input.job_requisition_specification** | ❌ 无 | ✅ **必填**(priority / deadline / hsm_employee_id,规则路由用) | 🔴 缺失 |
| **input.hsm_feedback** | ❌ 无 | ✅ **必填**(PAUSE 回流场景,规则 10-28/10-39 解析依赖) | 🔴 缺失 |
| **prompt.OUTPUT 段** | ❓ 未在 user guide 中明确 | ✅ **必须包含**(`overall_decision` / `drop_reasons` / `rule_flags` JSON schema 定义) | 🔴 需验证 |
| **prompt.RULES 段是否按维度过滤** | 应该是 snapshot 全量,LLM 自己 filter | 这是个 strategy 选择,先不阻塞 | 🟡 后续讨论 |

---

## 2. 必须改的 3 项 (P0)

### 2.1 扩展 `MatchResumeRuntimeInput` 加 3 个顶层字段

**目标 TS 类型**(请加在 `lib/ontology-gen/v4/runtime-input.types.ts`):

```ts
export interface MatchResumeRuntimeInput {
  kind: "matchResume";

  // ─── 已有字段(保持) ───
  client: ClientSlot;
  job:    Record<string, unknown> & { job_requisition_id: string };
  resume: Record<string, unknown> & { candidate_id: string };

  // ─── ★ 新增字段(按重要性排序) ───

  /**
   * 来自 RESUME_PROCESSED 事件的 anchor / metadata。
   * 不是简历内容,而是"这次匹配请求的上下文"。
   * 在 prompt 里用作 trace_id 透传 + LLM evidence 引用 candidate_id 来源。
   */
  runtime_context: {
    upload_id: string;          // RAAS 反查 candidate 的锚点
    candidate_id: string;        // 与 resume.candidate_id 应一致
    resume_id: string;
    employee_id: string;         // claimer_employee_id(招聘专员)
    parsed_at?: string;
    parser_version?: string;
    trace_id?: string | null;
    request_id?: string | null;
    received_at?: string;
    bucket?: string;
    object_key?: string;
    [k: string]: unknown;
  };

  /**
   * 来自 RAAS `getRequirementDetail.specification`(可能 null)。
   * 规则路由用:priority 影响 notification 紧急度,hsm_employee_id 决定通知发给谁。
   */
  job_requisition_specification?: {
    job_requisition_specification_id: string;
    priority?: string;
    deadline?: string;
    is_exclusive?: boolean;
    hsm_employee_id?: string;
    recruiter_employee_id?: string;
    status?: string;
    [k: string]: unknown;
  } | null;

  /**
   * 来自 RAAS `getHsmFeedback(candidate_id, job_requisition_id)`。
   * 首次匹配为 null;PAUSE 回流重跑时非 null。
   * 规则 10-28 / 10-39 / 10-46 等需要 HSM 二次输入的规则完全依赖这个字段。
   */
  hsm_feedback?: {
    kin_relation_result?: '存在利益冲突' | '无利益冲突-同部门' | '无利益冲突-非同部门' | null;
    tencent_history_leave_result?: '主动离场' | '淘汰退场' | '非淘汰退场' | null;
    reflux_cert_uploaded?: boolean;
    [k: string]: unknown;
  } | null;
}

/** 客户字段 — 同时给代码(rule 维度过滤匹配用) + 中文名(LLM evidence 引用用) */
export interface ClientSlot {
  name: string;                       // 例: "腾讯"
  business_group_code?: string;        // 例: "IEG" / "PCG" / "CDG" — 跟 ontology rule.applicableDepartment 对齐
  department_display?: string;         // 例: "互动娱乐事业群" — 给 LLM evidence 引用
  studio?: string;                     // 例: "天美" — 仅腾讯 IEG 类有
}
```

**为什么必填这 3 个字段**:

| 字段 | 不要会怎样 |
|------|-----------|
| `runtime_context` | LLM 输出的 evidence 写不出 candidate_id 来源,审计追溯失败,跨服务 tracing 断链 |
| `job_requisition_specification` | 触发 PAUSE 时不知道把 humanTask 发给谁(没有 hsm_employee_id) |
| `hsm_feedback` | **PAUSE 回流场景完全跑不通** — HSM 处理完任务后,我们重跑预筛,这时候规则 10-28 等基于 hsm 反馈判定的规则没数据,LLM 只能 NOT_APPLICABLE,候选人卡死 |

### 2.2 对应占位符设计

按你已经规划好的扩展模式(user guide §234-251),建议加这几个占位符:

```ts
// lib/ontology-gen/v4/placeholders.ts
export const PLACEHOLDER_RUNTIME_CONTEXT = "{{RUNTIME_CONTEXT}}";
export const PLACEHOLDER_SPEC            = "{{SPEC}}";
export const PLACEHOLDER_HSM_FEEDBACK    = "{{HSM_FEEDBACK}}";

export const MATCH_RESUME_HIERARCHY_SENTINEL = `
### 1. 运行时上下文 (runtime_context)

${PLACEHOLDER_RUNTIME_CONTEXT}

### 2. 客户 (client)

${PLACEHOLDER_CLIENT}

### 3. 招聘需求 (job_requisition)

${PLACEHOLDER_JOB}

### 4. 招聘需求规约 (job_requisition_specification)

${PLACEHOLDER_SPEC}

### 5. 候选人简历 (resume)

${PLACEHOLDER_RESUME}

### 6. HSM 反馈 (hsm_feedback)

${PLACEHOLDER_HSM_FEEDBACK}
`.trim();
```

**渲染示例**:每段都用 ` ```json ... ``` ` 包裹,LLM 一眼看清属于哪个数据块。`null` 值的字段(如 `hsm_feedback: null`)渲染成 `null` 即可,prompt 里保留段头,告诉 LLM "本次为空"。

### 2.3 `fillRuntimeInput` 扩展处理逻辑

```ts
// lib/ontology-gen/v4/fill-runtime-input.ts
function fillRuntimeInputForMatchResume(
  obj: ActionObjectV4,
  input: MatchResumeRuntimeInput,
): ActionObjectV4 {
  let prompt = obj.prompt;
  // 现有的三段保留
  prompt = prompt.replace(PLACEHOLDER_RESUME, renderJsonBlock(input.resume));
  prompt = prompt.replace(PLACEHOLDER_JOB,    renderJsonBlock(input.job));
  prompt = prompt.replace(PLACEHOLDER_CLIENT, renderClientBlock(input.client));
  // ★ 新增三段
  prompt = prompt.replace(PLACEHOLDER_RUNTIME_CONTEXT, renderJsonBlock(input.runtime_context));
  prompt = prompt.replace(PLACEHOLDER_SPEC,            renderJsonBlock(input.job_requisition_specification ?? null));
  prompt = prompt.replace(PLACEHOLDER_HSM_FEEDBACK,    renderJsonBlock(input.hsm_feedback ?? null));
  return { ...obj, prompt };
}

function renderJsonBlock(data: unknown): string {
  if (data === null) return '`null`(本次为空)';
  return '```json\n' + JSON.stringify(data, null, 2) + '\n```';
}

function renderClientBlock(client: ClientSlot): string {
  const lines = [`client_name: ${client.name}`];
  if (client.business_group_code) lines.push(`business_group_code: ${client.business_group_code}`);
  if (client.department_display)  lines.push(`department_display: ${client.department_display}`);
  if (client.studio)               lines.push(`studio: ${client.studio}`);
  return lines.join('\n');
}
```

注意保留你现有的 reverse-order 替换防 `{{...}}` 字面值冲突的逻辑。

---

## 3. 验证 / 补全 snapshot 里的 OUTPUT 段 (P0)

### 3.1 我们需要 LLM 输出什么

这是必须出现在 prompt 末尾的 OUTPUT 段定义。**如果你的 snapshot 已经包含等价内容,跳过这一节**;**如果没有,需要补上**(要么改 ontology Action 的 `outputs` 字段,要么 `fillRuntimeInput` 后我们追加):

````markdown
## 输出格式

返回严格符合下列结构的 JSON,不允许多余字段,不允许遗漏字段:

```json
{
  "candidate_id": "<from runtime_context.candidate_id>",
  "job_requisition_id": "<from job.job_requisition_id>",
  "client_id": "<from client.name>",
  "overall_decision": "KEEP" | "DROP" | "PAUSE",
  "drop_reasons": ["<rule_id>:<short_code>"],
  "pause_reasons": ["<rule_id>:<short_code>"],
  "rule_flags": [
    {
      "rule_id": "10-25",
      "rule_name": "...",
      "applicable_client": "通用" | "<client>",
      "severity": "terminal" | "needs_human" | "flag_only",
      "applicable": true | false,
      "result": "PASS" | "FAIL" | "REVIEW" | "NOT_APPLICABLE",
      "evidence": "<引用 resume 或 job 原文字段>",
      "next_action": "continue" | "block" | "pause" | "notify_recruiter" | "notify_hsm"
    }
  ],
  "resume_augmentation": "",
  "notifications": [
    {
      "recipient": "招聘专员" | "HSM",
      "channel": "InApp" | "Email",
      "rule_id": "<rule_id>",
      "message": "<给招聘专员/HSM 的具体说明>"
    }
  ]
}
```

## 决策结算逻辑

跑完全部 applicable 规则后:
1. 任一 `rule_flags[i].result == "FAIL"` → `overall_decision = "DROP"`
2. 否则任一 `result == "REVIEW"` → `overall_decision = "PAUSE"`
3. 否则 → `overall_decision = "KEEP"`

无论决策哪个,`rule_flags` 必须覆盖 §RULES 中**每一条**规则(不适用的写 NOT_APPLICABLE)。

## 提交前自检

- [ ] rule_flags 覆盖所有规则(不适用写 NOT_APPLICABLE)
- [ ] overall_decision 跟 drop_reasons / pause_reasons 一致
- [ ] 每条 evidence 引用简历或 JD 原文,简历未提供时写"简历未提供 <字段>,标 NOT_APPLICABLE"
- [ ] 不要给候选人打 matching score(这是下游 Robohire 的工作)
````

### 3.2 你能不能验证一下

执行你 user guide §269-281 里的 quick verification:

```bash
npm run gen:v4-snapshot -- --action matchResume --domain RAAS-v1
grep -E '## 输出格式|## 决策结算逻辑|overall_decision|drop_reasons' generated/v4/match-resume.action-object.ts
```

**如果 grep 有结果**:确认输出 schema 跟我们 §3.1 是否一致;如果有出入,告知我们具体差异,一起对齐
**如果 grep 没结果**:snapshot 缺 OUTPUT 段。两种解法:
- (a) 推 ontology 在 matchResume Action 的 `outputs` 字段加 schema 定义
- (b) 我们 AO 这边在 `fillRuntimeInput` 之后 append 自己的 OUTPUT 段(短期方案,但跟 §0 边界澄清冲突,不建议)

---

## 4. `client.department` 字段命名问题 (P0)

### 4.1 现状

你现在 `client.department` 传中文名(`"互动娱乐事业群"`),但 ontology rule 的 `applicableDepartment` 字段值是代码:

```
ontology rule data 实际取值:
  'N/A', '通用', 'IEG', 'CDG', 'IEG、PCG、WXG、CSIG、TEG、S线', ...
```

LLM 要把"互动娱乐事业群"和"IEG"对应起来,**需要它自己做 mental mapping**,容易错。

### 4.2 修复:`ClientSlot` 拆两个字段

```ts
interface ClientSlot {
  name: string;                  // "腾讯" — 给 LLM 看用的客户名
  business_group_code?: string;  // "IEG" — ★ 跟 ontology rule.applicableDepartment 一字不差
  department_display?: string;   // "互动娱乐事业群" — 可选,给 LLM 引用 evidence
  studio?: string;               // "天美" — 仅腾讯 IEG 类需求会有
}
```

### 4.3 prompt 里渲染的样子

```
### 客户 (client)

client_name: 腾讯
business_group_code: IEG
department_display: 互动娱乐事业群
studio: 天美
```

这样 LLM 一目了然:"哦,本次 business_group_code=IEG,所以 ontology 规则里 applicableDepartment=IEG 的需要检查"。

---

## 5. 集成代码片段(我们 AO 这边怎么用)

我们这边会写这样一段代码消费你的输出。**你不需要写这段,只要给好 prompt 字符串就行**:

```ts
// resume-parser-agent/lib/agents/rule-check-agent.ts (AO/我们维护)
import { matchResumeActionObject } from '@/generated/v4/match-resume.action-object';
import { fillRuntimeInput } from '@/lib/ontology-gen/v4';
import type { MatchResumeRuntimeInput } from '@/generated/v4/action-object-v4.types';

export class RuleCheckAgent {
  async evaluate(input: RuleCheckPromptInput): Promise<RuleCheckResult> {
    // Step 1: 拼装叶洋的 input
    const runtimeInput: MatchResumeRuntimeInput = {
      kind: 'matchResume',
      client: {
        name: normalizeClientId(input.job_requisition.client_id),  // "CLI_TENCENT" → "腾讯"
        business_group_code: input.job_requisition.client_business_group ?? null,
        department_display:  input.job_requisition.client_department_display ?? null,
        studio:              input.job_requisition.client_studio ?? null,
      },
      job:    input.job_requisition,
      resume: input.resume,
      runtime_context:               input.runtime_context,
      job_requisition_specification: input.job_requisition_specification ?? null,
      hsm_feedback:                  input.hsm_feedback ?? null,
    };

    // Step 2: 调用叶洋的 fillRuntimeInput
    const ready = fillRuntimeInput(matchResumeActionObject, runtimeInput);

    // Step 3: 调 LLM
    const response = await this.llmGateway.complete({
      system: RuleCheckAgent.SYSTEM_PROMPT,
      user: ready.prompt,
      response_format: { type: 'json_object' },
      temperature: 0.1,
    });

    // Step 4: 解析 + 校验
    return validateAndParse(response.text);
  }
}
```

---

## 6. 验收 checklist(完成后请发给我们)

### 必须项 (P0)

- [ ] **6.1** `MatchResumeRuntimeInput` 加了 `runtime_context` / `job_requisition_specification` / `hsm_feedback` 三个顶层字段(TS 类型 + 占位符 + render 逻辑)
- [ ] **6.2** `ClientSlot` 加了 `business_group_code` / `department_display` / `studio` 字段
- [ ] **6.3** 验证 snapshot 的 prompt 里有 OUTPUT 段(`## 输出格式` + JSON schema + 决策结算逻辑 + 提交前自检)。如缺失,要么改 ontology,要么提供一个 append 钩子
- [ ] **6.4** 跑 quick verification:把扩展后的 `MatchResumeRuntimeInput` 传进 `fillRuntimeInput()`,`console.log(ready.prompt)` 应当看到 6 个段头(runtime_context / client / job / spec / resume / hsm_feedback) + 输出 schema 段

### 验证用例

请用下面这个 mock 跑一遍,把生成的 prompt 发给我们:

```ts
const TEST_INPUT: MatchResumeRuntimeInput = {
  kind: 'matchResume',
  runtime_context: {
    upload_id: 'upl_test_001',
    candidate_id: 'c01-zhangsan-clean',
    resume_id: 'res_001',
    employee_id: 'EMP_REC_007',
    trace_id: 'trace_001',
    received_at: '2026-05-09T11:23:00Z',
  },
  client: {
    name: '腾讯',
    business_group_code: 'IEG',
    department_display: '互动娱乐事业群',
    studio: '天美',
  },
  job: {
    job_requisition_id: 'jr_z77',
    client_job_title: '游戏服务端开发工程师',
    must_have_skills: ['C++', 'Lua'],
    salary_range: '35k-60k',
    age_range: { min: 22, max: 35 },
    job_responsibility: '...',
    job_requirement: '...',
  },
  job_requisition_specification: {
    job_requisition_specification_id: 'jrs_z77_001',
    priority: 'P0',
    deadline: '2026-06-30',
    is_exclusive: true,
    hsm_employee_id: 'EMP_HSM_002',
    recruiter_employee_id: 'EMP_REC_011',
  },
  resume: {
    candidate_id: 'c01-zhangsan-clean',
    name: '张三',
    skills: ['C++', 'Lua', 'Redis'],
    experience: [/* ... */],
  },
  hsm_feedback: null,
};

const ready = fillRuntimeInput(matchResumeActionObject, TEST_INPUT);
console.log(ready.prompt);
```

预期看到:
1. 完整 6 个 input 段(每段一个 markdown 子标题 + JSON 代码块)
2. 完整 RULES 段(按 ontology matchResume action 的内容)
3. **完整 OUTPUT 段**(`## 输出格式` + JSON schema + `## 决策结算逻辑` + `## 提交前自检`)

### 后续可选项 (P1/P2,不阻塞 P0 上线)

- [ ] **6.5** TS 字段名 snake_case 化(`runtime_context.upload_id` 已经是,但 `client.name` → `client.client_name` 之类),跟生产 `RaasRequirement` schema 对齐
- [ ] **6.6** 提供 strategy flag:`fillRuntimeInput(obj, input, { strategy: 'full' | 'pre-filtered' })`,让我们可以选择"全量 rules 让 LLM filter"还是"传 dimensions 让 fill 时过滤"

---

## 7. 时间预估 + 协作

| 任务 | 预估 | 谁 | 阻塞下游 |
|------|------|----|---------|
| 扩展 input schema(§2)| 0.5 天 | 叶洋 | 🔴 阻塞我们接入 |
| 验证/补全 OUTPUT 段(§3)| 0.5 天 | 叶洋 + (可能需要陈洋配合改 ontology)| 🔴 阻塞 LLM 输出可解析 |
| client.department 拆字段(§4)| 0.2 天 | 叶洋 | 🟡 准确率影响 |
| 我们接入到 RuleCheckAgent + 跑 POC 6 场景验证 | 1 天 | 我们 (AO) | 等叶洋上面完成 |

**总周期**:叶洋 1-1.5 天 + 我们 1 天,合计 ~3 天完成接入 + 验证。

---

## 8. 如果你赶不上的备选方案

~~之前这里说可以"hybrid 用"(叶洋拼 RULES + AO 拼 INPUT/OUTPUT)~~。**已撤销** —— 按 §0 顶上的边界澄清,你的产出是我们发给 LLM 的**唯一** prompt source,**没有 fallback 路径**。

如果 P0 三项今天/明天做不完,选择只能是:

1. **降级测试**:我们 AO 这边用 POC 现有的 `PromptComposerAgent`(它能产生跟我们设计完全一致的 prompt)继续跑 demo,**仅做内部验证**,不上线;
2. **集中冲刺**:你这边 P0 三项一次性 1-2 天搞定;
3. **求助协作**:如果某一项卡住(比如 ontology Action 的 `outputs` 字段需要陈洋配合),我们可以帮你拉群对齐。

任何情况下**不能让 hybrid prompt 进生产** —— 双 source 会导致审计断链 + 版本错配。

---

## 9. 联系

有任何问题,**先看以下文档**再问我们:
- 工作流上下文:[docs/rule-check-end-to-end-workflow.md](rule-check-end-to-end-workflow.md)
- 输入字段语义溯源:[docs/rule-check-prompt-pipeline.md §3.5](rule-check-prompt-pipeline.md)
- POC 实现(可作为我们 AO 这边的对照实现):[scripts/rule-check-poc/agents/prompt-composer-agent.ts](../scripts/rule-check-poc/agents/prompt-composer-agent.ts)

不必要的调整(列表为空时再确认):
- ❌ 你**不需要**改 `assembleActionObjectV4_4`(那是 immutable 的,继续靠 sentinel pattern)
- ❌ 你**不需要**新增 v5(还在 v4 基础上扩字段就行)
- ❌ 你**不需要**改 v3 兼容(我们走 v4 only)

---

*生成时间:基于叶洋 `GENERATE-PROMPT-USER-GUIDE.md` v4 / matchResume 的现状*
*维护:Agentic Operator 团队(matchResumeAgent owner)*
