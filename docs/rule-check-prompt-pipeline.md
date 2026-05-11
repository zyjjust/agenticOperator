# matchResume 规则预筛 — User Prompt 生成流水线与端到端 I/O 契约设计

> **本文档目的**：定义 matchResume 工作流中的 LLM 规则预筛环节，逐边界写清每一个 input / output 契约，让协作各方（AO 团队、叶洋、陈洋、张元军）拿这份文档就能开工而不需要再追问。
>
> **核心交付物**：
>
> 1. **架构形式**：matchResumeAgent 作为 orchestrator workflow agent，内部同步调用 RuleCheckAgent（LLM 预筛 subagent）；KEEP 路径继续调 Robohire 做深度匹配评分
> 2. **流程模式**：一份简历 → 一条客户原始需求（Job_Requisition）→ 一份 user prompt → 一次 LLM 调用 → KEEP/DROP/PAUSE 三分支
> 3. **预筛作用**：用 LLM 按规则过滤掉**明显不合格**的简历，避免无谓地消耗 Robohire 的深度匹配能力；通过预筛的简历附带 augmentation flags 一起送 Robohire
> 4. **Robohire 契约不变**：`/match-resume` 仍然只接 `{ resume, jd }`，输出 `{ matchScore, recommendation, ... }`；augmentation 是拼到 resume 文本里送进去的
>
> **明确分工**（本文档读者参考下表）：
>
> | 角色 | 该做的事 | 该读的章节 |
> |------|---------|-----------|
> | 雨函（matchResumeAgent owner）| 改造 [match-resume-agent.ts](resume-parser-agent/lib/inngest/agents/match-resume-agent.ts)，写 RuleCheckAgent 类 | 全文，重点 §3.6 / §5 |
> | 叶洋（action layer owner）| 抓 Neo4j rules + 编 user prompt 字符串 | §3.3 / §3.4 / §3.5 / §4 |
> | 陈洋（ontology owner）| 提供 `getRulesForMatchResume` API + ontology Rule 节点 schema | §3.4 / §6.5 |
> | 张元军（RAAS owner）| RESUME_DOWNLOADED 带 job_requisition_id；新增 `getJobRequisition` API；扩 `saveMatchResults` 字段 | §3.1 / §3.2 / §3.8 / §6.1-6.4 |

---

## 0. 概念澄清

### 0.1 两份"JD"必须分清楚

| 名称 | 来源 | 角色 | 在 ontology | 在 RAAS DB |
|------|------|------|-------------|------------|
| **Job_Requisition（客户原始需求）** | 客户在 RAAS dashboard 录入 | **canonical** —— 所有规则匹配、规则元数据、客户/部门/工作室/标签都以它为准 | `Job_Requisition` 节点 | `job_requisitions` 表 |
| **Generated JD（生成的 JD）** | AO `createJdAgent` → Robohire `/generate-jd` → RAAS `/jd/sync-generated` | 派生工件 —— 仅用于发布渠道；matchResume 流程**不使用** | （Job_Requisition 的渲染产物） | RAAS 用作 posting 模板 |

候选人简历到达后，**RAAS 把简历关联到具体的 `Job_Requisition`**（不是 Generated JD）。后续整个 rule check + Robohire 匹配，都用这条 `Job_Requisition` 的数据。

### 0.2 三层 agent 体系（雨函要建的"sub-sub agent system"具体指什么）

| 层 | 实例 | 是什么 | 谁负责 |
|----|------|-------|--------|
| **L1 workflow agent** | `matchResumeAgent` | Inngest function，订阅事件、独立部署、独立重试 —— 整个匹配流程的 orchestrator | 雨函 |
| **L2 sub-agent** | `RuleCheckAgent` | 有自己 role + system prompt + 决策能力的 LLM 模块；由 L1 同步调用；本身不订阅事件 | **雨函（本设计核心交付物）** |
| **L3 LLM 调用工具** | `llmGateway.complete` | 实际调大模型的封装：多模型路由、重试、token 统计、prompt cache | 雨函（已有基础设施） |

**叶洋不直接是 agent**，而是给 L2 提供 **prompt 编译器**（`MatchResumeActionObject.getRuleCheckPrompt`），让 L2 能把 input + rules + output schema 拼成完整 user prompt 喂给 L3。

```
                            ┌──────────────────────────────────┐
                            │  L1: matchResumeAgent (Inngest)  │
                            │  ──────────────────              │
                            │  on RESUME_PROCESSED:            │
                            │    ... step ...                  │
                            │    ┌─────────────────────────┐   │
                            │    │ L2: RuleCheckAgent      │   │
                            │    │  ────────────────       │   │
                            │    │  evaluate(input):       │   │
                            │    │   1. 调叶洋的 actionObject│   │
                            │    │      getRuleCheckPrompt │   │  ← 叶洋负责
                            │    │      返回 prompt:string │   │
                            │    │   2. 调 L3 ↓             │   │
                            │    │      ┌─────────────────┐│   │
                            │    │      │L3:llmGateway   ││   │  ← 现有
                            │    │      │.complete        ││   │
                            │    │      │(model API call) ││   │
                            │    │      └─────────────────┘│   │
                            │    │   3. parse + validate   │   │
                            │    │   4. return Result      │   │
                            │    └─────────────────────────┘   │
                            │    ... step ...                  │
                            └──────────────────────────────────┘
```

**L2 才是雨函本设计真正要新建的核心交付物**（用户原话"sub-sub agent"的所指）。L1 的改造只是在 `step.run` 内多加一句对 L2 的同步调用。

### 0.3 叶洋 ↔ 雨函 协作 handoff（一次完整调用的时序）

```
matchResumeAgent (L1)        RuleCheckAgent (L2)         actionObject (叶洋)        ontologyApi (陈洋)        llmGateway (L3)

      │                              │                            │                          │                          │
      │ evaluate({                   │                            │                          │                          │
      │  candidate_id, resume,       │                            │                          │                          │
      │  job_requisition,            │                            │                          │                          │
      │  hsm_feedback })             │                            │                          │                          │
      ├─────────────────────────────►│                            │                          │                          │
      │                              │                            │                          │                          │
      │                              │ getRuleCheckPrompt(args)   │                          │                          │
      │                              ├───────────────────────────►│                          │                          │
      │                              │                            │ 1. 提取 client_id /       │                          │
      │                              │                            │    business_group /       │                          │
      │                              │                            │    studio / tags         │                          │
      │                              │                            │                          │                          │
      │                              │                            │ 2. 调 ontology ↓          │                          │
      │                              │                            │ getRulesForMatchResume(  │                          │
      │                              │                            │  {client_id, bg,         │                          │
      │                              │                            │   studio, tags})         │                          │
      │                              │                            ├─────────────────────────►│                          │
      │                              │                            │       Rule[]             │                          │
      │                              │                            │◄─────────────────────────┤                          │
      │                              │                            │                          │                          │
      │                              │                            │ 3. 渲染 INPUT 段          │                          │
      │                              │                            │ 4. 渲染 RULES 段          │                          │
      │                              │                            │ 5. 渲染 OUTPUT 段         │                          │
      │                              │                            │ 6. 拼接成 prompt: string │                          │
      │                              │  prompt: string            │                          │                          │
      │                              │  (8K-12K 字符)              │                          │                          │
      │                              │◄───────────────────────────┤                          │                          │
      │                              │                            │                          │                          │
      │                              │ complete({                 │                          │                          │
      │                              │  system: SYSTEM_PROMPT,    │                          │                          │
      │                              │  user: prompt,             │                          │                          │
      │                              │  response_format:          │                          │                          │
      │                              │    {type:'json_object'},   │                          │                          │
      │                              │  temperature: 0.1 })       │                          │                          │
      │                              ├─────────────────────────────────────────────────────────────────────────────────►│
      │                              │                                                                LLM 输出 raw text │
      │                              │◄─────────────────────────────────────────────────────────────────────────────────┤
      │                              │                            │                          │                          │
      │                              │ JSON.parse + zod 校验       │                          │                          │
      │                              │ + decision 一致性校验        │                          │                          │
      │                              │                            │                          │                          │
      │  RuleCheckResult             │                            │                          │                          │
      │◄─────────────────────────────┤                            │                          │                          │
      │                              │                            │                          │                          │
      │ switch overall_decision:     │                            │                          │                          │
      │   DROP  → emit MATCH_FAILED  │                            │                          │                          │
      │   PAUSE → createHumanTask    │                            │                          │                          │
      │   KEEP  → 继续调 Robohire     │                            │                          │                          │
```

每一步的详细 input/output 见 §3 各 Boundary。叶洋负责的范围：上图中"actionObject"竖线对应的所有步骤。雨函负责的范围：上图中"RuleCheckAgent"竖线对应的所有步骤。

---

## 1. 架构总览：orchestrator + subagent

```
┌─────────────────────────────────────────────────────────────────────────┐
│  matchResumeAgent (Inngest workflow function — orchestrator)             │
│  ──────────────────────────────────────────────────────────              │
│                                                                          │
│  on RESUME_PROCESSED:                                                    │
│    1. 取 job_requisition_id (从事件)                                     │
│    2. getJobRequisition(id)            ←── RAAS API                      │
│    3. 调用 RuleCheckAgent ↓                                              │
│                                                                          │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  RuleCheckAgent (subagent, 同步调用)                              │  │
│  │  ──────────────────────────────                                   │  │
│  │  Role:           简历预筛查员                                      │  │
│  │  System prompt:  "你是预筛查员…"                                   │  │
│  │  Output schema:  RuleCheckResult JSON                              │  │
│  │  LLM model:      Claude Sonnet 4.6 / Kimi 2.6 / DeepSeek V4       │  │
│  │                                                                    │  │
│  │  evaluate({ candidate_id, resume, job_requisition, hsm_feedback }):│  │
│  │     a. 调 ontologyApi.getRulesForMatchResume(...)  ← 陈洋 API     │  │
│  │     b. 调 actionObject.getRuleCheckPrompt(...)     ← 叶洋 method  │  │
│  │     c. 调 llmGateway.complete(...)                                │  │
│  │     d. 解析 → RuleCheckResult                                      │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│    4. 决策分支:                                                          │
│       • DROP  → saveMatchResults + emit MATCH_FAILED                     │
│       • PAUSE → createHumanTask × N                                     │
│       • KEEP  → 拼 augmentation,继续 ↓                                   │
│                                                                          │
│    5. (KEEP only) matchResume({ resume: augmented, jd })                 │
│                                          ↑                               │
│                              Robohire 契约不变                            │
│                                                                          │
│    6. (KEEP only) saveMatchResults({ ..., rule_check_flags })            │
│    7. (KEEP only) emit MATCH_PASSED_NEED_INTERVIEW                       │
└─────────────────────────────────────────────────────────────────────────┘
```

**为什么用 subagent 模式而不是独立 workflow agent**：

- DROP/PAUSE 路径需要在 matchResumeAgent 流程里 short-circuit，事件异步会增加 `step.waitForEvent` 复杂度
- KEEP 路径要把 RuleCheckAgent 输出的 `resume_augmentation` 字符串拼到 resume 后送 Robohire，是紧耦合数据流
- 当前没有别的 workflow 复用 rule check
- 未来如果有"批量重筛"等复用需求，再升级 RuleCheckAgent 为独立 Inngest function 即可

---

## 2. 端到端工作流（标注所有 I/O 边界）

