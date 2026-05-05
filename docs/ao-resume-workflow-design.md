# Agentic Operator × RAAS 简历自动化工作流 — 设计文档

| 字段 | 值 |
|---|---|
| 状态 | Draft v1 |
| 日期 | 2026-04-27 |
| 范围 | `RESUME_DOWNLOADED` → `matchResume` 完成（schema workflow 9-1 + 10）|
| 目标 | 给 leader 演示"事件驱动 + 跨服务 agent 协作 + 真 LLM 含金量" |
| 涉及系统 | Agentic Operator (AO) · raas_v4 · Action_and_Event_Manager (@aem) · Inngest · MinIO · RoboHire |

---

## 0. TL;DR

AO 在 Inngest 总线上挂两个 Function（`ao-process-resume` 和 `ao-match-resume`），**订阅** RAAS 发出的 `RESUME_DOWNLOADED`，**调用** RoboHire 的 `/parse-resume` + `/match-resume`，**产出** `ao/resume.processed` → `ao/match.completed`。整套流不动 RAAS 一行代码、不写 RAAS 数据库，AO 的 6 个前端页面以 `ao/*` 事件为数据源。

---

## 1. 背景

三个相关系统：

- **Agentic Operator（AO）** —— `/Users/yuhancheng/Desktop/agenticOperator`，Next.js 16 控制面 UI，6 个页面（`/fleet`, `/workflow`, `/live`, `/events`, `/alerts`, `/datasources`），目前全部用 mock 数据。
- **raas_v4** —— `Action_and_Event_Manager/raas_v4/backend`，Node.js 后端，承担候选人采集 / JD 发布 / PG 入库 / 等业务主流程。Inngest client id `raas-backend`，事件命名 `app/<domain>.<action>`。
- **@aem (Action_and_Event_Manager)** —— Express + Prisma 后端，承担事件 IDE / Event Manager / Conductor pipeline 的治理层。Inngest client id `event-manager`，事件命名 `raas/<domain>.<action>`。

**关键事实**（已经过代码核实）：

- raas_v4 与 @aem 的 Inngest namespace **不重叠**：raas_v4 发 `app/*`，@aem 发 `raas/*`，没有交叉订阅。
- `RESUME_DOWNLOADED` / `JD_APPROVED` 等 UPPER_SNAKE_CASE 名字是 **Schema 层概念事件**，定义在 `Action_and_Event_Manager/data/events_20260423.json`。它们是否就是 Inngest 总线上的字符串 —— **由 RAAS 那边决定，需确认**（见 §10）。
- @aem 定义了 `raas/agent.command` 和 `raas/event.observed`，但 raas_v4 没有任何消费者（grep 零命中），所以**控制面方向暂时无现成通道**。

**AO 接入策略选择**（详见 §11 路线图）：本文档采用 **设计 D — 智能增强层**：AO 不替换 RAAS 现有 agent，**与之并行**，挂自己的 LLM 富化 agent，结果通过 `ao/*` 事件发布，互不污染。

---

## 2. Schema 模型（来自 `Action_and_Event_Manager/data/`）

| 概念 | 数量 | 角色 |
|---|---|---|
| **Event** | 33 | 状态转移信号（不可变事实），含 `payload.event_data[]` 与 `payload.state_mutations[]` |
| **Action** | 22 | 能力单元，含 `actor` (`Agent`/`Human`)、`trigger[]`（被哪些事件触发）、`inputs[]`、`outputs[]`、`submission_criteria`、`action_steps[].type` (`tool`/`manual`/`logic`) |
| **Workflow** | 22 | 执行剧本（"N 步流程"），含 `trigger`、`actions[]`、`triggered_event[]` |

**Schema → Inngest 几乎是 1:1 映射**：

| Schema | Inngest |
|---|---|
| Workflow | `inngest.createFunction()` |
| Workflow.trigger | function 的 `{ event: ... }` |
| Workflow.actions[] | 一系列 `step.run()` |
| action_step.type === 'tool' | `step.run` 调外部 API |
| action_step.type === 'logic' | `step.run` 纯计算 |
| action_step.type === 'manual' | `step.waitForEvent('hitl.*.resolved')` |
| Workflow.triggered_event | `step.sendEvent(...)` |
| Action.submission_criteria | function 入口的 guard / 早退 |
| Action.inputs / outputs | event payload 的 schema |
| Event.state_mutations | 持久化时要触达的数据对象 |

