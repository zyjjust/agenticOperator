# matchResume 规则预筛 — User Prompt 生成流水线与端到端适配设计

> **本文档目的**：定义在调 Robohire 简历匹配**之前**插入的 LLM 规则预筛环节，重点回答三个问题：
>
> 1. **User prompt 长什么样** — 严格的 input + rules + output 三段式结构
> 2. **User prompt 怎么生成** — 从 RAAS / 简历 / ontology 抓取数据，按 (client × department × studio × job_tags) 维度过滤规则后编译
> 3. **怎么跟现有工作流适配** — input 完全对齐现有 `RESUME_PROCESSED` 事件 + 候选人在 RAAS 端关联的客户原始需求；output 完全对齐现有 `matchResume` 调用 + `saveMatchResults` + `emit MATCH_*`，不破坏任何已有契约
>
> **重要前提（本文档的核心修正）**：在 RAAS 平台上，每份候选人简历**已经被关联到一条具体的 JD**。这条 JD **不是** AO 这边 `createJdAgent` 生成的 JD（那只是发布渠道用的派生文档），而是**客户的原始需求**（ontology 里的 `Job_Requisition`）。规则匹配、深度打分、所有 rule 元数据都以这条客户原始需求为准。
>
> **结果**：rule check 是 **一份简历 → 一条客户原始需求 → 一份 user prompt → 一次 LLM 调用** 的线性流程，不需要循环匹配 HSM 名下所有 JD。

---

## 0. 前置概念：客户原始需求 vs 我们生成的 JD

整个流程涉及两份"JD"，必须先分清楚：

| 名称 | 来源 | 角色 | 在 ontology 里 | 在 RAAS DB 里 |
|------|------|------|----------------|---------------|
| **客户原始需求（Job_Requisition）** | 客户在 RAAS dashboard 录入 | **canonical（权威源）**：所有规则匹配、岗位元数据、客户/部门/工作室/标签都以它为准 | `Job_Requisition` 节点 | `job_requisitions` 表 |
| **生成的 JD（Generated JD）** | AO `createJdAgent` 由 Robohire `/generate-jd` 产出，回写 RAAS via `/jd/sync-generated` | **派生工件**：用于发布到招聘渠道（人才市场、内部官网等）；matchResume 流程**不使用它** | （不直接存在；是 Job_Requisition 的渲染产物） | RAAS 用作 posting 模板 |

```
客户在 dashboard 录入需求
        │
        ▼
┌─────────────────────────────┐
│ Job_Requisition (客户原始需求) │ ◀──── matchResume 规则匹配的依据
│  - client_id                 │       本文档讨论的 "JD"
│  - business_group            │
│  - studio                    │
│  - must_have_skills[]        │
│  - tags[]                    │
│  - negative_requirement      │
│  - 等                         │
└────────┬────────────────────┘
         │
         │ AO createJdAgent 据此调 Robohire /generate-jd
         ▼
┌─────────────────────────────┐
│ Generated JD (发布工件)        │
│  - title / description /     │
│    qualifications / 等         │
│  - 用于人才市场、官网等渠道发布│ ◀── 不参与匹配
└─────────────────────────────┘
```

候选人简历到达后，**RAAS 把简历关联到具体的 `Job_Requisition`**（不是 Generated JD）。后续整个 rule check + Robohire 匹配，都用这条 `Job_Requisition` 的数据。

---

## 1. 总览：单 JD 线性流水线

```
客户在 RAAS dashboard 上对一个 Job_Requisition 上传简历
                     │
                     ▼
        RAAS API Server 内部 parse-resume
                     │
                     │ publish RESUME_DOWNLOADED
                     │ (含 candidate_id + job_requisition_id)
                     ▼
        AO resumeParserAgent
                     │ POST /candidates
                     │ emit RESUME_PROCESSED
                     │ (传递 job_requisition_id)
                     ▼
┌──────────────────────────────────────────────────────┐
│  AO matchResumeAgent                                  │
│                                                       │
│  ① 取出 RESUME_PROCESSED.job_requisition_id          │
│                                                       │
│  ② getJobRequisition(job_requisition_id)             │
│        ↓                                              │
│     {client_id, business_group, studio, tags, ...}    │
│                                                       │
│  ③ getRulesForMatchResume({                           │
│        client_id, business_group, studio, tags        │
│     })                                                │
│        ↓                                              │
│     filtered Rule[]                                   │
│                                                       │
│  ④ getRuleCheckPrompt({inputs, rules})                │
│        ↓                                              │
│     完整 user prompt 字符串                            │
│                                                       │
│  ⑤ LLM call → ruleCheck JSON                          │
│        ↓                                              │
│     { overall_decision, rule_flags, augmentation, ...}│
│                                                       │
│  ⑥ 分支处理：                                          │
│     • DROP  → saveMatchResults + emit MATCH_FAILED   │
│     • PAUSE → createHumanTask × N                    │
│     • KEEP  → 注入 augmentation → 调 Robohire ↓       │
│                                                       │
│  ⑦ (仅 KEEP) matchResume({resume:augmented, jd})     │
│                                                       │
│  ⑧ (仅 KEEP) saveMatchResults + emit MATCH_PASSED_*  │
└──────────────────────────────────────────────────────┘
```

**关键设计点**：

- **一份简历，一次 LLM 调用** —— RAAS 已经替我们做了 "resume ↔ Job_Requisition" 的关联，AO 不需要再做一对多 fan-out
- **rule check 数据全部来自 Job_Requisition** —— `client_id` / `business_group` / `studio` / `tags` 都是 Job_Requisition 的字段，不是 Generated JD 的
- **如果同一份简历后续要重新匹配到其他 Job_Requisition**（比如换岗推荐场景），那是另一条工作流，不在本文档范围内

