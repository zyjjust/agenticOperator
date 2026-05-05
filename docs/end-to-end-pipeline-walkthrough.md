# End-to-End 流程演练 — RAAS 上传 → AO 解析 → 简历匹配

**测试时间**：2026-04-28 12:56
**简历**：`recruit-resume-raw/2026/04/e7b3dde7-...-【游戏测试（全国招聘）_深圳 7-11K】谌治中 3年.pdf`（380,866 字节）
**总耗时（事件触发 → 终态）**：~11 秒
**Inngest 总线**：本地 dev `http://localhost:8288`
**全部产物**：[data/e2e-out/raas-envelope-20260428T125714/](data/e2e-out/raas-envelope-20260428T125714/)

---

## 总览时间线

```
T+0.000s   ┌──────────────────────────────────────────────────┐
           │  [RAAS 侧]                                        │
           │  HR 在 RAAS Web Console 上传 PDF                  │
           │  RAAS 把字节写入 MinIO recruit-resume-raw/2026/04/...│
           │  RAAS outbox → InngestEventPublisher              │
           │  POST localhost:8288/e/dev  RESUME_DOWNLOADED     │
           └──────────────────────────────────────────────────┘
                              │
                              ▼  Inngest event_id=01KQ973ZQBESC9GXPKWXEMWVRC
T+0.066s   ┌──────────────────────────────────────────────────┐
           │  Inngest dev fan-out                              │
           │  匹配订阅了 "RESUME_DOWNLOADED" 的所有 fn          │
           │  → AO 的 processResume (workflow node 9-1)        │
           └──────────────────────────────────────────────────┘
                              │
                              ▼  POST :3002/api/inngest 调用 AO 的 fn
T+0.131s   ┌──────────────────────────────────────────────────┐
           │  processResume — step 0 log-received              │
           │  AgentActivity 写入 "Received RESUME_DOWNLOADED"   │
           └──────────────────────────────────────────────────┘
                              │
                              ▼  step.run("fetch-and-parse")
T+0.131s   ┌─────────────────────────────────────┐
           │  MinIO.getObject(bucket,object_key) │
           │  → 380,866 字节 (74ms)               │
           │                                     │
           │  unpdf PDF→text                     │
           │  → 3,427 字符 (~80ms)                │
           │                                     │
           │  new-api gateway LLM extract        │
           │  google/gemini-3-flash-preview      │
           │  → 完整 RoboHire 形结构化数据 (5,635ms) │
           └─────────────────────────────────────┘
                              │
                              ▼  step.sendEvent
T+6.085s   ┌─────────────────────────────────────────────┐
           │  emit RESUME_PROCESSED to Inngest             │
           │  AgentActivity 写入                          │
           │    "Published RESUME_PROCESSED · candidate=谌治中"│
           └─────────────────────────────────────────────┘
                              │
                              ▼  event_id=01KQ9745MWW5HHDRWYB5XGSMPJ
T+6.118s   ┌──────────────────────────────────────────────────┐
           │  Inngest dev fan-out                              │
           │  匹配订阅了 "RESUME_PROCESSED" 的所有 fn           │
           │  → AO 的 matchResume (workflow node 10)           │
           │  → RAAS 的 resume-processed function（入库 Candidate / Resume）│
           └──────────────────────────────────────────────────┘
                              │
                              ▼  POST :3002/api/inngest
T+6.150s   ┌──────────────────────────────────────────────────┐
           │  matchResume — step 0 log-received                │
           │  step.run("infer-jd")                             │
           │     文件名 regex → 职位/城市/薪资                  │
           │  step.run("flatten-resume")                       │
           │     ParsedData → plain text 给 LLM matcher        │
           │  step.run("llm-match")                            │
           │     gemini-3-flash-preview → score, recommendation │
           │  step.sendEvent → MATCH_PASSED_NO_INTERVIEW       │
           └──────────────────────────────────────────────────┘
                              │
                              ▼  event_id=01KQ974ADET012NZB77FREPGEB
T+10.957s  ┌─────────────────────────────────────────┐
           │  事件 MATCH_PASSED_NO_INTERVIEW 上线总线 │
           │  AO 内部下游可继续订阅（自动通知面试等）  │
           └─────────────────────────────────────────┘
```