整个业务链路（happy path）：

```
SCHEDULED_SYNC → syncFromClientSystem → REQUIREMENT_SYNCED
   → analyzeRequirement → ANALYSIS_COMPLETED
   → clarifyRequirement → CLARIFICATION_READY
   → createJD → JD_GENERATED
   → [人] jdReview → JD_APPROVED
   → assignRecruitTasks → TASK_ASSIGNED
   → publishJD → CHANNEL_PUBLISHED
   → [人] resumeCollection → RESUME_DOWNLOADED   ★★★ 本 PoC 起点
   → processResume → RESUME_PROCESSED            ★ AO Agent #1
   → matchResume → MATCH_PASSED_*                ★ AO Agent #2，PoC 终点
   → inviteInternalInterview → ...
   → [其余 8 个节点 PoC 不做]
```

---

## 3. PoC 范围

**起点**：`RESUME_DOWNLOADED` 事件（来自 RAAS）
**终点**：`ao/match.completed` 事件（含 score + recommendation + 三种 outcome 之一）

**需要实现的 schema 节点**：

| Schema id | 名称 | 角色 | 实现方 |
|---|---|---|---|
| Workflow 9-1 | `processResume` | 简历解析、唯一性、完整性 | **AO Agent #1** |
| Workflow 10 | `matchResume` | 红线、硬性匹配、加分项、生成结果 | **AO Agent #2** |

**不在范围内**：interview / evaluation / package / submit 等下游 6 个 workflow（schema 层都已设计，二期再做）。

---

## 4. 事件契约（4 个事件）

| 事件名 | 发送方 | 订阅方 | 角色 |
|---|---|---|---|
| `RESUME_DOWNLOADED` | RAAS（raas_v4 中现有 agent） | AO Agent #1 | 输入信号 |
| `ao/resume.processed` | AO Agent #1 | AO Agent #2 + AO Recorder | 内部接力 |
| `ao/match.completed` | AO Agent #2 | AO Recorder + 任意观察者 | **PoC 终点** |
| `ao/workflow.failed` | 任一 step 失败时 | AO `/alerts` 页 | 统一错误通道 |

**为什么用 `ao/*` 前缀**：与 RAAS 的 `app/*` 和 @aem 的 `raas/*` 命名空间隔离，AO 的事件不会被 RAAS 现有 function 误消费；如果以后需要让 RAAS 反向订阅 AO 结果，再加一个 mirror agent 把 `ao/match.completed` 翻成 schema 标准名 `MATCH_PASSED_*` 即可。

### 4.1 `RESUME_DOWNLOADED` —— 来自 RAAS

按 schema [`events_20260423.json`](../Action_and_Event_Manager/data/events_20260423.json) 中 `RESUME_DOWNLOADED` 定义：

```ts
{
  name: "RESUME_DOWNLOADED",     // 等 RAAS 确认是这个还是 "app/resume.downloaded"
  data: {
    resume_file_id: string,      // required — MinIO 中的 object key
    jd_id: string,               // required — 关联的 JD
    client: string,              // required — 客户标识
    candidate_name?: string,
    source_channel?: string
  }
}
```

### 4.2 `ao/resume.processed` —— AO 内部接力

```ts
{
  name: "ao/resume.processed",
  data: {
    // 上游关联键
    resume_file_id: string,
    jd_id: string,
    client: string,

    // AO 自己分配的 ID（不写 RAAS PG）
    candidate_id: string,
    resume_id: string,
    process_status: "处理成功",   // 与 schema action.outputs.process_status 对齐

    // RoboHire /parse-resume 富化结果
    parsed_fields: {
      name: string,
      email?: string,
      phone?: string,
      location?: string,
      summary?: string,
      skills: string[],
      experience: Array<{ title, company, startDate, endDate, description }>,
      education: Array<{ degree, field, institution, graduationYear }>
    },
    robohire: {
      requestId: string,         // 留 audit
      cached: boolean,
      documentId?: string
    }
  }
}
```

