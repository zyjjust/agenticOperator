# E2E 流程汇总报告（RoboHire 路径）— 2026-04-28 14:25

**所有步骤都用 RoboHire**：简历解析（`/parse-resume`）+ 简历匹配（`/match-resume`）。MinIO 拉真实 PDF。Inngest 跑在本地 Docker 里。

---

## 0. 总览

| 项 | 值 |
|---|---|
| 简历对象 | `recruit-resume-raw/2026/04/e7b3dde7-...-【游戏测试（全国招聘）_深圳 7-11K】谌治中 3年.pdf` |
| 简历字节 | 380,866 |
| 解析端点 | `https://api.robohire.io/api/v1/parse-resume` |
| 匹配端点 | `https://api.robohire.io/api/v1/match-resume` |
| Inngest 总线 | `http://localhost:8288`（Docker，`ao-inngest` 容器） |
| AO Next dev | `http://localhost:3002` |
| 端到端总耗时 | ~41 秒（事件发出 → 终态事件落总线） |
| 全部产物目录 | [data/e2e-out/robohire-20260428T142502/](../data/e2e-out/robohire-20260428T142502/) |

### 时间线

```
T=06:23:33.974 │ ① RESUME_DOWNLOADED 落 Inngest 总线
T=06:23:34.087 │   ↳ processResume 收到 (event_received)
T=06:23:52.835 │   ↳ MinIO fetch + RoboHire /parse-resume 完成（共 18.7s, parse 18.7s）
T=06:23:52.901 │ ② RESUME_PROCESSED 落 Inngest 总线
T=06:23:52.962 │   ↳ matchResume 收到 (event_received)
T=06:24:15.518 │   ↳ flatten + RoboHire /match-resume 完成（共 22.5s, match 22.5s）
T=06:24:15.601 │ ③ MATCH_PASSED_NO_INTERVIEW 落 Inngest 总线
```

| # | 事件 | event_id | 耗时 |
|---|---|---|---|
| ① 入参 | `RESUME_DOWNLOADED` | `01KQ9C3QCTAM9A8PQ13VTS4J0B` | — |
| ② 中态 | `RESUME_PROCESSED` | `01KQ9C49X68TMTHT1F12RBCX8G` | processResume **18.9 s** (parse=18.7s) |
| ③ 终态 | `MATCH_PASSED_NO_INTERVIEW` | `01KQ9C500HWH1K9WQG45052C36` | matchResume **22.7 s** (match=22.5s) |

**最终匹配**：score = **90**, recommendation = **STRONG_MATCH**, outcome = **MATCH_PASSED_NO_INTERVIEW**。

---

## 1. INPUT — `RESUME_DOWNLOADED`

文件 [event-01KQ9C3QCTAM9A8PQ13VTS4J0B.json](../data/e2e-out/robohire-20260428T142502/event-01KQ9C3QCTAM9A8PQ13VTS4J0B.json)

```json
{
  "name": "RESUME_DOWNLOADED",
  "data": {
    "entity_type": "Candidate",
    "entity_id": null,
    "event_id": "<uuid>",
    "payload": {
      "upload_id":         "<uuid>",
      "bucket":            "recruit-resume-raw",
      "object_key":        "2026/04/e7b3dde7-...谌治中 3年.pdf",
      "filename":          "【游戏测试（全国招聘）_深圳 7-11K】谌治中 3年.pdf",
      "etag": null, "size": null, "hr_folder": null,
      "employee_id": "EMP-TEST",
      "received_at": "2026-04-28T06:23:33.969Z",
      "source_label": "AO Manual Trigger",
      "summary_prefix": "/api/test/trigger-resume-uploaded",
      "operator_id": "EMP-TEST", "operator_name": "AO Tester",
      "operator_role": "recruiter", "ip_address": "127.0.0.1",
      ...
    },
    "trace": { "trace_id": null, "request_id": null, "workflow_id": null, "parent_trace_id": null }
  }
}
```

