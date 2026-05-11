# AO ↔ 叶洋 V4 `generatePrompt` 完整适配指南

> **致叶洋**:这份文档把你需要知道的全部内容合并在一处。读完之后,你能:
> - 理解我们 AO 工作流里 client_id 怎么传过来的、最终交给你时长什么样
> - 知道你的 v4 `generatePrompt` / `fillRuntimeInput` 要做哪些改动 (3 处 P0)
> - 拿到完整的 input contract / output schema / 集成代码 / 验收用例
> - 知道改完之后怎么自查、出问题找谁
>
> **总周期估计**:你 1-1.5 天 + 我们 1 天 = ~3 天接入完成

---

## ⚠️ 边界澄清 (最重要,先读)

你的产出 = **1 个完整的 user prompt 字符串**(含 INPUT + RULES + OUTPUT 三段),直接喂给 LLM 的 user message。我们 AO 这边拿到后**不解析、不修改、不补充、不拼接**:

```
叶洋(拼 prompt)  →  完整 user prompt (string)  →  AO/我们  →  llm.complete({ user: <这段> })
                                                                  │
                                                                  ▼
                                                         ruleCheckAgent 判定
                                                         ★ 二元状态:PASS / FAIL ★
                                                                  │
                                                ┌─────────────────┴─────────────────┐
                                                ▼ PASS                              ▼ FAIL
                                       call RAAS API Server                  emit RULE_CHECK_FAILED
                                       (RAAS 内部调 Robohire                  写 blacklist (含 LLM 推理依据)
                                        深度匹配)                              终止当前匹配流程
```

**关键含义**:
1. **OUTPUT 段(JSON schema + 决策逻辑 + 自检)必须在你的 snapshot 里**。我们这边没有兜底机制可以 append。如果 snapshot 缺这段,整条链路废
2. **OUTPUT schema 字段必须能无损映射到下游事件 payload**(LLM 输出的 `failure_reasons` / `rule_flags` 等字段会直接进 `RULE_CHECK_FAILED` 事件 payload)
3. **任何 prompt bug 都是单点**。我们不能 hotfix,必须由你重新 gen snapshot 或扩展 fill 逻辑修复

⟶ 这意味着 **§5 OUTPUT 段在 snapshot 里**是所有 P0 中最阻塞的一项。开工前请第一时间 grep 验证。

---

## 1. 整体工作流上下文

### 1.1 我们想干什么

在 `matchResumeAgent` 调 Robohire 深度匹配**之前**插入一层 LLM 规则预筛,过滤掉**明显不合格**的简历(命中黑名单 / 硬性要求一票否决 / 客户红线)。通过的简历正常调 Robohire;不通过的进 blacklist 或人工复核。

**好处**:
- 减少无谓的 Robohire 配额消耗(预计减少 30-60%)
- 客户红线 / 黑名单逻辑由我们自己 ontology 控制(可演化)
- 关键决策有审计 / event 可追溯

### 1.2 你的产出在工作流里的位置

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
      │     └─ hsm_feedback = getHsmFeedback(...)  [可选,默认 null;未来支持 HSM 解封 blacklist 时填充]
      │
      ├─ Step B: ★★★ 你的代码在这里 ★★★
      │     ├─ runtimeInput = 把 Step A 数据拼成 MatchResumeRuntimeInput
      │     ├─ ready = fillRuntimeInput(matchResumeActionObject, runtimeInput)  ← 你的
      │     │     ↓
      │     │     ready.prompt = 完整 markdown user prompt
      │     │
      │     ├─ response = llmGateway.complete({ system, user: ready.prompt, ... })
      │     └─ result = JSON.parse(response.text) as RuleCheckResult         ← 输出契约见 §5
      │
      └─ Step C: 按 result.overall_decision 二元路由
            ├─ PASS → 调 RAAS matchResume(原始 resume + jd) + emit MATCH_PASSED_NEED_INTERVIEW
            │           ↑ 完全复用现有 matchResumeAgent 逻辑,不改
            │
            └─ FAIL → 写 blacklist(含 LLM 推理依据 + 命中规则 ID)
                       + emit RULE_CHECK_FAILED
                       ↑ 终止流程,不调 Robohire