```
┌──────────┐                                                          ┌──────────┐
│  RAAS    │                                                          │ Robohire │
│ Dashboard│                                                          │  Service │
└─────┬────┘                                                          └──────┬───┘
      │ 候选人对                                                              │
      │ Job_Requisition                                                      │
      │ 上传 PDF 简历                                                         │
      ▼                                                                      │
┌─────────────┐                                                              │
│  RAAS API   │  ① Boundary 1                                                │
│   Server    │ ───RESUME_DOWNLOADED───►                                     │
└─────────────┘                                                              │
                                                                             │
            ┌───────────────────────────┐                                    │
            │  AO resumeParserAgent     │                                    │
            │  POST /candidates         │                                    │
            └─────────┬─────────────────┘                                    │
                      │ ② Boundary 2                                         │
                      │ RESUME_PROCESSED                                     │
                      │ (含 job_requisition_id)                              │
                      ▼                                                      │
            ┌───────────────────────────────────────────────┐                │
            │  AO matchResumeAgent (orchestrator)           │                │
            │                                                │                │
            │  ③ Boundary 3: getJobRequisition(id)          │                │
            │     ← RAAS API ──→ JobRequisition obj         │                │
            │                                                │                │
            │  ④ Boundary 4: RuleCheckAgent.evaluate(input)  │                │
            │     ┌────────────────────────────────────┐    │                │
            │     │ Subagent 内部:                       │    │                │
            │     │  4a. ontology.getRulesForMatchResume│    │                │
            │     │      ← 陈洋 API ──→ Rule[]           │    │                │
            │     │  4b. actionObject.getRuleCheckPrompt│    │                │
            │     │      ← 叶洋 method ──→ string        │    │                │
            │     │  4c. llmGateway.complete            │    │                │
            │     │      ← LLM ──→ RuleCheckResult       │    │                │
            │     └────────────────────────────────────┘    │                │
            │                                                │                │
            │  ⑤ 三种决策:                                   │                │
            │     • DROP  → saveMatchResults + emit FAIL     │                │
            │     • PAUSE → createHumanTask                  │                │
            │     • KEEP  → 继续 ↓                            │                │
            │                                                │                │
            │  ⑥ Boundary 6: matchResume(augmented_resume, jd)│               │
            │     ────────────RAAS API────────────────────────────────────►   │
            │                                                │      │         │
            │                                                │      │ 内部调   │
            │                                                │      ▼         │
            │                                                │ Robohire       │
            │                                                │ /match-resume  │
            │                                                │      │         │
            │                                                │ ◄────┘ matchScore│
            │                                                │                │
            │  ⑦ Boundary 7: saveMatchResults(...+flags)    │                │
            │     ────────────RAAS API─────────►            │                │
            │                                                │                │
            │  ⑧ Boundary 8: emit MATCH_PASSED_NEED_INTERVIEW│                │
            └────────────────────────────────────────────────┘                │
                                                                             │
                                                                             ▼
                                                                  下游 interview 流程
```

8 个 I/O 边界详细规约见 §3。

---

## 3. I/O 契约（按边界）

### 3.1 Boundary 1：RAAS → AO 的 `RESUME_DOWNLOADED` 事件

| 维度 | 值 |
|------|----|
| 方向 | RAAS API Server → 本地 Inngest |
| 触发 | 候选人在 RAAS dashboard 对一个 Job_Requisition 上传 PDF 简历后 |
| 改动 | **★ 必须新增 `job_requisition_id` 字段** |
| Owner | 张元军（生产端）+ 雨函（消费端 resumeParserAgent） |

#### Input schema（RAAS 发送）

```ts
interface ResumeDownloadedData {
  // 现有字段
  bucket: string;
  objectKey: string;
  filename: string;
  hrFolder: string | null;
  employeeId: string | null;
  etag: string | null;
  size: number | null;
  receivedAt: string;
  parsed: { data: RoboHireParsedData };

  // ★ 新增字段（本设计阻塞依赖）
  job_requisition_id: string;       // ← RAAS 在简历入库时已经知道这个关联,直接带上
  client_id: string;                 // ← Job_Requisition.client_id 的快照,可选透传
}
```

#### 真实示例

```json
{
  "bucket": "raas-resumes",
  "objectKey": "2026-05/张三-简历.pdf",
  "filename": "张三-简历.pdf",
  "hrFolder": "/腾讯/PCG",
  "employeeId": "emp_kenny_001",
  "etag": "abc123",
  "size": 156789,
  "receivedAt": "2026-05-09T10:23:45Z",
  "parsed": { "data": { "name": "张三", "experience": [...], ... } },
  "job_requisition_id": "jr_x99",
  "client_id": "腾讯"
}
```

---

### 3.2 Boundary 2：resumeParserAgent → matchResumeAgent 的 `RESUME_PROCESSED` 事件

| 维度 | 值 |
|------|----|
| 方向 | resumeParserAgent emit → matchResumeAgent consume |
| 改动 | **★ 必须新增 `job_requisition_id` 字段（透传 RAAS 的）** |
| Owner | 雨函 |

#### Input schema

```ts
// resume-parser-agent/lib/inngest/client.ts
interface ResumeProcessedData {
  // 现有字段
  bucket: string;
  objectKey: string;
  filename: string;
  upload_id?: string;
  candidate_id?: string;
  resume_id?: string;
  employee_id?: string;
  parsed?: { data?: RoboHireParsedData };
  // ... 其他元数据

  // ★ 新增字段
  job_requisition_id: string;        // ← 从 RESUME_DOWNLOADED 透传
  client_id?: string;                 // ← 可选,从 RESUME_DOWNLOADED 透传
}
```

#### 真实示例

```json
{
  "upload_id": "upl_a3f1",
  "candidate_id": "cand_a3f1",
  "resume_id": "res_a3f1",
  "employee_id": "emp_kenny_001",
  "parsed": { "data": { "name": "张三", ... } },
  "job_requisition_id": "jr_x99",
  "client_id": "腾讯",
  "parsedAt": "2026-05-09T10:24:01Z",
  "parserVersion": "rpa-v1.2.0"
}
```

---

### 3.3 Boundary 3：AO → RAAS 的 `getJobRequisition(id)` API

| 维度 | 值 |
|------|----|
| 方向 | matchResumeAgent → RAAS API Server |
| 改动 | **★ 新增 RAAS API**（当前只有 `getRequirementsAgentView` 列表，缺按 ID 单查）|
| Owner | 张元军 |

#### Request

```http
GET /api/v1/job-requisitions/{job_requisition_id}
Authorization: Bearer {AGENT_API_KEY}
```

#### Response schema

```ts
interface JobRequisition {
  job_requisition_id: string;
  client_id: string;                       // "腾讯" / "字节" / ...
  client_business_group?: string | null;   // "IEG" / "PCG" / "CDG" / "TikTok" / ...
  client_studio?: string | null;            // "天美" / "光子" / 仅腾讯 IEG 类有
  client_department?: string | null;        // 字节系等其他客户的部门标识
  client_job_title: string;
  must_have_skills: string[];
  nice_to_have_skills: string[];
  language_requirements: string;
  degree_requirement: string;
  education_requirement: string;
  age_range: { min: number | null; max: number | null } | null;
  work_years: number | null;
  salary_range: string;
  recruitment_type: string;
  interview_mode: string;
  negative_requirement: string;
  tags: string[];                           // ["外语","海外","国际化","轮班","夜班","倒班","长期出差"] 子集
  job_responsibility: string;
  job_requirement: string;
  hc_status: '招聘中' | '已暂停' | '已关闭' | string;
  created_at: string;
  updated_at: string;
}
```

#### 真实示例

```json
{
  "job_requisition_id": "jr_x99",
  "client_id": "腾讯",
  "client_business_group": "PCG",
  "client_studio": null,
  "client_department": null,
  "client_job_title": "高级前端开发工程师",
  "must_have_skills": ["React", "TypeScript", "Webpack"],
  "nice_to_have_skills": ["Next.js", "GraphQL"],
  "language_requirements": "CET-6 480 以上",
  "degree_requirement": "本科",
  "education_requirement": "全日制",
  "age_range": { "min": 25, "max": 40 },
  "work_years": 5,
  "salary_range": "30k-50k",
  "recruitment_type": "正编",
  "interview_mode": "线下",
  "negative_requirement": "不接受外包从业经历超过 2 年",
  "tags": [],
  "job_responsibility": "负责...",
  "job_requirement": "...",
  "hc_status": "招聘中",
  "created_at": "2026-05-01T10:00:00Z",
  "updated_at": "2026-05-08T14:20:00Z"
}
```

---

### 3.4 Boundary 4：叶洋 → 陈洋 的 `getRulesForMatchResume()` ontology API

| 维度 | 值 |
|------|----|
| 方向 | 叶洋的 `MatchResumeActionObject` 内部调 → 陈洋的 ontology API |
| 改动 | **★ 新增 ontology API**（当前只有 `get_rule_by_action`，无维度过滤） |
| Owner | 陈洋（提供方）+ 叶洋（消费方）|

#### Request schema

```ts
interface GetRulesForMatchResumeQuery {
  client_id: string;                  // "腾讯" | "字节" | ...
  business_group?: string | null;     // "IEG" | "CDG" | "TikTok" | null
  studio?: string | null;             // "天美" | null
  job_tags?: string[];                // ["外语", "轮班"] | []
}
```

#### Response schema

```ts
interface Rule {
  rule_id: string;                    // "10-25"
  rule_name: string;                  // "华为荣耀竞对互不挖角红线"
  applicable_client: '通用' | string;  // "通用" / "腾讯" / "字节"
  step: 1 | 2 | 3;
  severity: 'terminal' | 'needs_human' | 'flag_only';
  natural_language: string;            // 叶洋编译好的自然语言段落（含命中处理说明）
  output_action: {
    on_hit: { result: 'FAIL' | 'REVIEW' | 'PASS'; reason_code: string };
    notification?: {
      recipient: '招聘专员' | 'HSM';
      channel: 'InApp' | 'Email';
      template: string;                // 通知文本模板
    };
  };
  // 用于 trace / debug
  source_object: string;               // ontology 节点路径
  raw_metadata: Record<string, unknown>;
}
```

#### 内部过滤逻辑（陈洋实现）

```sql
-- pseudo-Cypher
MATCH (a:Action {name:'matchResume'})-[:HAS_STEP]->(s:Step)-[:HAS_RULE]->(r:Rule)
WHERE s.order IN [1, 2, 3]
  AND r.executor = 'Agent'
  AND (
    r.applicableClient = '通用'
    OR r.applicableClient = $client_id
  )
  AND (
    r.condition_business_group IS NULL
    OR r.condition_business_group = $business_group
  )
  AND (
    r.condition_studio IS NULL
    OR $studio IN r.condition_studio_list
  )
  AND (
    SIZE(r.condition_tags_required) = 0
    OR ALL(t IN r.condition_tags_required WHERE t IN $job_tags)
  )
RETURN r
ORDER BY s.order ASC, r.id ASC
```

#### 调用示例

```ts
// 调用方（叶洋的 actionObject 内部）:
const rules = await ontologyApi.getRulesForMatchResume({
  client_id: 'PCG' === jobReq.client_business_group ? '腾讯' : jobReq.client_id,
  business_group: jobReq.client_business_group,
  studio: jobReq.client_studio,
  job_tags: jobReq.tags,
});
// rules.length 大约 15-25 条
```

---

### 3.5 Boundary 5：AO → 叶洋 的 `getRuleCheckPrompt()` 调用契约（**核心契约 1**）

> 这是 AO 给叶洋的 input。叶洋拿这份 input 抓 rules + 编 user prompt 返回。

| 维度 | 值 |
|------|----|
| 方向 | RuleCheckAgent (AO 内部) → MatchResumeActionObject (叶洋包) |
| 形式 | 同步函数调用（不是事件）|
| Owner | 叶洋（实现方） |

