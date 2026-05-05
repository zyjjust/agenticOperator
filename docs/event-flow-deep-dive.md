# 事件流深度文档 — RAAS ↔ Agentic Operator

**最后更新**：2026-04-28
**适用版本**：AO + 3 个 agent（createJD / processResume / matchResume），本地 Docker Inngest，RoboHire prod API，**RAAS Dashboard Internal HTTP API**（getRequirementById）。

---

## 0. 一图看完

```
                   ┌──────────────────────────────────────────────────────┐
                   │              Inngest dev (Docker, :8288)             │
                   │           事件总线 + 持久化 + fan-out + retry         │
                   └──────────────────────────────────────────────────────┘
                          ▲                        ▲                        ▲
                          │                        │                        │
                          │ ① REQUIREMENT_LOGGED   │                        │
                          │ ④ RESUME_DOWNLOADED    │                        │
                          │                        │                        │
              ┌───────────┴───────────┐            │            ┌───────────┴───────────┐
              │                       │            │            │                       │
              │       RAAS            │            │            │      AO (此项目)       │
              │                       │            │            │                       │
              │  - dashboard form     │            │            │  ┌─ createJD       4   │
              │  - MinIO uploader     │   ② JD_GEN. + JD_APPR. │  ├─ processResume   9-1 │
              │  - jd-generated   fn  │ ────────────────────►  │  └─ matchResume    10  │
              │  - resume-processed fn│   ⑤ RESUME_PROCESSED   │                       │
              │  - match-outcome  fn  │ ────────────────────►  │  + agentic ON/OFF      │
              │  - 入库 Cand/Resume   │   ⑥ MATCH_*            │  + AgentActivity log    │
              │                       │ ────────────────────►  │                       │
              └───────────────────────┘                        └───────────────────────┘

         ① REQUIREMENT_LOGGED ──► createJD ─┬─► ② JD_GENERATED  ──► RAAS jd-generated fn
                                            └─► ③ JD_APPROVED   (auto, 跳过人工)
                                                     ↓
              [RAAS 自己: 发布 JD 到 BOSS / 智联 → HR 收回简历 → 上传 MinIO]
                                                     ↓
         ④ RESUME_DOWNLOADED   ──► processResume ┬─► ⑤ RESUME_PROCESSED ──► RAAS resume-processed fn
                                                  └─► AO_MATCH_REQUESTED  (内部级联)
                                                           ↓
                                                       matchResume
                                                           │
                                                           ├─► ⑦ HTTP GET RAAS Dashboard Internal API
                                                           │   :3001/api/v1/internal/requirements
                                                           │   ◄── 拿到 must_have_skills/nice_to_have_skills/...
                                                           │
                                                           └─► ⑥ MATCH_PASSED_* / MATCH_FAILED ──► RAAS match-outcome fn
```

**两条对话通道**：
1. **Inngest 异步事件总线**（双向）—— 6 条边界事件 + 1 条内部级联（AO_MATCH_REQUESTED）走这里。
2. **RAAS Dashboard Internal HTTP API**（AO → RAAS 单向同步）—— matchResume 用它拿**最新最权威的结构化需求数据**（must_have_skills、nice_to_have_skills、degree_requirement、work_years、language_requirements 等），喂给 RoboHire `/match-resume` 当 JD。

---

## 1. 事件分类（7 条事件）

| # | 事件名 | 谁发 | 谁订阅 | 边界 / 内部 |
|---|---|---|---|---|
| ① | `REQUIREMENT_LOGGED` | **RAAS** dashboard form | AO `createJD` | 边界（RAAS → AO） |
| ② | `JD_GENERATED` | AO `createJD` | **RAAS** `jd-generated` fn（落 JD 到 RAAS DB） | 边界（AO → RAAS） |
| ③ | `JD_APPROVED` | AO `createJD`（**auto**，跳过人工 jdReview）| **RAAS** 后续节点（assignRecruitTasks 等）| 边界（AO → RAAS） |
| ④ | `RESUME_DOWNLOADED` | **RAAS** （MinIO 上传后） | AO `processResume` | 边界（RAAS → AO） |
| ⑤ | `RESUME_PROCESSED` | AO `processResume` | **RAAS** `resume-processed` fn（入库 Candidate / Resume） | 边界（AO → RAAS） |
| ⑥ | `MATCH_PASSED_NO_INTERVIEW` / `MATCH_PASSED_NEED_INTERVIEW` / `MATCH_FAILED` | AO `matchResume` | **RAAS** `match-outcome` fn（更新 Candidate.match_score） | 边界（AO → RAAS） |
| ⑦ | `AO_MATCH_REQUESTED` | AO `processResume` | **AO** `matchResume` | 内部（AO → AO） |

> JD_REJECTED 和人工审核流（spec node 5 jdReview）暂不实现，createJD 完成后**自动 emit JD_APPROVED**。

> **6 条边界事件 + 1 条内部级联**。RAAS 那边一共要写 **3 个 Inngest fn**：`jd-generated`, `resume-processed`, `match-outcome`（match-outcome 同时订阅 3 条 MATCH_* 事件）。

---

## 2. 事件信封 — 全部 7 条统一格式

```json
{
  "name": "<EVENT_NAME>",
  "data": {
    "entity_type": "Job_Requisition" | "JobDescription" | "Candidate",
    "entity_id":   "<业务对象 ID 或 null>",
    "event_id":    "<每条事件唯一 UUID>",
    "payload":     { /* 业务字段，全 snake_case */ },
    "trace": {
      "trace_id":        "...",
      "request_id":      null,
      "workflow_id":     null,
      "parent_trace_id": null
    }
  }
}
```

