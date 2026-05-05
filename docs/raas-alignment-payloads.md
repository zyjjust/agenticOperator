# AO ↔ RAAS 对齐 · Event Payload 规范

> **目的**：本文档列出 Agentic Operator (AO) 的 `processResume` (workflow node 9-1)
> 和 `matchResume` (workflow node 10) 两个 agent **期望的事件契约**。请 RAAS 团队按此格式发送/订阅。
>
> **基准来源**：`docs/resume-agent-engineering-spec.md` §3 + AO 实际 agent 实现
> （[`server/ws/agents/sample-resume-parser.ts`](../server/ws/agents/sample-resume-parser.ts)
> 与 [`server/ws/agents/match-resume.ts`](../server/ws/agents/match-resume.ts)）。
>
> **现状**：当前共享 Inngest 上 `RESUME_DOWNLOADED` 事件的 `data` 是嵌套结构
> （`data.payload.{bucket, objectKey, ...}`），AO agent 期望**扁平结构**（`data.{bucket, objectKey, ...}`）。
> 需要 RAAS 调整发送格式或我们达成共识。

---

## 1. RESUME_DOWNLOADED · RAAS → AO（input）

**Inngest event name**：`RESUME_DOWNLOADED`

### 1.1 AO 期望的 payload 形状（扁平）

```json
{
  "name": "RESUME_DOWNLOADED",
  "data": {
    "bucket": "recruit-resume-raw",
    "objectKey": "2026/03/222a3b35-66fb-45af-bbba-f97ed7f8231c-【AI 产品经理（客服 _ 工作流方向）_深圳 12-13K】刘芷萱 26年应届生.pdf",
    "filename": "【AI 产品经理（客服 _ 工作流方向）_深圳 12-13K】刘芷萱 26年应届生.pdf",
    "hrFolder": "chenyuanbei001-0000419993",
    "employeeId": "0000419993",
    "etag": "169cc79bb4020e688a8b15ffa30931d3",
    "size": 199744,
    "sourceEventName": "s3:ObjectCreated:Put",
    "receivedAt": "2026-04-28T05:31:27.358Z"
  }
}
```

### 1.2 字段说明

| 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `data.bucket` | string | **是** | 永远 `recruit-resume-raw`（canonical bucket）。AO 据此 `getObject` 读字节。 |
| `data.objectKey` | string | **是** | MinIO 对象 key，URL 已解码，可含中文。`bucket + objectKey` 唯一定位简历文件。 |
| `data.filename` | string | **是** | `objectKey` 的最后一段。matchResume 用它推断 JD（命名规则见 §3.2）。 |
| `data.etag` | string | **强烈建议** | MinIO etag。AO 用作幂等 key（避免重复触发）。 |
| `data.hrFolder` | string \| null | 可选 | `{pinyin}-{employeeId}`，例 `chenyuanbei001-0000419993`。 |
| `data.employeeId` | string \| null | 可选 | HR 工号。RAAS 写 `Resume.uploaded_by`。 |
| `data.size` | number \| null | 可选 | 文件字节数。 |
| `data.sourceEventName` | string \| null | 可选 | 例 `s3:ObjectCreated:Put`。 |
| `data.receivedAt` | string (ISO) | 可选 | webhook 收到 MinIO 通知的时间。 |

### 1.3 当前 RAAS 实际发送的 shape（不匹配）

```json
{
  "name": "RESUME_DOWNLOADED",
  "data": {
    "entity_id": "bb1bcb25-...",
    "entity_type": "Candidate",
    "event_id": "39394146-...",
    "payload": {
      "candidate_id": "...",
      "candidate_name": "刘芷萱",
      "employee_id": "0000419993",
      "hr_folder": "chenyuanbei001-0000419993",
      "ip_address": "..."
    },
    "source_action": "...",
    "trace": "..."
  }
}
```

**问题**：
- `data.payload.*` 嵌套一层；AO 期望 `data.*`
- 字段命名 snake_case (`employee_id`)，AO 期望 camelCase (`employeeId`) ——
  这点可双方约定，但**整个事件总线必须统一**
- 缺少 AO 处理简历**必需的 `bucket / objectKey / filename`**

### 1.4 RAAS 团队需要选一种对齐方案

**方案 A**（推荐）：RAAS 发送时按 §1.1 形状扁平化，加上 `bucket/objectKey/filename` 三个必需字段。AO 不做任何改动。

**方案 B**：RAAS 现有 shape 不变；AO 加一层 unwrapping（`data.payload.bucket` → 内部当作 `data.bucket`）。需要 AO 适配。

**方案 C**：双方约定一个 envelope 标准（例如 CloudEvents），事件总线全部按此形状。改动最大，最规范。