---

## 2. processResume agent — 真实 RoboHire `/parse-resume` 调用

代码：[server/ws/agents/sample-resume-parser.ts](../server/ws/agents/sample-resume-parser.ts)
RoboHire 客户端：[server/llm/robohire.ts:46](../server/llm/robohire.ts#L46) `roboHireParseResume()`

### 2.1 Step 链

| 时刻 | Step | type | 内容 |
|---|---|---|---|
| 06:23:34.087 | log-received | `event_received` | "Received RESUME_DOWNLOADED · recruit-resume-raw/2026/04/...谌治中 3年.pdf" |
| 06:23:52.829 | fetch-and-parse | `tool` | "Fetched 380866 bytes · mode=robohire" |
| 06:23:52.831 | fetch-and-parse | `agent_complete` | "Parse complete in 18712ms · 30 skills · 1 jobs · 1 edu · mode=robohire" |
| 06:23:52.834 | emit-resume-processed | `event_emitted` | "Published RESUME_PROCESSED · candidate=谌治中 · upload_id=..." |

### 2.2 RoboHire 实际请求

```
POST https://api.robohire.io/api/v1/parse-resume
Authorization: Bearer rh_ed02***
Content-Type: multipart/form-data
Body: file=<380,866 bytes PDF>, mime=application/pdf
```

### 2.3 RoboHire 响应（直接落到 `payload.parsed.data`，无任何字段重命名）

文件 [event-01KQ9C49X68TMTHT1F12RBCX8G.json](../data/e2e-out/robohire-20260428T142502/event-01KQ9C49X68TMTHT1F12RBCX8G.json) — `data.payload.parsed.data` 完整字段：

```json
{
  "name": "谌治中",
  "email": "1461406879@qq.com",
  "phone": "18070573461",
  "address": "",
  "linkedin": "",
  "github": "",
  "portfolio": "",
  "summary": "本人对游戏测试工作充满热情，熟悉游戏测试全流程和各类测试方法...",
  "skills": {
    "technical": [
      "测试理论", "游戏测试流程", "黑盒测试方法", "测试计划编写",
      "测试报告编写", "测试用例编写与执行", "Linux 操作系统",
      "MySQL 数据库", "sql 语句", "adb 命令", "接口测试", "性能测试"
    ],
    "soft": ["沟通协作", "问题定位", "分析问题", "注重细节"],
    "languages": ["python"],
    "tools": ["Xmind", "Perfdog", "TAPD", "Airtest", "unity 引擎", "jira"],
    "frameworks": [],
    "other": ["自动化脚本"]
  },
  "experience": [
    {
      "company": "厦门雷霆互动网络有限公司",
      "role": "游戏测试工程师",
      "location": "",
      "startDate": "2023.07",
      "endDate": "2026.01",
      "duration": "2年6个月",
      "description": "游戏测试工程师",
      "achievements": [],
      "technologies": [],
      "employmentType": "full-time"
    }
  ],
  "education": [
    {
      "institution": "西安理工大学高科学院",
      "degree": "本科",
      "field": "计算机科学与技术",
      "startDate": "2019.09",
      "endDate": "2023.07",
      "year": "",
      "gpa": "",
      "achievements": ["英语四级证书", "计算机三级证书"],
      "coursework": []
    }
  ],
  "projects": [
    {
      "name": "杖剑传说",
      "role": "负责模块：技能、任务、背包",
      "date": "2024.11-2026.01",
      "description": "项目描述：《杖剑传说》是由 N SSStudio 开发的一款 MMORPG ...（共 200+ 字）",
      "technologies": ["jira", "MMORPG", "AI逻辑"],
      "link": ""
    },
    {
      "name": "超进化物语 2",
      "role": "负责模块：养成、技能、任务、背包",
      "date": "2023.07-2024.11",
      "description": "项目描述：《超进化物语 2》是由 NTFusion 研发的一款策略养成类游戏...",
      "technologies": ["perfdog", "jira"],
      "link": ""
    }
  ],
  "certifications": [
    { "name": "英语四级证书", "issuer": "", "date": "" },
    { "name": "计算机三级证书", "issuer": "", "date": "" }
  ],
  "awards": [],
  "languages": [
    { "language": "英语", "proficiency": "英语四级" }
  ],
  "volunteerWork": [],
  "publications": [],
  "patents": [],
  "otherSections": {
    "个人信息": "年龄：25 性别：男 民族：汉族 工作经验：3 年",
    "求职意向": "游戏测试工程师",
    "核心技能Raw": "...",
    "游戏经历": "网游：..."
  },
  "rawText": "（完整 PDF 抽出文本，~3,400 字）"
}
```

> ⚠️ **重要**：RoboHire 真实响应比官方 docs §2 的 example 字段多很多（projects / awards / volunteerWork / patents / otherSections / rawText / skills 是 object 而非 flat array / experience.role 而非 .title 等等）。spec §4 说"原样转发"——我们就这么做的，没做任何 normalize。RAAS 那边按照 docs 字段读会拿到 undefined 的字段（比如 `experience[0].title` 现在不存在，需要读 `.role`）；建议给 RAAS 一份这次抓到的真实样本，让他们对齐。

### 2.4 RESUME_PROCESSED 完整事件结构

```json
{
  "name": "RESUME_PROCESSED",
  "data": {
    "entity_type": "Candidate",
    "entity_id": null,
    "event_id": "964c6763-3397-4eac-b984-4e4ea4499aef",
    "payload": {
      // 16 个 transport 字段（从 RESUME_DOWNLOADED 透传）
      "upload_id": "...", "bucket": "recruit-resume-raw",
      "object_key": "2026/04/...", "filename": "...",
      "etag": null, "size": null, "hr_folder": null,
      "employee_id": "EMP-TEST", "source_event_name": null,
      "received_at": "2026-04-28T06:23:33.969Z",
      "source_label": "AO Manual Trigger",
      "summary_prefix": "/api/test/trigger-resume-uploaded",
      "operator_id": "EMP-TEST", "operator_name": "AO Tester",
      "operator_role": "recruiter", "ip_address": "127.0.0.1",

      // RoboHire response data 整段（spec §4 要求）
      "parsed": { "data": <见 §2.3> },

      // 诊断字段（RAAS 忽略即可）
      "parser_version": "ao+robohire@2026-04-28",
      "parser_mode": "robohire",
      "parser_model_used": "robohire/parse-resume",
      "parser_request_id": "req_1777357413174_7nr5xck",
      "parser_cached": true,
      "parser_document_id": "resume_1777356508528_o4t5a5",
      "parser_saved_as": "【游戏测试（全国招聘）_深圳 7-11K】谌治中 3年.json",
      "parser_duration_ms": 18712,
      "parsed_at": "2026-04-28T06:23:52.831Z"
    },
    "trace": { ... }
  }
}
```

> 注：`parser_cached: true` —— 这是同一个 PDF 第二次调用，RoboHire 命中缓存（不消耗 LLM 配额）。

---

## 3. matchResume agent — 真实 RoboHire `/match-resume` 调用

代码：[server/ws/agents/match-resume.ts](../server/ws/agents/match-resume.ts)
RoboHire 客户端：[server/llm/robohire.ts:131](../server/llm/robohire.ts#L131) `roboHireMatchResume()`

### 3.1 Step 链

| 时刻 | Step | type | 内容 |
|---|---|---|---|
| 06:23:52.962 | log-received | `event_received` | "Received RESUME_PROCESSED · candidate=谌治中" |
| 06:23:52.964 | infer-jd | (内联) | "游戏测试（全国招聘）" / 深圳 / 7-11K |
| 06:23:52.964 | flatten-resume | (内联) | RoboHire `parsed.data.rawText`（3,400 字符） |
| 06:24:15.515 | match | `agent_complete` | "Match complete in 22538ms · score=90 · STRONG_MATCH · mode=robohire" |
| 06:24:15.518 | emit-match-outcome | `event_emitted` | "Published MATCH_PASSED_NO_INTERVIEW · score=90 · STRONG_MATCH" |

### 3.2 RoboHire 请求

```
POST https://api.robohire.io/api/v1/match-resume
Authorization: Bearer rh_ed02***
Content-Type: application/json
Body: { "resume": "<3,400 字 plain text from rawText>", "jd": "<7 行 JD 文本>" }
```

### 3.3 RoboHire 响应（落到 `payload.match.data`，无 normalize）

实际响应字段比 docs §3 example 多得多。完整顶层 keys：

```
['areasToProbeDeeper', 'candidatePotential', 'experienceBreakdown',
 'experienceMatch', 'experienceValidation', 'hardRequirementGaps',
 'jdAnalysis', 'mustHaveAnalysis', 'niceToHaveAnalysis',
 'overallFit', 'overallMatchScore', 'preferenceAlignment',
 'recommendations', 'resumeAnalysis', 'skillMatch', 'skillMatchScore',
 'suggestedInterviewQuestions', 'transferableSkills']
```

### 3.4 关键评分字段

| 字段 | 值 |
|---|---|
| `overallMatchScore.score` | **90** |
| `overallMatchScore.grade` | **A** |
| `overallMatchScore.confidence` | **High** |
| `overallMatchScore.breakdown.experienceScore` | 90 |
| `overallMatchScore.breakdown.skillMatchScore` | 92 |
| `overallMatchScore.breakdown.potentialScore` | 88 |
| `skillMatchScore.score` | 92 |
| `skillMatchScore.breakdown.mustHaveScore` | 100 |
| `skillMatchScore.breakdown.niceToHaveScore` | 90 |
| `overallFit.verdict` | **Strong Match** |
| `overallFit.hiringRecommendation` | "Strongly Recommend" |
| `overallFit.suggestedRole` | "游戏测试工程师 / 资深游戏测试工程师" |

### 3.5 LLM 生成的关键洞察

**`overallFit.summary`**：
> 候选人是一名经验丰富、技能全面的游戏测试工程师。他拥有知名游戏公司背景，熟悉从功能到性能的测试全流程，且具备极强的游戏理解力，非常契合深圳游戏测试岗位的需求。

**`overallFit.topReasons`**：
- 2.5年对口游戏测试经验，来自知名企业雷霆互动
- 技能栈全面，涵盖功能、性能、自动化及数据库
- 硬核玩家背景，对游戏机制有深刻理解

**`recommendations.forRecruiter`**：
- 候选人目前可能在职，需确认其离职动机
- 薪资要求在7-11K区间，对于其2.5年经验及背景来说性价比极高

**`recommendations.interviewQuestions`**（RoboHire 自动生成 3 个面试问题）：
1. 请详细描述你在测试《杖剑传说》200多种技能组合时，是如何设计用例以确保没有数值冲突的？
2. 在使用PerfDog发现性能瓶颈后，你通常如何配合开发进行定位？
3. 针对《杀戮尖塔》这类游戏，你会从哪些维度设计其底层逻辑的测试用例？

**`areasToProbeDeeper[0]`**（RoboHire 标记的需要追问的疑点）：
- 区域：工作时间真实性
- 优先级：Critical
- 原因：简历显示工作至2026年01月，存在逻辑错误或笔误（确实，候选人简历应该写到2025/04 或 至今）
- 建议：开场时以确认基本信息的方式轻松询问，避免压力面试感。

> ⚠️ **同样**：RoboHire 真实响应字段和 docs §3 example 差很多。docs 用的是 `matchScore` / `recommendation`，实际是 `overallMatchScore.score` / `overallFit.verdict`。我们 `pickScore()` 已经做了兼容（[match-resume.ts:309-326](../server/ws/agents/match-resume.ts#L309-L326)），同时支持两套字段名。

### 3.6 outcome 决策

| score | outcome 阈值 |
|---|---|
| 90 ≥ 80 | **`MATCH_PASSED_NO_INTERVIEW`** ✓ |

### 3.7 MATCH_PASSED_NO_INTERVIEW 完整事件结构

```json
{
  "name": "MATCH_PASSED_NO_INTERVIEW",
  "data": {
    "entity_type": "Candidate",
    "entity_id": null,
    "event_id": "<uuid>",
    "payload": {
      // 16 个 transport 字段（从 RESUME_PROCESSED 又透传）
      "upload_id": "...", "bucket": "recruit-resume-raw",
      "object_key": "...", "filename": "...",
      "operator_id": "EMP-TEST", ... (其余 13 个),

      "candidate_ref": {
        "name": "谌治中", "phone": "18070573461", "email": "1461406879@qq.com"
      },

      "jd": {
        "source": "filename-inferred",
        "text": "职位: 游戏测试（全国招聘）\n工作地点: 深圳\n薪资范围: 7-11K\n...",
        "job_requisition_id": null,
        "job_title": "游戏测试（全国招聘）",
        "city": "深圳",
        "salary_range": "7-11K"
      },

      // RoboHire /match-resume response data 整段
      "match": { "data": <见 §3.3-§3.5> },

      "outcome": "MATCH_PASSED_NO_INTERVIEW",
      "reason": null,
      "matched_at": "2026-04-28T06:24:15.515Z",
      "matcher_version": "ao+robohire@2026-04-28",
      "matcher_mode": "robohire",
      "matcher_model_used": "robohire/match-resume",
      "matcher_request_id": "req_1777357435398_xxx"
    },
    "trace": { ... }
  }
}
```

文件 [event-01KQ9C500HWH1K9WQG45052C36.json](../data/e2e-out/robohire-20260428T142502/event-01KQ9C500HWH1K9WQG45052C36.json) — 33 KB，包含上面所有字段。

---

## 4. 全部产物

[data/e2e-out/robohire-20260428T142502/](../data/e2e-out/robohire-20260428T142502/) 共 5 个文件：

| 文件 | 说明 | 大小 |
|---|---|---|
| `event-01KQ9C3QCTAM9A8PQ13VTS4J0B.json` | ① RESUME_DOWNLOADED 完整事件 | 2.2 KB |
| `event-01KQ9C49X68TMTHT1F12RBCX8G.json` | ② RESUME_PROCESSED（含 RoboHire parse 全量） | 38 KB |
| `event-01KQ9C500HWH1K9WQG45052C36.json` | ③ MATCH_PASSED_NO_INTERVIEW（含 RoboHire match 全量） | 34 KB |
| `agent-activity-processResume.json` | processResume 全部 step + LLM 输出 | 76 KB |
| `agent-activity-matchResume.json` | matchResume 全部 step + LLM 输出 | 60 KB |

---

## 5. 代码改动总结

### 5.1 客户端：`server/llm/robohire.ts` 现在透传 raw `data`

之前：把 RoboHire 响应映射到 AO 老的 4-object schema（`ParsedResume`）
现在：直接返回 RoboHire response 的 `.data` 字段，零 normalize（spec §4 要求）

```ts
export async function roboHireParseResume(...): Promise<RoboHireParseResult> {
  ...
  return {
    data: json.data,                  // ← raw RoboHire data field
    requestId: ..., cached: ..., ...
  };
}
```

### 5.2 processResume：RoboHire-first，LLM fallback

[sample-resume-parser.ts:188-235](../server/ws/agents/sample-resume-parser.ts#L188-L235)：

```ts
if (isRoboHireConfigured()) {
  try {
    const r = await roboHireParseResume(buf, filename);
    return { parsedData: r.data, mode: "robohire", ... };  // ← raw passthrough
  } catch (e) {
    console.warn(`RoboHire failed (${e}); falling back to LLM`);
    // unpdf → new-api gateway → produces same schema
    const text = await pdfBufferToText(buf);
    const llm = await llmExtractRoboHireShape(text);
    return { parsedData: llm.parsed, mode: "llm-fallback", ... };
  }
}
```

`payload.parsed.data` 直接收 RoboHire 原响应的 `.data`，不重命名/拍扁。

### 5.3 matchResume：RoboHire-first，LLM fallback

[match-resume.ts:177-225](../server/ws/agents/match-resume.ts#L177-L225) — 同样 try-RoboHire-then-LLM。

`flatten-resume` step 用 [robohire.ts:218](../server/llm/robohire.ts#L218) `roboHireDataToResumeText()` 取 `parsed.data.rawText` 作为给 `/match-resume` 的 resume 字符串（fallback 是 stringify 结构化字段）。

### 5.4 score 提取兼容真实字段

RoboHire 真实响应是 `overallMatchScore.score` 而不是文档说的 `matchScore`。[match-resume.ts:309-340](../server/ws/agents/match-resume.ts#L309-L340) 同时探测两种字段名 + verdict 字符串映射。

---

## 6. 跟 partner spec 的对照（RoboHire 路径下）

| spec 要求 | 我们的实现 | ✓ |
|---|---|---|
| `data.{entity_type, entity_id, event_id, payload, trace}` 信封 | 入参解析 + 出参生成都用 | ✓ |
| 业务字段 `data.payload` snake_case | 全部 snake_case | ✓ |
| `payload.bucket + payload.object_key` 拉 MinIO | [sample-resume-parser.ts:175-184](../server/ws/agents/sample-resume-parser.ts#L175-L184) | ✓ |
| `payload.upload_id` 原样回传 | echo 在 TRANSPORT_FIELDS | ✓ |
| 16 个 transport 字段原样回传 | TRANSPORT_FIELDS 列表 | ✓ |
| `RESUME_PROCESSED.payload.parsed.data` = RoboHire `/parse-resume` 响应 `data` 字段，**原样** | `parsed: { data: r.data }`，零 normalize | ✓ |
| 调用 RoboHire 解析 | `roboHireParseResume(buf, filename)` | ✓ |
| event_id 每条新生成 UUID | `randomUUID()` | ✓ |
| `trace` 四字段保留 | 入参原样透传 | ✓ |

---

## 7. 已知 caveats

1. **RoboHire 真实响应 schema ≠ 官方文档 example**。我们透传，RAAS 收到的字段比 docs 多/不同（例如 `experience[0].role` 而不是 `.title`，`skills` 是 object 而不是 array）。建议把这次的 `event-01KQ9C49X68TMTHT1F12RBCX8G.json` 给 RAAS 团队，让他们对齐到真实字段。

2. **MinIO 是共享的（10.100.0.70:9000）**，但 Inngest 是本地 Docker。两者解耦没问题。

3. **JD 当前用文件名 regex 推断**（PoC）。等 RAAS 提供 `job_requisition_id → JD 文本` 接口替换。

4. **RoboHire 缓存**：第一次解析消耗配额，后续相同 PDF（content hash）`cached: true` 不消耗。这次跑的 `parser_cached: true`。

5. **matchResume agent 是 AO 内部下游（spec 没要求）**：`MATCH_*` 系列事件是 AO 工作流节点 10 的产物，RAAS 不订阅。但事件信封跟 `RESUME_PROCESSED` 一致，方便后续接入。

---

## 8. 怎么再跑一遍

```bash
# 1. Docker Inngest 必须在
curl -sS http://localhost:8288/health

# 2. AO Next dev 必须在
curl -sS http://localhost:3002/api/inngest

# 3. 触发（会用同一份谌治中 PDF）
curl -X POST http://localhost:3002/api/test/trigger-resume-uploaded

# 4. 41 秒后总线上看到 3 条事件
curl -sS 'http://localhost:8288/v1/events?limit=5' | python3 -m json.tool
```