**所有变化都在 `payload` 里**。`entity_type` 给路由用，`event_id` 给去重用，`trace` 给跨事件链路追踪用（partner 的 trace_id 我们透传）。

---

## 3. Inngest 在中间到底干了什么

### 3.1 事件流生命周期

每条事件从落总线到所有订阅者吃完，Inngest 做这 8 步：

```
publisher                 Inngest                          subscriber
   │                         │                                │
   │ ① POST /e/dev           │                                │
   │ ──────────────────────► │ ② SQLite persist               │
   │                         │   分配 internal_id              │
   │ ③ ack 200 + ids         │                                │
   │ ◄────────────────────── │                                │
   │                         │ ④ 查订阅表 → 列出所有订阅 fn    │
   │                         │ ⑤ POST <subscriber>/api/inngest │
   │                         │ ──────────────────────────────► │
   │                         │                                │ ⑥ run start
   │                         │                                │   按 step 顺序执行
   │                         │                                │
   │                         │ ⑦ 每个 step 完成时              │
   │                         │ ◄────────────────────────────── │   POST step output
   │                         │   持久化 (retry 时跳过)         │
   │                         │                                │
   │                         │ ⑧ step.sendEvent 时             │
   │                         │ ◄────────────────────────────── │   POST 新事件
   │                         │   重新走 ② → ⑤ 给下游           │
```

### 3.2 关键不变量

| 不变量 | 含义 |
|---|---|
| **at-least-once 投递** | 事件不丢，但订阅者可能收到重复 → fn 必须幂等（用 event_id 去重） |
| **step checkpointing** | 每个 `step.run` 完成后 Inngest 持久化 OUTPUT；fn 中途失败重试时已完成的 step 跳过（只重跑没完成的）|
| **step.sendEvent 事务化** | 在 fn 内部 emit 的事件**只有 fn 整体成功才落总线**；中途失败不会留下脏事件 |
| **fan-out 并行** | 多个订阅者同时收到同一事件并行执行，互不阻塞 |
| **payload 不变形** | Inngest 是 raw passthrough，不会动 payload 字段名/类型/嵌套 |
| **持久化 7 天** | 事件落 SQLite 持久卷（`inngest-data` Docker volume），7 天内可重放 |

### 3.3 一个具体例子：RESUME_DOWNLOADED 进来后

```
t=0     RAAS POST :8288/e/dev  body={name:"RESUME_DOWNLOADED",data:{...}}
t+10ms  Inngest persist event_id=01KQ9... + 200 ACK 给 RAAS
t+15ms  Inngest 查订阅表 → 找到 AO processResume (function_id=2da7645e-...)
t+30ms  Inngest POST host.docker.internal:3002/api/inngest 通知 AO 起 run
t+35ms  AO Next.js /api/inngest serve handler 启动 processResume fn
t+50ms  step.run("check-agentic-toggle") → 完成，OUTPUT={enabled:true} → POST 回 Inngest
t+80ms  step.run("log-received") → 完成，OUTPUT 是 prisma.create() 的 row → POST 回
        ...开始 step.run("fetch-and-parse") (这一步是大头)
```

---

## 4. 7 条事件逐条解析

> 用一次完整的真实跑通做锚点：
>
> ```
> 12:03:00.733  REQUIREMENT_LOGGED         01KQ9ZH8VJWXT2ASYZS4DE8RJ1
> 12:03:06.781  JD_GENERATED               01KQ9ZHENZ1T9XCXCPQZZDHVZM   jd_id=jd_xxx
> 12:03:06.781  JD_APPROVED                01KQ9ZHEP7QTT6ERVKHTRK9ERM  (auto, 同时刻)
> 11:00:00      RESUME_DOWNLOADED          ...                          (上次跑的)
> 11:00:05      RESUME_PROCESSED           ...
> 11:00:05      AO_MATCH_REQUESTED         ...
> 11:00:27      MATCH_PASSED_NO_INTERVIEW  ...
> ```

---

### ① `REQUIREMENT_LOGGED` — RAAS → AO

**触发场景**：HR 在 RAAS 后台的"岗位信息"表单里填完所有字段（截图里那一大堆输入框：岗位名称 / 期望级别 / 招聘人数 / 薪资范围 / 城市 / 面试官 / 岗位职责 / 任职要求...），点保存。RAAS 通过 outbox → InngestEventPublisher 发出。

**Payload**：

```json
{
  "client_id": "4b887b02-...",          // 客户唯一 ID
  "is_urgent": false,
  "raw_input_data": {                    // ← 28 个表单字段，flat 结构
    "client_job_title": "游戏测试工程师",
    "client_job_type":  "游戏测试",
    "city":             "深圳",
    "headcount":        1,
    "salary_range":     "7k-11k",        // 字符串
    "expected_level":   "初2-中2",
    "priority":         "高",
    "deadline":         "2026-05-29",
    "start_date":       "2026-04-10",
    "first_interview_format":  "现场面试",
    "first_interviewer_name":  "张三",
    "final_interview_format":  "现场面试",
    "final_interviewer_name":  "李四",
    "job_responsibility": "1.负责游戏功能测试...（粗稿）",
    "job_requirement":    "1.计算机相关本科...（粗稿）",
    "sd_org_name":        "雷霆互动游戏事业部",
    "client_job_id":      "999",
    "job_requisition_id": "JRQ-{client_id}-{client_job_id}",
    ...还有 city_id / client_department_id / hro_service_contract_id 等 ID 字段
  },
  "requirement_id":  "JRQ-{client_id}-{client_job_id}",
  "source_channel":  "dashboard_manual"
}
```