---

## 2. RESUME_PROCESSED · AO → RAAS（output）

AO 的 `processResume` agent 处理完成后发出此事件。RAAS 订阅此事件做 dedup 写库。

### 2.1 完整 payload 形状

```json
{
  "name": "RESUME_PROCESSED",
  "data": {
    "bucket": "recruit-resume-raw",
    "objectKey": "2026/03/222a3b35-...-【AI 产品经理...】刘芷萱 26年应届生.pdf",
    "filename": "【AI 产品经理（客服 _ 工作流方向）_深圳 12-13K】刘芷萱 26年应届生.pdf",
    "hrFolder": "chenyuanbei001-0000419993",
    "employeeId": "0000419993",
    "etag": "169cc79bb4020e688a8b15ffa30931d3",
    "size": 199744,
    "sourceEventName": "s3:ObjectCreated:Put",
    "receivedAt": "2026-04-28T05:31:27.358Z",
    "job_requisition_id": null,

    "candidate": {
      "name": "刘芷萱",
      "mobile": "+86-138-XXXX-XXXX",
      "email": "liu.zhixuan@example.com",
      "gender": null,
      "birth_date": null,
      "current_location": "深圳",
      "highest_acquired_degree": "本科",
      "work_years": 0,
      "current_company": null,
      "current_title": null,
      "skills": ["产品经理", "需求分析", "用户研究", "Axure", "SQL"]
    },
    "candidate_expectation": {
      "expected_salary_monthly_min": null,
      "expected_salary_monthly_max": null,
      "expected_cities": [],
      "expected_industries": [],
      "expected_roles": [],
      "expected_work_mode": null
    },
    "resume": {
      "summary": "应届生，AI 产品方向，关注客服与工作流场景。",
      "skills_extracted": ["产品经理", "需求分析", "用户研究", "Axure", "SQL"],
      "work_history": [
        {
          "title": "产品助理（实习）",
          "company": "某互联网公司",
          "startDate": "2025-06",
          "endDate": "2026-03",
          "description": "..."
        }
      ],
      "education_history": [
        {
          "degree": "本科",
          "field": "工业工程",
          "institution": "某 985 高校",
          "graduationYear": "2026"
        }
      ],
      "project_history": []
    },
    "runtime": {
      "current_title": null,
      "current_company": null
    },

    "parsedAt": "2026-04-28T05:31:35.812Z",
    "parserVersion": "ao+robohire@robohire-or-llm-2026-04-28",
    "parserMode": "robohire",
    "parserModelUsed": "robohire/parse-resume",
    "parserDurationMs": 5872,
    "parserRequestId": "rh_req_xxxxxxxx",
    "parserCached": false
  }
}
```

### 2.2 字段约定

| 区块 | 说明 |
|---|---|
| **来源透传**（`bucket / objectKey / filename / hrFolder / employeeId / etag / size / sourceEventName / receivedAt / job_requisition_id`）| 直接从 `RESUME_DOWNLOADED.data` 透传，便于 RAAS 关联回原始事件 |
| **`candidate`** | 候选人个人信息。**所有字段允许 null/空数组** — 如 LLM 没抽到不要伪造 |
| **`candidate_expectation`** | 期望（薪资/城市/行业/岗位/工作模式）。可缺失 |
| **`resume`** | 简历内容（summary / 技能 / 工作 / 教育 / 项目）|
| **`runtime`** | 当前在职信息（mirror candidate.current_*）|
| **`parser*`** | AO 解析器审计信息（mode/model/duration/requestId/cached）|

> ⚠️ **关键约束**：`candidate.candidate_id` / `resume.resume_id` / `candidate_expectation.id`
> 等 ID **不**由 AO 生成。RAAS 根据 dedup 结果决定 INSERT 新 ID 还是关联到已存在候选人。

---

## 3. MATCH_PASSED_NEED_INTERVIEW / MATCH_PASSED_NO_INTERVIEW / MATCH_FAILED · AO → RAAS（output）

AO 的 `matchResume` agent 在 `RESUME_PROCESSED` 后调 RoboHire `/match-resume`，根据 score 路由到三种 outcome。

### 3.1 共同 payload 形状（事件名即 outcome）