```

### 1.3 三方角色边界

| 角色 | 干啥 |
|------|------|
| **叶洋** | Neo4j 抓规则 → 拼 user prompt(INPUT + RULES + OUTPUT 三段合并)→ 给我们 |
| **AO/我们 (matchResumeAgent)** | 收 user prompt → 喂 LLM → 解析 JSON → 二元路由(PASS 继续 / FAIL 写 blacklist + emit 事件)|
| **RAAS API Server** | 我们调它,它内部调 Robohire 深度匹配。RAAS 团队负责,跟你和我们的 prompt 工作流无关 |
| **Robohire** | 在 RAAS 内部被调,我们和你都不直接接触 |

**核心契约边界**:
- **你负责**:接收 `MatchResumeRuntimeInput` → 输出能让 LLM 产生合法 `RuleCheckResult` JSON 的 prompt
- **我们负责**:把 RESUME_PROCESSED 数据组装成 `MatchResumeRuntimeInput`、调 LLM、解析 JSON、按 LLM 二元决策路由 — PASS 时调 RAAS API Server / FAIL 时写 blacklist + emit `RULE_CHECK_FAILED`
- **完全不交叉**:你不需要碰 LLM 调用 / Inngest / RAAS API;我们不需要碰 ontology / 占位符 / prompt 渲染逻辑

---

## 2. client_id 全链路数据流 (重点)

### 2.1 三层语义概念

我们系统里"client"概念有**多个相关字段**,你必须分清:

| 字段 | 例子 | 用途 | 哪里来 |
|------|------|------|--------|
| `client_id` | `"CLI_TENCENT"` | RAAS 内部主键(系统标识符)| RAAS DB `clients` 表主键 |
| **`client_id_display`**(派生)| `"腾讯"` | ★ ontology rule 的 `applicableClient` 字段匹配用 | 由 `client_id` 归一化得到 |
| `client_department_id` | `"CLI_TENCENT_PCG"` | RAAS 部门标识符 | RAAS DB `client_departments` 表主键 |
| **`business_group`**(派生)| `"PCG"` | ★ ontology rule 的 `applicableDepartment` 字段匹配用 | 从 `client_department_id` 提取 |
| **`studio`**(可选,腾讯 IEG 特有)| `"天美"` | ontology rule 的 studio 维度过滤 | `job_requisition.client_studio` |

**关键**:**ontology 规则用的是中文名("腾讯"、"PCG"),不是系统 ID("CLI_TENCENT"、"CLI_TENCENT_PCG")**。我们已经在调你之前**做好归一化映射**,所以你拿到的 `client.name` 直接就是 `"腾讯"`,`client.business_group_code` 直接就是 `"PCG"`。

### 2.2 从 RAAS 到你的 7 阶段流程图

```
┌─────────────────────────────────────────────────────────────────────┐
│ Stage 1:RAAS Dashboard (招聘专员上传简历的 UI)                       │
│  招聘专员选了具体 JD → 这个 JD 关联的 client_id 已在 RAAS DB         │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────────┐
│ Stage 2:RESUME_DOWNLOADED 事件 (RAAS → AO)                           │
│  payload: { upload_id, client_id: "CLI_TENCENT", job_requisition_id }│
└──────────────────────────┬──────────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────────┐
│ Stage 3:AO resumeParserAgent                                         │
│  - 下载 PDF, parse, saveCandidate (带 client_id)                     │
│  - emit RESUME_PROCESSED                                              │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────────┐
│ Stage 4:RESUME_PROCESSED 事件 (内部,触发 matchResumeAgent)            │
│  payload: { candidate_id, parsed.data, job_requisition_id, ... }     │
│  (注:client_id 不在这,需要从 JR 反查)                                │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────────┐
│ Stage 5:matchResumeAgent 准备阶段                                    │
│  - 调 RAAS /api/v1/requirements/jr_x99 → { requirement, spec }       │
│  - requirement.client_id = "CLI_TENCENT"                              │
│  - requirement.client_department_id = "CLI_TENCENT_PCG"               │
│  - requirement.client_business_group = "PCG"                          │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────────┐
│ Stage 6:★ 我们调你之前的归一化 ★                                    │
│  normalize_client("CLI_TENCENT") → "腾讯"                            │
│  derive_business_group("CLI_TENCENT_PCG") → "PCG"                    │
│                                                                       │
│  传给你的 input.client:                                               │
│    { name: "腾讯", business_group_code: "PCG",                       │
│      department_display: "互动娱乐事业群", studio: null }             │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────────┐
│ Stage 7:★ 你的工作 ★                                                │
│  - 用 (name, business_group_code, studio) 去 ontology 抓规则          │
│  - 拼 INPUT + RULES + OUTPUT 三段 user prompt                         │
│  - 返回完整 prompt 字符串给我们                                       │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.3 我们做的归一化逻辑(你不用管,只是让你知道)

```ts
// 我们 (matchResumeAgent / preScreenAgent wrapper) 维护:

function normalizeClientId(rawId: string): string {
  if (!rawId) return '';
  if (rawId === '腾讯' || rawId === '字节' || rawId === '华为') return rawId;
  const upper = rawId.toUpperCase();
  if (upper.includes('TENCENT'))   return '腾讯';
  if (upper.includes('BYTEDANCE') || upper.includes('BYTE')) return '字节';
  if (upper.includes('HUAWEI'))    return '华为';
  if (upper.includes('OPPO'))      return 'OPPO';
  if (upper.includes('XIAOMI'))    return '小米';
  return rawId;
}

function deriveBgFromDepartmentId(deptId: string | null): string | null {
  if (!deptId) return null;
  const upper = deptId.toUpperCase();
  // "CLI_TENCENT_PCG" → "PCG"
  // "CLI_TENCENT_IEG_TIANMEI" → "IEG"
  // "CLI_BYTEDANCE_TIKTOK" → "TikTok"
  for (const bg of ['IEG', 'PCG', 'WXG', 'CDG', 'CSIG', 'TEG', 'TIKTOK']) {
    if (upper.includes(`_${bg}_`) || upper.endsWith(`_${bg}`)) {
      return bg === 'TIKTOK' ? 'TikTok' : bg;
    }
  }
  return null;
}
```

**所以你拿到 `client.name = "腾讯"` 时直接用,不需要再做映射。**

---

## 3. 你收到的 input 完整 shape

### 3.1 5 个数据块结构

`MatchResumeRuntimeInput` 包含 5 个块,各自对应 production 系统中的一个数据来源:

| Sub-section | 来源 | 字段定义 |
|-------------|------|---------|
| **2.1 runtime_context** | `RESUME_PROCESSED` 事件 | upload_id / candidate_id / resume_id / employee_id / parsed_at / trace_id 等 |
| **2.2 client** | 我们归一化后给你 | name / business_group_code / department_display / studio |
| **2.3 job_requisition** | RAAS `getRequirementDetail.requirement` | `RaasRequirement` 完整字段 |
| **2.4 job_requisition_specification** | RAAS `getRequirementDetail.specification` | priority / deadline / hsm_employee_id 等 |
| **2.5 resume** | `RESUME_PROCESSED.parsed.data` | `RaasParseResumeData` 完整字段 |
| **2.6 hsm_feedback** | RAAS `getHsmFeedback(...)` | 历史 HSM 反馈,通常 null |

### 3.2 完整 input 示例 (实际数据)

```ts
{
  kind: "matchResume",

  // ─── ① runtime_context ───
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

  // ─── ② client (★ 已归一化好,你直接用) ───
  client: {
    name: "腾讯",                       // ★ ontology 规则 applicableClient 匹配用
    business_group_code: "PCG",          // ★ ontology 规则 applicableDepartment 匹配用
    department_display: "互动娱乐事业群",
    studio: null
  },

  // ─── ③ job (RaasRequirement 完整对象) ───
  job: {
    job_requisition_id: "jr_x99",
    client_id: "CLI_TENCENT",
    client_department_id: "CLI_TENCENT_PCG",
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
    interview_mode: "线下",
    expected_level: "senior",
    recruitment_type: "正编",
    age_range: { min: 25, max: 40 },
    tags: [],
    client_business_group: "PCG",
    client_studio: null
  },

  // ─── ④ job_requisition_specification ───
  job_requisition_specification: {
    job_requisition_specification_id: "jrs_x99_001",
    hro_service_contract_id: "HSC_2026_TC_001",
    start_date: "2026-04-15",
    deadline: "2026-07-15",
    priority: "P1",
    is_exclusive: false,
    number_of_competitors: 3,
    status: "recruiting",
    hsm_employee_id: "EMP_HSM_001",        // ← FAIL 时 emit 事件 payload 带这个,便于后续 HSM 接管
    recruiter_employee_id: "EMP_REC_007"
  },

  // ─── ⑤ resume (RaasParseResumeData) ───
  resume: {
    name: "张三",
    email: "zhangsan@example.com",
    phone: "13800000000",
    location: "上海",
    birth_date: "1996-05-12",
    gender: "男",
    nationality: "中国",
    marital_status: "已婚已育",
    summary: "5 年高级前端经验...",
    experience: [
      { title: "高级前端工程师", company: "阿里巴巴", ... },
      { title: "前端工程师", company: "字节跳动", ... }
    ],
    education: [{ degree: "本科", institution: "浙江大学", graduationYear: "2018" }],
    skills: ["React", "TypeScript", "Node.js", "Webpack", "Vite", "Next.js"],
    languages: [{ language: "英语", proficiency: "CET-6 580" }],
    expected_salary_range: "35k-50k",
    outsourcing_acceptance: "接受",
    labor_form_preference: "正编",
    former_csi_employment: null,
    former_tencent_employment: null,
    gap_periods: []
  },

  // ─── ⑥ hsm_feedback (通常 null) ───
  hsm_feedback: null
}
```

### 3.3 必须改的 3 项 (P0)

#### P0-1:扩展 `MatchResumeRuntimeInput` 加 3 个顶层字段

请加在 `lib/ontology-gen/v4/runtime-input.types.ts`:

```ts
export interface MatchResumeRuntimeInput {
  kind: "matchResume";

  // ─── 已有字段(保持) ───
  client: ClientSlot;
  job:    Record<string, unknown> & { job_requisition_id: string };
  resume: Record<string, unknown> & { candidate_id: string };

  // ─── ★ 新增 3 个字段 ───

  /** 来自 RESUME_PROCESSED 事件的 anchor / metadata。 */
  runtime_context: {
    upload_id: string;
    candidate_id: string;
    resume_id: string;
    employee_id: string;
    parsed_at?: string;
    parser_version?: string;
    trace_id?: string | null;
    request_id?: string | null;
    received_at?: string;
    bucket?: string;
    object_key?: string;
    [k: string]: unknown;
  };

  /** 来自 RAAS getRequirementDetail.specification。 */
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

  /** 来自 RAAS getHsmFeedback。当前二元决策下默认 null;预留给未来 HSM 解封 blacklist 重跑场景用。 */
  hsm_feedback?: {
    kin_relation_result?: '存在利益冲突' | '无利益冲突-同部门' | '无利益冲突-非同部门' | null;
    tencent_history_leave_result?: '主动离场' | '淘汰退场' | '非淘汰退场' | null;
    reflux_cert_uploaded?: boolean;
    [k: string]: unknown;
  } | null;
}
```

#### P0-2:扩展 `ClientSlot` 加新字段

```ts
/** 客户字段 — 同时给代码(rule 维度过滤匹配用) + 中文名(LLM evidence 引用用) */
export interface ClientSlot {
  name: string;                       // 例: "腾讯" — ontology 规则 applicableClient 字段匹配用
  business_group_code?: string;        // 例: "IEG" / "PCG" / "CDG" — ontology 规则 applicableDepartment 用
  department_display?: string;         // 例: "互动娱乐事业群" — LLM evidence 引用用
  studio?: string;                     // 例: "天美" — 仅腾讯 IEG 类有
}
```