#### Input schema（AO 提供给叶洋）

```ts
interface GetRuleCheckPromptArgs {
  inputs: {
    candidate_id: string;
    resume: RoboHireParsedData;        // 见 §3.1.parsed.data
    job_requisition: JobRequisition;   // 见 §3.3 完整对象
    hsm_feedback?: HsmFeedback | null; // 用于 10-28 / 10-39 等需要 HSM 二次输入的规则
  };
}

interface RoboHireParsedData {
  name?: string;
  email?: string;
  phone?: string;
  location?: string;
  summary?: string;
  experience?: Array<{
    title?: string;
    company?: string;
    location?: string;
    startDate?: string;       // "YYYY-MM" or "YYYY-MM-DD"
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
}

interface HsmFeedback {
  kin_relation_result?: '存在利益冲突' | '无利益冲突-同部门' | '无利益冲突-非同部门' | null;
  tencent_history_leave_result?: '主动离场' | '非淘汰退场' | '淘汰退场' | null;
  reflux_cert_uploaded?: boolean;
  // ... 未来扩展
}
```

#### Output（叶洋返回给 AO）

```ts
type GetRuleCheckPromptReturn = string;  // 完整的 user prompt markdown 字符串
```

#### 叶洋内部实现 — 6 步处理流程

整体方法签名：

```ts
class MatchResumeActionObject {
  constructor(private ontologyApi: OntologyApi) {}

  async getRuleCheckPrompt(args: GetRuleCheckPromptArgs): Promise<string> {
    // Step 1 ~ 6 见下方
  }
}
```

**Step 1 — 接收 input**

雨函的 RuleCheckAgent 调 `getRuleCheckPrompt(args)`，传入：

| 字段 | 类型 | 来源 |
|------|------|------|
| `args.inputs.candidate_id` | string | `RESUME_PROCESSED.candidate_id` |
| `args.inputs.resume` | `RoboHireParsedData` | `RESUME_PROCESSED.parsed.data` |
| `args.inputs.job_requisition` | `JobRequisition` | RAAS `getJobRequisition(jr_id)` 返回 |
| `args.inputs.hsm_feedback` | `HsmFeedback \| null` | RAAS `getHsmFeedback()` 返回，可能 null |

叶洋这边不要去主动 fetch input —— 全都由 L2 (RuleCheckAgent) 在调用前准备好传进来。

**Step 2 — 从 `job_requisition` 提取过滤维度**

叶洋只需要四个维度来过滤规则：

```ts
const jr = args.inputs.job_requisition;
const dims = {
  client_id:      jr.client_id,                    // 例: "腾讯"
  business_group: jr.client_business_group         // 例: "PCG" / "CDG" / null
                  ?? jr.client_department,          // (字节系等用 client_department)
  studio:         jr.client_studio,                // 例: "天美" / null
  job_tags:       jr.tags ?? [],                   // 例: ["外语", "轮班"]
};
```

**Step 3 — 调陈洋的 ontology API 抓 rules**

```ts
const rules: Rule[] = await this.ontologyApi.getRulesForMatchResume({
  client_id:      dims.client_id,
  business_group: dims.business_group,
  studio:         dims.studio,
  job_tags:       dims.job_tags,
});
// 返回的 Rule[] 已经按维度过滤好,长度大约 15-25 条
// 每条 Rule 含 rule_id / rule_name / applicable_client / step / severity / natural_language / output_action
// 详细 schema 见 §3.4
```

注意：`rule.natural_language` 字段是叶洋**预先编辑好的自然语言段落**，存在 ontology 里。每条规则的自然语言文本来自兄弟文档 [docs/match-resume-rule-check-prompt.md](docs/match-resume-rule-check-prompt.md) §3，以"如果...请..."的语气说明该怎么检查、命中后该怎么填 `rule_flags` / `drop_reasons` / `pause_reasons` / `notifications`。叶洋不需要每次重写，只需把这段文本从 ontology 取出原样放进 prompt 即可。

**Step 4 — 渲染 INPUT 段**

把 `args.inputs` 序列化成 JSON，嵌进 markdown 代码块：

```ts
function renderInputsSection(inputs: GetRuleCheckPromptArgs['inputs']): string {
  // 只挑 LLM 需要的 jr 字段，避免无用字段污染 prompt
  const jrTrimmed = {
    job_requisition_id:    inputs.job_requisition.job_requisition_id,
    client_job_title:      inputs.job_requisition.client_job_title,
    must_have_skills:      inputs.job_requisition.must_have_skills,
    nice_to_have_skills:   inputs.job_requisition.nice_to_have_skills,
    language_requirements: inputs.job_requisition.language_requirements,
    degree_requirement:    inputs.job_requisition.degree_requirement,
    age_range:             inputs.job_requisition.age_range,
    salary_range:          inputs.job_requisition.salary_range,
    negative_requirement:  inputs.job_requisition.negative_requirement,
    tags:                  inputs.job_requisition.tags,
    job_responsibility:    inputs.job_requisition.job_responsibility,
    job_requirement:       inputs.job_requisition.job_requirement,
  };

  const payload = {
    candidate_id:    inputs.candidate_id,
    client_id:       inputs.job_requisition.client_id,
    business_group:  inputs.job_requisition.client_business_group ?? inputs.job_requisition.client_department,
    studio:          inputs.job_requisition.client_studio,
    resume:          inputs.resume,
    job_requisition: jrTrimmed,
    hsm_feedback:    inputs.hsm_feedback ?? null,
  };

  return `## 2. Inputs

\`\`\`json
${JSON.stringify(payload, null, 2)}
\`\`\``;
}
```

**Step 5 — 渲染 RULES 段**

按 `applicable_client` 三级分组，每条 rule 用自然语言段落渲染：

```ts
const SEV_TAG: Record<Rule['severity'], string> = {
  terminal:    '终止级',
  needs_human: '需人工复核',
  flag_only:   '仅记录',
};

function renderSingleRule(r: Rule): string {
  return `#### 规则 ${r.rule_id}：${r.rule_name} [${SEV_TAG[r.severity]}]

${r.natural_language}`;
}

function renderRulesSection(rules: Rule[], dims: Dims): string {
  // 通用规则
  const general = rules.filter(r => r.applicable_client === '通用');

  // 客户级规则（不带 department condition）
  const clientLevel = rules.filter(r =>
    r.applicable_client !== '通用' && !hasDepartmentCondition(r));

  // 部门级规则（带 condition_business_group / condition_studio）
  const deptLevel = rules.filter(r =>
    r.applicable_client !== '通用' && hasDepartmentCondition(r));

  return `## 3. Rules to check

### 3.1 通用规则 (CSI 级，所有客户必查)

${general.map(renderSingleRule).join('\n\n')}

### 3.2 客户级规则 (本次 client_id="${dims.client_id}")

${clientLevel.map(renderSingleRule).join('\n\n')}

### 3.3 部门级规则 (本次 business_group="${dims.business_group ?? '无'}", studio="${dims.studio ?? '无'}")

${deptLevel.length > 0
  ? deptLevel.map(renderSingleRule).join('\n\n')
  : '> 本次激活的部门级规则：无'}`;
}
```

**Step 6 — 拼接所有段，返回 string**

OUTPUT 段（决策逻辑 + JSON schema + 自检 checklist）是固定模板，叶洋一次性写好作为常量：

```ts
const HEADER = '# Resume Pre-Screen Rule Check';

const ROLE_SECTION = `## 1. 你的角色

你是一名简历预筛查员。系统会给你一份候选人的解析后简历，以及一个具体的客户原始需求（Job_Requisition）。你的任务是逐条检查下列所有规则，找出哪些规则在这份简历上命中，并把结果整理成结构化标签输出。

请特别注意：
- **不要给候选人打匹配分数。** 打分是下游 Robohire 的工作。
- 你的输出会驱动三种处理：DROP / PAUSE / KEEP。`;

const DECISION_LOGIC_SECTION = `## 4. 决策结算逻辑

跑完全部 applicable 规则后：
1. 任一 \`rule_flags[i].result == "FAIL"\` → \`overall_decision = "DROP"\`
2. 否则任一 \`result == "REVIEW"\` → \`overall_decision = "PAUSE"\`
3. 否则 → \`overall_decision = "KEEP"\`

无论决策哪个，\`rule_flags\` 必须覆盖 §3 中**每一条**规则（不适用的写 NOT_APPLICABLE）。`;

const OUTPUT_SCHEMA_SECTION = `## 5. 输出格式

返回严格符合下列结构的 JSON，不允许多余字段，不允许遗漏字段：

\`\`\`json
{
  "candidate_id": "...",
  "job_requisition_id": "...",
  "client_id": "...",
  "overall_decision": "KEEP" | "DROP" | "PAUSE",
  "drop_reasons": ["<rule_id>:<short_code>"],
  "pause_reasons": ["<rule_id>:<short_code>"],
  "rule_flags": [
    {
      "rule_id": "...",
      "rule_name": "...",
      "applicable_client": "通用" | "<client>",
      "severity": "terminal" | "needs_human" | "flag_only",
      "applicable": true | false,
      "result": "PASS" | "FAIL" | "REVIEW" | "NOT_APPLICABLE",
      "evidence": "<引用简历原文>",
      "next_action": "continue" | "block" | "pause" | "notify_recruiter" | "notify_hsm"
    }
  ],
  "resume_augmentation": "<给 Robohire 的 markdown 标记段>",
  "notifications": [
    {
      "recipient": "招聘专员" | "HSM",
      "channel": "InApp" | "Email",
      "rule_id": "...",
      "message": "..."
    }
  ]
}
\`\`\``;

const SELF_CHECK_SECTION = `## 6. 提交前自检

- [ ] rule_flags 覆盖 §3 所有规则（不适用写 NOT_APPLICABLE）
- [ ] overall_decision 跟 drop_reasons / pause_reasons 一致
- [ ] 每条 evidence 引用了简历原文
- [ ] resume_augmentation 是给 Robohire 看的可读 markdown
- [ ] 不要给候选人打匹配分数`;