**AO 这边 — `createJD` 收到后做什么**（[server/ws/agents/create-jd.ts](../server/ws/agents/create-jd.ts)）：

| step | 做什么 |
|---|---|
| 1. `check-agentic-toggle` | 读 `data/agentic-state.json`，关掉就 short-circuit |
| 2. `log-received` | 写一行 `event_received` 到 AgentActivity（含整个 payload）|
| 3. `generate` | a) 解析 `salary_range="7k-11k"` → min=7000 / max=11000<br>b) `prisma.jobRequisition.upsert` 临时存原始需求（cache 用）<br>c) **HTTP POST `http://10.100.0.70:3010/v1/chat/completions`**（new-api gemini）<br>d) 把 LLM 返回的结构化 JD 存到 `JobDescription` 表（cache）<br>e) 分配 `jd_id = "jd_<8>_<base36>"` |
| 4. `log-generated` | 写 `agent_complete`（含完整 LLM 输出）|
| 5. `emit-jd-generated` | `step.sendEvent("JD_GENERATED", ...)` |
| 6. `emit-jd-approved` (auto) | `step.sendEvent("JD_APPROVED", ...)` 同 payload + `auto_approved:true` |
| 7. `mark-approved` | `prisma.jobDescription.update` status="approved" |
| 8. `log-emitted` | 写 `event_emitted` |

**外部 HTTP 调用**：
- 1 次 LLM 调用（new-api gateway, gemini-3-flash-preview, 5-7 秒）
- 2 次 `step.sendEvent` 给 Inngest（JD_GENERATED + JD_APPROVED）

---

### ② `JD_GENERATED` — AO → RAAS

**Payload**：

```json
{
  "jd_id": "jd_1b02d196_moiic5d8",
  "title": "游戏测试工程师 (初/中级)",       // ← LLM 标准化后的职位名
  "requisition_id": "JRQ-4b887b02-...-999",
  "client": "雷霆互动游戏事业部",
  "jd_content": {                            // ← 完整可发布的 JD
    "title":          "游戏测试工程师 (初/中级)",
    "searchKeywords": ["游戏测试", "Game QA", "功能测试", "PerfDog", "TAPD"],
    "responsibilities": "- 负责移动端/PC端游戏的功能测试...\n- ...",
    "requirements":     "- 计算机相关专业本科及以上...\n- 1-3年专业游戏测试经验...",
    "niceToHaves":      "- 具备自动化测试脚本编写能力...",
    "companyIntro":     "雷霆互动是...",
    "salaryBenefits":   "月薪 7,000 - 11,000 CNY，五险一金...",
    "workArrangement":  "工作地点：深圳；面试形式：初试与复试均为现场面试..."
  },
  "quality_score": 92,
  "quality_suggestions": ["可以加上具体技术栈..."],
  "market_competitiveness": "中",
  "generator_version": "ao-llm@2026-04-28",
  "generator_model":   "google/gemini-3-flash-preview",
  "generated_at":      "2026-04-28T12:03:06.781Z"
}
```

**RAAS 那边 — `jd-generated` fn 应该做什么**：

```ts
// RAAS 侧伪代码
inngest.createFunction(
  { id: "jd-generated" },
  { event: "JD_GENERATED" },
  async ({ event }) => {
    const p = event.data.payload;
    await db.jobDescription.upsert({
      where: { id: p.jd_id },
      create: {
        id: p.jd_id,
        requisition_id: p.requisition_id,
        client: p.client,
        title: p.title,
        content: p.jd_content,        // 整段保存
        search_keywords: p.jd_content.searchKeywords,
        quality_score: p.quality_score,
        market_competitiveness: p.market_competitiveness,
        status: "draft",              // 等审核
      },
      update: { ... },
    });
  }
);
```

---

### ③ `JD_APPROVED` — AO → RAAS（**auto，跳过人工**）

**为什么有这条**：spec node 5 jdReview 是 Human step（HSM 审核 JD）。**当前阶段跳过人工审核**，createJD 在发出 JD_GENERATED 之后立刻自动 emit JD_APPROVED，让下游节点（assignRecruitTasks → publishJD → resumeCollection）不被人工卡住。

**Payload**：

```json
{
  "jd_id": "jd_1b02d196_moiic5d8",
  "client": "雷霆互动游戏事业部",
  "requisition_id": "JRQ-4b887b02-...-999",
  "approved_by": "auto-approve@createJD",      // ← 标识自动审核
  "title": "游戏测试工程师 (初/中级)",
  "jd_content": { ... },                       // 同 JD_GENERATED 整段
  "quality_score": 92,
  "auto_approved": true,
  "auto_approved_at": "2026-04-28T12:03:06.781Z",
  "auto_approved_reason": "human jdReview skipped per 2026-04-28 directive"
}
```

**对 RAAS 的含义**：`approved_by` 字段告诉 RAAS 这是自动通过，不要再开人工审核任务。

> **以后想接回人工审核**：删掉 createJD 里的 `emit-jd-approved` step，让 RAAS 自己起 jdReview 任务，HSM 在 RAAS UI 点通过/驳回，RAAS 发 JD_APPROVED 或 JD_REJECTED；JD_REJECTED 触发 createJD 重生成（已订阅）。

---

### ④ `RESUME_DOWNLOADED` — RAAS → AO

**触发场景**：HR 在 RAAS 后台从渠道（BOSS 直聘 / 智联）下载简历，文件被传到 MinIO `recruit-resume-raw` bucket。MinIO 上传完成后 RAAS emit。

