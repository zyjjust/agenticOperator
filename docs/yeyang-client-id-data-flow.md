# client_id 全链路数据流 & 叶洋的 prompt 适配指南

> **致叶洋**:这份文档专门讲清楚 AO 工作流里 `client_id` 是怎么一路传过来的、各个阶段长什么样、最终我们交给你的 input 里这个字段是什么形态。然后告诉你 prompt 里要怎么用它去过滤 ontology 规则。
>
> **配套读**:
> - 输入/输出契约总览:[docs/yeyang-v4-adapter-spec.md](yeyang-v4-adapter-spec.md)
> - 工作流定义:[docs/workflow-agents-inngest-spec.md](workflow-agents-inngest-spec.md)
> - 三种决策事件设计:[docs/rule-check-end-to-end-workflow.md](rule-check-end-to-end-workflow.md)

---

## 0. 你读完这份文档能做什么

理解清楚之后,你的 `generatePrompt` / `fillRuntimeInput` 能:

1. **接收正确的 client 维度信息**(`client_id`、`business_group`、`studio`),不只是一个客户名字
2. **从 ontology 抓**正确的规则集 —— 通用 + 该客户 + 该部门相关
3. **拼装出**完整的 user prompt(INPUT + RULES + OUTPUT 三段)给我们
4. **不会因为字段映射误解**(比如把 `CLI_TENCENT` 当成"腾讯"匹配规则)而错过规则

---

## 1. client_id 是什么 — 三层语义

我们系统里"client"概念有**三个相关字段**,你必须分清:

| 字段 | 例子 | 用途 | 哪里来 |
|------|------|------|--------|
| `client_id` | `"CLI_TENCENT"` | RAAS 内部主键(系统标识符) | RAAS DB `clients` 表主键 |
| **`client_id_display`**(派生) | `"腾讯"` | ontology rule 的 `applicableClient` 字段匹配用 | 由 `client_id` 归一化得到 |
| `client_department_id` | `"CLI_TENCENT_PCG"` | RAAS 部门标识符 | RAAS DB `client_departments` 表主键 |
| **`business_group`**(派生) | `"PCG"` | ontology rule 的 `applicableDepartment` 字段匹配用 | 从 `client_department_id` 提取 |
| **`studio`**(可选,腾讯 IEG 特有) | `"天美"` | ontology rule 的 studio 维度过滤 | `job_requisition.client_studio` 字段 |

**关键**:**ontology 规则用的是中文名("腾讯"、"PCG"),不是系统 ID("CLI_TENCENT"、"CLI_TENCENT_PCG")**。所以你必须在我们传给你的 input 上**做归一化映射**,否则规则匹配不上。

---

## 2. 全链路:client_id 从哪来,怎么传到你这