---

## 2. User Prompt 三段式结构

每份 user prompt 都严格分三段：**INPUT + RULES + OUTPUT**。这三段在 prompt 字符串里以 markdown 的 `## 1. Inputs` / `## 2. Rules` / `## 3. Output schema` 划分，让 LLM 一眼看清楚。

### 2.1 段一：INPUT（runtime 注入数据）

每次 LLM 调用都注入实际数据：

| 字段 | 来源 | 备注 |
|------|------|------|
| `candidate_id` | `RESUME_PROCESSED.candidate_id` | 输出时回引 |
| `resume.*` | `RESUME_PROCESSED.parsed.data`（[robohire.ts:41-52](resume-parser-agent/lib/robohire.ts#L41-L52)）| name / experience / education / skills / languages 等结构化简历 |
| `job_requisition.*` | `getJobRequisition(job_requisition_id)` 返回的对象 | **客户原始需求** —— job_id / client_id / business_group / studio / must_have_skills / tags 等 |
| `client_id` | `job_requisition.client_id` | 决定加载哪段客户特定 rules |
| `business_group` | `job_requisition.client_business_group`（腾讯特有）/ `job_requisition.client_division`（字节特有）| 决定加载哪段部门特定 rules |
| `studio` | `job_requisition.client_studio`（仅腾讯 IEG 类用）| 决定 10-43 等工作室级 rule 是否激活 |
| `hsm_feedback`（可选）| `getHsmFeedback(candidate_id, job_requisition_id)` | 用于规则 10-28 / 10-39 等需要 HSM 二次输入的场景 |

INPUT 段在 prompt 里以 JSON 形式呈现，方便 LLM 引用具体字段。

### 2.2 段二：RULES（design-time 按维度过滤后的规则）

按 client_id + business_group + studio + tags 四个维度从 ontology 过滤出"应当被检查"的 rules 子集，每条规则用自然语言段落描述。三段顺序固定：

```markdown
## 2. Rules to check

### 2.1 通用规则 (CSI 级，所有客户必查)
〔ontology applicableClient="通用",过滤 executor=Agent,过滤 step ∈ {1,2,3}〕
- 规则 10-17 高风险回流人员 [终止级]
- 规则 10-18 EHS 风险回流 [需人工]
- ...

### 2.2 客户级规则 (仅当 client_id == "本次 client" 激活)
〔ontology applicableClient="<client>"〕
- 规则 10-38 腾讯历史从业经历核实 [需人工]
- ...

### 2.3 部门/工作室级规则 (按 business_group + studio 进一步过滤)
〔仅在客户级规则中,condition_business_group / condition_studio 与本次 JD 匹配的才出现〕
- 规则 10-42 CDG 6 个月绝对拦截 [终止级] (仅 business_group=CDG)
- 规则 10-43 IEG 工作室回流互斥 [终止级] (仅 IEG + studio∈{天美,光子,魔方,北极光})
- ...
```

**关键**：runtime 调用时，prompt 里**只出现"该被检查"的 rules**。客户/部门/工作室不匹配的 rules 不会出现在 prompt 里。

### 2.3 段三：OUTPUT（结构化输出 schema）

定义 LLM 必须返回的 JSON 形态。**所有 prompt 共用同一份 schema**（schema 与 client/department 无关）：

```json
{
  "candidate_id": "<from input>",
  "job_requisition_id": "<from input>",
  "client_id": "<from input>",
  "overall_decision": "KEEP" | "DROP" | "PAUSE",
  "drop_reasons": ["<rule_id>:<short_code>"],
  "pause_reasons": ["<rule_id>:<short_code>"],
  "rule_flags": [...每条 applicable rule 一项...],
  "resume_augmentation": "<给 Robohire 的 markdown 标记段>",
  "notifications": [...给招聘专员/HSM 的待办...]
}
```

完整字段定义见 §6。

---

## 3. User Prompt 生成流水线

### 3.1 流水线总览

```
[Stage P1]                    [Stage P2]                [Stage P3]              [Stage P4]
取关联 Job_Requisition          候选人简历数据             按维度抓规则             编译 user prompt
─────────────                  ─────────────             ────────────             ────────────
RAAS                           RESUME_PROCESSED          ontology API             叶洋 actionObject
getJobRequisition(             .parsed.data              getRulesFor              getRuleCheckPrompt(
  job_requisition_id                                      MatchResume({             { inputs, rules }
)                                                          client_id,             )
                                                            business_group,
                                                            studio,
                                                            job_tags
                                                          })
   │                                │                       │                         │
   └──────────────┐                 │            ┌──────────┘                         │
                  │                 │            │                                    │
                  ▼                 ▼            ▼                                    ▼
       Job_Requisition obj    parsed resume    rules[]                          user_prompt:string
       (客户原始需求)
```

### 3.2 Stage P1：取候选人关联的 Job_Requisition

**触发时机**：`matchResumeAgent` 收到 `RESUME_PROCESSED` 事件，第一步从事件中读取 `job_requisition_id`，然后用它去 RAAS 取详情。

**关键差异**：跟之前的设计相比，**不再循环调 `getRequirementsAgentView` 列出 HSM 名下所有 JD**。RAAS 已经在简历到达时把它关联到了具体的 Job_Requisition，AO 直接用就行。

**实现（雨函改造）**：

```ts
// 旧流程 (要替换):
//   const requirements = await getRequirementsAgentView({
//     claimer_employee_id: employeeId,
//     scope: 'claimed',
//     status: 'recruiting',
//   });
//   for (const req of requirements) { ... }

// 新流程:
const jobRequisitionId = pickJobRequisitionId(eventData);
if (!jobRequisitionId) {
  throw new NonRetriableError(
    `[matchResume] RESUME_PROCESSED 缺 job_requisition_id —— 简历未关联到客户原始需求`,
  );
}

const jobRequisition = await getJobRequisition(jobRequisitionId, { traceId });
//                            ↑ 新增的 RAAS API,见 §7.4
```

**`getJobRequisition` 返回**（这是 ontology `Job_Requisition` 节点的 RAAS 视图）：

```ts
type JobRequisition = {
  job_requisition_id: string;
  client_id: string;                       // "腾讯" / "字节" / ...
  client_business_group?: string;          // "IEG" / "PCG" / "CDG" / "TikTok" / ...
  client_studio?: string;                  // "天美" / "光子" / 仅腾讯 IEG 类有
  client_department?: string;              // 字节系等其他客户的部门标识
  client_job_title?: string;
  must_have_skills: string[];
  nice_to_have_skills: string[];
  language_requirements: string;
  degree_requirement: string;
  age_range?: { min?: number; max?: number };
  salary_range: string;
  negative_requirement: string;
  tags?: string[];                         // ["外语", "海外", "国际化", "轮班", "夜班", "倒班", "长期出差"]
  job_responsibility: string;
  job_requirement: string;
  hc_status: string;                       // 必须不是 "已关闭"
  // ...
};
```

### 3.3 Stage P2：拿候选人简历数据

**来源**：`RESUME_PROCESSED.parsed.data`，已是 RoboHire `/parse-resume` 输出的结构化 JSON。

**形态**（[robohire.ts:41-52](resume-parser-agent/lib/robohire.ts#L41-L52)）：

```ts
type RoboHireParsedData = {
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

**注意**：当前 schema 缺少几个 rule 需要的字段（出生日期、国籍、婚育情况、利益冲突声明、空窗期、求职意向）。**短期方案**：让 LLM 用 NOT_APPLICABLE 处理；**中期方案**：扩展 RoboHire `/parse-resume` 输出，或在 RAAS DB 把这些字段补齐后通过 `getCandidate` API 查出来 merge 进 prompt。详见 §8。

### 3.4 Stage P3：按 (client × business_group × studio × tags) 抓规则

**实现**：

```ts
const rules = await ontologyApi.getRulesForMatchResume({
  client_id: jobRequisition.client_id,                       // "腾讯"
  business_group: jobRequisition.client_business_group,       // "CDG" or "IEG" or null
  studio: jobRequisition.client_studio,                       // "天美" or null
  job_tags: jobRequisition.tags ?? [],                        // ["外语", "轮班"] or []
});
```

**陈洋的 ontology API 内部过滤逻辑**：

```
SELECT rules WHERE:
  action = 'matchResume'
  AND step IN (1, 2, 3)               -- 跳过 step 4 generateMatchResult
  AND executor = 'Agent'              -- 跳过 Human-only
  AND (
    applicableClient = '通用'          -- 通用规则
    OR
    applicableClient = $client_id     -- 客户级规则
  )
  AND (
    -- 部门 / studio / tags 维度的进一步过滤
    rule.condition_business_group IS NULL
    OR rule.condition_business_group = $business_group
  )
  AND (
    rule.condition_studio IS NULL
    OR $studio IN rule.condition_studio_list
  )
  AND (
    rule.condition_tags_required IS NULL
    OR rule.condition_tags_required ⊆ $job_tags
  )
ORDER BY step ASC, rule_id ASC
```

**返回**：本次 (client, business_group, studio, tags) 适用的 rule 列表，每条 rule 含：

```ts
type Rule = {
  rule_id: string;                          // "10-25"
  rule_name: string;                        // "华为荣耀竞对互不挖角红线"
  applicable_client: string;                // "通用" | "腾讯" | "字节"
  step: 1 | 2 | 3;
  severity: 'terminal' | 'needs_human' | 'flag_only';   // 见 §8.3
  natural_language: string;                 // 叶洋编译好的自然语言段落
  output_action: {                          // 命中后该填什么
    on_hit: { result: 'FAIL' | 'REVIEW' | 'PASS'; reason_code?: string };
    notification?: { recipient: '招聘专员' | 'HSM'; channel: 'InApp' | 'Email'; template: string };
  };
};
```

### 3.5 Stage P4：编译成 user prompt 字符串

**调用方**：`matchResumeAgent` 在收到 P1 / P2 / P3 三方数据后调一次。

**实现（叶洋的 actionObject 提供）**：

```ts
const userPrompt = matchResumeActionObject.getRuleCheckPrompt({
  inputs: {
    candidate_id: candidateId,
    resume: parsedResumeData,
    job_requisition: jobRequisition,
    hsm_feedback: maybeHsmFeedback,
  },
  rules: filteredRules,    // 来自 Stage P3
});
```

**内部逻辑**：

```ts
function getRuleCheckPrompt({ inputs, rules }: BuildArgs): string {
  return [
    SECTION_HEADER,                     // # Resume Pre-Screen Rule Check
    ROLE_SECTION,                       // ## 1. 你的角色（固定）
    renderInputsSection(inputs),        // ## 2. Inputs（runtime 注入 JSON）
    renderRulesSection(rules),          // ## 3. Rules（按 §2.2 三段分组）
    DECISION_LOGIC_SECTION,             // ## 4. 决策结算逻辑（固定）
    OUTPUT_SCHEMA_SECTION,              // ## 5. 输出格式（固定 JSON schema）
    SELF_CHECK_SECTION,                 // ## 6. 提交前自检（固定）
  ].join('\n\n');
}
```

`renderRulesSection` 把 rules 数组按 §2.2 的"通用 / 客户级 / 部门级"分组，每条 rule 用自然语言段落描述，附 severity tag 和命中处理说明。

---

## 4. matchResumeAgent 改造后的完整流程

下面是改造后的 [matchResumeAgent](resume-parser-agent/lib/inngest/agents/match-resume-agent.ts) 处理 `RESUME_PROCESSED` 事件的完整伪代码，**不再有 for 循环**：

```
on RESUME_PROCESSED(event):

    # ── 准备阶段 ──
    data            = unwrap(event.data)
    candidate_id    = pickCandidateId(data)
    upload_id       = pickUploadId(data)
    employee_id     = pickEmployeeId(data)
    parsed_resume   = data.parsed.data                              # ← Stage P2
    jr_id           = pickJobRequisitionId(data)                    # ← 新增

    if not jr_id:
        throw NonRetriableError("简历未关联到客户原始需求")

    # ── Stage P1: 取关联的客户原始需求 ──
    job_requisition = await getJobRequisition(jr_id, {traceId})

    if job_requisition.hc_status == "已关闭":
        log.warn("Job_Requisition 已关闭,不匹配")
        return {ok: true, skipped: "jr_closed"}

    # ── Stage P3: 按维度抓规则 ──
    rules = await ontologyApi.getRulesForMatchResume({
                client_id:      job_requisition.client_id,
                business_group: job_requisition.client_business_group
                                ?? job_requisition.client_department,
                studio:         job_requisition.client_studio,
                job_tags:       job_requisition.tags ?? [],
            })

    # ── Stage P4: 编译 user prompt ──
    hsm_feedback = await getHsmFeedback(candidate_id, jr_id)        # ← 可选,可能 null

    user_prompt = matchResumeActionObject.getRuleCheckPrompt({
                      inputs: {
                          candidate_id,
                          resume: parsed_resume,
                          job_requisition,
                          hsm_feedback,
                      },
                      rules,
                  })

    # ── LLM call: rule check ──
    rule_check = await llmGateway.complete({
                    system: SYSTEM_PROMPT_RULE_CHECKER,
                    user:   user_prompt,
                    response_format: {type: 'json_object'},
                    temperature: 0.1,
                 })

    result = JSON.parse(rule_check.text)

    # ── 决策分支 ──
    switch result.overall_decision:

        case 'DROP':
            await saveMatchResults({
                source: 'rule_check_drop',
                candidate_id, upload_id, job_requisition_id: jr_id,
                client_id: job_requisition.client_id,
                matchScore: 0, recommendation: 'WEAK_MATCH',
                summary: result.drop_reasons.join('; '),
                rule_check_flags: result.rule_flags,
            })
            await emit('MATCH_FAILED', {
                upload_id, job_requisition_id: jr_id,
                data: {rule_check: result},
            })
            return {ok: true, decision: 'DROP', drop_reasons: result.drop_reasons}

        case 'PAUSE':
            for n in result.notifications:
                await createHumanTask({
                    recipient: n.recipient, channel: n.channel,
                    title:   f"{n.rule_id}: 预筛挂起待确认",
                    message: n.message,
                    candidate_id, job_requisition_id: jr_id,
                })
            # 不 emit MATCH_*; 等 HSM 反馈触发重新匹配
            return {ok: true, decision: 'PAUSE', pause_reasons: result.pause_reasons}

        case 'KEEP':
            # 注入 augmentation 到 resume 文本
            resume_text      = buildResumeText(parsed_resume)
            augmented_resume = resume_text + '\n\n' + result.resume_augmentation
            jd_text          = flattenRequirementForMatch(job_requisition)

            # 现有 Robohire 调用(契约不变)
            match_result = await matchResume({
                resume: augmented_resume,
                jd:     jd_text,
            }, {traceId})

            # 现有持久化(扩 rule_check_flags 字段)
            await saveMatchResults({
                source: 'need_interview',
                candidate_id, upload_id, job_requisition_id: jr_id,
                client_id: job_requisition.client_id,
                matchScore:        match_result.matchScore,
                matchAnalysis:     match_result.matchAnalysis,
                mustHaveAnalysis:  match_result.mustHaveAnalysis,
                niceToHaveAnalysis: match_result.niceToHaveAnalysis,
                summary:           match_result.summary,
                recommendation:    match_result.recommendation,
                rule_check_flags:  result.rule_flags,                # ← 新增
            })

            # 现有 emit (不变)
            await emit('MATCH_PASSED_NEED_INTERVIEW', {
                upload_id,
                job_requisition_id: jr_id,
                success: true,
                data: match_result,
            })

            return {ok: true, decision: 'KEEP', matchScore: match_result.matchScore}
```

---

## 5. 端到端 I/O 适配性

### 5.1 Rule Check 输入数据来源（逐字段）

| Prompt 字段 | 来源 | 现有 / 新增 | 备注 |
|------------|------|------------|------|
| `candidate_id` | `RESUME_PROCESSED.candidate_id` | 现有 | resume-parser-agent 已写入 |
| `resume.*` | `RESUME_PROCESSED.parsed.data` | 现有 | RoboHire `/parse-resume` 输出 |
| `job_requisition_id` | `RESUME_PROCESSED.job_requisition_id` | **★ 新增字段** | **当前 [client.ts:70-98](resume-parser-agent/lib/inngest/client.ts#L70-L98) 的 `ResumeProcessedData` 没有这个字段，必须由 RAAS 在 `RESUME_DOWNLOADED` 中带入 → resumeParserAgent 透传到 `RESUME_PROCESSED`** |
| `job_requisition.*` | `getJobRequisition(jr_id)` | **★ 新增 RAAS API** | 当前 RAAS 只有 `getRequirementsAgentView`（列表），需要新增按 ID 查的单条 API |
| `client_id` | `job_requisition.client_id` | 现有（Job_Requisition 内有）| - |
| `business_group` | `job_requisition.client_business_group` | **现有但需 RAAS 确认有这个字段** | 腾讯 JD 必有；其他客户酌情 |
| `studio` | `job_requisition.client_studio` | **现有但需 RAAS 确认有这个字段** | 仅腾讯 IEG 类需求会有 |
| `job_tags` | `job_requisition.tags` | **可能需 RAAS 补充字段** | "外语 / 海外 / 轮班"等岗位标签 |
| `hsm_feedback` | `getHsmFeedback(candidate_id, jr_id)` | **★ 新增 API + 数据存储** | 用于 10-28 / 10-39 等需要 HSM 二次输入的场景 |
| `rules` | `ontologyApi.getRulesForMatchResume({...})` | **★ 新增 ontology 维度查询 API** | 比当前的 `get_rule_by_action` 多三个过滤维度 |

### 5.2 Rule Check 输出数据流

| LLM 输出字段 | 流向 | 备注 |
|-------------|------|------|
| `overall_decision = DROP` | → `saveMatchResults({source:'rule_check_drop',matchScore:0,...})` <br>→ `emit MATCH_FAILED` | 不调 Robohire；现有 `MATCH_FAILED` 事件 ([client.ts:241](resume-parser-agent/lib/inngest/client.ts#L241)) 直接承载 |
| `overall_decision = PAUSE` | → `createHumanTask(notification)` × N | 需新增 humanTask 入口；不 emit `MATCH_*` |
| `overall_decision = KEEP` + `resume_augmentation` | → 拼到 resume 文本后 → `matchResume({resume:augmented, jd})` | **Robohire 契约完全不变** |
| `rule_flags[]` | → `saveMatchResults({rule_check_flags:[...]})` | RAAS DB 需扩 `rule_check_flags` JSON 列 |
| `notifications[]` | → `createHumanTask` 或写消息队列 | 与 PAUSE 路径共用 |

### 5.3 跟 [match-resume-agent.ts](resume-parser-agent/lib/inngest/agents/match-resume-agent.ts) 当前实现的差异

**当前** [match-resume-agent.ts:88-247](resume-parser-agent/lib/inngest/agents/match-resume-agent.ts#L88-L247)：

```ts
const requirements = await getRequirementsAgentView({...});
for (const req of requirements) {
  match-${jrid}      step → 调 Robohire matchResume
  save-match-${jrid} step → saveMatchResults
  emit-match-${jrid} sendEvent → MATCH_PASSED_NEED_INTERVIEW
}
```

**改造后**：

```ts
// 不再调 getRequirementsAgentView; 不再 for 循环
const jrId            = pickJobRequisitionId(eventData);
const jobRequisition  = await getJobRequisition(jrId);

const ruleCheck       = await runResumeRuleCheck({
  candidate_id, resume: parsedResume, job_requisition: jobRequisition, hsm_feedback,
});

switch (ruleCheck.overall_decision) {
  case 'DROP':  ... emit MATCH_FAILED;       return;
  case 'PAUSE': ... createHumanTask × N;     return;
  case 'KEEP':
    const augmented = resumeText + '\n\n' + ruleCheck.resume_augmentation;
    const match     = await matchResume({resume: augmented, jd: jdText});
    await saveMatchResults({...match, rule_check_flags: ruleCheck.rule_flags});
    await emit('MATCH_PASSED_NEED_INTERVIEW', {...});
}
```

**关键变化**：

1. **去掉 `getRequirementsAgentView` 调用** —— RAAS 已经把简历关联到 Job_Requisition 了，不需要再列 HSM 名下所有 JD
2. **去掉 for 循环** —— 一份简历对应一条 Job_Requisition，不存在 fan-out
3. **新增 `getJobRequisition` 调用** —— 按 ID 取单条详情
4. **新增 rule check step** —— LLM 调用决策 KEEP/DROP/PAUSE
5. **KEEP 路径之后的 Robohire 调用 + saveMatchResults + emit 完全保留** —— 仅 saveMatchResults 多写一个 `rule_check_flags` 字段

---

## 6. User Prompt 完整模板（实例）

下面以"候选人 cand_a3f1 + 客户原始需求 jr_x99 (client=腾讯, business_group=PCG, 无 studio, tags=[])"为例，展示 runtime 注入数据后一份完整 user prompt 长什么样。

````markdown
# Resume Pre-Screen Rule Check

## 1. 你的角色

你是一名简历预筛查员。系统会给你一份候选人的解析后简历，以及一个具体的客户原始需求（Job_Requisition）。你的任务是逐条检查下列所有规则，找出哪些规则在这份简历上命中，并把结果整理成结构化标签输出。

请特别注意：
- **不要给候选人打匹配分数。** 打分是下游 Robohire 的工作。你只做规则命中检查。
- 你的输出会驱动三种处理：DROP（直接淘汰）/ PAUSE（暂停人工复核）/ KEEP（通过初筛，附 augmentation 送 Robohire 深度匹配）。

## 2. Inputs

```json
{
  "candidate_id": "cand_a3f1",
  "client_id": "腾讯",
  "business_group": "PCG",
  "studio": null,
  "resume": {
    "name": "张三",
    "experience": [
      { "company": "阿里巴巴", "title": "高级前端", "startDate": "2021-03", "endDate": "2024-08",
        "description": "..." }
    ],
    "education": [
      { "degree": "本科", "field": "CS", "institution": "浙大", "graduationYear": "2018" }
    ],
    "skills": ["React", "TypeScript", "Node.js"],
    "languages": [{ "language": "英语", "proficiency": "CET-6 580" }]
  },
  "job_requisition": {
    "job_requisition_id": "jr_x99",
    "client_job_title": "高级前端",
    "must_have_skills": ["React", "TypeScript"],
    "language_requirements": "CET-6 480 以上",
    "tags": [],
    "negative_requirement": "...",
    "job_responsibility": "...",
    "job_requirement": "..."
  },
  "hsm_feedback": null
}
```

## 3. Rules to check

### 3.1 通用规则 (CSI 级)

#### 规则 10-17：高风险回流人员 [终止级]
（详见 docs/match-resume-rule-check-prompt.md §3.1）

#### 规则 10-5：硬性要求一票否决 [终止级]
（...）

#### 规则 10-25：华为荣耀竞对互不挖角红线 [需人工复核]
（...）

#### 规则 10-26：OPPO 小米竞对互不挖角红线 [需人工复核]
（...）

#### ...（其他通用规则）

### 3.2 腾讯客户级规则

#### 规则 10-38：腾讯历史从业经历核实触发 [需人工复核]
（...）

#### 规则 10-27：腾讯亲属关系回避 [需人工复核]
（...）

#### 规则 10-47：腾讯婚育风险审视 [条件分支]
（...）

#### 规则 10-40：主动离职冷冻期紧急回流审核 [条件分支]
（...）

### 3.3 部门级规则

> 因 business_group=PCG，本次激活以下与 PCG 相关的部门级规则。
> 注意：10-42 (CDG 专属)、10-43 (IEG+四大工作室专属)、10-56 (腾娱互动专属) 等
> 规则不适用于 PCG，**本次 prompt 里都不出现**。

（如 PCG 没有部门专属规则，本节为空，明确告知 LLM 不需要查部门级规则。）

## 4. 决策结算逻辑
（固定章节，详见 docs/match-resume-rule-check-prompt.md §4）

## 5. 输出格式
（固定 JSON schema，详见 docs/match-resume-rule-check-prompt.md §5）

## 6. 提交前自检
（固定 checklist）
````

**对比另一份简历（同候选人，但关联到 jr_y88，client=腾讯，business_group=CDG）**：§3.3 会变成：

```markdown
### 3.3 部门级规则

#### 规则 10-42：CDG 事业群 6 个月回流绝对拦截 [终止级]
（自然语言描述... 注意此规则不提供任何人工审核放行通道）
```

**对比另一份简历（关联到 jr_z77，client=字节）**：§3.2 会完全换成字节规则（10-21, 10-22, 10-32 等），§3.3 视字节具体业务部门激活相应规则。

---

## 7. 接口契约定义

### 7.1 叶洋负责的 design-time 接口

```ts
// resume-parser-agent/lib/match-resume-action-object.ts

import type { ActionObject } from './action-object.types';
import type { Rule, JobRequisition } from './ontology-types';
import type { RoboHireParsedData } from './robohire';

interface RuleCheckBuildArgs {
  inputs: {
    candidate_id: string;
    resume: RoboHireParsedData;
    job_requisition: JobRequisition;
    hsm_feedback?: HsmFeedback | null;
  };
  rules: Rule[];   // 来自 ontology API,已按 (client, business_group, studio, tags) 过滤
}

class MatchResumeActionObject implements ActionObject {
  /**
   * 编译一份针对单个 Job_Requisition 的 user prompt。
   * 调用方负责先抓 rules,本方法只做字符串拼装。
   */
  getRuleCheckPrompt(args: RuleCheckBuildArgs): string;
}
```

### 7.2 陈洋负责的 ontology API 扩展

```ts
interface GetRulesForMatchResumeQuery {
  client_id: string;              // "腾讯" | "字节" | ...
  business_group?: string | null; // "IEG" | "CDG" | "TikTok" | null
  studio?: string | null;         // "天美" | null
  job_tags?: string[];            // ["外语", "轮班"] | []
}

interface Rule {
  rule_id: string;
  rule_name: string;
  applicable_client: '通用' | string;
  step: 1 | 2 | 3;
  severity: 'terminal' | 'needs_human' | 'flag_only';
  natural_language: string;
  // ...其他元数据
}

async function getRulesForMatchResume(
  query: GetRulesForMatchResumeQuery,
): Promise<Rule[]>;
```

### 7.3 雨函负责的 runtime 接口

```ts
// resume-parser-agent/lib/rule-check.ts (新文件)

interface RuleCheckResult {
  candidate_id: string;
  job_requisition_id: string;
  client_id: string;
  overall_decision: 'KEEP' | 'DROP' | 'PAUSE';
  drop_reasons: string[];
  pause_reasons: string[];
  rule_flags: Array<{
    rule_id: string;
    applicable: boolean;
    result: 'PASS' | 'FAIL' | 'REVIEW' | 'NOT_APPLICABLE';
    evidence: string;
    next_action: string;
  }>;
  resume_augmentation: string;
  notifications: Array<{
    recipient: '招聘专员' | 'HSM';
    channel: 'InApp' | 'Email';
    rule_id: string;
    message: string;
  }>;
}

async function runResumeRuleCheck(input: {
  candidate_id: string;
  resume: RoboHireParsedData;
  job_requisition: JobRequisition;        // ← 关键: 客户原始需求
  hsm_feedback?: HsmFeedback | null;
}): Promise<RuleCheckResult>;
```

实现逻辑：

```ts
async function runResumeRuleCheck(input) {
  const jr = input.job_requisition;

  // P3: 按维度抓规则
  const rules = await ontologyApi.getRulesForMatchResume({
    client_id:      jr.client_id,
    business_group: jr.client_business_group ?? jr.client_department,
    studio:         jr.client_studio,
    job_tags:       jr.tags ?? [],
  });

  // P4: 编译 prompt
  const userPrompt = matchResumeActionObject.getRuleCheckPrompt({
    inputs: input,
    rules,
  });

  // LLM call
  const response = await llmGateway.complete({
    system: '你是一名简历预筛查员。严格按照 user 消息中的规则评估候选人，输出严格符合 schema 的 JSON。',
    user: userPrompt,
    response_format: { type: 'json_object' },
    temperature: 0.1,
  });

  return JSON.parse(response.text);
}
```

### 7.4 张元军负责的 RAAS API 扩展

```ts
// 新增的 RAAS API:

// 4.1 按 ID 查 Job_Requisition (代替循环列表)
async function getJobRequisition(
  job_requisition_id: string,
  opts?: CommonOpts,
): Promise<JobRequisition>;

// 4.2 查 HSM 对某候选人 + 某需求的历史反馈
async function getHsmFeedback(
  candidate_id: string,
  job_requisition_id: string,
): Promise<HsmFeedback | null>;

// 4.3 saveMatchResults 扩字段
interface SaveMatchResultsBody {
  source: 'need_interview' | 'no_interview' | 'rule_check_drop';   // ← 新增 'rule_check_drop'
  candidate_id?: string;
  upload_id?: string;
  job_requisition_id: string;
  client_id?: string;
  matchScore?: number;
  // ...其他现有字段
  rule_check_flags?: RuleCheckFlag[];                              // ← 新增字段,JSON
}
```

### 7.5 RESUME_DOWNLOADED / RESUME_PROCESSED 字段扩展

```ts
// resume-parser-agent/lib/inngest/client.ts

export type ResumeProcessedData = {
  // ... 现有字段保留
  upload_id?: string;
  candidate_id?: string;
  resume_id?: string;
  employee_id?: string;
  parsed?: { data?: Record<string, unknown> };
  // ...

  // ★ 新增字段:
  job_requisition_id?: string;     // 由 RAAS 在 RESUME_DOWNLOADED 中带入,resumeParserAgent 透传
};
```

`RESUME_DOWNLOADED` 事件 schema 同步扩 `job_requisition_id`，由 RAAS 在简历入库时（已经知道关联 JD）写入。

---

## 8. 风险、缺口与开放问题

### 8.1 RESUME_PROCESSED 没有 job_requisition_id 字段（最高优先级）

**当前状态**：[client.ts:70-98](resume-parser-agent/lib/inngest/client.ts#L70-L98) 的 `ResumeProcessedData` 没有 `job_requisition_id` 字段。`getRequirementsAgentView` 是通过 `claimer_employee_id` 反查 HSM 名下所有 JD，假定一对多匹配。

**修复**：
- RAAS 端：`RESUME_DOWNLOADED` 事件必须携带候选人当前关联的 `job_requisition_id`（RAAS 在简历入库时已经知道这个关联，只需把它写进事件）
- AO 端：resumeParserAgent 在 emit `RESUME_PROCESSED` 时透传该字段
- 类型定义：[client.ts](resume-parser-agent/lib/inngest/client.ts) 中 `ResumeProcessedData` 加 `job_requisition_id: string` 必填字段

**owner**：张元军（RAAS 端）+ 雨函（AO 端 resumeParserAgent + matchResumeAgent）

### 8.2 RAAS 缺 `getJobRequisition(id)` API

**当前状态**：RAAS 只有 `getRequirementsAgentView`（列表查询，按 employee_id），没有按 ID 查单条 Job_Requisition 的 API。

**修复**：RAAS 增加 `GET /api/v1/job-requisitions/:id`，返回单条 Job_Requisition 详情，schema 至少含 §3.2 列出的字段。

**owner**：张元军

### 8.3 RAAS Job_Requisition 字段确认

本设计依赖 Job_Requisition 含以下字段，需跟 RAAS team 确认：
- `client_business_group` —— 腾讯特有的事业群字段
- `client_studio` —— 腾讯 IEG 类岗位的工作室字段
- `tags` —— 岗位标签数组（"外语 / 海外 / 轮班 / 长期出差"等）
- `age_range` —— 年龄范围对象

如果 RAAS 暂未存这些字段，要么先在 ontology Job_Requisition 节点维护、RAAS API 联读 Neo4j，要么 RAAS DB 扩列。

**owner**：张元军 + 陈洋

### 8.4 RoboHire `/parse-resume` 输出字段不全

[robohire.ts:41-52](resume-parser-agent/lib/robohire.ts#L41-L52) 的 `RoboHireParsedData` 缺：
- 出生日期 / 年龄（10-12 / 10-21 / 10-22 / 10-47 需要）
- 国籍（10-35 需要）
- 婚育情况（10-36 / 10-47 需要）
- 利益冲突声明（10-27 / 10-28 需要）
- 空窗期及原因说明（10-9 / 10-10 需要）
- 求职期望（期望薪资、外包接受度、劳务形式偏好 —— 10-7 / 10-8 / 10-11 需要）
- 历史任职我司记录 + 离职原因编码（10-16 / 10-17 / 10-18 / 10-29 需要）

**短期方案**：让 LLM 在数据缺失时一律输出 `result="NOT_APPLICABLE"` + `evidence="简历未提供该字段"`。

**中期方案**：协调 Robohire team 扩展 `/parse-resume` 输出，或在 RAAS DB 把这些字段补齐后通过 `getCandidate` API 查出 merge 进 prompt。

**owner**：Robohire team + 张元军

### 8.5 ontology severity 字段歧义

ontology 现状所有 rule 的 `severity` 都是 `"advisory"`，无法直接用作 DROP/PAUSE/KEEP 决策依据。

**短期**：叶洋在 `MatchResume` actionObject 里手工映射成 `terminal / needs_human / flag_only`。

**中期**：陈洋在 ontology Neo4j schema 加 `gating_severity` 字段，让 snapshot 自动带出。

**owner**：叶洋 → 陈洋

### 8.6 hsm_feedback 数据源缺失

规则 10-28（亲属关系结果处理）、10-39（腾讯历史离场原因核实结果处理）等需要 HSM 之前对 humanTask 的反馈作为输入。当前**没有 humanTask 反馈持久化机制**。

**修复**：
- RAAS 新增 `getHsmFeedback({candidate_id, job_requisition_id})` API
- 或在 `getJobRequisition` 返回中带跟该候选人相关的反馈

**owner**：张元军

### 8.7 prompt token 长度与成本

单份 prompt 约 6-10K token（含 §1-6 + 20-30 条 rule）。日 RESUME_PROCESSED 事件量 ~100 份简历，对应 ~100 次 LLM 调用，token 量 ~1M input + 100K output。
- Claude Sonnet 4.6：~$3.2 / 天
- Kimi 2.6：~$1 / 天
- DeepSeek V4：~$0.3 / 天

成本不是问题。但需要跑黄金集对比 LLM 准确率后选模型。

### 8.8 LLM 输出稳定性

需要黄金集（每客户 30-50 份代表性简历 + 人工 label）评估准确率。准确率不达 90% 的规则要：
- 拆出来单独再跑一次
- 或换更强的模型
- 或 prompt 加 few-shot 示例

---

## 9. 上线 checklist

### 9.1 阻塞前置

| 任务 | Owner |
|------|-------|
| RAAS 在 `RESUME_DOWNLOADED` 中带 `job_requisition_id` 字段 | 张元军 |
| RAAS 增 `GET /api/v1/job-requisitions/:id` API | 张元军 |
| RAAS 增 `getHsmFeedback({candidate_id, jr_id})` API | 张元军 |
| RAAS DB `match_results` 表加 `rule_check_flags` JSON 列 | 张元军 |
| RAAS `saveMatchResults` 接受 `source: 'rule_check_drop'` 枚举值 | 张元军 |
| RAAS Job_Requisition schema 含 `client_business_group / client_studio / tags / age_range` | 张元军 + 陈洋 |
| ontology 增 `getRulesForMatchResume(client, bg, studio, tags)` API | 陈洋 |
| ontology Rule 节点加 `gating_severity` 字段（或叶洋手工映射）| 陈洋 / 叶洋 |
| `MatchResumeActionObject.getRuleCheckPrompt(args)` 实现 | 叶洋 |
| AO `lib/rule-check.ts` 实现 `runResumeRuleCheck()` | 雨函 |
| AO resumeParserAgent 透传 `job_requisition_id` 进 RESUME_PROCESSED | 雨函 |
| AO [match-resume-agent.ts](resume-parser-agent/lib/inngest/agents/match-resume-agent.ts) 改造（去 for 循环 + 加 rule check） | 雨函 |
| AO `lib/human-task.ts` 实现 `createHumanTask()`（PAUSE 路径用）| 雨函 |
| AO [client.ts](resume-parser-agent/lib/inngest/client.ts) `ResumeProcessedData` 加 `job_requisition_id` 字段 | 雨函 |

### 9.2 测试

- [ ] 黄金集准备：每客户（腾讯/字节/...）30-50 份代表性简历 + 人工 label 期望 decision
- [ ] LLM 准确率评估：跑黄金集，准确率 ≥ 90% 才上线
- [ ] 端到端 e2e：发 RESUME_PROCESSED → 验证 KEEP / DROP / PAUSE 三条路径都跑通
- [ ] 数据完整性：验证 RESUME_DOWNLOADED → RESUME_PROCESSED 透传 `job_requisition_id` 不丢

### 9.3 上线

- [ ] feature flag `RULE_CHECK_ENABLED` 默认 `false`
- [ ] 灰度：先 10% 流量，观察 1 周，再 50% → 100%
- [ ] 监控：rule check 准确率、LLM 调用延迟、DROP/PAUSE/KEEP 比例、Robohire 调用量减少幅度、单次匹配总耗时

---

## 10. 跟前置文档的关系

- [docs/match-resume-rule-check-prompt.md](docs/match-resume-rule-check-prompt.md) — **prompt 内容设计**：规则的自然语言描述、§3.1/§3.2 完整 rule 文本、KEEP/DROP/PAUSE 三个工作示例
- 本文档 — **prompt 生成流水线 + I/O 适配**：单 JD 流式调用、按维度过滤规则、跟现有 schema 适配的具体清单

两份文档配合使用：

| 角色 | 该读 |
|------|------|
| **叶洋** | 前文 §4（每条 rule 怎么写） + 本文 §3.4 / §3.5 / §7.1（prompt 怎么按维度组装） |
| **雨函** | 前文 §7（prompt 实例长什么样） + 本文 §4 / §7.3 / §5.3（runtime 怎么改 [match-resume-agent.ts](resume-parser-agent/lib/inngest/agents/match-resume-agent.ts)） |
| **陈洋** | 本文 §3.4 / §7.2 / §8.3 / §8.5（ontology API 要扩什么、severity 字段要补什么） |
| **张元军** | 本文 §5 / §7.4 / §7.5 / §8.1 / §8.2 / §8.3 / §8.6 / §9.1（RAAS 端要补什么字段和接口） |

---

*生成时间：2026-05-09（修订：澄清 Job_Requisition vs Generated JD，改为单 JD 线性流程）*
*维护人：matchResumeAgent owner（雨函） + Action layer owner（叶洋） + Ontology owner（陈洋） + RAAS owner（张元军）*