**Payload**（partner 真实 shape）：

```json
{
  "upload_id":        "<uuid>",                       // ← RAAS 那边 resume_upload 表主键
  "bucket":           "recruit-resume-raw",
  "object_key":       "2026/04/<uuid>-【...】<候选人>.pdf",  // ← MinIO 路径
  "filename":         "【游戏测试...】谌治中 3年.pdf",
  "etag":             null,
  "size":             null,
  "hr_folder":        null,
  "employee_id":      "EMP-002",
  "source_event_name": null,
  "received_at":      "2026-04-28T11:00:00.000Z",
  "source_label":     "RAAS Web Console",
  "summary_prefix":   "手动上传简历",
  "operator_id":      "...",
  "operator_name":    "招聘小张",
  "operator_role":    "recruiter",
  "ip_address":       "127.0.0.1",
  "candidate_name":   null,
  "candidate_id":     null,
  "resume_file_path": "<同 object_key>",
  "jd_id":            "jd_1b02d196_moiic5d8"          // ← 关键！来自 ② JD_GENERATED
}
```

**关键字段**：
- `bucket` + `object_key` → AO 用 MinIO SDK 拉简历字节
- `upload_id` → AO 必须**原样回传**到 RESUME_PROCESSED
- `jd_id` → AO matchResume 用它精确查 JD

**AO `processResume` 内部做什么**（[server/ws/agents/sample-resume-parser.ts](../server/ws/agents/sample-resume-parser.ts)）：

| step | 做什么 | 外部 HTTP 调用 |
|---|---|---|
| 1. `check-agentic-toggle` | 读 toggle | — |
| 2. `log-received` | AgentActivity row | — |
| 3. `fetch-and-parse` ⭐ | a) **MinIO `getObject(bucket, object_key)`** 拉 PDF 字节<br>b) **RoboHire `POST /api/v1/parse-resume`** 发 multipart PDF<br>c) RoboHire 返回 30+ skill / 完整 experience / projects / education / certifications / languages / rawText<br>d) 失败时 fallback 到 `unpdf` + LLM gateway | **GET 10.100.0.70:9000/...** + **POST api.robohire.io/api/v1/parse-resume** |
| 4. `log-fetched` + `log-parsed` | AgentActivity rows，含 RoboHire 原响应 | — |
| 5. `emit-resume-processed` | `step.sendEvent("RESUME_PROCESSED", ...)` | — |
| 6. `emit-ao-match-requested` | `step.sendEvent("AO_MATCH_REQUESTED", ...)` 同 payload | — |
| 7. `log-emitted` | AgentActivity row | — |

> **⭐ 这就是"简历解析"的位置 — `processResume` 这个 agent 名字虽叫 process，但解析的核心动作（调 RoboHire `/parse-resume`）就在它内部 step 3**。不需要单独的 parseResume agent。

---

### ⑤ `RESUME_PROCESSED` — AO → RAAS

**Payload**：

```json
{
  // ─ 16 个 transport 字段（从 RESUME_DOWNLOADED 透传）─
  "upload_id":     "<同入参>",            // ← RAAS 用它定位 resume_upload 行
  "bucket":        "recruit-resume-raw",
  "object_key":    "...",
  "filename":      "...",
  "etag":          null,
  "size":          null,
  "hr_folder":     null,
  "employee_id":   "...",
  ...其余 transport 字段...,
  "jd_id":         "jd_1b02d196_moiic5d8",   // 透传

  // ─ 关键：RoboHire 响应的 data 字段，整段塞入 ─
  "parsed": {
    "data": {                                // ← RAAS 直接 JSON.stringify 存 raw_parse_result
      "name":           "谌治中",
      "email":          "1461406879@qq.com",
      "phone":          "18070573461",
      "location":       null,
      "summary":        "...热爱游戏行业...",
      "skills": {
        "technical": ["测试理论","游戏测试流程","黑盒测试方法",...],
        "soft":      ["沟通协作","问题定位",...],
        "languages": ["python"],
        "tools":     ["Xmind","Perfdog","TAPD","Airtest","unity 引擎","jira"],
        "frameworks":[],
        "other":     ["自动化脚本"]
      },
      "experience": [{
        "company":"厦门雷霆互动网络有限公司",
        "role":"游戏测试工程师",                     // ← 注意是 .role 不是 .title
        "location":"", "startDate":"2023.07", "endDate":"2026.01",
        "duration":"2年6个月",
        "description":"...", "achievements":[],
        "technologies":[], "employmentType":"full-time"
      }],
      "education": [{
        "institution":"西安理工大学高科学院",
        "degree":"本科", "field":"计算机科学与技术",
        "startDate":"2019.09", "endDate":"2023.07",
        "achievements":["英语四级证书","计算机三级证书"],
        "coursework":[]
      }],
      "projects": [
        { "name":"杖剑传说", "role":"...", "date":"...", "description":"...", "technologies":[...] },
        { "name":"超进化物语 2", "role":"...", "date":"...", "description":"...", "technologies":[...] }
      ],
      "certifications": [
        { "name":"英语四级证书", ... },
        { "name":"计算机三级证书", ... }
      ],
      "languages": [{"language":"英语","proficiency":"英语四级"}],
      "rawText": "<整份简历的纯文本，~3000+ 字>",
      "otherSections": { /* 自定义节段 */ }
    }
  },

  // ─ AO 加的诊断字段（RAAS 忽略即可）─
  "parser_version":     "ao+robohire@2026-04-28",
  "parser_mode":        "robohire",            // robohire / llm-fallback / llm-only
  "parser_request_id":  "req_xxx",
  "parser_cached":      true,                   // RoboHire 命中缓存
  "parser_duration_ms": 18712,
  "parsed_at":          "2026-04-28T11:00:05Z"
}
```