```json
{
  "name": "MATCH_PASSED_NEED_INTERVIEW",
  "data": {
    "bucket": "recruit-resume-raw",
    "objectKey": "2026/03/...刘芷萱 26年应届生.pdf",
    "filename": "【AI 产品经理（客服 _ 工作流方向）_深圳 12-13K】刘芷萱 26年应届生.pdf",
    "etag": "169cc79bb4020e688a8b15ffa30931d3",

    "candidate_ref": {
      "name": "刘芷萱",
      "mobile": "+86-138-XXXX-XXXX",
      "email": "liu.zhixuan@example.com"
    },

    "jd_source": "filename-inferred",
    "jd_text": "职位: AI 产品经理（客服 _ 工作流方向）\n工作地点: 深圳\n薪资范围: 12-13K\n(PoC: 此 JD 由文件名推断；待 RAAS 提供 jd_id 接口替换)",
    "jd_id": null,

    "match": {
      "score": 72,
      "recommendation": "GOOD_MATCH",
      "summary": "候选人虽为应届生，但项目经验贴近 AI 产品方向，沟通能力突出。",
      "technicalSkills": {
        "score": 68,
        "matchedSkills": ["产品经理", "需求分析", "Axure"],
        "missingSkills": ["LLM Prompt 设计", "Agent 工作流"]
      },
      "experienceLevel": {
        "score": 50,
        "required": "1-3 years",
        "candidate": "0 years (应届)",
        "assessment": "junior - 需培养"
      },
      "mustHave": {
        "extracted": {
          "skills": ["产品思维", "AI 行业知识"],
          "experience": ["客服或工作流相关"]
        },
        "matched": ["产品思维"]
      },
      "niceToHave": {
        "extracted": { "skills": ["SQL"], "certifications": [] },
        "matched": ["SQL"]
      }
    },

    "outcome": "MATCH_PASSED_NEED_INTERVIEW",
    "reason": null,
    "matchedAt": "2026-04-28T05:31:42.310Z",
    "robohireRequestId": "rh_match_xxxxxxxx"
  }
}
```

### 3.2 三种 outcome 的判定规则（spec §6.3）

| RoboHire `matchScore` | RoboHire `recommendation` | Inngest event `name` (= `outcome`) | 业务含义 |
|---|---|---|---|
| 80–100 | `STRONG_MATCH` | **`MATCH_PASSED_NO_INTERVIEW`** | 直接进推荐包，免面试 |
| 60–79 | `GOOD_MATCH` | **`MATCH_PASSED_NEED_INTERVIEW`** | 安排面试 |
| 40–59 | `PARTIAL_MATCH` | **`MATCH_FAILED`** | 不通过，原因="部分匹配但不达标" |
| 0–39 | `WEAK_MATCH` | **`MATCH_FAILED`** | 不通过 |

### 3.3 异常情况：MATCH_FAILED 早退

如果 filename 不符合 `【职位_城市 薪资】候选人 年限.ext` 模式，无法推断 JD，
agent 直接发出 `MATCH_FAILED`，`match` 为 `null`，`reason` 填明：

```json
{
  "name": "MATCH_FAILED",
  "data": {
    "bucket": "recruit-resume-raw",
    "objectKey": "...",
    "filename": "non-canonical-name.pdf",
    "etag": "...",
    "candidate_ref": { "name": "...", "mobile": "...", "email": "..." },
    "jd_source": "filename-inferred",
    "jd_text": "",
    "jd_id": null,
    "match": null,
    "outcome": "MATCH_FAILED",
    "reason": "JD inference failed",
    "matchedAt": "2026-04-28T05:31:42.310Z",
    "robohireRequestId": null
  }
}
```

---

## 4. 完整 E2E 链路示意

```
T+0     RAAS publishes RESUME_DOWNLOADED                 (input, §1)
          ↓
T+~5s   AO processResume agent receives, reads MinIO,
        calls RoboHire /parse-resume (~5s)
        emits RESUME_PROCESSED                           (output, §2)
          ↓
T+~5s   AO matchResume agent receives RESUME_PROCESSED,
        infers JD from filename,
        calls RoboHire /match-resume (~10-30s)
        emits MATCH_PASSED_NEED_INTERVIEW / NO_INTERVIEW / FAILED  (output, §3)
          ↓
        RAAS subscribes to RESUME_PROCESSED → dedup + INSERT/UPDATE
                                              Candidate / Resume / Candidate_Expectation
        RAAS subscribes to MATCH_*           → 安排面试 / 直接推荐 / 拒绝
```

---

## 5. 需要 RAAS 团队配合的 3 件事

1. **RESUME_DOWNLOADED 字段对齐**（§1.4 选 A/B/C 之一）
   - 推荐方案 A：扁平化发送，添加 `bucket/objectKey/filename` 必需字段

2. **加 `jd_id` 字段（强烈建议）**
   - 当前 AO 用 filename pattern 推断 JD，准确率有限且依赖命名规范
   - 如 RAAS 在 `RESUME_DOWNLOADED.data` 里加 `jd_id`，AO 可调 RAAS API 拉真实 JD 全文，匹配准确率显著提升