#### P0-3:验证 / 补全 OUTPUT 段在 snapshot 里 (★ 最关键 P0)

执行 quick verification:

```bash
npm run gen:v4-snapshot -- --action matchResume --domain RAAS-v1
grep -E '## 输出格式|## 决策结算逻辑|overall_decision|failure_reasons' generated/v4/match-resume.action-object.ts
```

**如果 grep 有结果**:确认输出 schema 跟我们 §5 是否一致;如果有出入,告知我们具体差异
**如果 grep 没结果**:snapshot 缺 OUTPUT 段,**整条链路废**。两种解法:
- (a) 推 ontology 在 matchResume Action 的 `outputs` 字段加 schema 定义
- (b) 在 `fillRuntimeInput` 之后追加我们 §5 给的 OUTPUT 段(短期方案,但不优雅)

---

## 4. 你的 user prompt 结构(三段式)

完整 user prompt 由三大块组成:

```markdown
# Resume Pre-Screen Rule Check

## 1. 你的角色
(固定文案 — 告诉 LLM 它是预筛查员)

## 2. Inputs        ← 动态注入
### 2.1 runtime_context
### 2.2 client
### 2.3 job
### 2.4 job_requisition_specification
### 2.5 resume
### 2.6 hsm_feedback

## 3. Rules to check  ← 动态(按维度过滤后的规则)
### 3.1 通用规则 (CSI 级)
### 3.2 客户级规则 (本次 client_id="腾讯")
### 3.3 部门级规则 (本次 business_group="PCG")

## 4. 决策结算逻辑  ← 固定
## 5. 输出格式      ← 固定 JSON schema (★ 必须有)
## 6. 提交前自检    ← 固定
```

### 4.1 占位符设计

按你已规划好的扩展模式(user guide §234-251),建议这几个占位符:

```ts
// lib/ontology-gen/v4/placeholders.ts
export const PLACEHOLDER_RUNTIME_CONTEXT = "{{RUNTIME_CONTEXT}}";
export const PLACEHOLDER_SPEC            = "{{SPEC}}";
export const PLACEHOLDER_HSM_FEEDBACK    = "{{HSM_FEEDBACK}}";
// (现有 {{CLIENT}}, {{JOB}}, {{RESUME}} 保留)

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

### 4.2 `fillRuntimeInput` 扩展处理逻辑

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

保留你现有的 reverse-order 替换(防 `{{...}}` 字面值冲突)逻辑。

---

## 5. OUTPUT 段必须告诉 LLM 的 JSON Schema

### 5.1 LLM 的二元决策直接驱动两个事件(必须在 prompt 里讲清楚)

**这是叶洋 prompt 设计的关键点**:LLM 的 `overall_decision` 字段直接决定下游 emit 哪个 ontology 事件。**Prompt 必须明确告诉 LLM 它的决策有这种 downstream 影响**:

```
LLM 输出 overall_decision   →   AO 这边 emit 的事件   →   下游行为
─────────────────────────────────────────────────────────────────────
"PASS"                       →   RULE_CHECK_PASSED    →   matchResumeAgent 继续调
                                                          RAAS API Server →
                                                          Robohire 深度匹配评分
"FAIL"                       →   RULE_CHECK_FAILED    →   候选人加入 blacklist,
                                                          终止当前匹配流程,
                                                          不调 Robohire
```

**因此你的 prompt §1 角色段必须包含类似这段**:

```
你是简历预筛查员。判断候选人简历是否值得交给 Robohire 做深度匹配。
你的决策直接驱动两个事件:
- 输出 overall_decision="PASS" → 系统会 emit RULE_CHECK_PASSED 事件 →
  matchResumeAgent 调 Robohire 做深度匹配评分
- 输出 overall_decision="FAIL" → 系统会 emit RULE_CHECK_FAILED 事件 →
  候选人加入 blacklist,流程终止,不调 Robohire