| 阶段 | 事件名 | event_id | 开始时间 | 耗时 |
|---|---|---|---|---|
| RAAS 发出 | `RESUME_DOWNLOADED` | `01KQ973ZQBESC9GXPKWXEMWVRC` | 12:56:19.435 | — |
| processResume 完成 | `RESUME_PROCESSED` | `01KQ9745MWW5HHDRWYB5XGSMPJ` | 12:56:25.498 | 5,920ms |
| matchResume 完成 | `MATCH_PASSED_NO_INTERVIEW` | `01KQ974ADET012NZB77FREPGEB` | 12:56:30.385 | 4,811ms |

---

## 阶段 1 — RAAS 发起 `RESUME_DOWNLOADED`

**触发源**：HR 上传 / Nextcloud 自动同步 / 任何 RAAS 内部动作触发简历落 MinIO。
**信封**（spec §2 + §3）：

```json
{
  "name": "RESUME_DOWNLOADED",
  "data": {
    "entity_type": "Candidate",
    "entity_id": null,
    "event_id": "a0fd0b85-39bf-4a2c-882d-36f646961f4f",
    "payload": {
      "upload_id": "32d18291-5a2f-4aef-8500-056aea55ccb4",
      "bucket": "recruit-resume-raw",
      "object_key": "2026/04/e7b3dde7-b4fc-96dc-6a9b-d2e2facd57db-【游戏测试（全国招聘）_深圳 7-11K】谌治中 3年.pdf",
      "filename": "【游戏测试（全国招聘）_深圳 7-11K】谌治中 3年.pdf",
      "etag": null,
      "size": null,
      "hr_folder": null,
      "employee_id": "EMP-TEST",
      "source_event_name": null,
      "received_at": "2026-04-28T04:56:19.435Z",
      "source_label": "AO Manual Trigger",
      "summary_prefix": "/api/test/trigger-resume-uploaded",
      "operator_id": "EMP-TEST",
      "operator_name": "AO Tester",
      "operator_role": "recruiter",
      "ip_address": "127.0.0.1",
      "candidate_name": null,
      "candidate_id": null,
      "resume_file_path": "2026/04/e7b3dde7-b4fc-96dc-6a9b-d2e2facd57db-【游戏测试（全国招聘）_深圳 7-11K】谌治中 3年.pdf"
    },
    "trace": { "trace_id": null, "request_id": null, "workflow_id": null, "parent_trace_id": null }
  }
}
```

> 真实 RAAS 部署：信封一模一样，`payload.upload_id` 是 raas 那边 `resume_upload` 表的主键，是 RAAS 收到 `RESUME_PROCESSED` 时定位行的 key —— 我们必须原样回传。

完整原始事件：[event-01KQ973ZQBESC9GXPKWXEMWVRC.json](data/e2e-out/raas-envelope-20260428T125714/event-01KQ973ZQBESC9GXPKWXEMWVRC.json)

---

## 阶段 2 — `processResume` (workflow node 9-1) 跑起来

**代码**：[server/ws/agents/sample-resume-parser.ts](server/ws/agents/sample-resume-parser.ts)

### 2.1 Inngest 路由

Inngest dev server 接到 `RESUME_DOWNLOADED`，查询订阅这个 event 的 functions 列表，把事件 dispatch 给所有匹配的 fn。我们的 fn 注册信息（来自 `GET /api/inngest` 自省）：

```json
{ "function_count": 2, "mode": "dev", "schema_version": "2024-05-24" }
```

匹配到：`27d29f31-487d-51ee-bac5-69d75cd3c101 = processResume (workflow node 9-1)`

### 2.2 内部 step 链

每个 `step.run` 是一个 Inngest checkpoint —— 失败可重试，结果会持久化。AO 还每步往 `AgentActivity` 表写一行，给 `/agent-demo` 页面消费。

| step | 耗时 | 干什么 | AgentActivity 落库 |
|---|---|---|---|
| **0. log-received** | <10ms | 写一行 "Received RESUME_DOWNLOADED" | type=`event_received` |
| **1. fetch-and-parse**（合并 step） | 5,920ms | MinIO 拉 380,866 字节 → unpdf 抽 3,427 字符 → LLM 结构化 | type=`tool` (fetched) + type=`agent_complete` (parse) |
| **2. emit-resume-processed** | <50ms | `step.sendEvent` 把 RESUME_PROCESSED 推回 Inngest | — |
| **3. log-emitted** | <5ms | 写 "Published RESUME_PROCESSED" | type=`event_emitted` |