### 4.3 `ao/match.completed` —— PoC 终点

```ts
{
  name: "ao/match.completed",
  data: {
    resume_file_id: string,
    jd_id: string,
    client: string,
    candidate_id: string,
    resume_id: string,

    // outcome 取值与 schema workflow 10 的 triggered_event 对齐
    outcome: "MATCH_PASSED_NEED_INTERVIEW" | "MATCH_PASSED_NO_INTERVIEW" | "MATCH_FAILED",

    // RoboHire /match-resume 结果
    score: number,                                  // 0-100
    recommendation: "STRONG_MATCH" | "GOOD_MATCH" | "PARTIAL_MATCH" | "WEAK_MATCH",
    summary: string,
    matchAnalysis: {
      technicalSkills: { score, matchedSkills, missingSkills },
      experienceLevel: { score, required, candidate, assessment }
    },

    // 红线/黑名单 stub
    redlineCheck: { passed: boolean, reasons: string[] },
    blacklistCheck: { passed: boolean },

    decided_at: string,
    robohire_request_id: string
  }
}
```

### 4.4 `ao/workflow.failed` —— 错误通道

```ts
{
  name: "ao/workflow.failed",
  data: {
    workflow: "processResume" | "matchResume",
    step: string,
    resume_file_id: string,
    jd_id: string,
    error: { type: string, message: string, requestId?: string },
    occurred_at: string
  }
}
```

---

## 5. Agent #1 — `ao-process-resume`

**对应 schema**：[workflow 9-1 `processResume`](../Action_and_Event_Manager/data/workflow_20260330%20(1).json) + [action `processResume`](../Action_and_Event_Manager/data/actions_20260323%20(1).json)

**触发**：`RESUME_DOWNLOADED`
**正常产出**：`ao/resume.processed`
**异常产出**：`ao/workflow.failed`

### 5.1 Step 拆解（严格映射 schema 的 `action_steps`）

| # | Step 名 | Schema 类型 | 实现要点 |
|---|---|---|---|
| 1 | `download-pdf-from-minio` | tool | `GET http://10.100.0.70:9001/<bucket>/<resume_file_id>`，返回 base64 让后续 step 可序列化复用 |
| 2 | `robohire-parse-resume` | tool | `POST https://api.robohire.io/api/v1/parse-resume`（multipart, file=PDF）— 对应 schema `parseResume` |
| 3 | `extract-key-fields` | tool | 从 RoboHire 返回里 pick `name` / `phone` / `email` / `skills` — 对应 schema `extractResumeInfo` |
| 4 | `validate-completeness` | logic | 检查 `name && phone && skills.length > 0`，不通过则发 `ao/workflow.failed` 并 return |
| 5 | `validate-uniqueness` | logic | 与 AO SQLite 中已有 candidate 比 `name + phone`（schema `validateCandidacy`，做候选人锁定）；冲突则 fail |
| 6 | `persist-to-ao-db` | logic | 写 AO 自己的 `Candidate` + `Resume` + `Application` 三张表 |
| 7 | `emit-resume-processed` | — | `step.sendEvent('ao/resume.processed', { … })` |

### 5.2 关键 step 伪码

```ts
// step 1
const pdfBase64 = await step.run('download-pdf-from-minio', async () => {
  const url = `http://10.100.0.70:9001/${BUCKET}/${event.data.resume_file_id}`;
  const r = await fetch(url, { headers: minioAuthHeader() });
  if (!r.ok) throw new NonRetryableError(`MinIO ${r.status}`);
  return Buffer.from(await r.arrayBuffer()).toString('base64');
});