所以你的 PASS / FAIL 判断必须有充分依据 — 错判 PASS 会浪费 Robohire 配额
+ 让本应被红线拦截的候选人继续走流程;错判 FAIL 会让合格候选人被误拒。
两类错误代价不对称:在不确定时,倾向标 FAIL 比标 PASS 更保险。
```

### 5.2 OUTPUT 段完整 JSON Schema

````markdown
## 输出格式

返回严格符合下列结构的 JSON,不允许多余字段,不允许遗漏字段:

```json
{
  "candidate_id": "<from runtime_context.candidate_id>",
  "job_requisition_id": "<from job.job_requisition_id>",
  "client_id": "<from client.name>",
  "overall_decision": "PASS" | "FAIL",
  "failure_reasons": ["<rule_id>:<short_code>"],   // PASS 时为空数组,FAIL 时列出命中的规则
  "rule_flags": [
    {
      "rule_id": "10-25",
      "rule_name": "华为荣耀竞对与客户互不挖角红线",
      "applicable_client": "通用" | "<client>",
      "severity": "terminal" | "needs_human" | "flag_only",
      "applicable": true | false,
      "result": "PASS" | "FAIL" | "NOT_APPLICABLE",
      "evidence": "<引用 resume 或 job 原文字段>",
      "reasoning": "<LLM 的判定推理过程,1-2 句话>"
    }
  ],
  "summary": "<整体推理摘要,2-3 句话,用于写 blacklist.summary 字段;PASS 时可简短>"
}
```

## 决策结算逻辑

跑完全部 applicable 规则后:
1. 任一 `rule_flags[i].result == "FAIL"` → `overall_decision = "FAIL"` → 系统 emit `RULE_CHECK_FAILED`
2. 否则 → `overall_decision = "PASS"` → 系统 emit `RULE_CHECK_PASSED`

**核心简化**:之前设计有 KEEP/DROP/PAUSE 三态(含人工复核挂起路径),现在改为二元 PASS/FAIL。
- PASS:候选人通过预筛,emit `RULE_CHECK_PASSED` → matchResumeAgent 调 Robohire 深度匹配
- FAIL:候选人未通过(命中任一终止级 / 需人工 / 软性违反的规则都归入 FAIL),emit `RULE_CHECK_FAILED` → 进 blacklist 终态,**不调 Robohire**
- 后续如果 HSM 要解封 blacklist,走另一个流程,不在本设计内

无论决策哪个,`rule_flags` 必须覆盖 §RULES 中**每一条**规则(不适用的写 NOT_APPLICABLE)。

## 提交前自检

- [ ] rule_flags 覆盖所有规则(不适用写 NOT_APPLICABLE)
- [ ] overall_decision = "FAIL" 时 failure_reasons 必须非空;overall_decision = "PASS" 时 failure_reasons 必须空数组
- [ ] 每条 evidence 引用简历或 JD 原文,简历未提供时写"简历未提供 <字段>,标 NOT_APPLICABLE"
- [ ] 不要给候选人打 matching score(这是下游 Robohire 的工作)
````

**重要**:OUTPUT schema 字段直接进我们 emit 的事件 payload(`RULE_CHECK_PASSED` / `RULE_CHECK_FAILED`),所以字段命名 + 类型必须稳定。任何变动告诉我们。

---

## 6. Ontology 数据文件改动 — 你需要知道的部分

为了让 LLM 的 `RULE_CHECK_PASSED` / `RULE_CHECK_FAILED` 决策能被 EM gateway 接受、能 emit 出去、能被下游消费,**ontology 三个数据文件都要改**。改动总成本 ~34 行,**陈洋负责改 ontology repo,你只需要知情**(因为你的 codegen 会读这些数据)。

### 6.1 改动总览

| 文件 | 改动 | 改动量 | 谁改 |
|------|------|--------|------|
| `events_*.json` | 🔴 **新增 2 个事件定义** | ~30 行 | 陈洋(ontology owner) |
| `workflow_*.json` | 🟡 matchResume.triggered_event 数组追加 2 项 | ~2 行 | 陈洋 |
| `actions_*.json` | 🟡 matchResume.triggered_event 数组追加 2 项 | ~2 行 | 陈洋 |

**1 个 atomic PR,~34 行,一次合并** —— 三个文件互相引用,中间状态混乱。

### 6.2 `events_*.json` 改动详情

新增 2 条 event 定义:

```jsonc
{
  "name": "RULE_CHECK_PASSED",
  "description": "候选人简历通过 LLM 规则预筛(无终止级规则命中),允许进入 Robohire 深度匹配评分。",
  "payload": {
    "source_action": "matchResume",
    "event_data": [
      { "name": "candidate_id",        "type": "String", "target_object": "Candidate" },
      { "name": "job_requisition_id",  "type": "String", "target_object": "Job_Requisition" },
      { "name": "client_id",           "type": "String", "target_object": "Client" },
      { "name": "rule_check_audit_id", "type": "String", "target_object": "Rule_Check_Audit" },
      { "name": "llm_model",           "type": "String", "target_object": null },
      { "name": "passed_at",           "type": "DateTime" }
    ],
    "state_mutations": []
  }
},
{
  "name": "RULE_CHECK_FAILED",
  "description": "候选人简历未通过 LLM 规则预筛,候选人加入 blacklist,不调用 Robohire。",
  "payload": {
    "source_action": "matchResume",
    "event_data": [
      { "name": "candidate_id",        "type": "String", "target_object": "Candidate" },
      { "name": "job_requisition_id",  "type": "String", "target_object": "Job_Requisition" },
      { "name": "client_id",           "type": "String", "target_object": "Client" },
      { "name": "failure_reasons",     "type": "List<String>" },
      { "name": "summary",             "type": "String" },
      { "name": "rule_check_audit_id", "type": "String", "target_object": "Rule_Check_Audit" },
      { "name": "llm_model",           "type": "String", "target_object": null },
      { "name": "failed_at",           "type": "DateTime" }
    ],
    "state_mutations": [
      {
        "target_object": "Candidate_Blacklist",
        "mutation_type": "CREATE",
        "impacted_properties": ["candidate_id", "job_requisition_id", "client_id", "failure_reasons", "rule_check_flags", "occurred_at"]
      },
      {
        "target_object": "Candidate",
        "mutation_type": "MODIFY",
        "impacted_properties": ["blacklist_status", "state"]
      }
    ]
  }
}
```

**字段对照** — 事件 payload 跟 LLM 输出 JSON 的映射关系:

| 事件字段 | 来自 LLM 输出 | 来自 system 富化 |
|----------|---------------|-----------------|
| `candidate_id` | `overall_decision` 对应 input.runtime_context.candidate_id | — |
| `job_requisition_id` | input.job.job_requisition_id | — |
| `client_id` | input.client.name | — |
| `failure_reasons` | LLM 的 `failure_reasons` 数组 | — |
| `summary` | LLM 的 `summary` 字段 | — |
| `llm_model` | — | system 添加(例 `google/gemini-3-flash-preview`)|
| `passed_at` / `failed_at` | — | system 添加(`new Date().toISOString()`)|
| `rule_check_audit_id` | — | system 添加(指向 audit 表的 ID)|

### 6.3 `workflow_*.json` 改动详情

`matchResume` workflow 的 `triggered_event` 数组追加 2 项:

```diff
  {
    "id": "10",
    "name": "matchResume",
    "actor": ["Agent"],
    "trigger": ["RESUME_PROCESSED"],
    "actions": [ /* 4 步 — 不动 */ ],
    "triggered_event": [
      "MATCH_PASSED_NEED_INTERVIEW",
      "MATCH_PASSED_NO_INTERVIEW",
      "MATCH_FAILED",
+     "RULE_CHECK_PASSED",
+     "RULE_CHECK_FAILED"
    ]
  }