### 2.3 三个核心子动作（在 step 1 内部）

#### a) MinIO 拉字节

```ts
const minio = getMinIOClient();
const stream = await minio.getObject(payload.bucket, payload.object_key);
const buf = Buffer.concat(chunks);
// → 380,866 bytes in 74ms
```

凭据来自 `.env.local`：MinIO endpoint `10.100.0.70:9000`，bucket `recruit-resume-raw`。

#### b) PDF → text

PDF 内容有图片混排，用 `unpdf`（pdfjs 的无 worker fork，过 Next.js Turbopack）：

```ts
const { extractText, getDocumentProxy } = await import("unpdf");
const pdf = await getDocumentProxy(new Uint8Array(buf));
const { text } = await extractText(pdf, { mergePages: true });
// → "陈语泓\n2023-2026  厦门雷霆互动..." 共 3,427 字符
```

#### c) 文本 → 结构化（LLM）

发到 new-api 网关（`AI_BASE_URL=http://10.100.0.70:3010/v1`，模型 `google/gemini-3-flash-preview`）。System prompt 严格要求 RoboHire `/parse-resume` 响应的 `data` 形状：

```
Output JSON matching this exact schema:
{ name, email, phone, location, summary,
  experience: [{title, company, location, startDate, endDate, description, highlights[]}],
  education:  [{degree, field, institution, graduationYear}],
  skills: [], certifications: [], languages: [{language, proficiency}] }
```

LLM 响应 5,635ms，输出严格 JSON，归一化后给下一步用。

> **为什么走 LLM 不走 RoboHire？** RoboHire `/parse-resume` 当前 100% 返回 HTTP 500 — 他们后端配置使用的 OpenRouter 模型 ID `openrouter/google/gemini-3.1-pro-preview` 不存在。详见 [docs/e2e-real-pdf-test-report.md §0](docs/e2e-real-pdf-test-report.md)。LLM 走的是同一个数据形状，等 RoboHire 修好把这一步的 client 切回去就行，下游 RAAS 完全无感。

### 2.4 发出 `RESUME_PROCESSED`

完整事件：[event-01KQ9745MWW5HHDRWYB5XGSMPJ.json](data/e2e-out/raas-envelope-20260428T125714/event-01KQ9745MWW5HHDRWYB5XGSMPJ.json)

```json
{
  "name": "RESUME_PROCESSED",
  "data": {
    "entity_type": "Candidate",
    "entity_id": null,
    "event_id": "b1494a1c-5e31-4263-830b-17de9e3ce982",
    "payload": {
      // —— 16 个透传字段，从入参原样搬 ——
      "upload_id": "32d18291-5a2f-4aef-8500-056aea55ccb4",
      "bucket": "recruit-resume-raw",
      "object_key": "2026/04/...谌治中 3年.pdf",
      "filename": "【游戏测试（全国招聘）_深圳 7-11K】谌治中 3年.pdf",
      "etag": null, "size": null, "hr_folder": null,
      "employee_id": "EMP-TEST", "source_event_name": null,
      "received_at": "2026-04-28T04:56:19.435Z",
      "source_label": "AO Manual Trigger",
      "summary_prefix": "/api/test/trigger-resume-uploaded",
      "operator_id": "EMP-TEST", "operator_name": "AO Tester",
      "operator_role": "recruiter", "ip_address": "127.0.0.1",

      // —— RoboHire 形状的解析结果 ——
      "parsed": {
        "data": {
          "name": "谌治中",
          "email": "1461406879@qq.com",
          "phone": "18070573461",
          "location": null,
          "summary": "本人对游戏测试工作充满热情...",
          "experience": [
            {
              "title": "游戏测试工程师",
              "company": "厦门雷霆互动网络有限公司",
              "location": "厦门",
              "startDate": "2023-07",
              "endDate": "2026-01",
              "description": "在职期间参与了《杖剑传说》与《超进化物语 2》两款游戏的测试工作。",
              "highlights": [
                "负责《杖剑传说》技能、任务、背包模块，拆解200余种技能激活条件及战斗AI逻辑。",
                "...4 more...",
                "使用 JIRA 进行缺陷生命周期管理，协助开发定位修复 Bug 并执行多轮回归测试。"
              ]
            }
          ],
          "education": [{
            "degree": "本科", "field": "计算机科学与技术",
            "institution": "西安理工大学高科学院", "graduationYear": "2023"
          }],
          "skills": ["测试理论","黑盒测试","Xmind","Perfdog","TAPD","Linux","MySQL","adb","Airtest","Python","Unity","接口测试","JIRA"],
          "certifications": ["英语四级证书","计算机三级证书"],
          "languages": [{"language":"中文","proficiency":"母语"}]
        }
      },

      // —— 我们加的诊断元数据（RAAS 忽略即可）——
      "parser_version": "ao-llm@2026-04-28",
      "parsed_at": "2026-04-28T04:56:25.499Z"
    },
    "trace": { "trace_id": null, "request_id": null, "workflow_id": null, "parent_trace_id": null }
  }
}
```