3. **订阅 AO 输出事件**
   - `RESUME_PROCESSED` → 走 dedup + 写 Candidate / Resume / Candidate_Expectation
   - `MATCH_PASSED_NEED_INTERVIEW` / `MATCH_PASSED_NO_INTERVIEW` / `MATCH_FAILED` → 业务后续动作

---

## 附录 A · TypeScript 类型定义（AO 实现侧）

可直接 copy 到 RAAS 的 SDK：

```ts
// RESUME_DOWNLOADED (input to AO)
type ResumeDownloadedData = {
  bucket: string;
  objectKey: string;
  filename: string;
  hrFolder: string | null;
  employeeId: string | null;
  etag: string | null;
  size: number | null;
  sourceEventName: string | null;
  receivedAt: string; // ISO
};

// RESUME_PROCESSED (output from AO)
type ResumeProcessedData = ResumeDownloadedData & {
  job_requisition_id: string | null;

  candidate: {
    name: string | null;
    mobile: string | null;
    email: string | null;
    gender: string | null;
    birth_date: string | null;
    current_location: string | null;
    highest_acquired_degree: string | null;
    work_years: number | null;
    current_company: string | null;
    current_title: string | null;
    skills: string[];
  };
  candidate_expectation: {
    expected_salary_monthly_min: number | null;
    expected_salary_monthly_max: number | null;
    expected_cities: string[];
    expected_industries: string[];
    expected_roles: string[];
    expected_work_mode: string | null;
  };
  resume: {
    summary: string | null;
    skills_extracted: string[];
    work_history: Array<{
      title?: string;
      company?: string;
      startDate?: string;
      endDate?: string;
      description?: string;
    }>;
    education_history: Array<{
      degree?: string;
      field?: string;
      institution?: string;
      graduationYear?: string;
    }>;
    project_history: unknown[];
  };
  runtime: {
    current_title: string | null;
    current_company: string | null;
  };

  parsedAt: string;
  parserVersion: string;
  parserMode: "robohire" | "new-api" | "openai" | "stub";
  parserModelUsed: string;
  parserDurationMs: number;
  parserRequestId?: string;
  parserCached?: boolean;
};

// MATCH_PASSED_NEED_INTERVIEW / MATCH_PASSED_NO_INTERVIEW / MATCH_FAILED
type MatchEventData = {
  bucket: string;
  objectKey: string;
  filename: string | null;
  etag: string | null;

  candidate_ref: {
    name: string | null;
    mobile: string | null;
    email: string | null;
  };

  jd_source: "filename-inferred" | "raas-api" | "minio-bucket";
  jd_text: string;
  jd_id: string | null;

  match: {
    score: number; // 0-100
    recommendation: "STRONG_MATCH" | "GOOD_MATCH" | "PARTIAL_MATCH" | "WEAK_MATCH";
    summary: string;
    technicalSkills: { score: number; matchedSkills: string[]; missingSkills: string[] };
    experienceLevel: { score: number; required: string; candidate: string; assessment: string };
    mustHave: { extracted: { skills: string[]; experience: string[] }; matched: string[] };
    niceToHave: { extracted: { skills: string[]; certifications: string[] }; matched: string[] };
  } | null; // null when reason = "JD inference failed"

  outcome:
    | "MATCH_PASSED_NEED_INTERVIEW"
    | "MATCH_PASSED_NO_INTERVIEW"
    | "MATCH_FAILED";
  reason: string | null;
  matchedAt: string;
  robohireRequestId: string | null;
};
```

---

## 附录 B · 验证联通的 curl 测试

把这一段发给 RAAS 团队，他们改完 payload 后能 self-test：

```bash
# 替换为你的真实 PDF objectKey
OBJECT_KEY="2026/03/your-real-resume.pdf"
FILENAME="【高级Java工程师_北京 30-45K】候选人姓名 5年.pdf"

curl -X POST 'http://10.100.0.70:8288/e/dev' \
  -H 'Content-Type: application/json' \
  -d "{
    \"name\": \"RESUME_DOWNLOADED\",
    \"data\": {
      \"bucket\": \"recruit-resume-raw\",
      \"objectKey\": \"$OBJECT_KEY\",
      \"filename\": \"$FILENAME\",
      \"hrFolder\": null,
      \"employeeId\": null,
      \"etag\": \"$(date +%s)-test\",
      \"size\": 199744,
      \"sourceEventName\": \"raas-test\",
      \"receivedAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"
    }
  }"
```

返回 `{"ids":["..."],"status":200}` 表示 Inngest 收到。AO 这边 5 秒内 bridge 拉过来，
agent 跑完后 RESUME_PROCESSED + MATCH_* 就在 Inngest 流上能看到。