**RAAS 那边 — `resume-processed` fn 应该做什么**（spec §4 末尾）：

```ts
inngest.createFunction(
  { id: "resume-processed" },
  { event: "RESUME_PROCESSED" },
  async ({ event }) => {
    const p = event.data.payload;
    const data = p.parsed.data;            // ← RoboHire response data, 原样

    // 1. 用 upload_id 找 resume_upload 行
    const upload = await db.resumeUpload.findUnique({ where: { id: p.upload_id } });

    // 2. 候选人去重 (mobile_normalized + name)
    const candidate = await upsertCandidate({
      name: data.name,
      phone: data.phone,
      email: data.email,
      location: data.location,
      // experience[0].company / .role / education[最高] / skills...
    });

    // 3. 写 Resume 表 + 留底 raw_parse_result
    await db.resume.create({
      data: {
        upload_id: p.upload_id,
        candidate_id: candidate.id,
        jd_id: p.jd_id,                    // ← 简历 ↔ JD 的关联
        summary: data.summary,
        experience: data.experience,
        education: data.education,
        skills: data.skills,
        certifications: data.certifications,
        languages: data.languages,
        raw_parse_result: data,
      },
    });
  }
);
```

> **AO 这边对 RESUME_PROCESSED 不订阅** — 这是单向边界事件，AO 不消费自己发给 RAAS 的事件。

---

### ⑦ `AO_MATCH_REQUESTED` — AO 内部级联

> 编号⑦是因为它和⑤同时发出，但 AO 的 matchResume 需要订阅它而不是 RESUME_PROCESSED。

**为什么需要它**：

如果 matchResume 直接订阅 RESUME_PROCESSED，那同一条事件会被两个消费者消费 ——
- RAAS 的 `resume-processed` fn（合约规定）
- AO 的 matchResume（架构脏）

**partner 的 spec 明确说 RESUME_PROCESSED 是 AO 发给 RAAS 的事件**。所以 processResume 在发出 RESUME_PROCESSED 之后，**立刻再发一条同 payload 的 `AO_MATCH_REQUESTED`** 给自己用。Inngest 的 fan-out 机制让这两条事件同时落总线（同一 `ts`），下游各自吃各自的。

**Payload**：跟 RESUME_PROCESSED 一字不差，只是事件名换了。

**谁订阅**：只有 AO `matchResume`。RAAS 那边看到 `AO_*` 前缀就知道是 AO 内部的，不会订阅。

---

### ⑥ `MATCH_PASSED_NO_INTERVIEW` / `MATCH_PASSED_NEED_INTERVIEW` / `MATCH_FAILED` — AO → RAAS

**AO `matchResume` 内部做什么**（[server/ws/agents/match-resume.ts](../server/ws/agents/match-resume.ts)）：

| step | 做什么 | 外部 HTTP 调用 |
|---|---|---|
| 1. `check-agentic-toggle` | toggle | — |
| 2. `log-received` | AgentActivity row | — |
| 3. `resolve-jd` | 三段优先级查 JD：<br>① `payload.jd_id` 精确查找 → DB SELECT JobDescription<br>② `payload.job_requisition_id` 找最新 JD<br>③ filename 前缀模糊匹配（过渡兜底）<br>④ 都没找到 → MATCH_FAILED | DB SELECT |
| 4. `flatten-resume` | `payload.parsed.data.rawText` 取整份简历文本（~3000 字）| — |
| 5. `match` ⭐ | **HTTP POST `https://api.robohire.io/api/v1/match-resume`**<br>body: `{resume:"<3000字简历>", jd:"<完整 JD 文本>"}`<br>RoboHire 返回完整 match analysis（overallMatchScore, overallFit, matchAnalysis, mustHaveAnalysis, niceToHaveAnalysis, recommendations, areasToProbeDeeper, suggestedInterviewQuestions...）| **POST api.robohire.io/api/v1/match-resume** |
| 6. `log-match-complete` | AgentActivity row（含 jd 解析 + match 完整 JSON） | — |
| 7. outcome 决策 | score ≥ 80 → NO_INTERVIEW；60-79 → NEED_INTERVIEW；<60 → FAILED | — |
| 8. `emit-match-outcome` | `step.sendEvent(outcome, ...)` | — |
| 9. `log-emitted` | AgentActivity row | — |

**Payload**（以 MATCH_PASSED_NO_INTERVIEW 为例）：