**RAAS 这边**收到这条事件，按 spec §4 走入库逻辑：

| RAAS 动作 | 用到的字段 |
|---|---|
| 用 `upload_id` 找 `resume_upload` 行 | `payload.upload_id` |
| 候选人去重 | `payload.parsed.data.name` + `.phone` |
| 拍到 Candidate 表 | `payload.parsed.data.{name, email, phone, location, experience[0].{company,title}, education[最高], skills, certifications, languages}` |
| 写 Resume 表 | `payload.parsed.data.{summary, experience[], education[], skills, certifications, languages}` |
| 存 raw_parse_result | `payload.parsed.data` 整段 |

---

## 阶段 3 — `matchResume` (workflow node 10) 跑起来

**代码**：[server/ws/agents/match-resume.ts](server/ws/agents/match-resume.ts)

> 注意：matchResume 不在 RAAS 对接 spec 内，是 AO 内部 workflow 的下游。RAAS 不需要订阅 `MATCH_*` 事件 —— 它只关心 `RESUME_PROCESSED`。但 `MATCH_*` 事件仍然走相同的信封格式（`data.entity_type / event_id / payload / trace`），方便后续接入。

### 3.1 step 链

| step | 耗时 | 干什么 |
|---|---|---|
| **0. log-received** | <10ms | 写 "Received RESUME_PROCESSED · candidate=谌治中" |
| **1. infer-jd** | <5ms | 文件名 regex `^【(.+?)_(.+?)\s+(.+?)】(.+?)\s+(.+?)\.\w+$` → 职位/城市/薪资 |
| **2. flatten-resume** | <5ms | `payload.parsed.data` → 给 LLM matcher 的纯文本 |
| **3. llm-match** | 4,811ms | gemini → matchScore + recommendation + 详细 analysis |
| **4. emit-match-outcome** | <50ms | `step.sendEvent("MATCH_PASSED_NO_INTERVIEW", ...)` |
| **5. log-emitted** | <5ms | 写 "Published MATCH_PASSED_NO_INTERVIEW · score=85" |

### 3.2 JD 推断（PoC）

文件名 `【游戏测试（全国招聘）_深圳 7-11K】谌治中 3年.pdf` 拆出来：

```json
{
  "ok": true,
  "jobTitle": "游戏测试（全国招聘）",
  "city": "深圳",
  "salaryRange": "7-11K",
  "candidateName": "谌治中",
  "yearsExp": "3年",
  "jdText": "职位: 游戏测试（全国招聘）\n工作地点: 深圳\n薪资范围: 7-11K\n(PoC: 此 JD 由文件名推断；待 RAAS 提供 job_requisition_id → JD 文本接口替换)",
  "source": "filename-inferred"
}
```

> **TODO**：等 RAAS 提供 `job_requisition_id → JD 文本` 接口（HTTP fetch）就把这一步换成正式 JD。

### 3.3 LLM 匹配

System prompt 让 LLM 输出 RoboHire `/match-resume` 响应的 `data` 形状（`matchScore` + `recommendation` + `matchAnalysis` + `mustHaveAnalysis` + `niceToHaveAnalysis`）：

| 维度 | 得分 | LLM 评估 |
|---|---|---|
| 总分 `matchScore` | **85** | STRONG_MATCH |
| 技术技能 | 90 | matched: Perfdog, JIRA, 功能测试, 性能测试, 缺陷管理, Python, Unity, 黑盒测试 (8 项); missing: 自动化测试框架搭建, 弱网测试 |
| 经验 | 85 | required="游戏测试经验"; candidate="约2.5年游戏测试经验"; "完全符合初中级岗位要求" |
| Must-have | — | 3 条全匹配 |
| Nice-to-have | — | Python / Unity / 计算机三级证书 / 接口测试 |

