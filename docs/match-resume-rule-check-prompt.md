# matchResume Rule-Check Agent — 设计文档与 User Prompt 模板

> **目的**：在 `matchResumeAgent` 调用 Robohire `/match-resume` **之前**插入一道 LLM 规则预筛，把 ontology 里 matchResume action 的 step 1-3 filter rules（含 CSI 通用 + 客户特定）整合进一段 markdown user prompt，由 LLM 评估命中情况，输出 DROP / PAUSE / KEEP 决策与 augmentation flags。
>
> **作用**：
> - 不合格简历不再调 Robohire，节省成本
> - 客户红线 / 黑名单 / 硬性要求由我们自己控制（基于 ontology rules）
> - 通过初筛的简历，附 augmentation flags 一起送 Robohire 做深度匹配评分

---

## 1. 在工作流中的位置

```
RAAS dashboard
    │
    │ 上传 PDF 简历
    ▼
RAAS API Server  ──────────►  RESUME_DOWNLOADED event
                                       │
                                       ▼
                            resumeParserAgent (我方)
                              POST /candidates
                                       │
                                       ▼
                              RESUME_PROCESSED event
                                       │
                                       ▼
              ┌─────────────────────────────────────────────┐
              │   matchResumeAgent (我方, Inngest fn)        │
              │                                              │
              │   ① getRequirementsAgentView → JD list       │
              │                                              │
              │   ② for each JD:                             │
              │       a. ★ NEW: ruleCheck() ★                │
              │          ↓                                   │
              │          decision = DROP / PAUSE / KEEP      │
              │          ↓                                   │
              │       b. if DROP    → emit MATCH_FAILED      │
              │       c. if PAUSE   → emit MATCH_PAUSED      │
              │       d. if KEEP    → 注入 augmentation 后   │
              │                       调 Robohire match-resume│
              │                                              │
              │   ③ saveMatchResults (RAAS DB)              │
              │   ④ emit MATCH_PASSED_NEED_INTERVIEW        │
              └─────────────────────────────────────────────┘
                                       │
                                       ▼
                              下游 interview / 推荐流程
```