// 最后拼接：
return [
  HEADER,
  ROLE_SECTION,
  renderInputsSection(args.inputs),    // 动态：每次调用不同
  renderRulesSection(rules, dims),      // 动态：每次调用不同
  DECISION_LOGIC_SECTION,
  OUTPUT_SCHEMA_SECTION,
  SELF_CHECK_SECTION,
].join('\n\n');
```

返回的字符串长度约 8K-12K 字符。叶洋的工作到此结束 —— 从这一刻起字符串归雨函的 RuleCheckAgent 处理。

---

#### 叶洋的最小可交付（MVP）

如果时间紧，先实现最小版本：

```ts
// 最小 MVP（只支持腾讯客户，无 hsm_feedback，无部门级规则）
class MatchResumeActionObject {
  async getRuleCheckPrompt(args: GetRuleCheckPromptArgs): Promise<string> {
    const rules = await this.ontologyApi.getRulesForMatchResume({
      client_id: args.inputs.job_requisition.client_id,
      business_group: null,
      studio: null,
      job_tags: [],
    });
    return [
      HEADER, ROLE_SECTION,
      `## 2. Inputs\n\`\`\`json\n${JSON.stringify(args.inputs, null, 2)}\n\`\`\``,
      `## 3. Rules\n\n${rules.map(r => `### ${r.rule_id} ${r.rule_name}\n${r.natural_language}`).join('\n\n')}`,
      DECISION_LOGIC_SECTION, OUTPUT_SCHEMA_SECTION, SELF_CHECK_SECTION,
    ].join('\n\n');
  }
}
```

可以先用这个 MVP 验证 LLM 输出质量，再逐步加分组渲染、字段裁剪、客户分支。

#### 端到端完整实例：叶洋 → 雨函 的 handoff artifact

下面是一次实际调用的完整数据流，从雨函传入的 input 到叶洋返回的 user prompt 字符串都展开。**叶洋拿这份当目标对照，照着实现就对**。

##### Step A — 雨函传给叶洋的 input

```ts
const args: GetRuleCheckPromptArgs = {
  inputs: {
    candidate_id: "cand_a3f1",

    resume: {
      name: "张三",
      email: "zhangsan@example.com",
      phone: "13800000000",
      location: "上海",
      summary: "5 年高级前端经验，曾任阿里淘宝高级前端工程师，主导团队从 webpack 4 迁移到 vite 5",
      experience: [
        {
          title: "高级前端工程师",
          company: "阿里巴巴",
          location: "杭州",
          startDate: "2021-03",
          endDate: "2024-08",
          description: "负责淘宝交易链路前端架构；主导 webpack→vite 迁移，构建时间下降 60%",
          highlights: ["主导 webpack→vite 迁移", "团队规模 8 人"]
        },
        {
          title: "前端工程师",
          company: "字节跳动",
          location: "北京",
          startDate: "2018-07",
          endDate: "2021-02",
          description: "负责抖音电商业务前端开发，参与从 0 到 1 搭建商品详情页"
        }
      ],
      education: [
        { degree: "本科", field: "计算机科学", institution: "浙江大学", graduationYear: "2018" }
      ],
      skills: ["React", "TypeScript", "Node.js", "Webpack", "Vite", "Next.js"],
      certifications: [],
      languages: [{ language: "英语", proficiency: "CET-6 580" }]
    },

    job_requisition: {
      job_requisition_id: "jr_x99",
      client_id: "腾讯",
      client_business_group: "PCG",
      client_studio: null,
      client_department: null,
      client_job_title: "高级前端开发工程师",
      must_have_skills: ["React", "TypeScript", "Webpack"],
      nice_to_have_skills: ["Next.js", "GraphQL"],
      language_requirements: "CET-6 480 以上",
      degree_requirement: "本科",
      education_requirement: "全日制",
      age_range: { min: 25, max: 40 },
      work_years: 5,
      salary_range: "30k-50k",
      recruitment_type: "正编",
      interview_mode: "线下",
      negative_requirement: "不接受外包从业经历超过 2 年",
      tags: [],
      job_responsibility: "负责腾讯视频前端架构演进...",
      job_requirement: "5+ 年前端经验，精通 React 生态...",
      hc_status: "招聘中",
      created_at: "2026-05-01T10:00:00Z",
      updated_at: "2026-05-08T14:20:00Z"
    },

    hsm_feedback: null
  }
};