总结：**"候选人拥有扎实的游戏测试实战经验，熟悉主流测试工具及流程，且具备计算机专业背景，与岗位需求高度匹配。"**

### 3.4 outcome 决策

阈值（spec §6.3）：

| score | outcome |
|---|---|
| ≥ 80 | `MATCH_PASSED_NO_INTERVIEW` |
| 60 – 79 | `MATCH_PASSED_NEED_INTERVIEW` |
| < 60 | `MATCH_FAILED` |

score=85 → `MATCH_PASSED_NO_INTERVIEW`。

### 3.5 发出 `MATCH_PASSED_NO_INTERVIEW`

完整事件：[event-01KQ974ADET012NZB77FREPGEB.json](data/e2e-out/raas-envelope-20260428T125714/event-01KQ974ADET012NZB77FREPGEB.json)

```json
{
  "name": "MATCH_PASSED_NO_INTERVIEW",
  "data": {
    "entity_type": "Candidate",
    "entity_id": null,
    "event_id": "9f9c12f5-044b-4381-8e59-07f2902af3a6",
    "payload": {
      // —— 16 个透传字段（从 RESUME_PROCESSED 又透传一次）——
      "upload_id": "32d18291-...", "bucket": "recruit-resume-raw",
      "object_key": "...", "filename": "...", "etag": null, "size": null,
      "hr_folder": null, "employee_id": "EMP-TEST",
      "source_event_name": null, "received_at": "2026-04-28T04:56:19.435Z",
      "source_label": "AO Manual Trigger", "summary_prefix": "...",
      "operator_id": "EMP-TEST", "operator_name": "AO Tester",
      "operator_role": "recruiter", "ip_address": "127.0.0.1",

      // —— 候选人快照 ——
      "candidate_ref": {
        "name": "谌治中", "phone": "18070573461", "email": "1461406879@qq.com"
      },

      // —— JD ——
      "jd": {
        "source": "filename-inferred",
        "text": "职位: 游戏测试（全国招聘）...",
        "job_requisition_id": null,
        "job_title": "游戏测试（全国招聘）", "city": "深圳", "salary_range": "7-11K"
      },

      // —— 完整匹配结果（RoboHire /match-resume 形状）——
      "match": {
        "data": {
          "matchScore": 85,
          "recommendation": "STRONG_MATCH",
          "summary": "候选人拥有扎实的游戏测试实战经验...",
          "matchAnalysis": {
            "technicalSkills": { "score": 90, "matchedSkills": [...8 项], "missingSkills": [...2 项] },
            "experienceLevel": { "score": 85, "required": "...", "candidate": "...", "assessment": "..." }
          },
          "mustHaveAnalysis": { /* extracted/candidate/matched */ },
          "niceToHaveAnalysis": { /* extracted/matched */ }
        }
      },

      "outcome": "MATCH_PASSED_NO_INTERVIEW",
      "reason": null,
      "matched_at": "2026-04-28T04:56:30.379Z"
    },
    "trace": { "trace_id": null, "request_id": null, "workflow_id": null, "parent_trace_id": null }
  }
}
```

---

## 在 AO UI 上看这个流程