```
┌─────────────────────────────────────────────────────────────────────┐
│ Stage 1:RAAS Dashboard(招聘专员上传候选人简历的 UI 界面)            │
│ ────────────────────────────────────────────────────────────────    │
│  招聘专员在 "上传简历" 弹框里选了一个具体 JD                          │
│  这个 JD 关联的 client_id / client_department_id 已经在 RAAS DB 里   │
│  RAAS Backend 把 client_id 写到 resume_upload_runtime 表             │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                           │ publish 事件
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Stage 2:RESUME_DOWNLOADED 事件(从 RAAS Inngest 推到 AO)             │
│ ────────────────────────────────────────────────────────────────    │
│  payload:                                                            │
│    upload_id, bucket, object_key, etag, mime_type, ...               │
│    operator_employee_id ← 招聘专员                                    │
│    client_id ← "CLI_TENCENT"  ★ 已经带上                              │
│    job_requisition_id ← "jr_x99"(关联的 JR,新加 feature)             │
│    received_at, source_event_name                                    │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Stage 3:AO resumeParserAgent(我们的)                                │
│ ────────────────────────────────────────────────────────────────    │
│  - 下载 PDF                                                           │
│  - 调 RAAS /api/v1/parse-resume → 得到 parsed.data(简历内容,         │
│    不含 client_id)                                                    │
│  - 调 RAAS /api/v1/candidates → 落库 (这步带 client_id 给 RAAS)       │
│  - emit RESUME_PROCESSED                                              │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Stage 4:RESUME_PROCESSED 事件(AO 内部,触发 matchResumeAgent)         │
│ ────────────────────────────────────────────────────────────────    │
│  payload:                                                            │
│    upload_id, candidate_id, resume_id, employee_id                   │
│    parsed: { data: <RaasParseResumeData> }  ← 简历内容                │
│    job_requisition_id  ← "jr_x99"  ★ 透传                            │
│    (注:client_id 不在 RESUME_PROCESSED 里,要从 JR 反查)              │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Stage 5:matchResumeAgent 准备阶段                                    │
│ ────────────────────────────────────────────────────────────────    │
│  - 从事件取出 job_requisition_id                                      │
│  - 调 RAAS /api/v1/requirements/jr_x99                               │
│    → 返回 { requirement, specification, ... }                         │
│  - requirement.client_id            = "CLI_TENCENT"  ★ ID            │
│  - requirement.client_department_id = "CLI_TENCENT_PCG"  ★ ID        │
│  - requirement.client_business_group = "PCG"  (扩展字段)             │
│  - requirement.client_studio = null (or "天美" if IEG)                │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Stage 6:★ 我们调你 ★                                                │
│ ────────────────────────────────────────────────────────────────    │
│  matchResumeAgent 在调你之前先做归一化:                                │
│                                                                       │
│    normalize_client(req.client_id):                                  │
│      "CLI_TENCENT" → "腾讯"                                           │
│      "CLI_BYTEDANCE" → "字节"                                         │
│      "CLI_HUAWEI" → "华为"                                            │
│                                                                       │
│    derive_business_group(req):                                       │
│      优先 req.client_business_group ("PCG")                           │
│      回退 deriveBgFromDepartmentId(req.client_department_id)          │
│        "CLI_TENCENT_PCG" → "PCG"                                      │
│        "CLI_TENCENT_IEG_TIANMEI" → "IEG"                              │
│                                                                       │
│  传给你的 input 里 client 字段:                                       │
│    {                                                                  │
│      name: "腾讯",                  ← 已归一化的中文名                │
│      business_group_code: "PCG",    ← 已提取的代码                    │
│      department_display: "互动娱乐事业群",  ← 可选,LLM evidence 用    │
│      studio: null                                                     │
│    }                                                                  │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Stage 7:★ 你的工作 ★                                                │
│ ────────────────────────────────────────────────────────────────    │
│  - 用 (name="腾讯", business_group_code="PCG", studio=null) 去       │
│    ontology 抓规则                                                    │
│  - 拼 INPUT + RULES + OUTPUT 三段 user prompt                         │
│  - 返回完整 prompt 字符串给我们                                       │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 3. 你收到的 input 完整 shape(示例)

`MatchResumeRuntimeInput`(详见 [docs/yeyang-v4-adapter-spec.md §2.1](yeyang-v4-adapter-spec.md))包含 5 个块:

```ts
{
  kind: "matchResume",

  // ─── ① runtime_context — 来自 RESUME_PROCESSED 事件透传 ───
  runtime_context: {
    upload_id: "upl_001_xxx",
    candidate_id: "cand_a3f1",
    resume_id: "res_001",
    employee_id: "EMP_REC_007",
    received_at: "2026-05-11T10:23:00Z",
    parsed_at: "2026-05-11T10:23:08Z",
    parser_version: "v7-pull-model@2026-05-08",
    trace_id: "trace_001_xxx",
  },

  // ─── ② client — ★ 已归一化好,你直接用 ──────────────────
  client: {
    name: "腾讯",                       // ★ ontology 规则 applicableClient 字段匹配用
    business_group_code: "PCG",          // ★ ontology 规则 applicableDepartment 匹配用
    department_display: "互动娱乐事业群",  // 可选,LLM evidence 引用用
    studio: null                          // 仅腾讯 IEG 类岗位会有"天美"等
  },

  // ─── ③ job (job_requisition) — RaasRequirement 完整对象 ───
  job: {
    job_requisition_id: "jr_x99",
    client_id: "CLI_TENCENT",                  // ← 系统 ID(我们已经在 client.name 里给你归一化版本了)
    client_department_id: "CLI_TENCENT_PCG",   // ← 系统 ID(已派生 business_group_code)
    client_job_id: "TC-FE-2026-001",
    client_job_title: "高级前端开发工程师",
    job_responsibility: "负责腾讯视频前端架构演进...",
    job_requirement: "5+ 年前端经验,精通 React 生态...",
    must_have_skills: ["React", "TypeScript", "Webpack"],
    nice_to_have_skills: ["Next.js", "GraphQL"],
    negative_requirement: "不接受外包从业经历超过 2 年",
    language_requirements: "CET-6 480 以上",
    city: "深圳",
    salary_range: "30k-50k",
    headcount: 2,
    work_years: 5,
    degree_requirement: "本科",
    education_requirement: "全日制",
    interview_mode: "线下",
    expected_level: "senior",
    recruitment_type: "正编",
    age_range: { min: 25, max: 40 },
    tags: [],
    client_business_group: "PCG",      // ★ 扩展字段(同 client.business_group_code)
    client_studio: null,                 // 扩展字段(仅 IEG 类有)
  },

  // ─── ④ job_requisition_specification — 优先级 / 截止 / HSM ID ───
  job_requisition_specification: {
    job_requisition_specification_id: "jrs_x99_001",
    hro_service_contract_id: "HSC_2026_TC_001",
    start_date: "2026-04-15",
    deadline: "2026-07-15",
    priority: "P1",
    is_exclusive: false,
    number_of_competitors: 3,
    status: "recruiting",
    hsm_employee_id: "EMP_HSM_001",          // ← 决定 humanTask 路由到谁
    recruiter_employee_id: "EMP_REC_007"
  },

  // ─── ⑤ resume — RaasParseResumeData ───
  resume: {
    name: "张三",
    email: "zhangsan@example.com",
    phone: "13800000000",
    location: "上海",
    birth_date: "1996-05-12",
    gender: "男",
    nationality: "中国",
    marital_status: "已婚已育",
    summary: "5 年高级前端经验,曾任阿里淘宝高级前端工程师",
    experience: [
      { title: "高级前端工程师", company: "阿里巴巴", ... },
      { title: "前端工程师", company: "字节跳动", ... }
    ],
    education: [ { degree: "本科", institution: "浙江大学", graduationYear: "2018" } ],
    skills: ["React", "TypeScript", "Node.js", "Webpack", "Vite", "Next.js"],
    languages: [{ language: "英语", proficiency: "CET-6 580" }],
    expected_salary_range: "35k-50k",
    outsourcing_acceptance: "接受",
    labor_form_preference: "正编",
    former_csi_employment: null,
    former_tencent_employment: null,
    gap_periods: [],
    conflict_of_interest: [],
  },

  // ─── ⑥ hsm_feedback — PAUSE 回流时非 null,首次匹配 null ───
  hsm_feedback: null
}
```

---

## 4. client_id 归一化逻辑(我们这边做,你不用管)

我们在调你之前会跑这段:

```ts
// resume-parser-agent/lib/agents/rule-check-agent.ts (我们维护)