// step 2
const parsed = await step.run('robohire-parse-resume', async () => {
  const form = new FormData();
  form.append(
    'file',
    new Blob([Buffer.from(pdfBase64, 'base64')], { type: 'application/pdf' }),
    `${event.data.resume_file_id}.pdf`
  );
  const r = await fetch('https://api.robohire.io/api/v1/parse-resume', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.ROBOHIRE_API_KEY}` },
    body: form,
  });
  const json = await r.json();
  if (!json.success) throw new Error(json.error);
  return { data: json.data, requestId: json.requestId, cached: json.cached };
});

// step 4 — schema 里 process_status 取值之一是 "信息缺失"
if (!parsed.data.name || !parsed.data.phone) {
  await step.sendEvent('emit-info-missing', {
    name: 'ao/workflow.failed',
    data: {
      workflow: 'processResume',
      step: 'validate-completeness',
      resume_file_id: event.data.resume_file_id,
      jd_id: event.data.jd_id,
      error: { type: 'RESUME_INFO_MISSING', message: '缺 name 或 phone' },
      occurred_at: new Date().toISOString(),
    },
  });
  return { skipped: true, reason: 'RESUME_INFO_MISSING' };
}

// step 7 — happy path
await step.sendEvent('emit-resume-processed', {
  name: 'ao/resume.processed',
  data: { /* §4.2 */ },
});
```

---

## 6. Agent #2 — `ao-match-resume`

**对应 schema**：[workflow 10 `matchResume`](../Action_and_Event_Manager/data/workflow_20260330%20(1).json) + [action `matchResume`](../Action_and_Event_Manager/data/actions_20260323%20(1).json)

**触发**：`ao/resume.processed`
**产出**：`ao/match.completed`

### 6.1 Step 拆解

| # | Step 名 | Schema 类型 | 实现要点 |
|---|---|---|---|
| 1 | `load-jd` | tool | 用 `event.data.jd_id` 拉 JD 文本 — **来源待 RAAS 确认**；PoC 阶段 hardcode 或从 AO seed 表取 |
| 2 | `validate-redline-blacklist` | logic | 对应 schema `validateRedlineAndBlacklist` —— PoC 全部 pass，留 hook |
| 3 | `match-hard-requirements` | logic | 对应 schema `matchHardRequirements` —— PoC 简化为：检查 RoboHire 返回的 `missingSkills.length` |
| 4 | `evaluate-bonus-and-reflux` | logic | 对应 schema `evaluateBonusAndCheckReflux` —— PoC stub |
| 5 | `robohire-match` | tool | `POST https://api.robohire.io/api/v1/match-resume`（JSON body）—— schema `generateMatchResult` 的实质 |
| 6 | `decide-outcome` | logic | score 阈值映射到三个分支（见下表） |
| 7 | `persist-match-result` | logic | 写 AO 的 `MatchResult` 表 + 更新 `Application.matching_score` |
| 8 | `emit-match-completed` | — | `step.sendEvent('ao/match.completed', { … })` |

### 6.2 分流规则（PoC 简化版）

| RoboHire matchScore | RoboHire recommendation | AO outcome | 业务含义 |
|---|---|---|---|
| ≥ 80 | `STRONG_MATCH` | `MATCH_PASSED_NO_INTERVIEW` | 直接进推荐包 |
| 60–79 | `GOOD_MATCH` | `MATCH_PASSED_NEED_INTERVIEW` | 需要面试 |
| < 60 | `PARTIAL_MATCH` / `WEAK_MATCH` | `MATCH_FAILED` | 不通过 |

> 阈值未来应与 RAAS 的"匹配规则"配置统一。PoC 阶段先用此清晰分段。

---

## 7. 整体流程图

```
                    ┌──────────── RAAS（不动）─────────────┐
                    │                                       │
                    │  Recruiter 上传 PDF → MinIO           │
                    │  RAAS emit  RESUME_DOWNLOADED         │
                    │   { resume_file_id, jd_id, client … } │
                    └────────────────┬──────────────────────┘
                                     │
                       Inngest Dev Server  10.100.0.70:8288
                                     │
                                     ▼
       ┌───────────────────────────────────────────────────────────┐
       │ AO Inngest function ①  ao-process-resume                  │
       │  ─────────────────────────────────────                    │
       │  1. download-pdf-from-minio                               │
       │       → http://10.100.0.70:9001/<bucket>/<file_id>        │
       │  2. robohire-parse-resume                                 │
       │       → https://api.robohire.io/api/v1/parse-resume       │
       │  3. extract-key-fields                                    │
       │  4. validate-completeness   ──fail──> ao/workflow.failed  │
       │  5. validate-uniqueness     ──fail──> ao/workflow.failed  │
       │  6. persist-to-ao-db        (AO SQLite)                   │
       │  7. emit ao/resume.processed                              │
       └───────────────────────────────┬───────────────────────────┘
                                       │
                                       ▼
       ┌───────────────────────────────────────────────────────────┐
       │ AO Inngest function ②  ao-match-resume                    │
       │  ─────────────────────────────────────                    │
       │  1. load-jd                                               │
       │  2. validate-redline-blacklist  (logic, stub)             │
       │  3. match-hard-requirements     (logic, simple)           │
       │  4. evaluate-bonus-and-reflux   (logic, stub)             │
       │  5. robohire-match                                        │
       │       → https://api.robohire.io/api/v1/match-resume       │
       │  6. decide-outcome  (score → 三个分支之一)                  │
       │  7. persist-match-result        (AO SQLite)               │
       │  8. emit ao/match.completed                               │
       └───────────────────────────────┬───────────────────────────┘
                                       │
                                       ▼
                          ★★★  PoC 终点  ★★★
                       ao/match.completed
              { outcome, score, recommendation, summary, … }
                                       │
                                       ▼
                          AO /events  实时刷新
                          AO /workflow 两个节点亮灯
```

---

## 8. 集成点细节

### 8.1 MinIO

- **Endpoint**：`http://10.100.0.70:9001/`
- **拉文件**：`GET <endpoint>/<bucket>/<resume_file_id>`
- **认证**：待确认（dev 可能匿名 GET，正式需 access key + secret key 走 AWS Signature V4）
- **建议 helper**：`lib/minio.ts` 暴露 `downloadResume(resume_file_id) → Promise<Buffer>`

### 8.2 RoboHire

- **Base URL**：`https://api.robohire.io`
- **Auth**：`Authorization: Bearer <ROBOHIRE_API_KEY>`（API key 在 Profile → API Keys 创建，scope 必须包含 `write`）
- **延迟**：parse 3-8s，match 5-15s；client timeout 设 120s
- **缓存**：parse 按 PDF 内容哈希缓存（`cached: true` 表示命中，不扣 LLM 配额）；match 不缓存
- **错误处理**：429 / 500 retry idempotent —— 在 `step.run` 里抛普通 Error 让 Inngest 自动重试；400 / 401 / 413 / 415 抛 `NonRetryableError` 防止无谓重试
- **Audit**：所有响应有 `requestId`，必须保留（demo 时点开 step 输出能看到，可在 RoboHire dashboard 反查）

### 8.3 Inngest

- **远端 dev server**：`http://10.100.0.70:8288`
- **环境变量**：
  ```
  INNGEST_DEV=http://10.100.0.70:8288
  INNGEST_BASE_URL=http://10.100.0.70:8288
  INNGEST_EVENT_KEY=dev
  INNGEST_SIGNING_KEY=dev
  ```
- **AO 在 Inngest 上的 client id**：建议 `ao-workflow`（区别于 raas_v4 的 `raas-backend` 和 @aem 的 `event-manager`）
- **Serve 端点**：`<AO_HOST>:<PORT>/api/inngest`
- **首次启动需手动注册一次**（因为远端 dev server 不会自动扫描我们的端口）：
  ```bash
  curl -X POST http://10.100.0.70:8288/fn/register \
    -H "Content-Type: application/json" \
    -d '{"url":"http://<AO_LAN_IP>:<PORT>/api/inngest"}'
  ```

---

## 9. AO 数据库 schema（SQLite via Prisma）

> AO 只写自己的 SQLite，**绝不**写 RAAS 的 PG。

```prisma
// prisma/schema.prisma 新增

model Candidate {
  id            String   @id @default(uuid())   // candidate_id
  name          String
  email         String?
  phone         String?
  location      String?
  source_channel String?
  client        String
  created_at    DateTime @default(now())

  resumes       Resume[]
  applications  Application[]

  @@unique([name, phone])  // 用于 step.validate-uniqueness 去重
}

model Resume {
  id              String   @id @default(uuid())   // resume_id
  candidate_id    String
  resume_file_id  String                          // MinIO key
  parsed_fields   String                          // JSON
  robohire_request_id String
  cached          Boolean
  created_at      DateTime @default(now())

  candidate       Candidate @relation(fields: [candidate_id], references: [id])
}

model Application {
  id               String   @id @default(uuid())
  candidate_id     String
  jd_id            String
  client           String
  matching_score   Float?
  outcome          String?  // MATCH_PASSED_NEED_INTERVIEW / NO_INTERVIEW / MATCH_FAILED
  created_at       DateTime @default(now())

  candidate        Candidate @relation(fields: [candidate_id], references: [id])
}

model MatchResult {
  id               String   @id @default(uuid())
  application_id   String
  score            Float
  recommendation   String
  summary          String
  match_analysis   String   // JSON
  redline_passed   Boolean
  blacklist_passed Boolean
  robohire_request_id String
  created_at       DateTime @default(now())
}

model EventObservation {  // 所有总线事件原样落地（用于 /events 页）
  id          String   @id @default(uuid())
  event_name  String
  event_id    String   @unique               // Inngest 内部 ID
  payload     String                          // JSON
  observed_at DateTime @default(now())

  @@index([event_name, observed_at])
}
```

---

## 10. 待 RAAS 同事确认事项

| # | 问题 | 阻塞程度 | 没确认前能不能动 |
|---|---|---|---|
| 1 | `RESUME_DOWNLOADED` 在 Inngest 总线上的真实事件名（`RESUME_DOWNLOADED` 直接发，还是 `app/resume.downloaded`）| 🔴 阻塞 | 可以先搭骨架，trigger 用占位符；答案到了改一行 |
| 2 | `resume_file_id` 的具体格式（完整路径 vs 仅 object key）和对应的 MinIO bucket 名 | 🔴 阻塞 | MinIO helper 可以先写，bucket 名作为环境变量后填 |
| 3 | MinIO 的认证方式（dev 是否匿名 GET？正式 access key 怎么领） | 🟠 部分阻塞 | dev 阶段假设匿名先跑；正式部署前补上 |
| 4 | `jd_id` 怎么换成 JD 全文 —— 是 MinIO、RAAS API、还是 ontology 表 | 🟠 部分阻塞 | PoC 可以先 hardcode JD 跑通 demo；正式接入后再换 |
| 5 | AO 发出的 `ao/match.completed` 是否需要 RAAS 反向消费（决定要不要 mirror 成 schema 标准名 `MATCH_PASSED_*`）| 🟡 不阻塞 | PoC 不影响，二期再决定 |
| 6 | RoboHire matchScore 阈值是否要跟 RAAS 现有评分模型对齐 | 🟡 不阻塞 | PoC 用 80/60 简单分段，后续可改 |

---

## 11. 实施计划

### 11.1 工程结构

```
agentic-operator/
├── docs/
│   └── ao-resume-workflow-design.md     ← 本文档
├── resume-parser-agent/                 ← 已有 PoC，保留作为参考
└── agentic-operator-workflow/           ← 新建（或原地扩展 resume-parser-agent）
    ├── package.json                     inngest, next, prisma
    ├── .env.local                       INNGEST_*, MINIO_*, ROBOHIRE_API_KEY
    ├── lib/
    │   ├── inngest/
    │   │   ├── client.ts                EventSchemas（§4 四个事件）
    │   │   └── functions/
    │   │       ├── process-resume.ts    Agent #1
    │   │       └── match-resume.ts      Agent #2
    │   ├── minio.ts                     downloadResume()
    │   ├── robohire.ts                  parse() / match()
    │   └── db.ts                        Prisma client
    ├── prisma/schema.prisma             §9 数据库 schema
    └── app/
        ├── api/inngest/route.ts         serve handler
        └── page.tsx                     最简状态面板（可省）
```

### 11.2 步骤（每一步都能 demo，避免最后大冒烟）

| Day | 任务 | 可演示物 |
|---|---|---|
| **D1 上午** | 搭骨架：复用 resume-parser-agent，加 EventSchemas、Prisma、注册到远端 Inngest | `npm run dev` 起服务，远端 Inngest UI 能看到 ao-workflow app |
| **D1 下午** | Agent #1 全套 step（MinIO + RoboHire 真调用） | 手动 send 一条 `RESUME_DOWNLOADED`，Stream 看到 `ao/resume.processed` |
| **D2 上午** | Agent #2 全套 step（含 RoboHire match） | 完整端到端：一条事件进，最终 `ao/match.completed` 出，含真分数 |
| **D2 下午** | EventObservation recorder + AO `/events` 页拆 mock | 页面实时刷新，能看到 4 行事件 |

> **里程碑判定**：D2 结束时一份真简历从 RAAS 进 → AO 屏幕上看到结构化数据 + 90+ 分 + 推荐结论，整段 demo ≤ 30s。

### 11.3 Day 0 准备（在等 RAAS 确认期间可并行做）

- 申请 RoboHire API key（`Profile → API Keys`，scope `write`），存到 1Password
- 准备 1-2 份测试 PDF（真实简历），手动上传到 MinIO 测试 bucket
- 准备 1-2 份测试 JD（明文 txt），用于 step "load-jd" hardcode

---

## 12. Demo 脚本（给 leader 的 2 分钟演示）

**演示者打开三个窗口**：

1. Inngest UI — `http://10.100.0.70:8288` → Stream
2. AO 控制台终端 — `npm run dev` 的 stdout
3. AO `/events` 页（浏览器）

**脚本**：

```
[00:00]  "这是 AO 的事件驱动 agentic workflow demo。"
         "RAAS 那边一旦有简历进来，我们 AO 这边的两个 agent 会自动接力处理。"

[00:10]  在 Inngest UI 手动 Send Event：
         {
           "name": "RESUME_DOWNLOADED",
           "data": {
             "resume_file_id": "demo/david-resume.pdf",
             "jd_id": "JD-FE-001",
             "client": "AcmeCorp",
             "candidate_name": "David"
           }
         }

[00:15]  Stream 中依次冒出：
         • RESUME_DOWNLOADED                         (来自 RAAS / 手动)
         • inngest/function.invoked                  (Agent #1 启动)
         • ao/resume.processed                       (Agent #1 完成)
         • inngest/function.invoked                  (Agent #2 启动)
         • ao/match.completed                        (Agent #2 完成)

[00:30]  AO /events 页同步出现这 5 行新事件。

[00:40]  点开 ao/match.completed 看 step 输入输出：
         - matchScore = 92
         - recommendation = STRONG_MATCH
         - matchedSkills: ["React", "TypeScript", "GraphQL", "Node.js"]
         - missingSkills: []
         - robohire_request_id = req_xxxxx  (可在 RoboHire dashboard 反查)

[01:00]  讲三件事：
         ① 事件驱动：每个 agent 只关心一类事件，加新 agent = 加新订阅
         ② 跨服务：RAAS 没动一行代码，AO 通过 Inngest 总线即可参与流程
         ③ 真 LLM：RoboHire 的 92 分是真实 GPT-4 调用结果，不是 mock

[01:30]  问答 / 结束
```

---

## 13. 风险与应对

| 风险 | 概率 | 影响 | 应对 |
|---|---|---|---|
| RoboHire 限流（429）| 中 | demo 卡住 | step.run 自动重试；demo 前先跑通 1-2 次预热缓存 |
| RoboHire LLM tail latency 超 15s | 中 | demo 看起来卡 | 客户端 timeout 120s；demo 时事先 cache 命中 |
| MinIO 认证方式 PoC 阶段不通 | 中 | step 1 失败 | 先用 hardcode 本地 PDF 跑通，MinIO 后接入 |
| RAAS 不同步 schema 变更（事件字段改了） | 低 | AO 解析报错 | EventObservation 表落地原始 payload；解析失败转 `ao/workflow.failed` 不阻断 |
| Inngest 远端 dev server 重启丢注册 | 中 | AO 收不到事件 | 把"主动注册"做成 npm script `npm run register`；启动 docs 提示 |
| AO 部署到云后无法被 10.100.0.70 反向连接 | 高（生产）| 无法收事件 | 生产环境用 Inngest Cloud（managed）替代自托管 dev server |

---

## 14. 路线图（PoC 之外）

本次 PoC 跑通后的演进路线（仅作记录，不在本文档实施范围内）：

| 阶段 | 内容 | 预估 |
|---|---|---|
| Phase 2 | 加 Agent #3 `ao-interview-evaluator`（订阅 `AI_INTERVIEW_COMPLETED`） | 1 天 |
| Phase 3 | 加 Agent #4 `ao-package-summarizer`（订阅 `PACKAGE_GENERATED`） | 1 天 |
| Phase 4 | EventObservation 通配订阅 + AO 6 页全部接真数据 | 2 天 |
| Phase 5 | mirror agent：把 AO 决策 mirror 成 schema 标准事件，让 RAAS 反向消费 | 跨团队对齐后 1-2 天 |
| Phase 6 | 控制面（暂停 / 重试 / HITL）—— 依赖 RAAS 实现 `raas/agent.command` consumer | 跨团队 1 周 |

---

## 15. 附录

### 15.1 关键文件路径

| 用途 | 路径 |
|---|---|
| 事件 schema | [`Action_and_Event_Manager/data/events_20260423.json`](../Action_and_Event_Manager/data/events_20260423.json) |
| Action schema | [`Action_and_Event_Manager/data/actions_20260323 (1).json`](../Action_and_Event_Manager/data/actions_20260323%20(1).json) |
| Workflow schema | [`Action_and_Event_Manager/data/workflow_20260330 (1).json`](../Action_and_Event_Manager/data/workflow_20260330%20(1).json) |
| @aem Inngest 事件常量 | [`Action_and_Event_Manager/packages/server/src/clients/inngestEvents.ts`](../Action_and_Event_Manager/packages/server/src/clients/inngestEvents.ts) |
| raas_v4 Inngest 客户端 | [`Action_and_Event_Manager/raas_v4/backend/packages/events/src/inngest-client.mjs`](../Action_and_Event_Manager/raas_v4/backend/packages/events/src/inngest-client.mjs) |
| raas_v4 matching service | [`Action_and_Event_Manager/raas_v4/backend/apps/api/src/modules/matching/job-matching.service.mjs`](../Action_and_Event_Manager/raas_v4/backend/apps/api/src/modules/matching/job-matching.service.mjs) |
| 现有 PoC（参考模板） | [`resume-parser-agent/`](../resume-parser-agent/) |
| RoboHire API 文档 | RoboHire 提供的 `api-external-resume-parsing-and-matching.md` |

### 15.2 术语

| 缩写 | 全称 | 说明 |
|---|---|---|
| AO | Agentic Operator | 本仓库 Next.js 控制面 UI |
| RAAS | Recruitment-as-a-Service | raas_v4，业务主流系统 |
| @aem | Action_and_Event_Manager | 事件治理后端 |
| HITL | Human-in-the-loop | 人工介入步骤 |
| MinIO | — | S3 兼容对象存储，存简历 PDF |
| RoboHire | — | LLM 驱动的简历解析 + 匹配 SaaS |
| Inngest | — | 事件总线 + 工作流引擎 |

### 15.3 RoboHire score → outcome 映射表（PoC）

| Score | RoboHire recommendation | AO outcome | 业务行动 |
|---|---|---|---|
| 80–100 | STRONG_MATCH | MATCH_PASSED_NO_INTERVIEW | 直接进推荐包 |
| 60–79 | GOOD_MATCH | MATCH_PASSED_NEED_INTERVIEW | 安排面试 |
| 40–59 | PARTIAL_MATCH | MATCH_FAILED | 不通过 |
| 0–39 | WEAK_MATCH | MATCH_FAILED | 不通过 |

---

**文档结束。**

下一步：在 RAAS 同事回 §10 的 Q1-Q3 之前，可并行执行 §11.3 Day 0 准备 + §11.2 D1 上午骨架搭建。