```json
{
  // ─ 16 个 transport 字段（再透传一次）─
  ...

  "candidate_ref": {
    "name":  "谌治中",
    "phone": "18070573461",
    "email": "1461406879@qq.com"
  },

  "jd": {
    "source":              "by-jd-id",                     // 直接 DB 查的，不是 mock
    "jd_id":               "jd_1b02d196_moiic5d8",
    "job_requisition_id":  "JRQ-4b887b02-...-999",
    "client":              "雷霆互动游戏事业部",
    "title":               "游戏测试工程师 (初/中级)",
    "text":                "职位: ...\n关键词: ...\n薪资福利: ...\n岗位职责: ...\n任职要求: ...\n加分项: ..."
  },

  "match": {
    "data": {                                              // ← RoboHire match.data 整段
      "overallMatchScore": { "score":96, "grade":"A", "confidence":"High", "breakdown":{...} },
      "overallFit": {
        "verdict":"Strong Match",
        "hiringRecommendation":"Strongly Recommend",
        "summary":"候选人是...",
        "topReasons":[...],
        "interviewFocus":[...]
      },
      "matchAnalysis":     { "technicalSkills":{...}, "experienceLevel":{...} },
      "mustHaveAnalysis":  { "extractedMustHaves":{...}, "candidateMustHaves":{...}, "matchedMustHaves":[...] },
      "niceToHaveAnalysis":{ ... },
      "skillMatchScore":   { "score":92, "breakdown":{...}, "credibilityFlags":{...} },
      "experienceMatch":   { "candidate":"...", "required":"...", "yearsGap":"Meets requirement" },
      "experienceBreakdown":{ ... },
      "candidatePotential":{ ... },
      "areasToProbeDeeper":[ {area, priority, reason, validationQuestions, ...} ],
      "hardRequirementGaps":[],
      "transferableSkills":[],
      "preferenceAlignment":{ ... },
      "recommendations":   { "forCandidate":[...], "forRecruiter":[...], "interviewQuestions":[...] },
      "suggestedInterviewQuestions":[...]
    }
  },

  "outcome":            "MATCH_PASSED_NO_INTERVIEW",
  "reason":             null,
  "matched_at":         "2026-04-28T11:00:27Z",
  "matcher_version":    "ao+robohire@2026-04-28",
  "matcher_mode":       "robohire",
  "matcher_request_id": "req_xxx"
}
```

**RAAS 那边 — `match-outcome` fn**（订阅 3 条 MATCH_* 事件）：

```ts
inngest.createFunction(
  { id: "match-outcome" },
  [
    { event: "MATCH_PASSED_NO_INTERVIEW" },
    { event: "MATCH_PASSED_NEED_INTERVIEW" },
    { event: "MATCH_FAILED" }
  ],
  async ({ event }) => {
    const p = event.data.payload;
    await db.candidate.update({
      where: { phone: p.candidate_ref.phone, name: p.candidate_ref.name },
      data: {
        match_score: p.match.data.overallMatchScore.score,
        match_status: p.outcome,
        match_jd_id: p.jd.jd_id,
        match_summary: p.match.data.overallFit.summary,
        // ...
      },
    });
    if (p.outcome === "MATCH_PASSED_NEED_INTERVIEW") {
      // 触发面试邀约流程
    }
  }
);
```

---

## 5. 实测时间线 — 一次完整跑通

| 时刻 | 事件 / step | event_id | 谁触发 |
|---|---|---|---|
| 12:03:00.733 | `REQUIREMENT_LOGGED` 落总线 | `01KQ9ZH8VJWXT2ASYZS4DE8RJ1` | RAAS form |
| 12:03:00.770 | createJD `event_received` | — | Inngest dispatch |
| 12:03:06.700 | createJD `agent_complete` | — | LLM 生成 JD（~6 秒）|
| 12:03:06.781 | `JD_GENERATED` 落总线 | `01KQ9ZHENZ1T9XCXCPQZZDHVZM` | createJD step.sendEvent |
| 12:03:06.781 | `JD_APPROVED` 落总线（**auto**, 同 ts） | `01KQ9ZHEP7QTT6ERVKHTRK9ERM` | createJD step.sendEvent |
| 12:03:06.800 | RAAS jd-generated fn 收到 | — | Inngest fan-out |
| 12:03:06.800 | RAAS 后续节点收到 JD_APPROVED | — | Inngest fan-out |
| ⋮ | （RAAS 自己：JD 发布、HR 收简历、上传 MinIO） | | |
| 11:00:00 | `RESUME_DOWNLOADED` 落总线（含 jd_id）| ... | RAAS upload |
| 11:00:00.500 | processResume `event_received` | | Inngest dispatch |
| 11:00:00.520 | step.run("fetch-and-parse") 开始 | | |
| 11:00:00.594 | MinIO 拉 380KB 完成 | | HTTP GET 10.100.0.70:9000 |
| 11:00:05.150 | RoboHire `/parse-resume` 完成 | | HTTP POST api.robohire.io/api/v1/parse-resume (cache hit ~18s)|
| 11:00:05.219 | `RESUME_PROCESSED` 落总线 | ... | step.sendEvent |
| 11:00:05.220 | `AO_MATCH_REQUESTED` 落总线 | ... | step.sendEvent (同 ts) |
| 11:00:05.250 | RAAS resume-processed fn 收到 + 开始入库 | | (RAAS 侧) |
| 11:00:05.250 | matchResume `event_received` | | Inngest dispatch (并行) |
| 11:00:05.300 | matchResume `resolve-jd` 完成 | | DB SELECT |
| 11:00:26.560 | RoboHire `/match-resume` 完成 | | HTTP POST api.robohire.io/api/v1/match-resume (~21s) |
| 11:00:27.130 | `MATCH_PASSED_NO_INTERVIEW` 落总线 | ... | step.sendEvent |
| 11:00:27.150 | RAAS match-outcome fn 更新 Candidate | | (RAAS 侧) |

**关键并行**：11:00:05.250 那一瞬间，**RAAS 入库 fn + AO matchResume 同时启动**，不互相等。RAAS 不需要等匹配做完才能落 Candidate；matchResume 也不需要等 RAAS 落完才能开跑。

---

## 6. 三个锚点 ID — 数据怎么串成一条链

| ID | 出生点 | 用途 |
|---|---|---|
| `requisition_id` (`JRQ-{client_id}-{client_job_id}`) | RAAS form 提交时分配 | 整个生命周期（need → JD → 发布 → 简历 → 匹配 → 推荐）的根 ID |
| `jd_id` (`jd_<8>_<base36>`) | AO `createJD` 创建 JobDescription 时分配 | 关联简历 ↔ JD（多对一：一个 JD 收多份简历）|
| `upload_id` | RAAS 上传 MinIO 时分配 | RAAS 那边 `resume_upload` 表的主键，AO 必须**原样回传** |