const userPromptString: string = await matchResumeActionObject.getRuleCheckPrompt(args);
```

##### Step B — 叶洋内部的 4 个维度提取

```ts
const dims = {
  client_id:      "腾讯",          // ← from job_requisition.client_id
  business_group: "PCG",           // ← from job_requisition.client_business_group
  studio:         null,             // ← from job_requisition.client_studio
  job_tags:       []                // ← from job_requisition.tags
};
```

##### Step C — 叶洋调陈洋 ontology API 抓到的 rules（示例返回）

```ts
const rules: Rule[] = [
  // 通用 step 1
  { rule_id: "10-17", rule_name: "高风险回流人员", applicable_client: "通用", step: 1, severity: "terminal", natural_language: "<见下方 D §3.1>", ... },
  { rule_id: "10-18", rule_name: "EHS 风险回流", applicable_client: "通用", step: 1, severity: "needs_human", ... },
  { rule_id: "10-16", rule_name: "被动释放人员", applicable_client: "通用", step: 1, severity: "needs_human", ... },
  { rule_id: "10-25", rule_name: "华为/荣耀竞对互不挖角", applicable_client: "通用", step: 1, severity: "needs_human", ... },
  { rule_id: "10-26", rule_name: "OPPO/小米竞对互不挖角", applicable_client: "通用", step: 1, severity: "needs_human", ... },
  // 通用 step 2
  { rule_id: "10-5",  rule_name: "硬性要求一票否决", applicable_client: "通用", step: 2, severity: "terminal", ... },
  { rule_id: "10-7",  rule_name: "期望薪资校验", applicable_client: "通用", step: 2, severity: "needs_human", ... },
  { rule_id: "10-8",  rule_name: "意愿度校验", applicable_client: "通用", step: 2, severity: "terminal", ... },
  { rule_id: "10-9",  rule_name: "履历空窗期标记", applicable_client: "通用", step: 2, severity: "flag_only", ... },
  { rule_id: "10-10", rule_name: "空窗期与职业稳定性", applicable_client: "通用", step: 2, severity: "terminal", ... },
  { rule_id: "10-12", rule_name: "学历年龄逻辑校验", applicable_client: "通用", step: 2, severity: "needs_human", ... },
  { rule_id: "10-14", rule_name: "语言能力硬性门槛", applicable_client: "通用", step: 2, severity: "terminal", ... },
  { rule_id: "10-15", rule_name: "特殊工时与出差意愿", applicable_client: "通用", step: 2, severity: "needs_human", ... },
  { rule_id: "10-54", rule_name: "负向要求匹配", applicable_client: "通用", step: 2, severity: "terminal", ... },
  // 通用 step 3
  { rule_id: "10-29", rule_name: "通用二次入职提醒", applicable_client: "通用", step: 3, severity: "flag_only", ... },
  // 腾讯客户级（不带 department condition）
  { rule_id: "10-38", rule_name: "腾讯历史从业经历核实触发", applicable_client: "腾讯", step: 1, severity: "needs_human", ... },
  { rule_id: "10-35", rule_name: "腾讯外籍候选人通道限制", applicable_client: "腾讯", step: 2, severity: "flag_only", ... },
  { rule_id: "10-47", rule_name: "腾讯婚育风险审视", applicable_client: "腾讯", step: 2, severity: "needs_human", ... },
  { rule_id: "10-27", rule_name: "腾讯亲属关系回避", applicable_client: "腾讯", step: 3, severity: "needs_human", ... },
  { rule_id: "10-45", rule_name: "腾讯正编转外包标记", applicable_client: "腾讯", step: 3, severity: "flag_only", ... },
  { rule_id: "10-46", rule_name: "正编转外包凭证校验", applicable_client: "腾讯", step: 3, severity: "needs_human", ... },
  // 腾讯部门级被维度过滤排除（业务部门=PCG，不激活）：
  // - 10-42 (CDG 专属)、10-43 (IEG+四大工作室)、10-3 (IEG 活跃流程)、10-40 (IEG/PCG/WXG/CSIG/TEG/S 线主动离职)
  // - 10-56 (腾娱互动子公司)
  // 这些 rule 的 condition_business_group 跟本次 PCG 不匹配，ontology API 已自动滤掉
];
// 共约 21 条
```

##### Step D — 叶洋返回给雨函的完整 user prompt 字符串

下面这段 markdown 就是 `userPromptString` 的完整内容（叶洋拼好返回给雨函的最终产物）：

````markdown
# Resume Pre-Screen Rule Check

## 1. 你的角色

你是一名简历预筛查员。系统会给你一份候选人的解析后简历，以及一个具体的客户原始需求（Job_Requisition）。你的任务是逐条检查下列所有规则，找出哪些规则在这份简历上命中，并把结果整理成结构化标签输出。

请特别注意：
- **不要给候选人打匹配分数。** 打分是下游 Robohire 的工作。
- 你的输出会驱动三种处理：DROP / PAUSE / KEEP。

## 2. Inputs

```json
{
  "candidate_id": "cand_a3f1",
  "client_id": "腾讯",
  "business_group": "PCG",
  "studio": null,
  "resume": {
    "name": "张三",
    "email": "zhangsan@example.com",
    "phone": "13800000000",
    "location": "上海",
    "summary": "5 年高级前端经验，曾任阿里淘宝高级前端工程师...",
    "experience": [
      {
        "title": "高级前端工程师",
        "company": "阿里巴巴",
        "location": "杭州",
        "startDate": "2021-03",
        "endDate": "2024-08",
        "description": "负责淘宝交易链路前端架构；主导 webpack→vite 迁移..."
      },
      {
        "title": "前端工程师",
        "company": "字节跳动",
        "location": "北京",
        "startDate": "2018-07",
        "endDate": "2021-02",
        "description": "负责抖音电商业务前端开发..."
      }
    ],
    "education": [
      { "degree": "本科", "field": "计算机科学", "institution": "浙江大学", "graduationYear": "2018" }
    ],
    "skills": ["React", "TypeScript", "Node.js", "Webpack", "Vite", "Next.js"],
    "certifications": [],
    "languages": [{ "language": "英语", "proficiency": "CET-6 580" }]
  },
  "job_requisition": {
    "job_requisition_id": "jr_x99",
    "client_job_title": "高级前端开发工程师",
    "must_have_skills": ["React", "TypeScript", "Webpack"],
    "nice_to_have_skills": ["Next.js", "GraphQL"],
    "language_requirements": "CET-6 480 以上",
    "degree_requirement": "本科",
    "age_range": { "min": 25, "max": 40 },
    "salary_range": "30k-50k",
    "negative_requirement": "不接受外包从业经历超过 2 年",
    "tags": [],
    "job_responsibility": "负责腾讯视频前端架构演进...",
    "job_requirement": "5+ 年前端经验，精通 React 生态..."
  },
  "hsm_feedback": null
}
```

## 3. Rules to check

### 3.1 通用规则 (CSI 级，所有客户必查)

#### 规则 10-17：高风险回流人员 [终止级]

如果候选人简历中曾在「华腾」或「中软国际」任职过，请定位那段历史经历，读取离职原因编码。当离职原因属于以下任一高风险类型时，请直接判定不予录用：A15（劳动纠纷及诉讼，YCH）、B8（有犯罪记录，YCH）、B7-1（协商解除劳动合同，YCH，有补偿金）、B3(1)（合同到期终止-技能不达标，YCH，有补偿金）、B3(2)（合同到期终止-劳动态度，YCH，有补偿金）。

命中此规则时，请在 `rule_flags` 数组中加一条 `result="FAIL"` 的记录，`evidence` 字段写明命中的具体编码。同时在 `drop_reasons` 数组里追加 `"10-17:high_risk_reflux"`。一旦此规则命中，候选人直接 DROP。

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
- 如果 **期望薪资 > 岗位上限**：粗略估算综合匹配度（凭技能、学历、经验等粗判，不用精算）。如果你判断匹配度低于 90 分，标 `result="FAIL"`、`drop_reasons` 加 `"10-7:salary_no_match"`；如果匹配度看起来在 90 分及以上，标 `result="REVIEW"`、`pause_reasons` 加 `"10-7:salary_negotiable"`。

`evidence` 字段一律写清楚候选人期望薪资和岗位薪资上限的具体数字。

#### 规则 10-8：候选人意愿度校验 [终止级]

如果候选人的求职期望中明确表示"对人力资源外包模式明确排斥"，由于我司业务以外包为主，请直接淘汰这位候选人。`rule_flags` 标 `result="FAIL"`，`evidence` 写"候选人在求职期望中明确排斥外包模式"，`drop_reasons` 加 `"10-8:outsourcing_rejected"`。

#### 规则 10-9：履历空窗期标记 [仅记录]

请检查候选人的职业时间线连续性：（a）从最终学历毕业月份到第一份工作开始月份的间隔；（b）任何相邻两段工作经历之间的间隔。

只要发现某段间隔超过 3 个月、并且没有给出原因说明，就需要打 flag。这条规则不阻断流程，标 `result="PASS"`，但在 `evidence` 写出空窗时段，并在 `resume_augmentation` 文本里追加"空窗期未说明：YYYY-MM 到 YYYY-MM（X 个月）"。

#### 规则 10-10：履历空窗期与职业稳定性 [条件分支]

第一步，逐个检查空窗期。如果某段空窗期超过 1 年，并且其原因说明带有消极描述（如"长时间找不到工作"、"不想上班"等），属于"严重职业风险"。请标 `result="FAIL"`，`drop_reasons` 加 `"10-10:severe_career_risk"`。

第二步，如果第一步没命中，再看职业稳定性：把所有工作段的总时长除以段数，如果平均每段不到 1 年，仍然让候选人通过，但要打个标记。这种情况标 `result="PASS"`，但在 `resume_augmentation` 追加"职业稳定性风险（命中规则 10-10）"。

#### 规则 10-12：学历年龄逻辑校验 [需人工复核]

用「毕业年份 - 出生年份」算出候选人毕业时的实际年龄，跟下列基准对比：专科约 21 岁、本科约 22-23 岁、硕士约 24-26 岁。如果偏差**达到 2 岁或以上**，需要人工核查（可能是跳级、复读、参军、休学、医学长学制等）。

命中时标 `result="REVIEW"`，`pause_reasons` 加 `"10-12:age_education_mismatch"`，通知招聘专员（InApp）。

#### 规则 10-14：语言能力硬性门槛 [条件分支]

只有当岗位 `tags` 包含"外语"、"海外"或"国际化"，**并且**岗位需求里明确要求语言证书时，这条规则才激活。激活后：完全无证书 → FAIL（`drop_reasons` 加 `"10-14:no_language_cert"`）；有证书但分数低于最低线 → FAIL（`"10-14:language_score_below"`）；只要求证书无分数线 → PASS；只有"英语流利"等模糊描述 → REVIEW（`"10-14:language_ambiguous"`，通知招聘专员）。

#### 规则 10-15：特殊工时与出差意愿 [需人工复核]

如果岗位 `tags` 包含"轮班"/"夜班"/"倒班"/"长期出差"任一项，由于这是候选人意愿问题，简历无法直接给答案，统一标 `result="REVIEW"`，`pause_reasons` 加 `"10-15:special_schedule_unconfirmed"`，通知招聘专员（InApp）。

#### 规则 10-54：负向要求匹配 [条件分支]

如果岗位 `negative_requirement` 非空，请检查候选人最近一段或核心工作经历是否命中。硬性排除项命中（用词如"不予录取"、"严禁"、"绝对不接受"）→ FAIL（`drop_reasons` 加 `"10-54:negative_match_terminal"`）。非硬性命中（用词如"不优先"）→ PASS，在 `resume_augmentation` 追加"负向要求软性命中（10-54）"。

#### 规则 10-29：通用二次入职提醒 [仅记录]

如果识别候选人曾在我司任职过、最近一次离职距今 < 3 个月，标 `result="PASS"`，`evidence` 写距今月数，`resume_augmentation` 追加"二次入职 - 距上次离职不足 3 个月"，`notifications` 加 HSM 的 InApp 通知。

### 3.2 客户级规则 (本次 client_id="腾讯")

#### 规则 10-38：腾讯历史从业经历核实触发 [需人工复核]

如果候选人简历的工作履历或职责描述里出现了"腾讯"、"腾讯外包"或腾讯子公司，立即暂停流程让 HSM 跟客户确认离场原因。

标 `result="REVIEW"`，`evidence` 写出腾讯相关的具体经历段落。`pause_reasons` 加 `"10-38:tencent_history_verify"`。`notifications` 加一条 HSM 的 InApp 通知："腾讯历史离场原因核实：候选人简历中包含腾讯相关工作经历，推荐流程已暂停，请与客户确认该候选人的真实离场原因并在系统中反馈核实结果。"

#### 规则 10-35：腾讯外籍候选人通道限制 [仅记录]

如果候选人国籍字段不是"中国"，按腾讯客户的合规要求，可推荐通道范围被锁定为"仅外籍人在国内工作品类通道"。这不淘汰候选人，但要打 flag。

标 `result="PASS"`，`evidence` 写"候选人国籍：<nationality>，可推荐通道锁定为外籍专项"。在 `resume_augmentation` 里追加"腾讯外籍通道锁定（10-35）"。

#### 规则 10-47：腾讯婚育风险审视 [条件分支]

如果候选人**性别为女、年龄超过 26 岁、且婚育情况为「未婚」或「已婚未育」**，按腾讯客户偏好需要走婚育风险审视。

粗略估算候选人在该岗位下命中加分项的比例（凭技能、经验等粗判）：达到一半或以上 → REVIEW（`pause_reasons` 加 `"10-47:tencent_marital_review"`，HSM Email 通知）；不到一半 → FAIL（`drop_reasons` 加 `"10-47:tencent_marital_block"`）。

#### 规则 10-27：腾讯亲属关系回避 [需人工复核]

只要是腾讯岗位，都要检查候选人利益冲突声明中是否有以下范围的亲属：配偶、父母、子女、兄弟姐妹及其配偶、配偶的父母及兄弟姐妹。如果上述任一亲属是腾讯正式员工/毕业生/实习生/外包人员，需要让 HSM 确认是否构成利益冲突。

标 `result="REVIEW"`，`evidence` 写出命中的亲属关系类型和对应人员所属的腾讯职位。`pause_reasons` 加 `"10-27:tencent_kin_conflict"`。`notifications` 加 HSM 的 Email 通知。

#### 规则 10-45：腾讯正编转外包标记 [仅记录]

如果候选人有腾讯**正式岗位**（不是外包）的工作经历，按合规要求要标记为"正编转外包受控"状态。`result="PASS"`，在 `resume_augmentation` 追加"正编转外包受控状态（10-45）"。

#### 规则 10-46：正编转外包凭证校验 [需人工复核]

如果候选人已经被规则 10-45 标记为"正编转外包受控"，请检查输入数据里是否已经上传"腾讯采购部门同意回流书面凭证"。如果没上传，需要先锁定流程。

标 `result="REVIEW"`，`pause_reasons` 加 `"10-46:reflux_cert_required"`，`notifications` 加 HSM Email。如果候选人完全没有腾讯正编经历（即 10-45 没被触发），那 10-46 也不适用，标 `result="NOT_APPLICABLE"`。

### 3.3 部门级规则 (本次 business_group="PCG", studio="无")

> 本次激活的部门级规则：无
>
> 注：腾讯部门级规则中，10-3 (IEG 活跃流程)、10-40 (IEG/PCG/WXG/CSIG/TEG/S 线主动离职冷冻)、10-42 (CDG 6 月绝对拦截)、10-43 (IEG 工作室回流互斥)、10-56 (腾娱互动子公司) 均不适用于 PCG 业务部门，已被 ontology API 自动滤除。

## 4. 决策结算逻辑

跑完全部 applicable 规则后：
1. 任一 `rule_flags[i].result == "FAIL"` → `overall_decision = "DROP"`
2. 否则任一 `result == "REVIEW"` → `overall_decision = "PAUSE"`
3. 否则 → `overall_decision = "KEEP"`

无论决策哪个，`rule_flags` 必须覆盖 §3 中**每一条**规则（不适用的写 NOT_APPLICABLE）。

## 5. 输出格式

返回严格符合下列结构的 JSON，不允许多余字段，不允许遗漏字段：

```json
{
  "candidate_id": "...",
  "job_requisition_id": "...",
  "client_id": "...",
  "overall_decision": "KEEP" | "DROP" | "PAUSE",
  "drop_reasons": ["<rule_id>:<short_code>"],
  "pause_reasons": ["<rule_id>:<short_code>"],
  "rule_flags": [
    {
      "rule_id": "...",
      "rule_name": "...",
      "applicable_client": "通用" | "<client>",
      "severity": "terminal" | "needs_human" | "flag_only",
      "applicable": true | false,
      "result": "PASS" | "FAIL" | "REVIEW" | "NOT_APPLICABLE",
      "evidence": "<引用简历原文>",
      "next_action": "continue" | "block" | "pause" | "notify_recruiter" | "notify_hsm"
    }
  ],
  "resume_augmentation": "<给 Robohire 的 markdown 标记段>",
  "notifications": [
    {
      "recipient": "招聘专员" | "HSM",
      "channel": "InApp" | "Email",
      "rule_id": "...",
      "message": "..."
    }
  ]
}
```

## 6. 提交前自检

- [ ] rule_flags 覆盖 §3 所有规则（不适用写 NOT_APPLICABLE）
- [ ] overall_decision 跟 drop_reasons / pause_reasons 一致
- [ ] 每条 evidence 引用了简历原文
- [ ] resume_augmentation 是给 Robohire 看的可读 markdown
- [ ] 不要给候选人打匹配分数
````

##### Step E — 雨函拿这段字符串接下来做什么

雨函的 RuleCheckAgent 拿到上面这一整段 markdown，**不解析、不修改、不拼接**，直接当作 LLM 的 user message：

```ts
const response = await llmGateway.complete({
  system: SYSTEM_PROMPT,        // 雨函固定常量（见 §3.6 Step 3）
  user:   userPromptString,     // ← 上面叶洋返回的整段 markdown
  response_format: { type: 'json_object' },
  temperature: 0.1,
});
```

LLM 返回的 `response.text` 期望是合法 JSON，雨函再做 parse + schema 校验（见 §3.6 Step 5-7）。

##### 关键观察

1. **叶洋的产出是字符串**，不是结构化对象 —— 雨函直接当 LLM input 用
2. **同一份 candidate + 不同 jr 时**，§2 / §3.1（部分）/ §3.2 / §3.3 都会变化；§1 / §4 / §5 / §6 完全不变
3. **同一份 jr + 不同 candidate 时**，只有 §2 的 `resume` 字段变化，其他全部不变
4. **prompt cache 优势**：§1 / §4 / §5 / §6 是固定字符串，可以完全缓存；§3.x（rules）按 (client × bg × studio × tags) 哈希后也可以缓存。日 100 简历的场景下，prompt cache 命中率应该 ≥ 80%，token 成本会显著降低

---

### 3.6 Boundary 6：AO → LLM 的 `RuleCheckAgent.evaluate()` 调用（**核心契约 2**）

| 维度 | 值 |
|------|----|
| 方向 | matchResumeAgent → RuleCheckAgent → LLM Gateway |
| 形式 | 同步函数调用 |
| Owner | 雨函（实现 RuleCheckAgent 类）|

#### Input schema（matchResumeAgent 给 RuleCheckAgent）

```ts
interface RuleCheckAgentEvaluateInput {
  candidate_id: string;
  resume: RoboHireParsedData;
  job_requisition: JobRequisition;
  hsm_feedback?: HsmFeedback | null;
}
```

#### Output schema（RuleCheckAgent 返回给 matchResumeAgent）

```ts
interface RuleCheckResult {
  candidate_id: string;
  job_requisition_id: string;
  client_id: string;

  // 总决策
  overall_decision: 'KEEP' | 'DROP' | 'PAUSE';

  // 命中详情
  drop_reasons: string[];        // ["10-17:high_risk_reflux", ...]
  pause_reasons: string[];       // ["10-25:huawei_under_3mo", ...]
  rule_flags: Array<{
    rule_id: string;             // "10-25"
    rule_name: string;
    applicable_client: '通用' | string;
    severity: 'terminal' | 'needs_human' | 'flag_only';
    applicable: boolean;
    result: 'PASS' | 'FAIL' | 'REVIEW' | 'NOT_APPLICABLE';
    evidence: string;            // 引用简历原文的命中证据
    next_action: 'continue' | 'block' | 'pause' | 'notify_recruiter' | 'notify_hsm';
  }>;