★ 标注的步骤就是本文档要落地的内容，对应 [match-resume-agent.ts:147](resume-parser-agent/lib/inngest/agents/match-resume-agent.ts#L147) 的 `step.run('match-${stepKey}', ...)` 内部新增逻辑。

---

## 2. 实际输入 Schema

Rule-check agent 的输入完全可以从现有 `matchResumeAgent` 上下文中拼出来，**不需要新增任何上游事件字段**。

### 2.1 来自 `RESUME_PROCESSED` 事件 ([client.ts:70-98](resume-parser-agent/lib/inngest/client.ts#L70-L98))

```ts
type ResumeProcessedData = {
  upload_id?: string;
  candidate_id?: string;     // ← 用作输出 reference
  resume_id?: string;
  employee_id?: string;
  parsed?: { data?: Record<string, unknown> };  // ★ 简历原始解析数据
  candidate: CandidateNested | {};               // 标准化后的候选人字段
  resume: ResumeNested | {};                     // 标准化后的简历字段
  candidate_expectation: CandidateExpectationNested | {};
  // ... 其他元数据字段
};
```

`parsed.data` 形态（对应 RoboHireParsedData，[robohire.ts:41-52](resume-parser-agent/lib/robohire.ts#L41-L52)）：

```ts
type ParsedResumeData = {
  name?: string;
  email?: string;
  phone?: string;
  location?: string;
  summary?: string;
  experience?: Array<{
    title?: string;
    company?: string;
    location?: string;
    startDate?: string;
    endDate?: string;
    description?: string;
    highlights?: string[];
  }>;
  education?: Array<{
    degree?: string;
    field?: string;
    institution?: string;
    graduationYear?: string;
  }>;
  skills?: string[];
  certifications?: string[];
  languages?: Array<{ language?: string; proficiency?: string }>;
};
```

### 2.2 来自 `getRequirementsAgentView` ([raas-api-client.ts:739](resume-parser-agent/lib/raas-api-client.ts#L739))

```ts
type RequirementsAgentViewItem = Record<string, unknown>;
// 已知字段（从 flattenRequirementForMatch 反推）：
// - job_requisition_id / requisition_id / job_id / id
// - client_id
// - client_job_title / title
// - expected_level
// - work_city / city
// - salary_range
// - recruitment_type
// - interview_mode
// - work_years
// - degree_requirement
// - education_requirement
// - language_requirements
// - must_have_skills: string[]
// - nice_to_have_skills: string[]
// - negative_requirement
// - job_responsibility
// - job_requirement
// - tags?: string[]                      // 岗位标签（外语/海外/国际化/轮班/夜班/倒班/长期出差等）
// - client_business_group?: string       // 仅腾讯需求会有：IEG/PCG/WXG/CDG/CSIG/TEG/S 线
// - client_studio?: string                // 仅 IEG 类岗位会有：天美/光子/魔方/北极光
// - age_range?: { min?: number; max?: number }
```

### 2.3 客户标识

`client_id` 来自 `getRequirementsAgentView` 返回的 `req.client_id`，由 [match-resume-agent.ts:336-342](resume-parser-agent/lib/inngest/agents/match-resume-agent.ts#L336-L342) 的 `pickClientId(req)` 提取。

---

## 3. Rule-Check Agent 的 LLM 调用契约

### 3.1 接口签名

```ts
// resume-parser-agent/lib/rule-check.ts (新文件)

import type { RoboHireParsedData } from './robohire';
import type { RequirementsAgentViewItem } from './raas-api-client';

export interface RuleCheckInput {
  candidate_id: string;
  resume: RoboHireParsedData;          // 来自 RESUME_PROCESSED.parsed.data
  job_requisition: RequirementsAgentViewItem;  // 来自 getRequirementsAgentView
  client_id: string;                    // 来自 req.client_id
  hsm_feedback?: {                       // 可选：用于 10-28 场景
    kin_relation_result?: '存在利益冲突' | '无利益冲突-同部门' | '无利益冲突-非同部门';
  };
}

export interface RuleCheckResult {
  candidate_id: string;
  client_id: string;
  overall_decision: 'KEEP' | 'DROP' | 'PAUSE';
  drop_reasons: string[];
  pause_reasons: string[];
  rule_flags: Array<{
    rule_id: string;
    rule_name: string;
    applicable_client: '通用' | '腾讯' | '字节';
    severity: 'terminal' | 'needs_human' | 'flag_only';
    applicable: boolean;
    result: 'PASS' | 'FAIL' | 'REVIEW' | 'NOT_APPLICABLE';
    evidence: string;
    next_action: 'continue' | 'block' | 'pause' | 'notify_recruiter' | 'notify_hsm';
  }>;
  resume_augmentation: string;     // markdown，注入给 Robohire 的简历后段
  notifications: Array<{
    recipient: '招聘专员' | 'HSM';
    channel: 'InApp' | 'Email';
    rule_id: string;
    message: string;
  }>;
}

export async function runResumeRuleCheck(
  input: RuleCheckInput,
): Promise<RuleCheckResult>;
```

### 3.2 LLM 调用

```ts
// 系统侧用 server/llm/gateway.ts 调 Claude / Kimi / DeepSeek
import { llmGateway } from '@/server/llm/gateway';

async function runResumeRuleCheck(input: RuleCheckInput): Promise<RuleCheckResult> {
  const userPrompt = buildRuleCheckUserPrompt(input);  // 见 §4
  const response = await llmGateway.complete({
    system: '你是一名简历预筛查员。严格按照 user 消息中的规则评估候选人，输出严格符合 schema 的 JSON。',
    user: userPrompt,
    response_format: { type: 'json_object' },  // 或 json_schema with strict shape
    temperature: 0.1,
  });
  return JSON.parse(response.text) as RuleCheckResult;
}
```

`buildRuleCheckUserPrompt(input)` 由叶洋的 `MatchResume` action object 提供：

```ts
const action = await new MatchResume({ clientId: input.client_id }).load();
const userPrompt = action.getRuleCheckPrompt({
  candidate_id: input.candidate_id,
  resume: input.resume,
  job_requisition: input.job_requisition,
  hsm_feedback: input.hsm_feedback,
});
```

---

## 4. User Prompt 完整模板

下方是叶洋 `getRuleCheckPrompt('腾讯')` 应当输出的 markdown user prompt。Runtime 注入数据的占位符用 `{{...}}` 标记。

````markdown
# Resume Pre-Screen Rule Check — 腾讯客户

## 1. 你的角色

你是一名简历预筛查员。系统会给你一份候选人的解析后简历，以及一个具体招聘需求（含客户标识、业务部门、岗位特征等）。你的任务是逐条检查下列所有规则，找出哪些规则在这份简历上命中，并把结果整理成结构化标签输出。

请特别注意：

- **不要给候选人打匹配分数。** 打分是下游 Robohire 的工作。你只做规则命中检查。
- 根据你的输出，候选人会落入三种处理之一：
  - **DROP（直接淘汰）**：候选人不再进入 Robohire，匹配流程终止。
  - **PAUSE（暂停人工复核）**：候选人不进 Robohire，等 HSM 或招聘专员确认后再决定。
  - **KEEP（通过初筛）**：候选人通过预筛，附带你输出的 `resume_augmentation` 文本一起送 Robohire 做深度匹配。

## 2. 输入数据

```json
{
  "candidate_id": "{{candidate_id}}",
  "client_id": "腾讯",
  "resume": {
    "name": "{{resume.name}}",
    "email": "{{resume.email}}",
    "phone": "{{resume.phone}}",
    "summary": "{{resume.summary}}",
    "experience": {{resume.experience | JSON}},
    "education": {{resume.education | JSON}},
    "skills": {{resume.skills | JSON}},
    "certifications": {{resume.certifications | JSON}},
    "languages": {{resume.languages | JSON}}
  },
  "job_requisition": {
    "job_requisition_id": "{{job_requisition_id}}",
    "client_business_group": "{{client_business_group}}",
    "client_studio": "{{client_studio}}",
    "title": "{{title}}",
    "must_have_skills": {{must_have_skills | JSON}},
    "nice_to_have_skills": {{nice_to_have_skills | JSON}},
    "language_requirements": "{{language_requirements}}",
    "degree_requirement": "{{degree_requirement}}",
    "work_years": {{work_years}},
    "salary_range": "{{salary_range}}",
    "negative_requirement": "{{negative_requirement}}",
    "tags": {{tags | JSON}}
  },
  "hsm_feedback": {{hsm_feedback | JSON or "null"}}
}
```

## 3. 检查规则

下面分两部分：第一部分是适用所有客户的通用规则；第二部分仅当 `client_id == "腾讯"` 时激活，本次需要全部检查。

每条规则末尾都会明确告诉你：命中后应该把 `result` 标成什么、应该往 `drop_reasons` 还是 `pause_reasons` 数组里追加什么标识、要不要触发哪一类通知。

### 3.1 通用规则（CSI 级，所有客户都要检查）

#### 规则 10-17：高风险回流人员 [终止级]

如果候选人简历中曾在「华腾」或「中软国际」任职过，请定位那段历史经历，读取离职原因编码。当离职原因属于以下任一高风险类型时，请直接判定不予录用：A15（劳动纠纷及诉讼，YCH）、B8（有犯罪记录，YCH）、B7-1（协商解除劳动合同，YCH，有补偿金）、B3(1)（合同到期终止-技能不达标，YCH，有补偿金）、B3(2)（合同到期终止-劳动态度，YCH，有补偿金）。

命中此规则时，请在 `rule_flags` 数组中加一条 `result="FAIL"` 的记录，`evidence` 字段写明命中的具体编码（例如"曾在华腾任职 2022-08 至 2023-12，离职编码 B8 有犯罪记录"）。同时在 `drop_reasons` 数组里追加 `"10-17:high_risk_reflux"`。一旦此规则命中，候选人直接 DROP。

#### 规则 10-18：EHS 风险回流人员 [需人工复核]

如果候选人曾在华腾或中软国际任职过，且其离职原因编码为 A13(1)（EHS 类），不要直接淘汰，但要暂停流程让 HSM 复核。

请在 `rule_flags` 中标记为 `result="REVIEW"`，`evidence` 写"曾任华腾/中软员工，离职原因 A13(1) EHS 类，需 HSM 判定是否可继续推进"。在 `pause_reasons` 数组里加 `"10-18:ehs_reflux"`。在 `notifications` 数组中追加一条记录：`recipient="HSM"`、`channel="Email"`、`message="EHS 离职人员审核：候选人曾为华腾/中软国际前员工且离职原因编码为 A13(1) EHS 类，请判定是否可继续推进"`。

#### 规则 10-16：被动释放人员 [需人工复核]

如果候选人曾在华腾或中软国际任职，且离职原因编码含 YCH，但**不属于** 10-17 列举的那五种高风险类型，那么不直接淘汰，但需要 HSM 完成特殊备案。

`rule_flags` 标 `result="REVIEW"`，`evidence` 描述具体的离职编码与公司。`pause_reasons` 加 `"10-16:passive_release_review"`。`notifications` 加一条 HSM 的 InApp 通知："黑名单特殊备案：候选人存在 YCH 离职记录但非高风险类型，请完成特殊备案后方可继续推进。"

#### 规则 10-25：华为/荣耀竞对互不挖角红线 [需人工复核]

如果候选人的工作经历中包含华为、荣耀或它们的关联公司的任职记录，请找到最近的那一段华为/荣耀经历，把离职日期与当前日期对比。如果**不满 3 个月**，规则命中；如果已满 3 个月或以上，规则未命中（通过）。

命中时，请在 `rule_flags` 加 `result="REVIEW"`，`evidence` 写明公司名、起止时间、离职至今的月数（如"华为 2025-12 至 2026-04，离职 1 个月"）。在 `pause_reasons` 加 `"10-25:huawei_under_3mo"`。在 `notifications` 加一条发给"招聘专员"的 InApp 通知，message 为："竞对互不挖角待确认：候选人最近 3 个月内从华为/荣耀离职，请确认处理。"

#### 规则 10-26：OPPO/小米竞对互不挖角红线 [需人工复核]

逻辑跟规则 10-25 完全一样，区别只有两点：适用对象是 OPPO、小米及其关联公司，**冷冻期阈值是 6 个月**（不是 3 个月）。命中时使用 `pause_reasons` 标识 `"10-26:oppo_xiaomi_under_6mo"`，通知接收方仍是"招聘专员"。

#### 规则 10-5：硬性要求一票否决 [终止级]

不论候选人背景如何，先把岗位的全部硬性要求拉出来，对每一项跟简历做精确比对：

1. **学历**：候选人的最高学历级别是否达到岗位要求的最低学历？
2. **必备技能**：候选人 `skills` 是否覆盖了岗位 `must_have_skills` 列表中的全部技能？
3. **语言**：如果岗位有语言要求，候选人的语言能力（含证书和分数）是否满足？
4. **性别**：如果岗位有性别要求，候选人性别是否符合？
5. **年龄**：如果岗位有年龄范围，候选人年龄是否在范围内？

只要任一项不符，立即判定该候选人不匹配。`rule_flags` 标 `result="FAIL"`，`evidence` 写出具体不符合的维度（如"必备技能：岗位要求 Python+Spark，候选人简历无 Spark"）。`drop_reasons` 加 `"10-5:hard_requirement_fail:<不符的维度名>"`，例如 `"10-5:hard_requirement_fail:must_have_skills"`。

#### 规则 10-7：候选人期望薪资校验 [条件分支]

这条规则的处理取决于候选人的薪资期望情况：

- 如果候选人 **没填期望薪资**，标 `result="REVIEW"`，`pause_reasons` 加 `"10-7:salary_unknown"`。
- 如果填了期望薪资，并且 **期望薪资 ≤ 岗位上限**，标 `result="PASS"`，无需特殊处理。
- 如果 **期望薪资 > 岗位上限**：
  - 你需要先粗略估算这位候选人的综合匹配度（凭技能、学历、经验等粗判，不用精算）。如果你判断匹配度低于 90 分，标 `result="FAIL"`、`drop_reasons` 加 `"10-7:salary_no_match"`。
  - 如果匹配度看起来在 90 分及以上，标 `result="REVIEW"`、`pause_reasons` 加 `"10-7:salary_negotiable"`，让人工判断成本是否能覆盖。

`evidence` 字段一律写清楚候选人期望薪资和岗位薪资上限的具体数字。

#### 规则 10-8：候选人意愿度校验 [终止级]

如果候选人的求职期望中明确表示"对人力资源外包模式明确排斥"（即 `outsourcing_acceptance_level` 字段值为"明确排斥"或类似表述），由于我司业务以外包为主，请直接淘汰这位候选人。

`rule_flags` 标 `result="FAIL"`，`evidence` 写"候选人在求职期望中明确排斥外包模式"，`drop_reasons` 加 `"10-8:outsourcing_rejected"`。

#### 规则 10-10：履历空窗期与职业稳定性 [条件分支]

请通读候选人的全部工作经历和空窗期记录，分两步判定：

第一步，逐个检查空窗期。如果某段空窗期超过 1 年，并且其原因说明带有消极描述（典型的如"长时间找不到工作"、"不想上班"、"心情低落"等），属于"严重职业风险"。请标 `result="FAIL"`，`evidence` 写出空窗时段和原文的消极描述，`drop_reasons` 加 `"10-10:severe_career_risk"`。

第二步，如果第一步没命中，再看候选人的职业稳定性：把所有工作段的总时长除以段数，如果平均每段不到 1 年，仍然让候选人通过，但要打个标记。这种情况标 `result="PASS"`，但在 `evidence` 里写"平均每段工作时长不足 1 年，存在职业稳定性风险"，并在 `resume_augmentation` 文本里追加一行"职业稳定性风险（命中规则 10-10）"，让 Robohire 知情。

#### 规则 10-12：学历年龄逻辑校验 [需人工复核]

如果简历同时有出生年份和毕业年份，请用「毕业年份 - 出生年份」算出候选人毕业时的实际年龄，再跟下列教育周期基准做对比：专科约 21 岁、本科约 22-23 岁、硕士约 24-26 岁。如果实际毕业年龄与基准的偏差**达到 2 岁或以上**（无论偏高还是偏低），都需要人工核查（可能是跳级、复读、参军、休学、医学长学制等）。

命中时标 `result="REVIEW"`，`evidence` 写出推算的毕业年龄、对应学历、跟基准的偏差。`pause_reasons` 加 `"10-12:age_education_mismatch"`。`notifications` 加一条招聘专员的 InApp 通知："年龄逻辑异常：候选人毕业时年龄与常规教育周期偏差较大，请对教育周期年限偏差执行人工核查。"

#### 规则 10-14：语言能力硬性门槛 [条件分支]

只有当岗位 `tags` 包含"外语"、"海外"或"国际化"，**并且**岗位需求里明确要求语言证书时，这条规则才激活。激活后请按以下逻辑判定：

- 如果候选人简历完全没有任何语言证书或分数信息，直接判语言不匹配。`result="FAIL"`，`drop_reasons` 加 `"10-14:no_language_cert"`。
- 如果岗位设了最低分数线、候选人有同类证书但分数低于该线，仍判不匹配，`drop_reasons` 加 `"10-14:language_score_below"`。
- 如果岗位只要求证书没设最低分数线，候选人有相应证书即视为通过。`result="PASS"`。
- 如果候选人简历只有"英语流利"这种模糊描述，没具体证书或分数，标 `result="REVIEW"`，`pause_reasons` 加 `"10-14:language_ambiguous"`，并通知招聘专员（InApp）去找候选人确认证书与分数。

`evidence` 一律写清楚候选人简历中的语言部分原文和岗位要求。

#### 规则 10-15：特殊工时与出差意愿 [需人工复核]

如果岗位 `tags` 包含"轮班"、"夜班"、"倒班"或"长期出差"任一项，需要确认候选人是否愿意接受这种工作制。由于这是候选人意愿问题，简历无法直接给答案，统一标 `result="REVIEW"`，`evidence` 写出岗位的特殊工作制标签，`pause_reasons` 加 `"10-15:special_schedule_unconfirmed"`，`notifications` 加招聘专员 InApp 通知"特殊工时意愿待确认"。

#### 规则 10-54：负向要求匹配 [条件分支]

如果岗位需求中存在 `negative_requirement` 字段（即不希望出现的背景），请检查候选人最近一段或核心工作经历是否命中。如果你能从需求文本判断该负向要求是"硬性排除项"（用词如"不予录取"、"严禁"、"绝对不接受"），命中即淘汰：`result="FAIL"`，`drop_reasons` 加 `"10-54:negative_match_terminal"`。如果是非硬性的（用词如"不优先"、"建议避免"），仍让候选人通过但打 flag：`result="PASS"`，在 `resume_augmentation` 里追加"负向要求软性命中（10-54）"。

#### 规则 10-9：履历空窗期标记 [仅记录]

请检查候选人的职业时间线连续性，主要关注两类间隔：（a）从最终学历毕业月份到第一份工作开始月份的间隔；（b）任何相邻两段工作经历之间的间隔。

只要发现某段间隔超过 3 个月、并且没有给出原因说明，就需要打 flag。这条规则不阻断流程，标 `result="PASS"`，但在 `evidence` 写出空窗时段，并在 `resume_augmentation` 文本里追加"空窗期未说明：YYYY-MM 到 YYYY-MM（X 个月）"。

#### 规则 10-29：通用二次入职提醒 [仅记录]

如果系统能识别候选人曾在我司任职过（比如 experience 中有"华腾"或"中软国际"且是早期经历），请取最近一次离职日期和今天对比。**如果不满 3 个月**，这是个值得 HSM 知情的二次入职情况，但不阻断流程。

标 `result="PASS"`，`evidence` 写"候选人曾任职我司，距今 X 个月"。在 `resume_augmentation` 里追加"二次入职 - 距上次离职不足 3 个月"。在 `notifications` 加一条 HSM 的 InApp 通知"二次入职提醒：候选人曾在我司任职且最近一次离职不足 3 个月，请知悉"。

---

### 3.2 腾讯客户专属规则（仅当 client_id == "腾讯" 激活）

#### 规则 10-38：腾讯历史从业经历核实触发 [需人工复核]

如果候选人简历的工作履历或职责描述里出现了"腾讯"、"腾讯外包"或腾讯子公司，立即暂停流程让 HSM 跟客户确认离场原因。

标 `result="REVIEW"`，`evidence` 写出腾讯相关的具体经历段落。`pause_reasons` 加 `"10-38:tencent_history_verify"`。`notifications` 加一条 HSM 的 InApp 通知："腾讯历史离场原因核实：候选人简历中包含腾讯相关工作经历，推荐流程已暂停，请与客户确认该候选人的真实离场原因并在系统中反馈核实结果。"

#### 规则 10-35：腾讯外籍候选人通道限制 [仅记录]

如果候选人国籍字段不是"中国"，按腾讯客户的合规要求，可推荐通道范围被锁定为"仅外籍人在国内工作品类通道"。这不淘汰候选人，但要打 flag 让下游知道。

标 `result="PASS"`，`evidence` 写"候选人国籍：<nationality>，可推荐通道锁定为外籍专项"。在 `resume_augmentation` 里追加"腾讯外籍通道锁定（10-35）"。

#### 规则 10-47：腾讯婚育风险审视 [条件分支]

如果候选人**性别为女、年龄超过 26 岁、且婚育情况为「未婚」或「已婚未育」**，按腾讯客户偏好需要走婚育风险审视。

请粗略估算候选人在该岗位下命中加分项的比例（凭技能、经验等粗判，不用精算）：

- 如果你判断命中加分项**达到岗位总加分项的一半或以上**，候选人有机会通过，但要让 HSM 复核：标 `result="REVIEW"`，`pause_reasons` 加 `"10-47:tencent_marital_review"`，`notifications` 加 HSM Email 通知"婚育风险审核提醒：候选人为腾讯婚育风险类，但命中加分项达半数以上，请审核是否解除限制"。
- 如果加分项不到半数，候选人按腾讯偏好被禁止推荐：标 `result="FAIL"`，`drop_reasons` 加 `"10-47:tencent_marital_block"`。

`evidence` 一律写清楚性别/年龄/婚育状态以及你判断的加分项命中情况。

#### 规则 10-3：IEG 活跃流程候选人改推拦截 [终止级]

如果岗位的业务部门是 IEG（即 `client_business_group == "IEG"`），并且候选人当前正处于另一个 IEG 岗位的活跃流程中（已筛选通过但流程未完结，比如面试中、笔试中），按腾讯规则禁止把这位候选人改推到其他岗位。

标 `result="FAIL"`，`evidence` 描述候选人正在进行的活跃流程（如"候选人正在 IEG 天美 P3-game-engineer 岗位面试中，流程未完结"）。`drop_reasons` 加 `"10-3:ieg_active_flow_block"`。

#### 规则 10-27：腾讯亲属关系回避 [需人工复核]

只要是腾讯岗位，无论 IEG 还是其他 BG，都要检查候选人利益冲突声明中是否有以下范围的亲属：配偶、父母、子女、兄弟姐妹及其配偶、配偶的父母及兄弟姐妹。如果上述任一亲属是腾讯正式员工/毕业生/实习生/外包人员，需要让 HSM 确认是否构成利益冲突。

标 `result="REVIEW"`，`evidence` 写出命中的亲属关系类型和对应人员所属的腾讯职位。`pause_reasons` 加 `"10-27:tencent_kin_conflict"`。`notifications` 加一条 HSM 的 Email 通知："腾讯亲属关系待确认：候选人利益冲突声明中存在腾讯在职人员，推荐流程已挂起，请确认是否存在利益冲突。"

#### 规则 10-28：腾讯亲属关系结果处理 [条件分支]

这条规则在 HSM 已经返回亲属关系核实结果的场景下生效（即输入 `hsm_feedback.kin_relation_result` 非空）。

- 如果反馈是"存在利益冲突"，立即终止：`result="FAIL"`，`drop_reasons` 加 `"10-28:kin_conflict_confirmed"`。
- 如果反馈是"无利益冲突-同部门"，本岗位匹配终止（但允许转其他 BG）：`result="FAIL"`，`drop_reasons` 加 `"10-28:same_dept_block"`。
- 如果反馈是"无利益冲突-非同部门"，正常通过：`result="PASS"`。

如果输入数据里没有 HSM 反馈字段，这条规则不适用，标 `result="NOT_APPLICABLE"`。

#### 规则 10-40：主动离职冷冻期紧急回流审核 [条件分支]

如果候选人曾在腾讯任职、离场类型为"主动离场"、并且距今未满 6 个月，**而且**目标岗位的业务部门属于 IEG / PCG / WXG / CSIG / TEG / S 线之一，按规则需要冷冻 6 个月，但加分项突出的可以申请放行。

请粗略判断该候选人在本岗位下的加分项命中比例：达到一半以上 → `result="REVIEW"`、`pause_reasons` 加 `"10-40:active_leave_cooldown_review"`、HSM Email 通知"冷冻期回流待审核：候选人处于腾讯主动离职冷冻期但命中加分项达到半数以上，请审核是否放行推荐"。不到一半 → `result="FAIL"`、`drop_reasons` 加 `"10-40:active_leave_cooldown_block"`。

`evidence` 写出腾讯任职时段、离职日期、距今月数、估算的加分项命中情况。

#### 规则 10-42：CDG 事业群 6 个月回流绝对拦截 [终止级]

如果目标岗位的业务部门**正好是 CDG**（即 `client_business_group == "CDG"`），并且候选人简历中有任何腾讯或腾讯外包的工作经历，请定位最近一次从腾讯离职的具体日期。如果距今**不满 6 个月**（即使候选人在离开腾讯之后又有过其他非腾讯公司的短暂经历），立即拦截。

标 `result="FAIL"`，`evidence` 写出最近一次腾讯离职日期和距今月数。`drop_reasons` 加 `"10-42:cdg_6mo_absolute_block"`。

**重要：这条规则不提供任何人工审核放行通道**，命中即终止，不要发 PAUSE。

#### 规则 10-43：IEG 工作室回流互斥拦截 [终止级]

只在岗位属于 IEG 业务部门、并且 `client_studio` 是天美、光子、魔方、北极光四大工作室之一时激活。请检查候选人历史工作经历里是否有这四大工作室之一的从业记录。如果有，并且**离职不满 6 个月、并且目标岗位所属工作室与候选人历史工作室不同**，立即拦截跨室推荐。

标 `result="FAIL"`，`evidence` 写出候选人原工作室、目标工作室、离职距今月数。`drop_reasons` 加 `"10-43:ieg_cross_studio_block"`。

注意：如果离职已满 6 个月，或目标工作室与候选人原工作室相同，规则不命中，可以正常推进。

#### 规则 10-45：腾讯正编转外包标记 [仅记录]

如果候选人有腾讯**正式岗位**（不是外包）的工作经历，按合规要求要标记为"正编转外包受控"状态。这不立即阻断，但跟规则 10-46 联动。

标 `result="PASS"`，`evidence` 写出腾讯正式岗位的具体经历段落。在 `resume_augmentation` 里追加"正编转外包受控状态（10-45）"。

#### 规则 10-46：正编转外包凭证校验 [需人工复核]

如果候选人已经被规则 10-45 标记为"正编转外包受控"，请检查输入数据里是否已经上传"腾讯采购部门同意回流书面凭证"（这是个具体的合规材料）。如果没上传，需要先锁定流程让 HSM 去拿到凭证。

标 `result="REVIEW"`，`evidence` 写"候选人具备腾讯正编经历，需上传采购部门同意回流凭证后方可推进"。`pause_reasons` 加 `"10-46:reflux_cert_required"`。`notifications` 加 HSM Email："正编转外包凭证待上传：候选人具备腾讯正式员工记录，推荐流程已锁定，请获取腾讯采购部门出具的同意回流书面凭证并上传至系统。"

注意：如果候选人完全没有腾讯正编经历（即 10-45 没被触发），那 10-46 也不适用，标 `result="NOT_APPLICABLE"`。

#### 规则 10-56：腾娱互动子公司回流冷冻期 [终止级]

如果候选人历史工作经历中出现了"深圳市腾娱互动科技有限公司"（这是腾讯系的特定子公司），请定位从该公司离职的具体日期，跟今天对比。**如果不满 6 个月**，立即拦截推荐。

标 `result="FAIL"`，`evidence` 写出从腾娱互动离职的日期和距今月数。`drop_reasons` 加 `"10-56:tengyu_6mo_block"`。如果距今已满 6 个月，规则不命中，正常推进。

---

## 4. 决策结算逻辑

把全部 applicable 的规则跑完后，按以下顺序得出 `overall_decision`：

1. 如果 `rule_flags` 中至少有一条 `result == "FAIL"`，那么 `overall_decision` 就是 `"DROP"`，候选人不再送 Robohire。
2. 否则，如果至少有一条 `result == "REVIEW"`，那么 `overall_decision` 是 `"PAUSE"`，候选人暂停等人工反馈。
3. 否则（所有 applicable 规则都是 PASS 或 NOT_APPLICABLE），`overall_decision` 是 `"KEEP"`，候选人通过初筛，附带 `resume_augmentation` 文本送 Robohire。

**重要约束**：无论 `overall_decision` 是哪个，都必须在 `rule_flags` 数组里给出**每一条**规则的结果（命中的写 PASS/FAIL/REVIEW，不适用的写 NOT_APPLICABLE）。不要漏报。

## 5. 输出格式

返回严格符合下列结构的 JSON，不允许多余字段，不允许遗漏字段：

```json
{
  "candidate_id": "{{candidate_id}}",
  "client_id": "腾讯",
  "overall_decision": "KEEP" | "DROP" | "PAUSE",
  "drop_reasons": ["<rule_id>:<short_code>"],
  "pause_reasons": ["<rule_id>:<short_code>"],
  "rule_flags": [
    {
      "rule_id": "10-25",
      "rule_name": "华为/荣耀竞对互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS" | "FAIL" | "REVIEW" | "NOT_APPLICABLE",
      "evidence": "...",
      "next_action": "continue" | "block" | "pause" | "notify_recruiter" | "notify_hsm"
    }
  ],
  "resume_augmentation": "## 预筛 flags\n- 通用红线: ...\n- 腾讯特定: ...\n- 标记: ...\n- 待人工: ...\n",
  "notifications": [
    {
      "recipient": "招聘专员" | "HSM",
      "channel": "InApp" | "Email",
      "rule_id": "10-25",
      "message": "..."
    }
  ]
}
```

## 6. 提交前自检

在返回 JSON 之前，请逐项确认：

- `rule_flags` 中包含了 §3 列出的**所有规则**（不适用的也要写一条 NOT_APPLICABLE）。
- `overall_decision` 跟 `drop_reasons` / `pause_reasons` 互相一致：DROP 时 `drop_reasons` 非空，PAUSE 时 `pause_reasons` 非空，KEEP 时两者都为空。
- 每条 `evidence` 都引用了简历里的具体内容，不要泛泛而谈。
- `resume_augmentation` 是给 Robohire 看的可读 markdown，把所有 PASS-with-flag 的提示集中归纳。
- 所有 `notifications` 都对应了 §3 中明确要求触发通知的规则；不要无中生有触发通知。
- 不要在输出里给候选人打匹配分数，那是 Robohire 的工作。
````

---

## 5. 集成到 matchResumeAgent — 代码改动 diff

### 5.1 当前实现（[match-resume-agent.ts:147-183](resume-parser-agent/lib/inngest/agents/match-resume-agent.ts#L147-L183)）

```ts
// 4a. 调 RAAS /api/v1/match-resume (透传 RoboHire)
const matchResult = await step.run(`match-${stepKey}`, async () => {
  const jdText = flattenRequirementForMatch(req);
  const r = await matchResume(
    { resume: resumeText, jd: jdText },
    { traceId },
  );
  return { ok: true, data: r.data, requestId: r.requestId, savedAs: r.savedAs };
});
```

### 5.2 改动后

```ts
// 4a-pre. ★ NEW: rule check via LLM
const ruleCheck = await step.run(`rule-check-${stepKey}`, async () => {
  const parsedData = (data.parsed?.data ?? {}) as RoboHireParsedData;
  return runResumeRuleCheck({
    candidate_id: candidateId ?? '',
    resume: parsedData,
    job_requisition: req,
    client_id: pickClientId(req) ?? 'CSI',
  });
});

logger.info(
  `[${AGENT_NAME}] ruleCheck · job_req=${jrid} decision=${ruleCheck.overall_decision} ` +
    `drops=[${ruleCheck.drop_reasons.join(',')}] pauses=[${ruleCheck.pause_reasons.join(',')}]`,
);

// 4a-DROP. 不调 Robohire,直接 emit MATCH_FAILED
if (ruleCheck.overall_decision === 'DROP') {
  await step.run(`save-drop-${stepKey}`, () =>
    saveMatchResults({
      source: 'rule_check_drop',
      candidate_id: candidateId ?? undefined,
      upload_id: uploadId ?? undefined,
      job_requisition_id: jrid,
      client_id: pickClientId(req),
      matchScore: 0,
      recommendation: 'WEAK_MATCH',
      summary: ruleCheck.drop_reasons.join('; '),
      ruleCheckFlags: ruleCheck.rule_flags,    // 新字段:让 RAAS DB 也存 flags
    }, { traceId }),
  );
  await step.sendEvent(`emit-fail-${stepKey}`, {
    name: 'MATCH_FAILED',
    data: {
      upload_id: uploadId ?? '',
      job_requisition_id: jrid,
      success: true,
      data: { drop_reasons: ruleCheck.drop_reasons, ruleCheck },
    },
  });
  summaries.push({ job_requisition_id: jrid, ok: false, error: 'rule_check_drop' });
  continue;
}

// 4a-PAUSE. 不调 Robohire,触发 human task
if (ruleCheck.overall_decision === 'PAUSE') {
  for (const note of ruleCheck.notifications) {
    await step.run(`notify-${stepKey}-${note.rule_id}`, () =>
      createHumanTask({
        recipient: note.recipient,
        channel: note.channel,
        title: `${note.rule_id}: 预筛挂起待确认`,
        message: note.message,
        candidate_id: candidateId,
        job_requisition_id: jrid,
      }),
    );
  }
  // 不 emit MATCH_*,等 HSM 反馈后由别的 inngest fn 重新触发
  summaries.push({ job_requisition_id: jrid, ok: false, error: 'rule_check_paused' });
  continue;
}

// 4a-KEEP. 注入 augmentation,正常调 Robohire
const matchResult = await step.run(`match-${stepKey}`, async () => {
  const jdText = flattenRequirementForMatch(req);
  const augmentedResume = `${resumeText}\n\n${ruleCheck.resume_augmentation}`;
  // ★ 把 rule-check 的 flags 一起送给 Robohire
  const r = await matchResume(
    { resume: augmentedResume, jd: jdText },
    { traceId },
  );
  return { ok: true, data: r.data, requestId: r.requestId, savedAs: r.savedAs };
});

// 后续 4b saveMatchResults / 4c emit MATCH_PASSED_NEED_INTERVIEW 不变
```

### 5.3 需要新增的依赖

| 文件 | 用途 |
|------|------|
| `resume-parser-agent/lib/rule-check.ts` | `runResumeRuleCheck()` 主入口；调 LLM gateway |
| `resume-parser-agent/lib/match-resume-action-object.ts`（叶洋交付） | `MatchResume` action object，提供 `getRuleCheckPrompt()` |
| `resume-parser-agent/lib/human-task.ts`（如果还没有） | `createHumanTask()`：把 PAUSE 的 notifications 转成人工任务 |

`saveMatchResults` 的 RAAS 端契约可能需要扩 `source: 'rule_check_drop'` 枚举值 + 可选 `ruleCheckFlags` 字段。

---

## 6. 三种 decision 的下游路径

```
                    ┌─── DROP  ────┐
                    │   (10-17 等   │
                    │    硬性命中)  │
                    │              │
                    │  ✗ 不调       │
                    │    Robohire   │
                    │              │
                    │  saveMatchResults({              │
                    │    source: 'rule_check_drop',    │
                    │    matchScore: 0,                │
                    │    summary: drop_reasons         │
                    │  })                              │
                    │              │
                    │  emit MATCH_FAILED               │
                    └──────────────┘
                    
                    ┌─── PAUSE ────┐
                    │   (10-25 等   │
                    │    需人工)    │
                    │              │
                    │  ✗ 不调       │
                    │    Robohire   │
                    │              │
                    │  for n in    │
                    │   notifications:                 │
                    │     createHumanTask(n)           │
                    │              │
                    │  ✗ 不 emit                       │
                    │   MATCH_*,等人工反馈触发         │
                    │   重新匹配                        │
                    └──────────────┘
                    
                    ┌─── KEEP  ────┐
                    │   (全部 PASS  │
                    │    或仅 flag) │
                    │              │
                    │  resume += ' \\n' +              │
                    │   ruleCheck.resume_augmentation  │
                    │              │
                    │  ✓ 调 Robohire match-resume     │
                    │  ✓ saveMatchResults(            │
                    │      source: 'need_interview',   │
                    │      matchScore: ...             │
                    │    )                             │
                    │  ✓ emit MATCH_PASSED_*          │
                    └──────────────┘
```

---

## 7. 完整工作示例

### 示例 1：KEEP 情况

**输入**（runtime 注入到 prompt 的 §2）：

```json
{
  "candidate_id": "cand_a3f1",
  "client_id": "腾讯",
  "resume": {
    "name": "张三",
    "experience": [
      {
        "company": "阿里巴巴",
        "title": "高级前端工程师",
        "startDate": "2021-03",
        "endDate": "2024-08",
        "description": "负责淘宝交易链路前端架构..."
      }
    ],
    "education": [
      { "degree": "本科", "field": "计算机科学", "institution": "浙江大学", "graduationYear": "2018" }
    ],
    "skills": ["React", "TypeScript", "Node.js", "Webpack"],
    "languages": [{ "language": "英语", "proficiency": "CET-6 580" }]
  },
  "job_requisition": {
    "job_requisition_id": "jr_x99",
    "client_business_group": "PCG",
    "title": "高级前端开发",
    "must_have_skills": ["React", "TypeScript"],
    "language_requirements": "CET-6 480 以上",
    "tags": []
  },
  "hsm_feedback": null
}
```

**输出**：

```json
{
  "candidate_id": "cand_a3f1",
  "client_id": "腾讯",
  "overall_decision": "KEEP",
  "drop_reasons": [],
  "pause_reasons": [],
  "rule_flags": [
    {
      "rule_id": "10-5",
      "rule_name": "硬性要求一票否决",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "学历本科 ≥ 要求；技能 React+TypeScript 全覆盖；语言 CET-6 580 ≥ 480。",
      "next_action": "continue"
    },
    { "rule_id": "10-17", "applicable": false, "result": "NOT_APPLICABLE", "evidence": "无华腾/中软经历", ... },
    { "rule_id": "10-25", "applicable": false, "result": "NOT_APPLICABLE", "evidence": "无华为/荣耀经历", ... },
    { "rule_id": "10-38", "applicable": false, "result": "NOT_APPLICABLE", "evidence": "无腾讯历史经历", ... },
    { "rule_id": "10-42", "applicable": true, "result": "PASS", "evidence": "目标岗位 PCG 不是 CDG", ... },
    // ... 其余规则
  ],
  "resume_augmentation": "## 预筛 flags\n- 通用红线: 全部通过\n- 腾讯特定: 无相关历史\n- 待人工: 无\n",
  "notifications": []
}
```

后续：matchResumeAgent 把 `resume_augmentation` 拼到 resume 文本后，调 Robohire `/match-resume` 拿 score。

### 示例 2：DROP 情况

**输入**：候选人有华腾经历，离职编码 B8（有犯罪记录）。

**输出**：

```json
{
  "candidate_id": "cand_b9c2",
  "client_id": "腾讯",
  "overall_decision": "DROP",
  "drop_reasons": ["10-17:high_risk_reflux"],
  "pause_reasons": [],
  "rule_flags": [
    {
      "rule_id": "10-17",
      "rule_name": "通用黑名单-高风险回流人员",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "曾在华腾任职 2020-05 至 2022-12，离职编码 B8（有犯罪记录-YCH）",
      "next_action": "block"
    },
    // ... 其余 PASS / NOT_APPLICABLE 规则,但 overall_decision 已 DROP
  ],
  "resume_augmentation": "",
  "notifications": []
}
```

后续：不调 Robohire，写一条 `source: 'rule_check_drop'` 的 saveMatchResults，emit `MATCH_FAILED`。

### 示例 3：PAUSE 情况

**输入**：候选人 2026-03 从华为离职，距今 2 个月。

**输出**：

```json
{
  "candidate_id": "cand_d4e5",
  "client_id": "腾讯",
  "overall_decision": "PAUSE",
  "drop_reasons": [],
  "pause_reasons": ["10-25:huawei_under_3mo"],
  "rule_flags": [
    {
      "rule_id": "10-25",
      "rule_name": "华为/荣耀竞对互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "REVIEW",
      "evidence": "华为 2023-06 至 2026-03，离职 2 个月（< 3 个月冷冻期）",
      "next_action": "notify_recruiter"
    },
    // ... 其余规则
  ],
  "resume_augmentation": "",
  "notifications": [
    {
      "recipient": "招聘专员",
      "channel": "InApp",
      "rule_id": "10-25",
      "message": "竞对互不挖角待确认：候选人最近 3 个月内从华为/荣耀离职，请确认处理。"
    }
  ]
}
```

后续：不调 Robohire，为每条 notification 创建一条 humanTask；候选人状态记录为 `paused_for_review`，等招聘专员处理。

---

## 8. 配置 / 环境变量

| 变量名 | 用途 | 示例 |
|--------|------|------|
| `RULE_CHECK_LLM_MODEL` | 规则检查使用的模型 | `claude-sonnet-4-6` |
| `RULE_CHECK_TEMPERATURE` | LLM 温度 | `0.1`（推荐，求一致性） |
| `RULE_CHECK_MAX_TOKENS` | 输出最大 token | `4096` |
| `RULE_CHECK_TIMEOUT_MS` | 单次调用超时 | `30000` |
| `RULE_CHECK_ENABLED` | feature flag | `true` / `false`（关掉则直通 Robohire） |

---

## 9. 风险与开放问题

### 9.1 LLM 输出稳定性
50+ 条规则一次评估，token 量约 8K input + 2K output。需要：
- 用 `response_format: json_object` 强制 JSON
- 跑一批黄金集（每客户 30-50 份代表性简历）人工 label 后，对比 LLM 输出，评估准确率
- 准确率不达标的规则要拆出来单独再跑一次或换更强的模型

### 9.2 客户特定规则的扩展
当前模板只覆盖腾讯。字节、未来其他客户的规则要由叶洋的 `getRuleCheckPrompt(clientId)` 自动按 `applicableClient` 字段过滤生成。

### 9.3 ontology 中 severity 字段的歧义
ontology 现状是所有 rule 的 `severity` 都是 `"advisory"`。本文档手工映射成 `terminal` / `needs_human` / `flag_only` 三档。**建议陈洋在 ontology 加一个 `gating_severity` 字段**，让 snapshot 生成时自动带出，不再依赖手工标注。

### 9.4 加分项命中比例的估算
规则 10-40、10-47 都需要"粗估加分项命中比例"。LLM 在没有"加分项总数"参考时容易给出不稳定的数字。可能的修法：
- 由 ontology 的 nice-to-have skills + bonus rules 总数作为分母传入 prompt
- 或把这两条规则推迟到 Robohire 端做（Robohire 已有完整加分项评估能力）

### 9.5 跟 Robohire 双跑的成本
当前设计是 KEEP 的简历仍然过 Robohire。如果某天 LLM 准确率足够高，可以考虑直接 bypass Robohire（即把规则 10-40 那种 conditional FAIL 也让 LLM 自己判，不再走 Robohire 打分）。这是后续优化方向。

---

## 10. 上线 checklist

- [ ] 叶洋交付 `MatchResume` action object，含 `getRuleCheckPrompt(clientId)` 方法
- [ ] 雨函在 `lib/rule-check.ts` 实现 `runResumeRuleCheck()`
- [ ] [match-resume-agent.ts](resume-parser-agent/lib/inngest/agents/match-resume-agent.ts) 加 §5.2 的 diff
- [ ] RAAS 端 `saveMatchResults` 支持 `source: 'rule_check_drop'` 与 `ruleCheckFlags` 字段
- [ ] 黄金集准备：每客户 30-50 份代表性简历 + 人工 label
- [ ] feature flag `RULE_CHECK_ENABLED` 默认 `false`，通过流量比例 ramp up
- [ ] 监控指标：rule-check 准确率、LLM 调用延迟、DROP/PAUSE/KEEP 比例、Robohire 调用量减少幅度

---

*生成时间：2026-05-09*
*维护人：matchResumeAgent owner（雨函） + Action layer owner（叶洋）*