```
REQUIREMENT_LOGGED         (requisition_id 出生)
    ↓ createJD
JD_GENERATED               (jd_id 出生，挂在 requisition_id 下)
JD_APPROVED  (auto)        (jd_id 透传)
    ↓ partner 发布 JD 到招聘渠道，把 jd_id 带过去
    ↓ ......
    ↓ partner 收到简历，上传 MinIO，发 RESUME_DOWNLOADED
RESUME_DOWNLOADED          (upload_id 出生 + 带回 jd_id)
    ↓ processResume
RESUME_PROCESSED           (upload_id + jd_id 透传)
AO_MATCH_REQUESTED         (同上)
    ↓ matchResume
MATCH_*                    (3 个 ID 全在 payload 里)
```

---

## 7. 失败 / 重试语义

| 失败场景 | Inngest 行为 | 业务影响 |
|---|---|---|
| createJD LLM 调用 timeout | step "generate" 失败 → fn 失败 → retries=1 重跑 → 已完成 step 跳过 | JD_GENERATED 晚 6-15 秒到 |
| RoboHire `/parse-resume` 返回 500 | step "fetch-and-parse" 内的 try/catch → fallback unpdf + LLM | RESUME_PROCESSED 仍出，`parser_mode="llm-fallback"` |
| RoboHire `/match-resume` 返回 500 | step "match" 内的 try/catch → fallback LLM | MATCH_* 仍出，`matcher_mode="llm-fallback"` |
| MinIO `NoSuchKey`（partner 给的路径不存在）| step throw → fn Failed → 不发 RESUME_PROCESSED → AgentActivity `agent_error` | RAAS 不会收到 RESUME_PROCESSED → partner 自查 |
| matchResume 找不到 JD | 直接发 `MATCH_FAILED` reason="No JD found" | 不会用 mock 兜底，fail loud |
| RAAS 那边 fn 处理慢 / 失败 | RAAS 的 retry 策略（默认 4 次指数退避） | 事件持久 7 天，不丢 |
| AO 进程挂了 | Inngest 把 fn 标 unreachable → 重启后从最后 checkpoint 续跑 | 中断几分钟也能续 |
| `agentic toggle = OFF` | 所有 3 个 agent 收到事件后立即 short-circuit | 事件还在总线上，开了之后再跑 |

---

## 8. RAAS partner 端的最小工程量

只需要写 **3 个 Inngest fn**：

| RAAS fn | 订阅事件 | 干什么 |
|---|---|---|
| `jd-generated` | `JD_GENERATED` | upsert JD content 到 RAAS DB；可选触发 jdReview 任务（人工审核流；目前我们 auto-approve 跳过了，所以可只观测）|
| `resume-processed` | `RESUME_PROCESSED` | 用 upload_id 找 resume_upload 行；按 spec §4 拍 Candidate / Resume 表 |
| `match-outcome` | `MATCH_PASSED_NO_INTERVIEW`, `MATCH_PASSED_NEED_INTERVIEW`, `MATCH_FAILED` (3 个事件 1 个 fn) | 更新 Candidate.match_score / match_status，决定后续流程 |

**JD_APPROVED 也可以订阅**用来推进后续节点（assignRecruitTasks / publishJD），但因为我们 auto-approve，partner 收到的就是已经 approved 的状态，可以直接进发布流程。

---

## 9. RAAS Dashboard Internal HTTP API（matchResume 用的同步通道）

事件总线之外，**AO 还会同步调用 RAAS 的 HTTP API** 拿权威结构化需求数据。这是 partner 在 Inngest 之外开的第二条对话通道。

### 9.1 接入信息

```
RAAS_INTERNAL_API_URL = http://172.16.1.143:3001
RAAS_AGENT_API_KEY    = <双方约好的共享密钥；不一致返回 401>
```

env 变量在 [.env.local](../.env.local)。

### 9.2 端点

```
GET  {RAAS_INTERNAL_API_URL}/api/v1/internal/requirements
Authorization: Bearer {RAAS_AGENT_API_KEY}
```

**Query 参数**：

| 参数 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `claimer_employee_id` | ✓ | string | 招聘人员 employee_id（来自 REQUIREMENT_LOGGED.payload.raw_input_data.create_by 或 sd_owner_id）|
| `scope` | optional | `claimed`(默认) / `watched` / `mine` | 过滤维度 |
| `page` | optional | int | 页码，默认 1 |
| `page_size` | optional | int | 默认 20，最大 100 |
| `status` | optional | string | "recruiting" 等需求状态 |
| `client_id` | optional | string | 客户 ID 过滤 |

**响应** `{ items, page, page_size, total, total_pages }`，每条 item 是 `RaasRequirement`：

```ts
type RaasRequirement = {
  job_requisition_id: string;          // ← 我们用它对齐
  client_id, client_job_id, client_job_title,
  first_level_department, work_city, headcount, status, priority,
  salary_range, publish_date, expected_arrival_date,

  // ── 简历匹配核心字段（这才是 RAAS 内部 API 真正给我们的价值）──
  job_responsibility: string,
  job_requirement: string,
  degree_requirement: string,          // "本科及以上"
  education_requirement: string,
  must_have_skills: string[],          // ← 已经是结构化数组
  nice_to_have_skills: string[],       // ← 已经是结构化数组
  language_requirements: string,
  negative_requirement: string,
  work_years: number,
  expected_level: string,
  interview_mode: string,
  required_arrival_date: string,
  gender: string | null,
  age_range: string | null,
  recruitment_type: string,

  our_application_count, headcount_filled,
  hsm_employee_id, assigned_hsm_name
}
```