  // 给 Robohire 的 augmentation（KEEP 路径用）
  resume_augmentation: string;   // markdown,会拼到 resume 文本后

  // 待办通知（PAUSE 路径用）
  notifications: Array<{
    recipient: '招聘专员' | 'HSM';
    channel: 'InApp' | 'Email';
    rule_id: string;
    message: string;
  }>;
}
```

#### 雨函内部实现 — 7 步处理流程

整体类骨架：

```ts
// resume-parser-agent/lib/agents/rule-check-agent.ts (新建)

export class RuleCheckAgent {
  static readonly ROLE = '简历预筛查员';

  constructor(private deps: {
    actionObject: MatchResumeActionObject;   // 叶洋提供
    llmGateway:   LlmGateway;                 // 雨函现有 L3
  }) {}

  async evaluate(input: RuleCheckAgentEvaluateInput): Promise<RuleCheckResult> {
    // Step 1 ~ 7 见下方
  }

  // 私有辅助方法
  private validateAndParse(text: string): RuleCheckResult { /* ... */ }
  private assertDecisionConsistency(r: RuleCheckResult): void { /* ... */ }
}
```

**Step 1 — 接收 input**

matchResumeAgent (L1) 在某个 step.run 内调 `ruleCheckAgent.evaluate(input)`，传入：

| 字段 | 类型 | 来源 |
|------|------|------|
| `input.candidate_id` | string | 从 `RESUME_PROCESSED.candidate_id` 提取 |
| `input.resume` | `RoboHireParsedData` | 从 `RESUME_PROCESSED.parsed.data` 提取 |
| `input.job_requisition` | `JobRequisition` | 调 `getJobRequisition(jr_id)` 拿到 |
| `input.hsm_feedback` | `HsmFeedback \| null` | 调 `getHsmFeedback(...)` 拿到 |

雨函在调 evaluate 之前就要把这 4 个字段都准备好（matchResumeAgent 改造后的 `step.run('rule-check', ...)` 之前的步骤已经做了，见 §5）。

**Step 2 — 调叶洋的 actionObject 拿 user prompt**

```ts
const userPromptString: string = await this.deps.actionObject.getRuleCheckPrompt({
  inputs: input,
});
```

返回的字符串大约 8K-12K 字符的 markdown，包含 INPUT / RULES / OUTPUT 三段。雨函这边**不需要关心内部结构**，直接当作 LLM 的 user message 用。

如果 `getRuleCheckPrompt` 抛错（比如 ontology API 挂了），雨函的 `evaluate` 直接把异常往上抛 —— Inngest 的 `step.run` 会处理重试。

**Step 3 — 构造 system prompt**

system prompt 是固定常量：

```ts
private static readonly SYSTEM_PROMPT = `你是一名简历预筛查员。

严格按照 user 消息中的规则评估候选人，输出严格符合 schema 的 JSON。

边界约束：
- 不要给候选人打匹配分数（那是下游 Robohire 的工作）
- 不要超出 user 消息中规定的规则范围进行评估
- 不要在 evidence 里编造简历未提供的信息；缺字段一律标 NOT_APPLICABLE
- 输出必须是合法 JSON，不要在 JSON 外加任何文本`;
```

**Step 4 — 调 L3 `llmGateway.complete`**

```ts
const response = await this.deps.llmGateway.complete({
  system:          RuleCheckAgent.SYSTEM_PROMPT,         // Step 3 固定
  user:            userPromptString,                      // Step 2 来自叶洋
  response_format: { type: 'json_object' },               // 强制 JSON 输出
  temperature:     0.1,                                   // 稳定性
  max_tokens:      4096,                                  // 上限
});
```

`llmGateway.complete` 的契约：

```ts
interface LlmCompleteInput {
  system:           string;
  user:             string;
  response_format?: { type: 'json_object' } | { type: 'text' };
  temperature?:     number;
  max_tokens?:      number;
  model?:           'claude-sonnet-4-6' | 'claude-haiku-4-5' | 'kimi-2-6' | 'deepseek-v4';
}

interface LlmCompleteOutput {
  text:        string;            // 大模型输出的原始字符串（期望是合法 JSON）
  model_used:  string;
  prompt_tokens:    number;
  completion_tokens: number;
  cost_usd:    number;
  request_id:  string;
}
```

llmGateway 内部做的事（雨函现有基础设施）：
- 多模型路由（按 `model` 参数或全局 config）
- 自动重试（超时 / 5xx / rate limit，按 backoff 策略）
- token 计数与成本统计
- prompt cache（system prompt 不变时复用）
- 请求日志 + tracing

**Step 5 — 解析 LLM 输出 JSON**

```ts
let parsed: unknown;
try {
  parsed = JSON.parse(response.text);
} catch (e) {
  throw new NonRetriableError(
    `RuleCheckAgent: LLM 输出非合法 JSON。raw=${response.text.slice(0, 500)}`,
  );
}
```

JSON.parse 失败抛 NonRetriableError，因为这是 LLM 输出格式错，重试也不会变好（要换模型或调 prompt）。

**Step 6 — Schema 校验 + 业务一致性校验**

```ts
// 用 zod schema 强制结构一致
const result: RuleCheckResult = ruleCheckResultSchema.parse(parsed);
//                              ↑ 失败抛 ZodError → 雨函包装成 NonRetriableError

// 业务一致性二次校验：overall_decision 跟 reasons 互验
this.assertDecisionConsistency(result);

private assertDecisionConsistency(r: RuleCheckResult): void {
  if (r.overall_decision === 'DROP' && r.drop_reasons.length === 0) {
    throw new NonRetriableError('LLM 输出 overall_decision=DROP 但 drop_reasons 为空');
  }
  if (r.overall_decision === 'PAUSE' && r.pause_reasons.length === 0) {
    throw new NonRetriableError('LLM 输出 overall_decision=PAUSE 但 pause_reasons 为空');
  }
  if (r.overall_decision === 'KEEP'
      && (r.drop_reasons.length > 0 || r.pause_reasons.length > 0)) {
    throw new NonRetriableError(
      'LLM 输出 overall_decision=KEEP 但 drop_reasons/pause_reasons 非空',
    );
  }
  // 也可以加：rule_flags 是否覆盖了所有 applicable rules（需要从叶洋传入预期 rule_id 列表才能校验）
}
```

zod schema 单独放一个文件（`lib/agents/rule-check-agent.schema.ts`）：

```ts
import { z } from 'zod';

const ruleFlagSchema = z.object({
  rule_id:           z.string(),
  rule_name:         z.string(),
  applicable_client: z.string(),
  severity:          z.enum(['terminal', 'needs_human', 'flag_only']),
  applicable:        z.boolean(),
  result:            z.enum(['PASS', 'FAIL', 'REVIEW', 'NOT_APPLICABLE']),
  evidence:          z.string(),
  next_action:       z.enum(['continue', 'block', 'pause', 'notify_recruiter', 'notify_hsm']),
});

const notificationSchema = z.object({
  recipient: z.enum(['招聘专员', 'HSM']),
  channel:   z.enum(['InApp', 'Email']),
  rule_id:   z.string(),
  message:   z.string(),
});

export const ruleCheckResultSchema = z.object({
  candidate_id:        z.string(),
  job_requisition_id:  z.string(),
  client_id:           z.string(),
  overall_decision:    z.enum(['KEEP', 'DROP', 'PAUSE']),
  drop_reasons:        z.array(z.string()),
  pause_reasons:       z.array(z.string()),
  rule_flags:          z.array(ruleFlagSchema),
  resume_augmentation: z.string(),
  notifications:       z.array(notificationSchema),
}).strict();   // strict() 禁止多余字段
```

**Step 7 — 返回 `RuleCheckResult`**

```ts
return result;
// matchResumeAgent (L1) 据此做 KEEP/DROP/PAUSE 三分支决策（见 §5 完整伪代码）
```

---

#### 完整 evaluate() 实现（拼起来）

```ts
async evaluate(input: RuleCheckAgentEvaluateInput): Promise<RuleCheckResult> {
  // Step 2: 调叶洋
  const userPrompt = await this.deps.actionObject.getRuleCheckPrompt({ inputs: input });

  // Step 4: 调 L3
  const response = await this.deps.llmGateway.complete({
    system:          RuleCheckAgent.SYSTEM_PROMPT,
    user:            userPrompt,
    response_format: { type: 'json_object' },
    temperature:     0.1,
    max_tokens:      4096,
  });

  // Step 5: parse
  const parsed = this.validateAndParse(response.text);

  // Step 6: assert
  this.assertDecisionConsistency(parsed);

  // Step 7: return
  return parsed;
}

private validateAndParse(text: string): RuleCheckResult {
  let obj: unknown;
  try { obj = JSON.parse(text); }
  catch { throw new NonRetriableError(`RuleCheckAgent: LLM 输出非 JSON`); }

  const result = ruleCheckResultSchema.safeParse(obj);
  if (!result.success) {
    throw new NonRetriableError(`RuleCheckAgent: schema 不匹配 — ${result.error.message}`);
  }
  return result.data;
}
```

雨函的工作到此结束 —— 把 `RuleCheckResult` 返回给 matchResumeAgent (L1)，L1 根据 `overall_decision` 走分支。

---

#### 雨函的最小可交付（MVP）

```ts
// 最简实现，等 zod schema 完整后再加校验
export class RuleCheckAgent {
  constructor(private deps: { actionObject: MatchResumeActionObject; llmGateway: LlmGateway }) {}

  async evaluate(input: RuleCheckAgentEvaluateInput): Promise<RuleCheckResult> {
    const userPrompt = await this.deps.actionObject.getRuleCheckPrompt({ inputs: input });
    const response = await this.deps.llmGateway.complete({
      system: '你是简历预筛查员，输出 JSON',
      user: userPrompt,
      response_format: { type: 'json_object' },
      temperature: 0.1,
    });
    return JSON.parse(response.text) as RuleCheckResult;
  }
}
```

可以先用 MVP 跑通 e2e，再补 zod schema 校验、一致性校验、错误处理。

#### 真实输出示例（KEEP / DROP / PAUSE 各一）

**KEEP 示例**（候选人完全符合）：

```json
{
  "candidate_id": "cand_a3f1",
  "job_requisition_id": "jr_x99",
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
    { "rule_id": "10-17", "applicable": false, "result": "NOT_APPLICABLE", "evidence": "无华腾/中软经历", "...": "..." },
    { "rule_id": "10-25", "applicable": false, "result": "NOT_APPLICABLE", "evidence": "无华为/荣耀经历", "...": "..." },
    { "rule_id": "10-38", "applicable": false, "result": "NOT_APPLICABLE", "evidence": "无腾讯历史经历", "...": "..." },
    { "rule_id": "10-42", "applicable": true, "result": "PASS", "evidence": "目标岗位 PCG 不是 CDG", "...": "..." }
  ],
  "resume_augmentation": "## 预筛 flags\n- 通用红线: 全部通过\n- 腾讯特定: 无相关历史\n- 待人工: 无\n",
  "notifications": []
}
```

**DROP 示例**（候选人有华腾经历，离职编码 B8）：

```json
{
  "candidate_id": "cand_b9c2",
  "job_requisition_id": "jr_x99",
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
      "evidence": "曾在华腾任职 2020-05 至 2022-12,离职编码 B8(有犯罪记录-YCH)",
      "next_action": "block"
    }
  ],
  "resume_augmentation": "",
  "notifications": []
}
```

**PAUSE 示例**（候选人 2026-03 从华为离职）：

```json
{
  "candidate_id": "cand_d4e5",
  "job_requisition_id": "jr_x99",
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
      "evidence": "华为 2023-06 至 2026-03 离职 2 个月(< 3 个月冷冻期)",
      "next_action": "notify_recruiter"
    }
  ],
  "resume_augmentation": "",
  "notifications": [
    {
      "recipient": "招聘专员",
      "channel": "InApp",
      "rule_id": "10-25",
      "message": "竞对互不挖角待确认:候选人最近 3 个月内从华为/荣耀离职,请确认处理。"
    }
  ]
}
```

---

### 3.7 Boundary 7：AO → RAAS → Robohire 的 `matchResume` 调用（**契约不变**）

| 维度 | 值 |
|------|----|
| 方向 | matchResumeAgent → RAAS API Server → Robohire `/match-resume` |
| 触发 | 仅 KEEP 路径 |
| 改动 | **★ 契约不变**，仅 resume 字段值在调用前被拼上 augmentation |
| Owner | 张元军（RAAS adapter）+ Robohire team（核心匹配） |

#### Request schema（不变）

```ts
// 当前 [resume-parser-agent/lib/robohire.ts:101-107]
interface RoboHireMatchInput {
  resume: string;                  // ← KEEP 路径下,此处是 augmented_resume
  jd: string;
  candidatePreferences?: string;
  jobMetadata?: string;
}
```

#### AO 调用前如何拼装 `augmented_resume`（关键技巧）

```ts
const resumeText      = buildResumeText(parsedResume);   // 原始简历 markdown
const augmentation    = ruleCheckResult.resume_augmentation;
const augmentedResume = `${resumeText}\n\n${augmentation}`;