function normalizeClientId(rawId: string): string {
  // 把 RAAS 系统 ID 转成 ontology 用的中文名
  if (!rawId) return '';
  if (rawId === '腾讯' || rawId === '字节' || rawId === '华为') return rawId;  // 已是中文
  const upper = rawId.toUpperCase();
  if (upper.includes('TENCENT'))   return '腾讯';
  if (upper.includes('BYTEDANCE')) return '字节';
  if (upper.includes('BYTE'))      return '字节';
  if (upper.includes('HUAWEI'))    return '华为';
  if (upper.includes('OPPO'))      return 'OPPO';
  if (upper.includes('XIAOMI'))    return '小米';
  return rawId;  // fallback
}

function deriveBgFromDepartmentId(deptId: string | null): string | null {
  if (!deptId) return null;
  const upper = deptId.toUpperCase();
  // CLI_TENCENT_PCG → "PCG"
  // CLI_TENCENT_IEG_TIANMEI → "IEG"  (studio 在 client.studio 单独传)
  // CLI_BYTEDANCE_TIKTOK → "TikTok"
  for (const bg of ['IEG', 'PCG', 'WXG', 'CDG', 'CSIG', 'TEG', 'TIKTOK']) {
    if (upper.includes(`_${bg}_`) || upper.endsWith(`_${bg}`)) {
      return bg === 'TIKTOK' ? 'TikTok' : bg;
    }
  }
  return null;
}
```

**所以你拿到 `client.name` 时已经是 `"腾讯"`,`client.business_group_code` 已经是 `"PCG"`** ——直接拿去匹配 ontology 规则就行。

---

## 5. 你要做什么:从 input 到 user prompt 的完整流程

### 5.1 从 client / business_group / studio 抓规则

```ts
// 你的 generatePrompt / fillRuntimeInput 内部应当这么用 client 字段
async function buildPrompt(input: MatchResumeRuntimeInput) {
  const { name, business_group_code, studio } = input.client;

  // 调 ontology API 抓规则(按维度过滤)
  const rules = await ontologyApi.getRulesForMatchResume({
    client_id: name,                  // "腾讯"
    business_group: business_group_code,  // "PCG"
    studio: studio,                    // null (or "天美")
    job_tags: input.job.tags ?? []
  });
  // 返回的规则应当只包括:
  //   1. applicableClient="通用" 的所有规则
  //   2. applicableClient="腾讯" 且 applicableDepartment ∈ {"N/A", "通用", "PCG", ...} 的规则
  //   3. 满足 job_tags 条件的规则

  // 然后拼 prompt 三段
  return assembleFullPrompt(input, rules);
}
```

### 5.2 你的产出 = 完整 user prompt 字符串

```
# Resume Pre-Screen Rule Check