```

### 6.4 `actions_*.json` 改动详情

`matchResume` action 的 `triggered_event` 数组(在 actions_*.json 里 action 跟 workflow 1:1 对应)同样追加:

```diff
  {
    "id": "10",
    "name": "matchResume",
    "actor": ["Agent"],
    "trigger": ["RESUME_PROCESSED"],
    /* ... 4 个 action_steps + 50+ 条 rules — 不动 ... */
    "triggered_event": [
      "MATCH_PASSED_NEED_INTERVIEW",
      "MATCH_PASSED_NO_INTERVIEW",
      "MATCH_FAILED",
+     "RULE_CHECK_PASSED",
+     "RULE_CHECK_FAILED"
    ]
  }
```

### 6.5 你(叶洋)在 ontology 改完后需要做什么

1. **重新生成 snapshot** — `npm run gen:v4-snapshot -- --action matchResume --domain RAAS-v1`
2. **验证 snapshot 的 prompt 里 OUTPUT 段提到新事件** — grep `RULE_CHECK_PASSED|RULE_CHECK_FAILED`
3. **如果没提到** — 在你的 prompt 模板 §1 角色段 / §4 决策结算逻辑段加上 §5.1 给的"PASS → RULE_CHECK_PASSED / FAIL → RULE_CHECK_FAILED" 说明,让 LLM 明白它的决策驱动哪个事件

### 6.6 ontology 不改的代价

| 不改的文件 | 直接后果 |
|-----------|---------|
| events_*.json | 🔴 致命 — EM gateway schema 校验 reject `RULE_CHECK_PASSED/FAILED`,我们 emit 时被打成 `EVENT_REJECTED` 元事件,整条链路废 |
| workflow_*.json | 🟡 文档 drift — 别人看 workflow_*.json 不知道 matchResume 还触发 RULE_CHECK_* 事件 |
| actions_*.json | 🟡 文档 drift — 同上 |

---

## 7. ontology 规则过滤逻辑

### 7.1 用 client / business_group / studio 过滤规则

```ts
async function buildPrompt(input: MatchResumeRuntimeInput) {
  const { name, business_group_code, studio } = input.client;

  const rules = await ontologyApi.getRulesForMatchResume({
    client_id:      name,                  // "腾讯"
    business_group: business_group_code,    // "PCG"
    studio:         studio,                  // null (or "天美")
    job_tags:       input.job.tags ?? []
  });
  // 返回的规则应当只包括:
  //   1. applicableClient="通用" 的所有规则
  //   2. applicableClient="腾讯" 的规则
  //   3. applicableDepartment 跟 business_group_code 匹配的规则
  //   4. studio 维度匹配的规则
  // 跳过:
  //   - executor="Human" 的规则
  //   - applicableDepartment 跟本次 business_group_code 不匹配的规则

  return assembleFullPrompt(input, rules);
}
```

### 7.2 NOT_APPLICABLE vs PASS 区分 (常见错误,务必告诉 LLM)

- **NOT_APPLICABLE**:规则的触发条件不满足(如规则只对腾讯生效,但本次是字节)→ 标 NOT_APPLICABLE
- **PASS**:规则的触发条件满足,但候选人没违反 → 标 PASS

**例子**:候选人没有华为经历,跑规则 10-25 "华为竞对冷冻期":
- 规则 applicableClient="通用",触发条件 = "候选人简历已完成解析,工作经历数据已结构化",这条**满足**(简历解析完了)
- 但候选人没有华为经历,所以没命中规则的判定逻辑
- ✅ 应当标 `PASS`(规则被检查了,候选人不违反)
- ❌ **不应当标 NOT_APPLICABLE**

LLM 经常错把"候选人不违反"标成 NOT_APPLICABLE,prompt §1 角色段或 §6 自检段需要明确这一点。

### 7.3 evidence 写法约定

每条 `rule_flags[i].evidence` 必须引用 input 里的具体内容:
- ✅ "候选人 2023-06 至 2026-04 在华为任职,离职距今 1.5 月,< 3 月冷冻期"
- ❌ "候选人有华为经历"(太泛,不算 evidence)
- ❌ "符合规则要求"(没引用原文)

prompt §1 或 §6 应当包含这条约定。

---

## 8. 我们这边怎么用你的产出 (集成代码)

### 8.1 RuleCheckAgent — 调你的 fillRuntimeInput

```ts
// resume-parser-agent/lib/agents/rule-check-agent.ts (AO/我们维护)
import { matchResumeActionObject } from '@/generated/v4/match-resume.action-object';
import { fillRuntimeInput } from '@/lib/ontology-gen/v4';
import type { MatchResumeRuntimeInput } from '@/generated/v4/action-object-v4.types';