await matchResume(
  { resume: augmentedResume, jd: jdText },
  { traceId },
);
```

`augmented_resume` 长度比原 resume 多约 200-500 字符（augmentation 段），完全在 Robohire prompt 容量内。Robohire 的内部 prompt 在读 resume 文本时会自然读到 augmentation 段，会把 flags 作为额外信号纳入打分。

#### Response schema（不变）

```ts
interface RaasMatchResumeData {
  matchScore: number;               // 0-100
  recommendation: 'STRONG_MATCH' | 'GOOD_MATCH' | 'PARTIAL_MATCH' | 'WEAK_MATCH';
  summary?: string;
  matchAnalysis?: Record<string, unknown>;
  mustHaveAnalysis?: Record<string, unknown>;
  niceToHaveAnalysis?: Record<string, unknown>;
}
```

#### 真实示例

请求：

```json
{
  "resume": "# 张三\n\n## 工作经历\n- 阿里巴巴, 高级前端, 2021-03 ~ 2024-08...\n\n## 预筛 flags\n- 通用红线: 全部通过\n- 腾讯特定: 无相关历史\n",
  "jd": "职位: 高级前端\n必备技能:\n  - React\n  - TypeScript\n..."
}
```

响应：

```json
{
  "success": true,
  "data": {
    "matchScore": 87,
    "recommendation": "GOOD_MATCH",
    "summary": "候选人技术栈高度匹配,有大型业务经验,推荐进入面试",
    "matchAnalysis": {...},
    "mustHaveAnalysis": {...},
    "niceToHaveAnalysis": {...}
  },
  "requestId": "req_abc123",
  "savedAs": "match_xyz"
}
```

---

### 3.8 Boundary 8：AO → RAAS 的 `saveMatchResults` 调用

| 维度 | 值 |
|------|----|
| 方向 | matchResumeAgent → RAAS API Server |
| 改动 | **★ 扩字段**：`source` 枚举增加 `'rule_check_drop'`；新增 `rule_check_flags` JSON 字段 |
| Owner | 张元军 |

#### Request schema（扩展后）

```ts
interface SaveMatchResultsBody {
  source: 'need_interview' | 'no_interview' | 'rule_check_drop';   // ★ 新增 'rule_check_drop'
  candidate_id?: string;
  upload_id?: string;
  job_requisition_id: string;
  client_id?: string;

  // 匹配评分相关（KEEP 路径填,DROP 路径置 0）
  matchScore?: number;
  recommendation?: 'STRONG_MATCH' | 'GOOD_MATCH' | 'PARTIAL_MATCH' | 'WEAK_MATCH';
  summary?: string;
  matchAnalysis?: Record<string, unknown>;
  mustHaveAnalysis?: Record<string, unknown>;
  niceToHaveAnalysis?: Record<string, unknown>;

  // ★ 新增字段(无论 KEEP/DROP 都写)
  rule_check_flags?: RuleCheckResult['rule_flags'];
}
```

#### 调用示例（KEEP）

```json
{
  "source": "need_interview",
  "candidate_id": "cand_a3f1",
  "upload_id": "upl_a3f1",
  "job_requisition_id": "jr_x99",
  "client_id": "腾讯",
  "matchScore": 87,
  "recommendation": "GOOD_MATCH",
  "summary": "...",
  "rule_check_flags": [
    { "rule_id": "10-5", "result": "PASS", ... },
    ...
  ]
}
```

#### 调用示例（DROP）

```json
{
  "source": "rule_check_drop",
  "candidate_id": "cand_b9c2",
  "upload_id": "upl_b9c2",
  "job_requisition_id": "jr_x99",
  "client_id": "腾讯",
  "matchScore": 0,
  "recommendation": "WEAK_MATCH",
  "summary": "10-17:high_risk_reflux",
  "rule_check_flags": [
    {
      "rule_id": "10-17",
      "result": "FAIL",
      "evidence": "曾在华腾任职 2020-05 至 2022-12,离职编码 B8",
      ...
    }
  ]
}
```

---

### 3.9 Boundary 9：AO → Inngest 的 emit 事件

| 路径 | 事件 | 何时 emit |
|------|------|----------|
| KEEP  | `MATCH_PASSED_NEED_INTERVIEW` | matchResume 返回后 |
| DROP  | `MATCH_FAILED` | DROP 决策时 |
| PAUSE | （不 emit） | 仅 createHumanTask，等 HSM 反馈触发重试 |

#### Schema（KEEP / DROP 共用 [client.ts:109-121](resume-parser-agent/lib/inngest/client.ts#L109-L121)）

```ts
interface MatchPassedNeedInterviewData {
  upload_id: string;
  job_requisition_id: string;
  success?: boolean;
  data?: Record<string, unknown>;        // KEEP 路径放 RaasMatchResumeData;DROP 放 ruleCheck 摘要
  requestId?: string;
  savedAs?: string;
  error?: string;
}
```

#### KEEP 时 emit

```json
{
  "name": "MATCH_PASSED_NEED_INTERVIEW",
  "data": {
    "upload_id": "upl_a3f1",
    "job_requisition_id": "jr_x99",
    "success": true,
    "data": { "matchScore": 87, "recommendation": "GOOD_MATCH", ... },
    "requestId": "req_abc123"
  }
}
```

#### DROP 时 emit

```json
{
  "name": "MATCH_FAILED",
  "data": {
    "upload_id": "upl_b9c2",
    "job_requisition_id": "jr_x99",
    "success": true,
    "data": {
      "drop_reasons": ["10-17:high_risk_reflux"],
      "rule_check_summary": "..."
    }
  }
}
```

#### PAUSE 路径（不 emit）

PAUSE 路径只调 `createHumanTask` API（待新建），不 emit `MATCH_*` 事件。HSM 在 dashboard 处理后，由后端触发新的 `RESUME_REMATCH_REQUESTED` 事件（待新建），matchResumeAgent 重新跑一遍 rule check（这次输入的 `hsm_feedback` 非空）。

---

## 4. User Prompt 内部三段式结构

§3.5 中叶洋返回的 user prompt 字符串内部分三段：

### 4.1 段一：INPUT（runtime 注入）

```markdown
## 1. Inputs

```json
{
  "candidate_id": "cand_a3f1",
  "client_id": "腾讯",
  "business_group": "PCG",
  "studio": null,
  "resume": { "name": "张三", "experience": [...], ... },
  "job_requisition": { "job_requisition_id": "jr_x99", ... },
  "hsm_feedback": null
}
```

### 4.2 段二：RULES（按 §3.4 维度过滤后的规则）

```markdown
## 2. Rules to check

### 2.1 通用规则 (CSI 级)
- 规则 10-17 高风险回流人员 [终止级]
  ...自然语言段落,见 docs/match-resume-rule-check-prompt.md §3.1...
- 规则 10-5 硬性要求一票否决 [终止级]
- 规则 10-25 华为/荣耀竞对互不挖角 [需人工]
- ...

### 2.2 客户级规则 (本次 client_id="腾讯")
- 规则 10-38 腾讯历史从业经历核实 [需人工]
- 规则 10-27 腾讯亲属关系回避 [需人工]
- ...

### 2.3 部门级规则 (本次 business_group="PCG")
> 因 business_group=PCG,以下专属规则不激活:
> 10-42 (CDG 专属) / 10-43 (IEG+四大工作室专属) / 10-56 (腾娱互动专属)
(本次无 PCG 专属规则,本节为空)
```

### 4.3 段三：OUTPUT（schema + 决策逻辑 + 自检）

```markdown
## 3. 决策结算逻辑
1. 任一 rule_flags[i].result == "FAIL"  → overall_decision = "DROP"
2. 否则任一 result == "REVIEW"          → overall_decision = "PAUSE"
3. 否则                                  → overall_decision = "KEEP"

## 4. 输出格式
返回严格符合下列结构的 JSON,不允许多余字段,不允许遗漏字段:
{
  "candidate_id": "...",
  "job_requisition_id": "...",
  "client_id": "...",
  "overall_decision": "KEEP" | "DROP" | "PAUSE",
  "drop_reasons": [...],
  "pause_reasons": [...],
  "rule_flags": [...],
  "resume_augmentation": "...",
  "notifications": [...]
}

## 5. 提交前自检
- [ ] rule_flags 覆盖 §2 所有规则(不适用的也要写 NOT_APPLICABLE)
- [ ] overall_decision 跟 drop_reasons / pause_reasons 一致
- [ ] 每条 evidence 引用了简历原文
- [ ] resume_augmentation 是给 Robohire 看的可读 markdown
- [ ] 不要打 matching score
```

完整规则自然语言文本见兄弟文档 [docs/match-resume-rule-check-prompt.md](docs/match-resume-rule-check-prompt.md) §3。

---

## 5. matchResumeAgent 改造伪代码