### 9.3 错误码

| HTTP | 含义 | 处理 |
|---|---|---|
| 401 | AGENT_API_KEY 不匹配 | 检查两侧 key 一致 |
| 400 | 缺 claimer_employee_id | 补传 |
| 503 | RAAS 未就绪 | 稍后重试 |

### 9.4 在 matchResume 里的用法（[server/ws/agents/match-resume.ts](../server/ws/agents/match-resume.ts) `resolveJd`）

JD 解析现在按这 4 段优先级查（best signal first）：

```
1. RAAS Dashboard Internal API by job_requisition_id
   ✓ 拿到结构化 must_have_skills[] / nice_to_have_skills[] / degree_requirement
   ✓ 这是 partner 端实时数据（HSM 改了需求立刻反映）
   ✗ 需要 claimer_employee_id（从本地 JobRequisition.rawPayload cache 取）

2. local cache by exact jd_id
   → LLM-generated 完整 JD content（叙述好，结构化弱）

3. local cache by requisition_id
   → 同上，最新一版

4. filename title hint （过渡兜底）
   → partner 还没把 jd_id 塞进 RESUME_DOWNLOADED.payload 时退化用

→ 都没找到 → MATCH_FAILED reason="No JD"
```

**关键：路径 1 拿到的 RaasRequirement 通过 `flattenRequirementForMatch()` 拼成给 RoboHire `/match-resume` 的 jd 文本**，比 LLM-generated 的版本权威 —— must_have_skills 是 partner 直接给的结构化字段，不是 LLM 推断的。

### 9.5 emitted MATCH_* 事件里多出的字段

当 jd 是从 RAAS API 拿的，`payload.jd.source = "raas-internal-api"`，并且会带上 `payload.jd.raas` 字段：

```json
"jd": {
  "source": "raas-internal-api",
  "jd_id": "jd_xxx",
  "job_requisition_id": "JRQ-...",
  "client": "WXG",
  "title": "高级后端工程师",
  "text": "<flattened JD text 给 RoboHire 用的>",
  "raas": {
    "must_have_skills":     ["Go", "分布式系统", "MySQL"],
    "nice_to_have_skills":  ["Kubernetes", "Rust"],
    "degree_requirement":   "本科及以上",
    "work_years":           5,
    "expected_level":       "T4-T5",
    "language_requirements":"英语读写流利",
    "negative_requirement": "无",
    "priority":             "high",
    "salary_range":         "30-50k"
  }
}
```

让 RAAS match-outcome fn 不仅看到 RoboHire 的评分，也能看到匹配时用了什么 must-have / nice-to-have 当依据。

### 9.6 测试连接

```bash
# 直接测 RAAS 服务（用真实 key）
curl -H "Authorization: Bearer <REAL_KEY>" \
  "http://172.16.1.143:3001/api/v1/internal/requirements?claimer_employee_id=0000199059"

# 通过我们的 proxy（key 在 server side，浏览器看不到）
curl http://localhost:3002/api/raas/requirements?employee_id=0000199059

# 拿单条
curl "http://localhost:3002/api/raas/requirements?employee_id=0000199059&job_requisition_id=JRQ-..."
```

实测：现在 `172.16.1.143:3001` 已经响应（返回 `{"detail":"Authentication required"}`），只需要把 `RAAS_AGENT_API_KEY` 换成真实的 shared secret 就能通。

### 9.7 关于 "AO 不落库"

按 partner 协议，Candidate / Resume / 真正的 JD 都由 RAAS 入库。AO 这边的本地表只是辅助 cache：

| AO 表 | 作用 | 是否最终能去掉 |
|---|---|---|
| `JobRequisition` | 存 raw REQUIREMENT_LOGGED payload，给 matchResume 反查 claimer_employee_id 用 | ⚠️ 等 RAAS 在 RESUME_DOWNLOADED.payload 里直接带 `claimer_employee_id` 就能去掉 |
| `JobDescription` | LLM 生成的 JD content cache，作为 RAAS API 不可达时的 fallback | ⚠️ RAAS API 稳定后退化为 disaster recovery 用，可以缩减 |
| `AgentActivity` | UI live log（/agent-demo 用）| ❌ 不去掉，UI 需要 |

**理想终态**：matchResume 完全无状态，只调 RAAS API 拿 JD + RoboHire 匹配。这次接入 RAAS Internal API 就是朝这个方向走的第一步。

---

## 10. 一句话总结

> RAAS 和 AO 通过 Inngest 解耦，**6 条边界事件 + 1 条内部级联**。AO 的 3 个 agent (createJD / processResume / matchResume) 都用 `step.run` checkpoint 外部 HTTP 调用（MinIO / RoboHire / LLM gateway），失败重试不会重复花外部 API 配额。`step.sendEvent` 让事件在 fn 成功后才一次性落总线。**RESUME_PROCESSED 落总线的瞬间 RAAS 入库 fn 就启动了，和 AO 自己的 matchResume 完全并行**；createJD 在跳过人工审核的当前阶段会同时 emit JD_GENERATED + JD_APPROVED，让 RAAS 后续节点不被卡住。所有事件统一信封，`payload` snake_case，`event_id` 唯一，`upload_id` / `jd_id` / `requisition_id` 三个锚点 ID 把整条链串起来。