| 页面 | 看什么 |
|---|---|
| `/workflow` | workflow 图节点 9-1 (processResume) + 10 (matchResume) 高亮，banner 显示 "N agents active" |
| `/events` 的 Firehose tab | 实时显示 3 条事件（RESUME_DOWNLOADED → RESUME_PROCESSED → MATCH_PASSED_NO_INTERVIEW） |
| `/agent-demo` | 选 processResume / matchResume 看每个 step 的活动流（received → tool → complete → emitted） |
| Inngest dev UI (http://localhost:8288) | 看 Runs 面板里两个 fn 的 Completed 状态 + 每个 step 的输入输出 + 时长 |

---

## 在 Inngest 总线上看 (`http://localhost:8288/v1/events`)

```
2026-04-28T04:56:30  MATCH_PASSED_NO_INTERVIEW   01KQ974ADET012NZB77FREPGEB
2026-04-28T04:56:25  RESUME_PROCESSED            01KQ9745MWW5HHDRWYB5XGSMPJ
2026-04-28T04:56:19  RESUME_DOWNLOADED           01KQ973ZQBESC9GXPKWXEMWVRC
```

---

## 当前唯一的"假失败"

Inngest UI 上你会看到 `Resume Parser Agent` 跑 `RESUME_DOWNLOADED` 失败 —— 那不是我们的 fn，是 `~/Desktop/agenticOperator/resume-parser-agent/`（旧 prototype 项目，3020 端口还在跑）。它的代码期待旧的扁平 schema，对新 RAAS 信封会 throw。我们的两个 fn (`processResume` + `matchResume`) 都是 Completed。建议 `kill $(lsof -ti :3020)` 把它停掉就清净了。

---

## 关键文件索引

### 代码

| 路径 | 作用 |
|---|---|
| [server/inngest/client.ts](server/inngest/client.ts) | Inngest 客户端单例 (id: `agentic-operator-main`) |
| [server/inngest/functions.ts](server/inngest/functions.ts) | 注册表（导出给 `/api/inngest` serve handler） |
| [server/ws/agents/sample-resume-parser.ts](server/ws/agents/sample-resume-parser.ts) | processResume agent (workflow node 9-1) |
| [server/ws/agents/match-resume.ts](server/ws/agents/match-resume.ts) | matchResume agent (workflow node 10) |
| [server/llm/robohire-shape.ts](server/llm/robohire-shape.ts) | LLM 抽取器 + LLM 匹配器（RoboHire 同形输出） |
| [server/llm/minio-client.ts](server/llm/minio-client.ts) | MinIO singleton |
| [app/api/inngest/route.ts](app/api/inngest/route.ts) | Inngest serve handler |
| [app/api/test/trigger-resume-uploaded/route.ts](app/api/test/trigger-resume-uploaded/route.ts) | 手动触发 RESUME_DOWNLOADED 的测试入口 |

### 文档

| 路径 | 内容 |
|---|---|
| [docs/raas-alignment-payloads.md](docs/raas-alignment-payloads.md) | 给 RAAS 团队的事件 schema 对齐参考 |
| [docs/resume-agent-engineering-spec.md](docs/resume-agent-engineering-spec.md) | 简历 agent 工程详细规范 |
| [docs/e2e-real-pdf-test-report.md](docs/e2e-real-pdf-test-report.md) | RoboHire 失败 + LLM 替代的根因报告 |
| [docs/end-to-end-pipeline-walkthrough.md](docs/end-to-end-pipeline-walkthrough.md) | 本文档 |

### 这次 E2E 跑出来的产物

| 路径 | 内容 |
|---|---|
| [data/e2e-out/raas-envelope-20260428T125714/event-01KQ973ZQBESC9GXPKWXEMWVRC.json](data/e2e-out/raas-envelope-20260428T125714/event-01KQ973ZQBESC9GXPKWXEMWVRC.json) | 入：RESUME_DOWNLOADED |
| [data/e2e-out/raas-envelope-20260428T125714/event-01KQ9745MWW5HHDRWYB5XGSMPJ.json](data/e2e-out/raas-envelope-20260428T125714/event-01KQ9745MWW5HHDRWYB5XGSMPJ.json) | 中：RESUME_PROCESSED |
| [data/e2e-out/raas-envelope-20260428T125714/event-01KQ974ADET012NZB77FREPGEB.json](data/e2e-out/raas-envelope-20260428T125714/event-01KQ974ADET012NZB77FREPGEB.json) | 出：MATCH_PASSED_NO_INTERVIEW |

---

## 怎么再跑一遍

```bash
# 1. 确认 Inngest dev server 在 8288 上跑（同时挂 :3002 和 :3020 两个 SDK）
curl -sS http://localhost:8288/health

# 2. 确认 AO Next dev 在 :3002 跑
curl -sS http://localhost:3002/api/inngest

# 3. 触发一个 RESUME_DOWNLOADED（默认会用谌治中那个 PDF）
curl -X POST http://localhost:3002/api/test/trigger-resume-uploaded

# 4. （可选）改默认 PDF
curl -X POST http://localhost:3002/api/test/trigger-resume-uploaded \
  -H 'Content-Type: application/json' \
  -d '{"object_key":"2026/04/<other>.pdf","filename":"<other>.pdf"}'

# 5. 看 Inngest UI 的 Runs 面板：http://localhost:8288/runs
#    或在 AO 端点看：http://localhost:3002/agent-demo
```