```ts
// resume-parser-agent/lib/inngest/agents/match-resume-agent.ts

export const matchResumeAgent = inngest.createFunction(
  { id: 'match-resume-agent', name: 'Match Resume Agent (orchestrator)', retries: 2 },
  { event: 'RESUME_PROCESSED' },
  async ({ event, step, logger }) => {
    const data = unwrapResumeProcessedEvent(event.data);

    // ── Anchor 提取 ──
    const candidate_id = pickCandidateId(data);
    const upload_id    = pickUploadId(data);
    const employee_id  = pickEmployeeId(data);
    const jr_id        = pickJobRequisitionId(data);   // ★ 新字段(§3.2)

    if (!jr_id) {
      throw new NonRetriableError('RESUME_PROCESSED 缺 job_requisition_id');
    }

    // ── Boundary 3: 取 Job_Requisition ──
    const jobRequisition = await step.run('fetch-job-requisition', () =>
      getJobRequisition(jr_id),
    );

    if (jobRequisition.hc_status === '已关闭') {
      logger.warn(`[matchResume] jr_id=${jr_id} 已关闭,不匹配`);
      return { ok: true, skipped: 'jr_closed' };
    }

    const parsedResume = (data.parsed?.data ?? {}) as RoboHireParsedData;
    const resumeText   = buildResumeText(parsedResume);
    const jdText       = flattenRequirementForMatch(jobRequisition);

    // ── Boundary 4-5: RuleCheckAgent 同步调用(subagent) ──
    const ruleCheckResult = await step.run('rule-check', async () => {
      const hsm_feedback = await getHsmFeedback(candidate_id, jr_id);   // 可能 null
      return await ruleCheckAgent.evaluate({
        candidate_id,
        resume: parsedResume,
        job_requisition: jobRequisition,
        hsm_feedback,
      });
    });

    logger.info(
      `[matchResume] decision=${ruleCheckResult.overall_decision} ` +
      `drops=[${ruleCheckResult.drop_reasons.join(',')}] ` +
      `pauses=[${ruleCheckResult.pause_reasons.join(',')}]`,
    );

    // ── 决策分支 ──
    if (ruleCheckResult.overall_decision === 'DROP') {
      await step.run('save-drop', () =>
        saveMatchResults({
          source: 'rule_check_drop',
          candidate_id, upload_id, job_requisition_id: jr_id,
          client_id: jobRequisition.client_id,
          matchScore: 0,
          recommendation: 'WEAK_MATCH',
          summary: ruleCheckResult.drop_reasons.join('; '),
          rule_check_flags: ruleCheckResult.rule_flags,
        }),
      );
      await step.sendEvent('emit-fail', {
        name: 'MATCH_FAILED',
        data: {
          upload_id: upload_id ?? '',
          job_requisition_id: jr_id,
          success: true,
          data: { drop_reasons: ruleCheckResult.drop_reasons },
        },
      });
      return { ok: true, decision: 'DROP', drop_reasons: ruleCheckResult.drop_reasons };
    }

    if (ruleCheckResult.overall_decision === 'PAUSE') {
      for (const note of ruleCheckResult.notifications) {
        await step.run(`notify-${note.rule_id}`, () =>
          createHumanTask({
            recipient: note.recipient,
            channel:   note.channel,
            title:     `${note.rule_id}: 预筛挂起待确认`,
            message:   note.message,
            candidate_id,
            job_requisition_id: jr_id,
          }),
        );
      }
      // 不 emit MATCH_*,等 HSM 反馈触发重试
      return { ok: true, decision: 'PAUSE', pause_reasons: ruleCheckResult.pause_reasons };
    }

    // ── KEEP: 注入 augmentation 后调 Robohire ──
    const augmentedResume = `${resumeText}\n\n${ruleCheckResult.resume_augmentation}`;

    // ── Boundary 7: matchResume(契约不变) ──
    const matchData = await step.run('match-robohire', async () => {
      const r = await matchResume(
        { resume: augmentedResume, jd: jdText },
      );
      return { data: r.data, requestId: r.requestId, savedAs: r.savedAs };
    });

    // ── Boundary 8: saveMatchResults ──
    await step.run('save-match', () =>
      saveMatchResults({
        source: 'need_interview',
        candidate_id, upload_id, job_requisition_id: jr_id,
        client_id: jobRequisition.client_id,
        matchScore:        matchData.data.matchScore,
        recommendation:    matchData.data.recommendation,
        summary:           matchData.data.summary,
        matchAnalysis:     matchData.data.matchAnalysis,
        mustHaveAnalysis:  matchData.data.mustHaveAnalysis,
        niceToHaveAnalysis: matchData.data.niceToHaveAnalysis,
        rule_check_flags:  ruleCheckResult.rule_flags,
      }),
    );

    // ── Boundary 9: emit ──
    await step.sendEvent('emit-pass', {
      name: 'MATCH_PASSED_NEED_INTERVIEW',
      data: {
        upload_id: upload_id ?? '',
        job_requisition_id: jr_id,
        success: true,
        data: matchData.data,
        requestId: matchData.requestId,
        savedAs: matchData.savedAs,
      },
    });

    return { ok: true, decision: 'KEEP', matchScore: matchData.data.matchScore };
  },
);
```

---

## 6. 风险与缺口

### 6.1 RESUME_DOWNLOADED / RESUME_PROCESSED 缺 `job_requisition_id`（最高优先级）

当前 [client.ts:70-98](resume-parser-agent/lib/inngest/client.ts#L70-L98) 的 `ResumeProcessedData` 没有 `job_requisition_id` 字段。整个新设计阻塞依赖这个字段。

**修复**：
- 张元军：RAAS 在 `RESUME_DOWNLOADED` 中带 `job_requisition_id`
- 雨函：resumeParserAgent 透传到 `RESUME_PROCESSED`
- 类型：[client.ts](resume-parser-agent/lib/inngest/client.ts) 加 `job_requisition_id: string` 必填

### 6.2 RAAS 缺 `getJobRequisition(id)` API

当前 RAAS 只有 `getRequirementsAgentView`（列表），没有按 ID 单查 Job_Requisition 的 API。

**修复**：张元军新增 `GET /api/v1/job-requisitions/:id`，返回 §3.3 定义的 schema。

### 6.3 RAAS Job_Requisition 字段确认

§3.3 schema 中 `client_business_group / client_studio / tags / age_range` 这几个字段不一定 RAAS 现存。需要确认或补全。

**修复**：张元军 + 陈洋核对 RAAS DB schema 与 ontology Job_Requisition 节点 schema 的差异，对齐字段。

### 6.4 RAAS `saveMatchResults` 字段扩展

需扩 `source` 枚举增加 `'rule_check_drop'`；新增 `rule_check_flags` JSON 列。

**修复**：张元军。

### 6.5 ontology 缺 `getRulesForMatchResume` 维度查询 API

当前 ontology API 只能按 action 拉所有 rules，不能按 (client, business_group, studio, tags) 过滤。

**修复**：陈洋实现 §3.4 的 API。

### 6.6 ontology Rule 节点 severity 字段歧义

所有 rule 现状 `severity = "advisory"`。需要在 Rule 节点加 `gating_severity` 字段（terminal / needs_human / flag_only）。

**短期方案**：叶洋在 actionObject 内手工映射（一次性）。
**中期方案**：陈洋扩 ontology schema。

### 6.7 RoboHire `/parse-resume` 输出缺字段

[robohire.ts:41-52](resume-parser-agent/lib/robohire.ts#L41-L52) 的 `RoboHireParsedData` 缺：出生日期、国籍、婚育情况、利益冲突声明、空窗期、求职意向、历史任职记录、离职原因编码。

**短期方案**：LLM 在数据缺失时输出 `result="NOT_APPLICABLE"` + `evidence="简历未提供该字段"`。
**中期方案**：协调 Robohire team 扩展输出，或 RAAS DB 补字段后通过 `getCandidate` API 查出 merge。

### 6.8 `getHsmFeedback` API 缺失

规则 10-28 / 10-39 等需要 HSM 历史反馈作为输入。当前没有持久化机制。

**修复**：张元军新增 `GET /api/v1/hsm-feedback?candidate_id=&job_requisition_id=`。

### 6.9 `createHumanTask` API 缺失

PAUSE 路径需要往 RAAS humanTask 系统写入待办通知。

**修复**：雨函（如果 AO 已有 humanTask 子系统则直接用；否则需协商 RAAS 的 humanTask API 契约）。

---

## 7. 上线 checklist（按 owner）

### 张元军（RAAS 端）

- [ ] `RESUME_DOWNLOADED` 事件 schema 加 `job_requisition_id` 必填字段（§3.1）
- [ ] 新增 `GET /api/v1/job-requisitions/:id` API（§3.3）
- [ ] Job_Requisition schema 补 `client_business_group / client_studio / tags / age_range` 字段（§6.3）
- [ ] `saveMatchResults` 接受 `source: 'rule_check_drop'` 枚举值（§3.8）
- [ ] `match_results` 表加 `rule_check_flags` JSON 列（§3.8）
- [ ] 新增 `GET /api/v1/hsm-feedback` API（§6.8）
- [ ] (待定) 提供 `createHumanTask` API（§6.9）

### 陈洋（ontology 端）

- [ ] 新增 `getRulesForMatchResume({client_id, business_group, studio, job_tags})` API（§3.4）
- [ ] Rule 节点加 `gating_severity` 字段（或叶洋手工映射，短期可选）（§6.6）
- [ ] Rule 节点加 `condition_business_group / condition_studio / condition_tags_required` 维度过滤字段（§3.4 SQL）

### 叶洋（action layer 端）

- [ ] `MatchResumeActionObject.getRuleCheckPrompt(args)` 实现（§3.5）
- [ ] 内部调陈洋的 `getRulesForMatchResume`（§3.4）
- [ ] User prompt 三段式渲染逻辑（§4）：INPUT 段渲染 + RULES 段渲染（按通用/客户/部门三级分组）+ OUTPUT 段固定模板
- [ ] severity 手工映射表（短期方案，等陈洋补完字段后下线）

### 雨函（AO workflow 端）

- [ ] `ResumeProcessedData` 类型加 `job_requisition_id` 字段（§3.2）
- [ ] resumeParserAgent 透传 `job_requisition_id`（§6.1）
- [ ] 新建 `lib/agents/rule-check-agent.ts` 实现 `RuleCheckAgent` 类（§3.6）
- [ ] 新建 `lib/raas-api-client.ts` 加 `getJobRequisition(id)` 客户端方法（§3.3）
- [ ] 新建 `lib/raas-api-client.ts` 加 `getHsmFeedback(...)` 客户端方法（§6.8）
- [ ] 新建 `lib/human-task.ts` 实现 `createHumanTask(...)`（§6.9）
- [ ] [match-resume-agent.ts](resume-parser-agent/lib/inngest/agents/match-resume-agent.ts) 改造（§5 完整伪代码）
- [ ] 单元测试：mock LLM 输出，验证 KEEP/DROP/PAUSE 三种分支
- [ ] 集成测试：end-to-end 跑 RESUME_PROCESSED → MATCH_PASSED/FAILED

### 测试 & 上线

- [ ] 准备黄金集：每客户 30-50 份代表性简历 + 人工 label 期望 decision
- [ ] LLM 准确率评估：跑黄金集，准确率 ≥ 90% 才上线
- [ ] feature flag `RULE_CHECK_ENABLED` 默认 `false`，灰度 10% → 50% → 100%
- [ ] 监控指标：rule check 准确率 / LLM 调用延迟 / DROP/PAUSE/KEEP 比例 / Robohire 调用量减少幅度 / 单次匹配总耗时

---

## 8. 跟前置文档的关系

- [docs/match-resume-rule-check-prompt.md](docs/match-resume-rule-check-prompt.md) — **prompt 内容设计**：所有 rule 的自然语言文本模板（叶洋 §4 渲染时直接引用）
- 本文档 — **生成流水线 + I/O 契约**：所有边界的 input/output 类型 + 真实示例

两份文档配合阅读：
- 叶洋实现 `getRuleCheckPrompt` 时需要：本文 §3.5 的 input contract + §4 的三段式结构 + 兄弟文档 §3 的规则文本
- 雨函实现 `RuleCheckAgent` 时需要：本文 §3.6 的 evaluate 契约 + §5 的改造伪代码
- 陈洋实现 ontology API 时需要：本文 §3.4 的 query schema + Rule 节点字段定义
- 张元军扩 RAAS 时需要：本文 §3.1 / §3.3 / §3.8 / §6.1-6.4 / §6.8

---

*生成时间：2026-05-09（修订：以 I/O 契约为主线重构，明确每个边界的 input/output schema + 真实示例）*
*维护人：matchResumeAgent owner（雨函） + Action layer owner（叶洋） + Ontology owner（陈洋） + RAAS owner（张元军）*