## 1. 你的角色
(固定文案 — 告诉 LLM 它是预筛查员)

## 2. Inputs
(把 input 的 6 个块都 render 进来)

### 2.1 runtime_context
```json
{ ... input.runtime_context ... }
```

### 2.2 client
```
client_name: 腾讯
business_group_code: PCG
department_display: 互动娱乐事业群
studio: (无)
```

### 2.3 job
```json
{ ... input.job ... }
```

### 2.4 job_requisition_specification
```json
{ ... input.job_requisition_specification ... }
```

### 2.5 resume
```json
{ ... input.resume ... }
```

### 2.6 hsm_feedback
```json
{ ... input.hsm_feedback ... }  // 通常是 null
```

## 3. Rules to check
(从 ontology 抓的所有 applicable 规则,按"通用 / 客户级 / 部门级"三组排版)

### 3.1 通用规则 (CSI 级 — N 条)
#### 规则 10-X:<name> [终止级/需人工/仅记录]
**触发条件**:...
**判定逻辑**:...
**命中时的输出动作**:
- 在 rule_flags 加 {...}
- drop_reasons 加 "10-X:<short_code>"

### 3.2 客户级规则 (本次 client_id="腾讯" — N 条)
(同样格式)

### 3.3 部门级规则 (本次 business_group="PCG" — N 条)
(同样格式)

## 4. 决策结算逻辑
(固定文案)

## 5. 输出格式
(LLM 必须返回的 JSON schema)

## 6. 提交前自检
(固定 checklist)
```

### 5.3 我们调你的方式

```ts
// 我们 (matchResumeAgent / preScreenAgent wrapper) 这边的代码
const userPrompt: string = await yeyangBuildPrompt(runtimeInput);

// 直接喂 LLM —— 我们不修改、不拼接、不补充
const response = await llmGateway.complete({
  system: '你是简历预筛查员...',
  user: userPrompt,                     // ← 你的产出
  response_format: { type: 'json_object' },
  temperature: 0.1,
});

