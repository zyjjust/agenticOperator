# Workflow Agents · Inngest Functions 规格总览

> **范围**：当前 `resume-parser-agent/` 仓里部署的三个 Inngest functions（即业务侧 Workflow Agents），它们订阅的事件、I/O schema、与 RAAS / RAAS API Server 的协作方式、以及 AO-main ↔ RAAS Inngest 之间的事件桥接。
> **代码定位**：所有 agent runtime 都在 [resume-parser-agent/](../resume-parser-agent/) 子项目（`:3020`），AO-main（`:3002`）只跑 control-plane（UI、event manager、RAAS bridge），不再托管任何 agent 运行时。
> **最后核对的实现**：`workflow-a@2026-05-08`（见 [resume-parser-agent/lib/inngest/agents/create-jd-agent.ts:34](../resume-parser-agent/lib/inngest/agents/create-jd-agent.ts#L34)）。

---

## 0. 拓扑一图

```
                            ┌─────────────────────────────────────┐
                            │   RAAS Inngest (10.100.0.70:8288)   │
                            │  ─ "shared bus" — 双方共同订阅       │
                            └─────────────────────────────────────┘
                              ▲           ▲           ▲
              ① RAAS publish  │           │  ⑤ AO forward (回灌)
              REQUIREMENT_*   │           │  JD_GENERATED / RESUME_PROCESSED
              RESUME_DOWN-    │           │  MATCH_*
              LOADED          │           │
                              │           │
                              │           │ pull (raas-bridge: poll /v1/events)
                              │           │
                            ┌─┴───────────┴─────────────────────────┐
                            │  AO-main Inngest (local :8288)        │
                            │  agentic-operator-main app id         │
                            │  em.publish gateway · EventInstance    │
                            └────────────┬──────────────────────────┘
                                         │ fan-out (Inngest serve)
                                         ▼
                            ┌────────────────────────────────────────┐
                            │  resume-parser-agent (Next.js :3020)   │
                            │  app id: agentic-operator              │
                            │  /api/inngest serve handler            │
                            │                                        │
                            │   • createJdAgent       (workflow #4)  │
                            │   • resumeParserAgent   (workflow #9)  │
                            │   • matchResumeAgent    (workflow #10) │
                            └─────────┬──────────────────────────────┘
                                      │  HTTPS (Bearer AGENT_API_KEY)
                                      ▼
                            ┌────────────────────────────────────────┐
                            │  RAAS API Server (raas_v4 backend)     │
                            │  /api/v1/{...}                         │
                            │  • capability proxies → RoboHire       │
                            │  • persistence (Candidate / JD / Match)│
                            │  • read-only (requirements/...)        │
                            └────────────────────────────────────────┘
```

**关键约束**

- AO 与 RAAS 各自有独立的 Inngest dev server。AO → RAAS 由 [server/inngest/raas-forward.ts](../server/inngest/raas-forward.ts) 直接 POST 推送；RAAS → AO 由 [server/inngest/raas-bridge.ts](../server/inngest/raas-bridge.ts) 反向 poll。
- `resume-parser-agent` 注册到本地 `:8288`（同一台机器），不直接订阅 RAAS Inngest——它依赖 AO-main 的 `raas-bridge` 把 RAAS 上的事件中继下来后，由本地 Inngest fan-out 给 `:3020/api/inngest` 的 serve handler。
- agent 不允许直连 `api.robohire.io`、不允许直接读 RAAS 数据库；所有外部调用必须走 RAAS API Server（per ADR-0011 边界）。

---

## 1. Inngest client / Event 表（agent 侧）

定义见 [resume-parser-agent/lib/inngest/client.ts](../resume-parser-agent/lib/inngest/client.ts)。

```ts
new Inngest({
  id: 'agentic-operator',
  schemas: new EventSchemas().fromRecord<Events>(),
});
```

**事件名 → 数据 type** 映射（直接来自 `client.ts:236`）：

| Event Name | TS type (data field) | 出/入 | 主要订阅者 |
|---|---|---|---|
| `RESUME_DOWNLOADED` | `ResumeDownloadedData` | in (RAAS → AO) | `resumeParserAgent` |
| `RESUME_PROCESSED` | `ResumeProcessedData` | out (AO → RAAS) | `matchResumeAgent` (内部级联) + RAAS 自家入库 |
| `MATCH_PASSED_NEED_INTERVIEW` | `MatchPassedNeedInterviewData` | out (AO → RAAS) | RAAS `match-result-ingest-need-interview` |
| `MATCH_PASSED_NO_INTERVIEW` | 同上 | out | RAAS ingest fn (no-interview 通道, 当前未发) |
| `MATCH_FAILED` | 同上 | out | RAAS ingest fn (失败通道, 当前未发) |
| `REQUIREMENT_LOGGED` | `RequirementLoggedData` | in | `createJdAgent` |
| `CLARIFICATION_READY` | `RequirementLoggedData`（同 shape） | in | `createJdAgent` |
| `JD_REJECTED` | `RequirementLoggedData`（同 shape） | in | `createJdAgent` |
| `JD_GENERATED` | `JdGeneratedEnvelope` | out | RAAS `jd-generated-sync`（cascade-only，不再走入库订阅） |

> 在 AO-main 的 [server/em/schemas/builtin.ts](../server/em/schemas/builtin.ts) 还有一份兜底 zod schema（v1.0），覆盖 envelope `{ entity_type, entity_id, event_id, payload, trace }`，用于 `em.publish` 的 schema validation 和 `EVENT_REJECTED` 元事件生成。

`MAPPING_VERSION = '2026-04-28'`、`PARSER_VERSION = 'robohire@v1+map@2026-04-28'`（`client.ts:255`）—— Workflow A 实现已经把 schema 映射的责任挪到 RAAS 端，但版本号仍保留以便审计。

---

## 2. Function ① — `resumeParserAgent`（Workflow node 9）

**文件**：[resume-parser-agent/lib/inngest/functions/resume-parser-agent.ts](../resume-parser-agent/lib/inngest/functions/resume-parser-agent.ts)

```ts
inngest.createFunction(
  { id: 'resume-parser-agent', name: 'Resume Parser Agent', retries: 0 },
  { event: 'RESUME_DOWNLOADED' },
  async ({ event, step, logger }) => { … }
);
```

`retries: 0` 是有意——RAAS API 失败不自动重试，避免重复扣 RoboHire 配额或重写 RAAS DB（`resume-parser-agent.ts:37`）。

### 2.1 入参（`RESUME_DOWNLOADED`）

事件支持两种 envelope 形态（agent 用 `unwrapDownloadedEnvelope` 兼容，`resume-parser-agent.ts:259`）：

**A. RAAS canonical envelope**（生产）

```jsonc
{
  "entity_type": "ResumeUpload",
  "entity_id": "<upload_id>",
  "event_id": "01KQ973ZQB...",
  "payload": {
    "upload_id": "uuid",                    // ★ 必填，agent 反向定位 candidate
    "bucket": "recruit-resume-raw",         // ★ 必填
    "object_key": "2026/04/<…>.pdf",        // ★ 必填
    "filename": "张三.pdf",
    "etag": null,                           // 手动上传链路可能为 null
    "size": 380866,
    "mime_type": "application/pdf",
    "operator_employee_id": "EMP001",       // 招聘人员
    "operator_id": null,
    "client_id": "CLI001",
    "job_requisition_id": "JR_xxx",
    "received_at": "2026-04-28T12:57:14Z",
    "source_event_name": "ResumeUploaded"
  },
  "trace": { "trace_id": "…", "request_id": "…" }
}
```

**B. Flat (legacy / publish-test)**：直接铺平 payload 字段，可选带 `parsed.data`（已 parse 过的 RoboHire 结果，agent 会跳过 download+parse）。

> **必填校验**：`upload_id` + `bucket` + `object_key`，缺任意一个直接 `NonRetriableError`（4xx 不重试）。

### 2.2 内部流程

```
RESUME_DOWNLOADED
   │
   ├─ unwrap envelope, 抽 anchor (upload_id / bucket / object_key / employee_id / job_requisition_id)
   │
   ├─ pickParsedData() —— 事件里已带 parsed？
   │    ├─ Y → 用事件里的 parsed.data，跳过 download/parse
   │    └─ N → step.run("download-and-parse-<upload_id>"):
   │            ├─ ① GET  /api/v1/resumes/uploads/:upload_id/raw     → PDF Buffer
   │            ├─ ② POST /api/v1/parse-resume (multipart, file=Blob) → RaasParseResumeData
   │            └─ ③ MD5(pdfBuffer) → computed_etag (saveCandidate dedup 兜底)
   │
   ├─ step.run("save-candidate"):
   │     POST /api/v1/candidates  ({ upload_id, bucket, object_key, etag, mime_type,
   │                                operator_employee_id, parsed, robohire_request_id, … })
   │     ← { candidate_id, resume_id, is_new_candidate, is_new_resume, … }
   │
   └─ step.sendEvent("emit-resume-processed", { name: "RESUME_PROCESSED", data })
```

### 2.3 出参（`RESUME_PROCESSED.data` —— `ResumeProcessedData`）

```ts
{
  // transport（透传）
  bucket, objectKey, filename,
  hrFolder, employeeId, etag, size, sourceEventName, receivedAt,

  // anchor（matcher 必读）
  upload_id, employee_id,

  // parsed.data 透传（matcher 用作 resume-text 来源）
  parsed: { data: RaasParseResumeData },

  // ★ Workflow A 新增——下游不必再调 RAAS 反查
  candidate_id, resume_id,

  // 4-object nested（已废弃，保留为空对象，schema 映射全部由 RAAS 端处理）
  candidate: {}, candidate_expectation: {}, resume: {}, runtime: {},

  parsedAt, parserVersion: "v7-pull-model@2026-05-08",
}
```

**dual-track 注意**：v7 §4.8 起 RAAS 在 `saveCandidate` 后会自己再发一份 `RESUME_PROCESSED` 给 matcher。AO 这边仍 emit 一份做兜底，等 partner 全路径稳定后可去掉（`resume-parser-agent.ts:194-198` 的 TODO）。

### 2.4 错误处理

| 来源 | 处理 |
|---|---|
| RESUME_DOWNLOADED 缺 upload_id / bucket / object_key | `NonRetriableError`（不进入 step.run） |
| RAAS 4xx（除 429）on download/parse/saveCandidate | `NonRetriableError`（视为 agent payload bug） |
| RAAS 5xx / 429 / 网络 | 抛原 `RaasApiError`，Inngest `step.run` 自带重试一层（function 级 `retries:0` 不再重试整个 fn） |

---

## 3. Function ② — `createJdAgent`（Workflow node 4）

**文件**：[resume-parser-agent/lib/inngest/agents/create-jd-agent.ts](../resume-parser-agent/lib/inngest/agents/create-jd-agent.ts)

```ts
inngest.createFunction(
  { id: 'create-jd-agent', name: 'Create JD Agent (workflow node 4)', retries: 1 },
  [{ event: 'REQUIREMENT_LOGGED' }, { event: 'CLARIFICATION_READY' }, { event: 'JD_REJECTED' }],
  async ({ event, step, logger }) => { … }
);
```

`retries: 1` —— 网络抖动允许一次自动重试。

### 3.1 入参（`REQUIREMENT_LOGGED` / `CLARIFICATION_READY` / `JD_REJECTED`）

```jsonc
{
  "entity_type": "JobRequisition",
  "entity_id": "JR_xxx",                   // ★ Workflow A 标准锚点
  "event_id": "evt_…",
  "payload": {
    // 老格式（envelope.entity_id 缺失时兜底）
    "requirement_id": "JR_xxx",
    "client_id": "CLI001",
    "raw_input_data": { "job_requisition_id": "JR_xxx", … }
  },
  "trace": { "trace_id": "…" }
}
```

> **协议变更**：Workflow A 起 RAAS 不再在 payload 里塞 `raw_input_data` 28 字段；agent 只取 `entity_id`，详情走 `GET /api/v1/requirements/:id` 拉。

### 3.2 内部流程

```
REQUIREMENT_LOGGED / CLARIFICATION_READY / JD_REJECTED
   │
   ├─ pickRequisitionIdFromEnvelope() —— 优先 entity_id，回落到 payload.requirement_id
   │
   ├─ step.run("fetch-requirement-<jrid>"):
   │     GET /api/v1/requirements/:id
   │     ← { requirement, specification, siblings, latest_task, latest_analysis,
   │         analysis_history, clarification_rounds, manual_override_history, can_trigger_analysis }
   │
   ├─ buildPromptFromRequirement(req, spec) → free-text prompt (4-4000 chars)
   │     拼接：客户/岗位标题/招聘类型/期望级别/城市/HC/薪资/年限/学历/语言/面试形式/
   │            优先级/截止/期望到岗/独家委托/必备技能/加分技能/排除条件/原始责任与要求
   │
   ├─ step.run("generate-<jrid>"):
   │     POST /api/v1/generate-jd  ({ prompt, language: 'zh', companyName, department })
   │     ← { data: RaasGenerateJdData /* RoboHire camelCase 21 字段 */, meta: { stages } }
   │
   ├─ step.run("sync-jd-<jrid>"):
   │     POST /api/v1/jd/sync-generated
   │       body = { job_requisition_id, client_id,
   │                ...generateResult.data,                   // RoboHire camelCase spread
   │                must_have_skills, nice_to_have_skills,
   │                negative_requirement, language_requirements,
   │                expected_level, degree_requirement, education_requirement,
   │                work_years, interview_mode, recruitment_type,
   │                city: pickCityFromBoth() }                // string→array 转换
   │     ← { synced: true, job_posting_id, job_requisition_id }
   │
   └─ step.sendEvent("emit-jd-generated-<jrid>", { name: 'JD_GENERATED', data })
```

### 3.3 出参（`JD_GENERATED.data` —— `JdGeneratedEnvelope`）

```ts
{
  entity_type: 'JobDescription',
  entity_id: jdId,                              // jd_<8>_<base36 ts>
  event_id: <uuid>,
  payload: {
    // ① RoboHire generate-jd data 整段 spread（camelCase 21 字段，title/description/
    //    qualifications/hardRequirements/niceToHave/interviewRequirements/evaluationRules/
    //    benefits/salaryMin/Max/Currency/Period/Text/headcount/experienceLevel/education/
    //    employmentType/location/workType/companyName/department）
    ...jdData,

    // ② raas 关联（必带）
    job_requisition_id, client_id,

    // ③ partner-canonical normalized snake_case（与 sync-generated body 对齐）
    posting_title, posting_description,
    city: string[], salary_range,
    interview_mode, degree_requirement, education_requirement, work_years,
    recruitment_type, must_have_skills, nice_to_have_skills,
    negative_requirement, language_requirements, expected_level,

    // ④ 发布渠道用的 2 段独立字段
    responsibility, requirement,

    // ⑤ bookkeeping
    jd_id, claimer_employee_id, hsm_employee_id, client_job_id,

    // ⑥ 诊断字段
    search_keywords: string[], quality_score, quality_suggestions,
    market_competitiveness: '高'|'中'|'低',
    generator_version: 'workflow-a@2026-05-08',
    generator_model: 'raas-api/generate-jd',
    generated_at,
  },
  trace: <upstream trace>
}
```

> **JD_GENERATED 是 cascade-only 事件**：RAAS 端不再依赖订阅它来入库（`syncJdGenerated` 已经在 step 3 里把数据写进 RAAS DB 了）。事件本身只用于驱动后续节点（如 sync-to-publish-channel）。

### 3.4 错误处理

| 来源 | 处理 |
|---|---|
| 缺 `entity_id` / `requirement_id` | `NonRetriableError` |
| `RAAS_API_BASE_URL` / `AGENT_API_KEY` 未配置 | `NonRetriableError`（启动期就 fail-fast） |
| `getRequirementDetail` 4xx | `NonRetriableError` |
| `requirement.client_id` 缺 | `NonRetriableError`（sync-generated 必填） |
| prompt 长度 < 4 | `NonRetriableError` |
| `generateJd` / `syncJdGenerated` 4xx | `NonRetriableError` |
| `generateJd` / `syncJdGenerated` 5xx / 429 | 重抛 → step.run 重试 → function-level retry (1) |

---

## 4. Function ③ — `matchResumeAgent`（Workflow node 10）

**文件**：[resume-parser-agent/lib/inngest/agents/match-resume-agent.ts](../resume-parser-agent/lib/inngest/agents/match-resume-agent.ts)

```ts
inngest.createFunction(
  { id: 'match-resume-agent', name: 'Match Resume Agent (workflow node 10)', retries: 2 },
  { event: 'RESUME_PROCESSED' },
  async ({ event, step, logger }) => { … }
);
```

`retries: 2` —— RoboHire `/match-resume` 网络抖动多，允许两次。

### 4.1 入参（`RESUME_PROCESSED`）

直接是上一步 `resumeParserAgent` 发的 `ResumeProcessedData`（也兼容 envelope shape，见 `match-resume-agent.ts:283`）。**关键 anchor**：

```ts
{ upload_id, candidate_id, employee_id, parsed: { data: RaasParseResumeData }, … }
```

校验：`upload_id || candidate_id` 至少其一，`employee_id` 必填，否则 `NonRetriableError`。

### 4.2 内部流程

```
RESUME_PROCESSED
   │
   ├─ pickUploadId / pickCandidateId / pickEmployeeId
   │
   ├─ step.run("build-resume-text"):
   │     buildResumeText(data)  → JSON.stringify(parsed.data) 当 resume 文本
   │
   ├─ step.run("list-requirements"):
   │     GET /api/v1/requirements/agent-view?claimer_employee_id=<emp>
   │     ← { items: [...], page, page_size, total, total_pages }
   │     客户端兜底过滤：
   │       isRecruitingStatus()   —— status ∈ {recruiting / 招聘中 / active / open}
   │       hasMatchableContent() —— 必须有 job_responsibility / job_requirement / must_have_skills
   │
   └─ for (each requirement):
        ├─ step.run("match-<jrid>"):
        │     POST /api/v1/match-resume  ({ resume: <text>, jd: flattenRequirementForMatch(req) })
        │     ← { data: RaasMatchResumeData /* RoboHire 20+ 字段 */, requestId, savedAs }
        │     // 4xx 跳过该 JD（其他 JD 不受影响），5xx/429 抛重试
        │
        ├─ step.run("save-match-<jrid>"):
        │     POST /api/v1/match-results
        │       body = { ...matchResult.data,            // RoboHire camelCase 全字段
        │                source: 'need_interview',
        │                candidate_id, upload_id, job_requisition_id, client_id,
        │                robohire_request_id, savedAs }
        │     ← { upserted: true, candidate_match_result_id, source: 'need_interview' }
        │
        └─ step.sendEvent("emit-match-<jrid>", { name: 'MATCH_PASSED_NEED_INTERVIEW', data })
```

> **`source` 当前固定为 `need_interview`**。`MATCH_PASSED_NO_INTERVIEW` / `MATCH_FAILED` 通道在 `client.ts` 已声明但**目前没有 emitter**——需要时再在循环里按 `matchScore` / `recommendation` 分支。

### 4.3 出参（`MATCH_PASSED_NEED_INTERVIEW.data` —— `MatchPassedNeedInterviewData`）

```ts
{
  upload_id: string,                // RAAS 反查 candidate 的锚点
  job_requisition_id: string,
  // RoboHire /match-resume 响应平铺
  success?: boolean,
  data?: Record<string, unknown>,   // matchScore / overallMatchScore / skillMatch / … 全字段
  requestId?: string,
  savedAs?: string,
  error?: string
}
```

> **设计选择**：旧的 `candidate_ref` / `jd_text` / 自己重打分的字段已删除。事件名本身承载 outcome，candidate 信息让 RAAS 按 `upload_id` 反查 `resume_upload` 表取（详见 [docs/raas-event-flow-upload-id-correlation.md](raas-event-flow-upload-id-correlation.md)）。

### 4.4 函数级输出（return value）

```ts
{
  ok: true,
  upload_id, candidate_id, employee_id,
  matched_count: number,         // 拉到的可匹配 JD 总数
  emitted_count: number,         // 实际 emit 成功的条数
  summaries: [{ job_requisition_id, ok, requestId?, error? }]
}
```

---

## 5. RAAS API Server 接口清单（agent 调用方）

所有调用都通过 [resume-parser-agent/lib/raas-api-client.ts](../resume-parser-agent/lib/raas-api-client.ts)，`Authorization: Bearer ${AGENT_API_KEY}`，可选 `X-Trace-Id`，默认超时 120s。

### 5.1 Capability proxies（透传 RoboHire）

| Path | Method | 入参 | 出参 | Caller |
|---|---|---|---|---|
| `/api/v1/parse-resume` | POST (multipart) | `file=<pdf Blob>` | `{ success, data: RaasParseResumeData, cached, documentId, savedAs, requestId }` | `resumeParserAgent` |
| `/api/v1/match-resume` | POST (json) | `{ resume, jd, candidatePreferences?, jobMetadata? }` | `{ success, data: RaasMatchResumeData, requestId, savedAs }` | `matchResumeAgent` |
| `/api/v1/generate-jd` | POST (json) | `{ prompt: 4-4000, language?, companyName?, department? }` | `{ success, data: RaasGenerateJdData, meta: { stages }, requestId }` | `createJdAgent` |
| `/api/v1/invite-interview` | POST (json) | `{ candidate_id, candidate_name, candidate_email, …, job_title }` | 当前 501 | (未启用) |

### 5.2 Persistence（写 RAAS DB）

| Path | Method | 入参 | 出参 | Caller |
|---|---|---|---|---|
| `/api/v1/candidates` | POST | `SaveCandidateInput`（`upload_id`/`bucket`/`object_key` + `etag` + `parsed` + operator_*） | `{ candidate_id, resume_id, candidate_name, is_new_candidate, is_new_resume, … }` | `resumeParserAgent` |
| `/api/v1/jd/sync-generated` | POST | `SyncJdInput`（`job_requisition_id`/`client_id` + RoboHire camelCase spread + raas snake_case 增强） | `{ synced, job_posting_id, job_requisition_id }` | `createJdAgent` |
| `/api/v1/match-results` | POST | `SaveMatchResultsInput`（`source: 'need_interview'` + RoboHire data spread + IDs；或 `source: 'no_interview'` + `match_results[]`） | `need_interview`: `{ upserted, candidate_match_result_id }` / `no_interview`: `{ count, results[] }` | `matchResumeAgent` |

> **写法约定**：所有 persist 调用都直接 `...result.data` 整段 spread，再用 IDs 之类的 anchor **放在后面 override**，避免 RoboHire 未来加同名字段把 anchor 覆盖（`match-resume-agent.ts:206-223` 注释）。

### 5.3 Read-only

| Path | Method | 入参 | 出参 | Caller |
|---|---|---|---|---|
| `/api/v1/resumes/uploads/:upload_id/raw` | GET | path: `upload_id` | `application/pdf` 字节流（不是 JSON envelope） | `resumeParserAgent` |
| `/api/v1/requirements/:id` | GET | path: `job_requisition_id` | `RequirementDetailResponse`（`requirement` + `specification` + `siblings` + `latest_task` + `latest_analysis` + `analysis_history` + `clarification_rounds` + `manual_override_history` + `can_trigger_analysis`） | `createJdAgent` |
| `/api/v1/requirements/agent-view` | GET | query: `claimer_employee_id`（其他 deprecated） | `{ items, page, page_size, total, total_pages }` | `matchResumeAgent` |

### 5.4 错误信封 & 错误码

任何非 2xx 或 `success: false` 的 body 都被翻译成 `RaasApiError`（`raas-api-client.ts:34`）：

```ts
class RaasApiError extends Error {
  status: number;     // HTTP status
  code: string;       // RAAS 错误码（AGENT_AUTH_INVALID / RATE_LIMITED / INVALID_* / MISSING_FIELD / PROMPT_LENGTH / HTTP_<n>）
  requestId?: string;
  traceId?: string;
  isRetryable: 429 || 502 || 504
  isClientError: 4xx 且非 429
}
```

agent 内部统一规则：`isClientError` → `NonRetriableError`（payload bug），其他重抛交给 `step.run` 重试。

### 5.5 Header 约定

- 请求头：`Authorization: Bearer ${AGENT_API_KEY}`、可选 `X-Trace-Id: <uuid>`、JSON 调用带 `Content-Type: application/json`。
- 响应头会把 `x-trace-id` / `x-request-id` 都回灌给 agent（`raas-api-client.ts:847`），所以 agent 端日志能拿到上游 trace 做跨服务关联。

---

## 6. 事件路由：AO ↔ RAAS Inngest 桥接

### 6.1 RAAS → AO（pull）：[server/inngest/raas-bridge.ts](../server/inngest/raas-bridge.ts)

- 启用条件：`RAAS_BRIDGE_ENABLED=1`（默认关闭）。
- 周期 poll `${RAAS_INNGEST_URL}/v1/events?limit=20`（默认 5s），过滤 `RAAS_BRIDGE_EVENTS`（默认 `RESUME_DOWNLOADED`）。
- 命中后调 `em.publish(name, data, { source: 'raas-bridge', externalEventId: shared.id })`，让 AO-main 走 schema validate → dedup → Inngest send（`em/publish.ts`）。
- `externalEventId = shared.id` 同时作为 `inngest.send().id`，所以 RAAS 重发同一个 id 会在两层都被去重。
- 启动时 seed 50 条历史事件到 `_seenIds` 以避免回放历史。

### 6.2 AO → RAAS（push）：[server/inngest/raas-forward.ts](../server/inngest/raas-forward.ts)

- 启用条件：`RAAS_FORWARD_ENABLED=1` + `RAAS_INNGEST_URL` 已配置。
- 直接 `POST ${RAAS_INNGEST_URL}/e/${INNGEST_EVENT_KEY}`，body = `{ name, data }`，timeout 15s。
- 用于补救 `step.sendEvent()` 只写本地 Inngest 的局限——所有 customer-facing 事件（`JD_GENERATED` / `RESUME_PROCESSED` / `MATCH_*`）都需要在 step.run 里再调一次 `forwardToRaas` 以推到 partner bus。
- 当前 `resume-parser-agent` 的三个 fn **没有显式调 `forwardToRaas`**——它们依赖 partner 端从 AO-main 拉取或者 partner Inngest 自身订阅 AO-main 的本地总线。如果上线发现 partner 收不到，需要在 emit 后加 `forwardToRaas` 调用。

### 6.3 EM 网关：[server/em/publish.ts](../server/em/publish.ts)

`em.publish` 是 AO-main 的 publish 入口（`raas-bridge` 必走，agent 直 `step.sendEvent` 不经过它）：

1. **degraded 自检**：EM 已 fault → 直接 `inngest.send`，跳过审计。
2. **filter**（Phase 3 占位）。
3. **schema validate**：先查 Neo4j EventDefinition，回落 `BUILTIN_SCHEMAS`（[server/em/schemas/builtin.ts](../server/em/schemas/builtin.ts)）；非 strict 模式下未注册事件标记为 `unvalidated` 通过；strict 模式下 reject。
4. **dedup**：基于 `EventInstance.external_event_id` 唯一索引。
5. **persist**：写 `EventInstance(status='accepted')` + `AuditLog`。
6. **inngest.send**：`idempotencyKey = externalEventId ?? eventId`。
7. **失败 emit `EVENT_REJECTED`** 元事件（per spec v2 §6.1）。

返回值：

```ts
| { accepted: true, eventId, schemaVersionUsed }
| { accepted: false, reason: 'filter'|'schema'|'duplicate'|'em_degraded'|'no_schema', details }
```

### 6.4 内置 schema（兜底）

[server/em/schemas/builtin.ts](../server/em/schemas/builtin.ts) 给 8 个核心事件留了 zod v1.0：`REQUIREMENT_LOGGED` / `RESUME_DOWNLOADED` / `RESUME_PROCESSED` / `JD_GENERATED` / `JD_REJECTED` / `MATCH_PASSED_NEED_INTERVIEW` / `MATCH_PASSED_NO_INTERVIEW` / `MATCH_FAILED`。schema 都用 `envelope(payload)` 包一层，再 `.passthrough()` 让未来字段不破校验。`publishers` / `subscribers` 元数据驱动 `/events` 直观图。

---

## 7. 端到端事件链（happy path）

```
1)  HR 在 RAAS Dashboard 提交需求
       └─ RAAS publish REQUIREMENT_LOGGED  (entity_type=JobRequisition, entity_id=JR_xxx)
                ↓ (raas-bridge poll → em.publish → Inngest send)

2)  createJdAgent  (resume-parser-agent :3020)
       ├─ GET  /api/v1/requirements/:id           (拉详情 + spec)
       ├─ POST /api/v1/generate-jd                (RoboHire 生成 JD)
       ├─ POST /api/v1/jd/sync-generated          (写 RAAS JobPosting + 推 spec.status → pending_publish)
       └─ step.sendEvent JD_GENERATED              (cascade trigger)

3)  RAAS 自家流程: 把 JobPosting 发布到 BOSS / 智联 / ……
       └─ HR 收到候选简历 → RAAS Web Console 上传 PDF → MinIO
       └─ RAAS publish RESUME_DOWNLOADED  (entity_id=upload_id)
                ↓ (raas-bridge → em.publish → Inngest)

4)  resumeParserAgent
       ├─ GET  /api/v1/resumes/uploads/:upload_id/raw   (拉 PDF 字节)
       ├─ POST /api/v1/parse-resume (multipart)         (RoboHire 解析)
       ├─ POST /api/v1/candidates                       (落库 Candidate / Resume)
       └─ step.sendEvent RESUME_PROCESSED               (cascade)

5)  matchResumeAgent
       ├─ GET  /api/v1/requirements/agent-view?claimer_employee_id=<emp>
       ├─ for each requirement:
       │     ├─ POST /api/v1/match-resume              (RoboHire 打分)
       │     ├─ POST /api/v1/match-results             (落库, source=need_interview)
       │     └─ step.sendEvent MATCH_PASSED_NEED_INTERVIEW  (1 条/JD)
       │
       └─ RAAS 收到 MATCH_PASSED_NEED_INTERVIEW
            └─ 用 upload_id → resume_upload → candidate_id → 写 candidate_match_result_runtime_state
```

---

## 8. 环境变量速查（agent 侧）

| Env | 作用 | 默认 |
|---|---|---|
| `RAAS_API_BASE_URL` | RAAS API Server base URL（必填） | — |
| `AGENT_API_KEY` | 调 RAAS API 的 Bearer token（必填） | — |
| `INNGEST_DEV` / `INNGEST_BASE_URL` | 本地 / 共享 dev server URL | `1`（local） |
| `INNGEST_EVENT_KEY` | partner forward 的 event key 路径 | `dev` |
| `RAAS_DEFAULT_EMPLOYEE_ID` | matchResume 兜底 employee_id（可选） | — |

AO-main 侧另外用到：

| Env | 作用 | 默认 |
|---|---|---|
| `RAAS_BRIDGE_ENABLED` | 启用 RAAS → AO 反向 poll | 关闭 |
| `RAAS_INNGEST_URL` | 共享 bus URL | `http://10.100.0.70:8288` |
| `RAAS_BRIDGE_POLL_INTERVAL_MS` | poll 周期 | `5000` |
| `RAAS_BRIDGE_EVENTS` | 桥接的事件名（逗号分隔） | `RESUME_DOWNLOADED` |
| `RAAS_FORWARD_ENABLED` | 启用 AO → RAAS push | 关闭 |
| `EM_STRICT_SCHEMA` | 未注册事件直接 reject | `false` |

---

## 9. 关键参考代码索引

| 关注点 | 文件 |
|---|---|
| Inngest client 实例 + 全部 event TS types | [resume-parser-agent/lib/inngest/client.ts](../resume-parser-agent/lib/inngest/client.ts) |
| serve handler（注册 3 个 fn） | [resume-parser-agent/app/api/inngest/route.ts](../resume-parser-agent/app/api/inngest/route.ts) |
| Function ① resumeParserAgent | [resume-parser-agent/lib/inngest/functions/resume-parser-agent.ts](../resume-parser-agent/lib/inngest/functions/resume-parser-agent.ts) |
| Function ② createJdAgent | [resume-parser-agent/lib/inngest/agents/create-jd-agent.ts](../resume-parser-agent/lib/inngest/agents/create-jd-agent.ts) |
| Function ③ matchResumeAgent | [resume-parser-agent/lib/inngest/agents/match-resume-agent.ts](../resume-parser-agent/lib/inngest/agents/match-resume-agent.ts) |
| RAAS API client（出入参 type 全在这） | [resume-parser-agent/lib/raas-api-client.ts](../resume-parser-agent/lib/raas-api-client.ts) |
| AO-main em.publish 网关 | [server/em/publish.ts](../server/em/publish.ts) |
| 事件兜底 zod schema | [server/em/schemas/builtin.ts](../server/em/schemas/builtin.ts) |
| RAAS → AO bridge | [server/inngest/raas-bridge.ts](../server/inngest/raas-bridge.ts) |
| AO → RAAS forward | [server/inngest/raas-forward.ts](../server/inngest/raas-forward.ts) |
| AO-main Inngest client | [server/inngest/client.ts](../server/inngest/client.ts) |
| 相关历史 docs | [docs/raas-event-flow-upload-id-correlation.md](raas-event-flow-upload-id-correlation.md) · [docs/raas-internal-api-spec.md](raas-internal-api-spec.md) · [docs/event-flow-deep-dive.md](event-flow-deep-dive.md) · [docs/end-to-end-pipeline-walkthrough.md](end-to-end-pipeline-walkthrough.md) |