export class RuleCheckAgent {
  async evaluate(input: RuleCheckPromptInput): Promise<RuleCheckResult> {
    // Step 1: 拼装你的 input(我们这边做归一化 + 字段提取)
    const runtimeInput: MatchResumeRuntimeInput = {
      kind: 'matchResume',
      client: {
        name: normalizeClientId(input.job_requisition.client_id),
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

    // Step 2: 调用你的 fillRuntimeInput
    const ready = fillRuntimeInput(matchResumeActionObject, runtimeInput);

    // Step 3: 调 LLM
    const response = await this.llmGateway.complete({
      system: RuleCheckAgent.SYSTEM_PROMPT,
      user: ready.prompt,                        // ← 你的产出
      response_format: { type: 'json_object' },
      temperature: 0.1,
    });

    // Step 4: 解析 + 校验
    return validateAndParse(response.text);
  }
}
```

### 8.2 我们的 caller 怎么用 evaluate 返回结果(二元路由)

```ts
// resume-parser-agent/lib/inngest/agents/match-resume-agent.ts (改造后)

on RESUME_PROCESSED:
  // ... 准备 input ...

  const result = await ruleCheckAgent.evaluate(input);

  // ★ 二元分支 ★
  if (result.overall_decision === 'FAIL') {
    // 写 blacklist (含 LLM 推理依据)
    await addToBlacklist({
      candidate_id, job_requisition_id, client_id,
      failure_reasons:  result.failure_reasons,
      rule_check_flags: result.rule_flags,
      summary:          result.summary,
      llm_model:        '...',
      occurred_at:      new Date().toISOString(),
    });

    // emit 终态事件
    await emit('RULE_CHECK_FAILED', {
      upload_id, candidate_id, job_requisition_id, client_id,
      failure_reasons: result.failure_reasons,
      summary:         result.summary,
    });

    return;   // ★ 不调 Robohire,流程结束
  }

  // PASS 路径 — 走原有 matchResumeAgent 逻辑,一字不改
  const matchResult = await matchResume({ resume: resumeText, jd: jdText });
  await saveMatchResults({ ..., rule_check_flags: result.rule_flags });
  await emit('MATCH_PASSED_NEED_INTERVIEW', { ... });
```

**你不需要写这段** —— 只要 `fillRuntimeInput` 接收正确 input 返回正确 prompt 就行。

---

## 9. 验收测试用例

### 9.1 测试 input(请用这个 mock 跑一遍)

```ts
const TEST_INPUT: MatchResumeRuntimeInput = {
  kind: 'matchResume',
  runtime_context: {
    upload_id: 'upl_test_001',
    candidate_id: 'c01-zhaoliu-tencent',
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
      { title: '游戏后端工程师', company: '某游戏公司',
        startDate: '2025-03', endDate: '2026-04' },
      { title: '资深游戏工程师', company: '腾讯',
        startDate: '2019-08', endDate: '2025-02',
        description: '腾讯 IEG 天美工作室,《王者荣耀》后端' },
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

### 9.2 你的 prompt 必须满足的预期(自查清单)

1. **§2 Inputs 段**显示 6 个 sub-section,每个对应一个数据块
2. **§2.2 client 段**显示:
   ```
   client_name: 腾讯
   business_group_code: IEG
   department_display: 互动娱乐事业群
   studio: 天美
   ```
3. **§3.3 部门级规则**应当**激活**以下规则(因为 business_group=IEG + studio=天美):
   - 10-3 IEG 活跃流程候选人改推拦截 [终止级]
   - 10-40 腾讯主动离职人员紧急回流审核(IEG 在列表内)
   - 10-43 IEG 工作室回流候选人互斥标记(天美在 4 大工作室)
   - 10-52 IEG 内部技术面试强制校验

4. **§3.3 部门级规则**应当**不出现**:
   - 10-42 CDG 6 个月冷冻期(不是 CDG)
   - 10-53 非 IEG 跳过技面(本次是 IEG)
   - 字节相关规则(不是字节客户)

5. **§5 输出格式段**:应当包含完整的 `{"overall_decision": ..., "rule_flags": [...], ...}` JSON schema 定义

如果你的产出符合上面预期,我们一接就能跑通。

---

## 10. 你的完整 TODO 清单

### 必须项 (P0)

- [ ] **10.1** `MatchResumeRuntimeInput` 加 3 个顶层字段(`runtime_context` / `job_requisition_specification` / `hsm_feedback`)— 见 §3.3 P0-1
- [ ] **10.2** `ClientSlot` 加 3 个新字段(`business_group_code` / `department_display` / `studio`)— 见 §3.3 P0-2
- [ ] **10.3** 验证 snapshot 的 prompt 里有 OUTPUT 段(`## 输出格式` + JSON schema + 决策结算逻辑 + 提交前自检)— 见 §3.3 P0-3
- [ ] **10.4** prompt §1 角色段 / §4 决策结算段明确说明"PASS → RULE_CHECK_PASSED / FAIL → RULE_CHECK_FAILED"事件映射 — 见 §5.1
- [ ] **10.5** prompt §3 RULES 段告诉 LLM evidence 写法约定 — 见 §7.3
- [ ] **10.6** prompt §3 RULES 段明确 NOT_APPLICABLE vs PASS 的区分 — 见 §7.2
- [ ] **10.7** 内部规则过滤逻辑用 `client.name` + `business_group_code` + `studio`(可能需要扩展你的 ontology API 调用)— 见 §7.1
- [ ] **10.8** 跟陈洋同步:ontology 三个数据文件需要 atomic PR(新增 2 事件 + 追加 triggered_event)— 见 §6.1-6.4
- [ ] **10.9** ontology PR 合并后,重新生成 snapshot 验证 — 见 §6.5
- [ ] **10.10** 跑 §9.1 的 TEST_INPUT,把生成的 prompt 发给我们 — 见 §9.2 自查清单

### 后续可选项 (P1/P2)

- [ ] **10.11** TS 字段名 snake_case 化(跟 production `RaasRequirement` schema 对齐),不阻塞
- [ ] **10.12** 提供 strategy flag:`fillRuntimeInput(obj, input, { strategy: 'full' | 'pre-filtered' })`,让我们可以选择"全量 rules 让 LLM filter"还是"传 dimensions 让 fill 时过滤"

### 时间预估

| 任务 | 预估 | 谁 | 阻塞下游 |
|------|------|----|---------|
| 扩展 input schema(§3.3 P0-1, P0-2)| 0.5 天 | 叶洋 | 🔴 阻塞我们接入 |
| 验证/补全 OUTPUT 段(§3.3 P0-3)| 0.5 天 | 叶洋 + 可能陈洋 | 🔴 阻塞 LLM 输出可解析 |
| 我们接入到 RuleCheckAgent + 跑 POC 验证 | 1 天 | AO (我们) | 等叶洋上面完成 |

**总周期**:你 1-1.5 天 + 我们 1 天 = ~3 天完成接入 + 验证。

---

## 11. FAQ / 问题升级路径

### 11.1 你不需要做的事

- ❌ 你**不需要**改 `assembleActionObjectV4_4`(那是 immutable 的,继续靠 sentinel pattern)
- ❌ 你**不需要**新增 v5(还在 v4 基础上扩字段就行)
- ❌ 你**不需要**改 v3 兼容(我们走 v4 only)
- ❌ 你**不需要**碰 LLM 调用 / Inngest / RAAS API

### 11.2 不能 hybrid 用

之前讨论过"hybrid 用"(叶洋拼 RULES + AO 拼 INPUT/OUTPUT)**已撤销** —— 按"边界澄清"段,你的产出是我们发给 LLM 的**唯一** prompt source,**没有 fallback 路径**。

如果 P0 三项今天/明天做不完,选择只能是:
1. **降级测试**:我们 AO 这边用 POC 现有的 `PromptComposerAgent`(它能产生跟我们设计完全一致的 prompt)继续跑 demo,**仅做内部验证**,不上线
2. **集中冲刺**:你这边 P0 三项一次性 1-2 天搞定
3. **求助协作**:如果某一项卡住(比如 ontology Action 的 `outputs` 字段需要陈洋配合),我们可以帮你拉群对齐

任何情况下**不能让 hybrid prompt 进生产** —— 双 source 会导致审计断链 + 版本错配。

### 11.3 问题升级表

| 问题类型 | 先看 | 再问 |
|---------|------|------|
| 字段语义 / shape 不清楚 | 本文 §2-§3 | AO 团队 (我们) |
| client_id 归一化看不懂 | 本文 §2.3 | AO 团队 |
| ontology 规则查询不到 / API 报错 | ontology-lab 文档 | 陈洋 |
| 工作流上下文 / 事件链 | [docs/rule-check-end-to-end-workflow.md](rule-check-end-to-end-workflow.md) | AO 团队 |
| 测试用例跑不出预期 prompt | 本文 §9 | AO 团队 |
| OUTPUT schema 字段跟事件 payload 对不上 | 本文 §5 + [docs/rule-check-end-to-end-workflow.md](rule-check-end-to-end-workflow.md) | AO 团队 |

---

## 12. 配套文档索引

| 文档 | 内容 | 你需要看吗 |
|------|------|------------|
| **本文** | 你需要的全部内容,一站式 | ✅ 必读 |
| [docs/yeyang-v4-adapter-spec.md](yeyang-v4-adapter-spec.md) | 早期适配规约(已合并到本文)| 可跳过,内容已含在本文 |
| [docs/yeyang-client-id-data-flow.md](yeyang-client-id-data-flow.md) | client_id 数据流(已合并到本文)| 可跳过,内容已含在本文 |
| [docs/rule-check-end-to-end-workflow.md](rule-check-end-to-end-workflow.md) | 完整工作流 + 事件设计 | ⚠️ **已过时** — 该文档基于 KEEP/DROP/PAUSE 三态,现在简化为 PASS/FAIL 二态。本文 §5 / §6 / §8 是当前权威 |
| [docs/rule-check-prompt-pipeline.md](rule-check-prompt-pipeline.md) | AO 这边的 RuleCheckAgent 实现细节 | 不用看 — 那是我们的事 |
| [scripts/rule-check-poc/](../scripts/rule-check-poc/) | POC 实现(可作为 prompt 渲染逻辑对照) | 选读 — 我们 POC 里 `PromptComposerAgent` 可以参考 |
| `GENERATE-PROMPT-USER-GUIDE.md` | 你自己写的 v4 codegen user guide | 你的源文档,作为本文的基础 |

---

*生成时间:2026-05-11*
*维护:Agentic Operator 团队*
*基于:叶洋 `GENERATE-PROMPT-USER-GUIDE.md` v4 / matchResume*