const result = JSON.parse(response.text) as RuleCheckResult;
```

---

## 6. 我们期待 LLM 输出的 JSON

**所有 user prompt 的 §5 OUTPUT 段都必须告诉 LLM 输出这个结构**(每个 rule_flag 引用 `runtime_context.candidate_id` 等 input 字段做 evidence):

```json
{
  "candidate_id": "cand_a3f1",
  "job_requisition_id": "jr_x99",
  "client_id": "腾讯",
  "overall_decision": "KEEP" | "DROP" | "PAUSE",
  "drop_reasons": ["10-17:high_risk_reflux"],
  "pause_reasons": ["10-25:huawei_under_3mo"],
  "rule_flags": [
    {
      "rule_id": "10-25",
      "rule_name": "华为荣耀竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS" | "FAIL" | "REVIEW" | "NOT_APPLICABLE",
      "evidence": "引用 resume.experience 或 job 原文",
      "next_action": "continue" | "block" | "pause" | "notify_recruiter" | "notify_hsm"
    }
    // ... 每条 applicable 规则一项
  ],
  "resume_augmentation": "",   // 本设计中不使用,保留字段兼容
  "notifications": [
    {
      "recipient": "HSM",
      "channel": "Email",
      "rule_id": "10-25",
      "message": "...具体说明..."
    }
  ]
}
```

---

## 7. 关键约定 — 你的 prompt 必须告诉 LLM 这些

### 7.1 client / business_group 怎么用

LLM 看到 prompt 里 `client.name="腾讯"`、`business_group_code="PCG"` 后,应当:
- 把"通用"规则全部跑一遍
- 把 `applicable_client="腾讯"` 的客户级规则跑一遍
- 部门级规则:
  - 如果规则的 `applicableDepartment="N/A"` 或 `"通用"` → 跑
  - 如果 `applicableDepartment="PCG"` 或包含 "PCG"(如 "IEG、PCG、WXG、CSIG、TEG、S线") → 跑
  - 否则跳过(标 NOT_APPLICABLE)
- studio 维度同理

### 7.2 evidence 写法约定

每条 `rule_flags[i].evidence` 必须引用 input 里的具体内容:
- ✅ "候选人 2023-06 至 2026-04 在华为任职,离职距今 1.5 月,< 3 月冷冻期"
- ❌ "候选人有华为经历"(太泛,不算 evidence)
- ❌ "符合规则要求"(没引用原文)

### 7.3 NOT_APPLICABLE vs PASS 的区分

- **NOT_APPLICABLE**:规则的触发条件不满足(如规则只对腾讯生效,但本次是字节)→ 标 NOT_APPLICABLE
- **PASS**:规则的触发条件满足,但候选人没违反 → 标 PASS

例:候选人没有华为经历,跑规则 10-25 "华为竞对冷冻期":
- 规则 applicableClient="通用",触发条件 = "候选人简历已完成解析,工作经历数据已结构化",这条**满足**(简历解析完了)
- 但候选人没有华为经历,所以没命中规则的判定逻辑
- 应当标 `PASS`(规则被检查了,候选人不违反),不是 `NOT_APPLICABLE`

---

## 8. 测试用例 — 你跑这个 mock 后把生成的 prompt 发我们

请用下面这个 mock input 跑一遍 `fillRuntimeInput(matchResumeActionObject, TEST_INPUT)`,把输出发给我们,我们用 LLM 真跑一遍验证准确率:

```ts
const TEST_INPUT: MatchResumeRuntimeInput = {
  kind: 'matchResume',
  runtime_context: {
    upload_id: 'upl_test_001',
    candidate_id: 'c01-zhangsan',
    resume_id: 'res_001',
    employee_id: 'EMP_REC_007',
    received_at: '2026-05-11T10:23:00Z',
    parsed_at: '2026-05-11T10:23:08Z',
    parser_version: 'v7-pull-model@2026-05-08',
    trace_id: 'trace_001',
  },
  client: {
    name: '腾讯',
    business_group_code: 'IEG',
    department_display: '互动娱乐事业群',
    studio: '天美',
  },
  job: {
    job_requisition_id: 'jr_z77',
    client_id: 'CLI_TENCENT',
    client_department_id: 'CLI_TENCENT_IEG_TIANMEI',
    client_job_title: '游戏服务端开发工程师',
    must_have_skills: ['C++', 'Lua'],
    nice_to_have_skills: ['UnrealEngine', 'Redis'],
    salary_range: '35k-60k',
    age_range: { min: 22, max: 35 },
    job_responsibility: '天美工作室游戏服务端...',
    job_requirement: '3+ 年游戏服务端经验',
    client_business_group: 'IEG',
    client_studio: '天美',
    tags: [],
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
    name: '赵六',
    skills: ['C++', 'Lua', 'Redis', 'Protobuf', 'UnrealEngine'],
    experience: [
      {
        title: '游戏后端工程师',
        company: '某游戏公司',
        startDate: '2025-03',
        endDate: '2026-04',
      },
      {
        title: '资深游戏工程师',
        company: '腾讯',
        startDate: '2019-08',
        endDate: '2025-02',
        description: '腾讯 IEG 天美工作室,《王者荣耀》后端',
      },
    ],
    education: [
      { degree: '硕士', field: '计算机科学', institution: '北京大学', graduationYear: '2019' },
    ],
    expected_salary_range: '45k-58k',
    former_tencent_employment: {
      company: '腾讯',
      business_group: 'IEG',
      studio: '天美',
      employment_type: '正式',
      start_date: '2019-08',
      end_date: '2025-02',
      leave_type: '主动离场',
    },
  },
  hsm_feedback: null,
};

const ready = fillRuntimeInput(matchResumeActionObject, TEST_INPUT);
console.log(ready.prompt);
```

**预期 prompt 里能看到的内容**(用来自查你的实现正确):

1. **§2.2 client 段**显示:
   ```
   client_name: 腾讯
   business_group_code: IEG
   department_display: 互动娱乐事业群
   studio: 天美
   ```

2. **§3.3 部门级规则** 应当**激活以下规则**(因为 business_group=IEG + studio=天美):
   - 10-3 IEG 活跃流程候选人改推拦截 [终止级]
   - 10-40 腾讯主动离职人员紧急回流审核(IEG 在列表内)
   - 10-43 IEG 工作室回流候选人互斥标记(天美在 4 大工作室)
   - 10-52 IEG 内部技术面试强制校验

3. **§3.3 部门级规则**应当**不出现**:
   - 10-42 CDG 6 个月冷冻期(不是 CDG)
   - 10-53 非 IEG 跳过技面(本次是 IEG)
   - 字节相关规则(不是字节客户)

4. **§5 输出格式段**:应当包含完整的 `{"overall_decision": ..., "rule_flags": [...], ...}` JSON schema 定义

如果你的产出符合上面预期,我们这边一接就能跑通。

---

## 9. 总结 — 你 6 个 todo

| # | 任务 | 详情 |
|---|------|------|
| 1 | 扩展 `MatchResumeRuntimeInput` 加 3 个新字段 | `runtime_context` / `job_requisition_specification` / `hsm_feedback`(见 [yeyang-v4-adapter-spec.md §2.1](yeyang-v4-adapter-spec.md))|
| 2 | 扩展 `ClientSlot` 加新字段 | `business_group_code` / `department_display` / `studio`(本文 §4)|
| 3 | 验证 / 补全 OUTPUT 段在 snapshot 里 | 见 [yeyang-v4-adapter-spec.md §3](yeyang-v4-adapter-spec.md)|
| 4 | 内部规则过滤逻辑用 `client.name` + `business_group_code` + `studio` | 本文 §7.1 |
| 5 | prompt §3 RULES 段告诉 LLM evidence 写法约定 | 本文 §7.2 |
| 6 | prompt §3 RULES 段明确 NOT_APPLICABLE vs PASS 的区分 | 本文 §7.3 |

**完成后跑一遍 §8 的 TEST_INPUT,把生成的 prompt 发给我们 (AO 团队)**。

---

## 10. 这里跟你直接相关的 ontology 数据源

| 你需要的字段 | 数据源 | 例子 |
|-------------|--------|------|
| `applicableClient` | `ontology actions.matchResume.business_logic_rules[i].applicableClient` | `"通用"` / `"腾讯"` / `"字节"` |
| `applicableDepartment` | 同上,`.applicableDepartment` | `"N/A"` / `"通用"` / `"IEG"` / `"IEG、PCG、WXG、CSIG、TEG、S线"` |
| `executor` | 同上,`.executor` | `"Agent"`(只取这种)/ `"Human"`(跳过)|
| `standardizedLogicRule` | 同上,`.standardizedLogicRule` | 自然语言段落,放进 prompt §3 |
| `submissionCriteria` | 同上,`.submissionCriteria` | 触发条件,放进 prompt §3 每条规则的"触发条件"小段 |

---

## 11. 有任何问题,联系流程

| 问题类型 | 先看 | 再问 |
|---------|------|------|
| 字段语义 / shape 不清楚 | 本文 §3 / [yeyang-v4-adapter-spec.md](yeyang-v4-adapter-spec.md) | AO 团队 (我们) |
| client_id 归一化看不懂 | 本文 §4 | AO 团队 |
| ontology 规则查询不到 / API 报错 | ontology-lab 文档 | 陈洋 |
| 工作流上下文 / 事件链 | [docs/rule-check-end-to-end-workflow.md](rule-check-end-to-end-workflow.md) | AO 团队 |
| 测试用例跑不出预期 prompt | 本文 §8 | AO 团队 |

---

*生成时间:2026-05-11*
*维护:Agentic Operator 团队*
