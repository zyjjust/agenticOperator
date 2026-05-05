# Resume Agent — 工程化实施规约

> **本文档是实施基准（spec），团队所有人按此对齐。**
> 早期分析见 [`ao-resume-workflow-design.md`](./ao-resume-workflow-design.md)（保留作背景）；
> 实质契约以 zyjjust 提供的 `resume-parser-agent-handoff.md` 为准；
> 本文档在 handoff 基础上扩展 match 范围 + 落地工程细节。

| 字段 | 值 |
|---|---|
| 文档状态 | **Active spec, ready to implement** |
| 日期 | 2026-04-27 |
| 范围 | RESUME_DOWNLOADED → RESUME_PROCESSED → MATCH_PASSED_* / MATCH_FAILED |
| 实施团队 | AO 维护方 |
| RAAS 对接人 | zyjjust |
| 部署形式 | 独立 Next.js 项目，**不修改** agenticOperator UI 任何代码 |

---

## 0. TL;DR

AO 在 `resume-parser-agent/` 独立项目里跑两个 Inngest function：

1. **`resume-parser-agent`** — 订阅 `RESUME_DOWNLOADED` → 从 MinIO 读 PDF → 文本提取 → RoboHire LLM 解析 → 字段映射成 RAAS Prisma 期望的 `{ candidate, candidate_expectation, resume, runtime }` 结构 → 发出 `RESUME_PROCESSED`
2. **`resume-matcher-agent`** — 订阅 `RESUME_PROCESSED` → 从 filename 推断 JD（PoC 简化）→ RoboHire `/match-resume` 打分 → 按 score 路由 → 发出 `MATCH_PASSED_NEED_INTERVIEW` / `MATCH_PASSED_NO_INTERVIEW` / `MATCH_FAILED`

**输出可视化**：
- 不改 AO 6 个 mock 页面
- 用 Inngest Dev Server UI（`http://10.100.0.70:8288`）作为主可视化
- 新项目内置一个独立 `/status` 页面，展示最近事件 + RoboHire 调用 audit

---

## 1. 决策档案

| # | 决策 | 选择 | 理由 |
|---|---|---|---|
| D1 | AO 与 raas_v4 的关系 | **替换** raas 现有解析逻辑（按 handoff） | zyjjust 已规划：他改 webhook 加 server-side copy + 删除旧 parser + 加 RESUME_PROCESSED 订阅者 |
| D2 | 范围 | parse + match（覆盖 schema workflow 9-1 + 10） | 用户决策；matchResume 同样属于 Agent 类 workflow，AO 可接管 |
| D3 | LLM 来源 | **RoboHire SaaS** + 字段映射层 | API key 现成，今天就能跑；缺失字段（薪资期望等）允许留空，不阻塞 raas dedup |
| D4 | DB 写入 | AO **不写任何 DB**（不写 SQLite，不写 RAAS PG） | handoff 明确：AO 是 stateless 转换器；状态全部走事件 |
| D5 | 重试策略 | `retries: 0`（LLM 解析失败不自动重试） | LLM 半成品危害大 |
| D6 | 幂等 key | `event.data.etag`（MinIO 给的） | 同一份简历重复触发时 step.run 短路 |
| D7 | 输出事件命名 | 用 schema 标准 UPPER_SNAKE_CASE：`RESUME_PROCESSED` `MATCH_PASSED_NEED_INTERVIEW` 等 | 直接对齐 ontology，不创新 namespace |
| D8 | AO UI 修改 | **不动** agenticOperator/app/* | 用户明确要求 |
| D9 | 共享 Inngest signing | `INNGEST_EVENT_KEY=dev` `INNGEST_SIGNING_KEY=dev` | 当前 dev server 接受 dev keys |
| D10 | MinIO 凭证 | `minioadmin / minioadmin@321`（用户提供，已验证） | handoff 写的 `myadmin/...` 可能过期 |

---

## 2. 系统拓扑

```
┌─ raas_v4（zyjjust 在重构）──────────────────────────────────────────┐
│  入口 A: HR 拖文件到 Nextcloud                                       │
│    → MinIO: recruit-nextcloud-raw                                    │
│    → MinIO webhook → raas server-side copy 到 recruit-resume-raw     │
│    → raas 发 RESUME_DOWNLOADED                                       │
│                                                                      │
│  入口 B: HR 在 dashboard 点上传                                       │
│    → POST /api/v1/candidates/upload-resume                           │
│    → 直接写 recruit-resume-raw                                       │
│    → raas 发 RESUME_DOWNLOADED                                       │
│                                                                      │
│  约定：发出事件时 bucket 永远 = "recruit-resume-raw"（canonical）     │
└────────────────────────────────────────┬─────────────────────────────┘
                                         │
                       Inngest Bus  http://10.100.0.70:8288
                                         │
                                         ▼
┌─ AO（本项目，新建 resume-parser-agent/）─────────────────────────────┐
│                                                                      │
│  ┌─ Function ① resume-parser-agent ─────────────────────────────┐   │
│  │  trigger: RESUME_DOWNLOADED                                   │   │
│  │  steps:                                                       │   │
│  │    1. fetch-from-minio   (10.100.0.70:9000)                  │   │
│  │    2. extract-text       (pdf-parse / mammoth)                │   │
│  │    3. robohire-parse     (POST /api/v1/parse-resume)         │   │
│  │    4. map-to-raas-schema (RoboHire → 4 对象嵌套)              │   │
│  │    5. sanity-check       (hasStructuredResumePayload)        │   │
│  │    6. emit RESUME_PROCESSED                                   │   │
│  └───────────────────────────────────────────────────────────────┘   │
│                              │                                       │
│                              ▼                                       │
│  ┌─ Function ② resume-matcher-agent ────────────────────────────┐   │
│  │  trigger: RESUME_PROCESSED                                    │   │
│  │  steps:                                                       │   │
│  │    1. infer-jd-from-filename (PoC 简化方案)                   │   │
│  │    2. robohire-match    (POST /api/v1/match-resume)          │   │
│  │    3. decide-outcome    (score → 三分支)                      │   │
│  │    4. emit MATCH_PASSED_NEED_INTERVIEW                        │   │
│  │       /  MATCH_PASSED_NO_INTERVIEW                            │   │
│  │       /  MATCH_FAILED                                         │   │
│  └───────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  /status (Next.js page，本项目内): 展示最近事件 + RoboHire audit      │
│  (不影响 agenticOperator/app/* 任何代码)                              │
└────────────────────────────────────────┬─────────────────────────────┘
                                         │
                                         ▼
┌─ raas_v4（继续）─────────────────────────────────────────────────────┐
│  ① 订阅 RESUME_PROCESSED                                              │
│       → mergeCandidateFields / buildDedupKey / normalizeMobile       │
│       → INSERT/UPDATE Candidate + Resume + Candidate_Expectation     │
│  ② 订阅 MATCH_PASSED_*                                                │
│       → 决定后续动作（面试邀请 / 直接推荐 / 拒绝）                      │
│       → 注意：raas 现有 job-matching.service.mjs 与 AO matcher 并行 │
│         的协调方式由 zyjjust 决定（feature flag 切换 / 二选一）       │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 3. 事件契约

### 3.1 `RESUME_DOWNLOADED`（输入，来自 RAAS）

**取自 handoff §2 真实样例**：

```ts
type ResumeDownloadedData = {
  bucket: string;         // 永远 "recruit-resume-raw"
  objectKey: string;      // 已 URL 解码，含中文
  filename: string;       // objectKey 的最后一段
  hrFolder: string | null;        // "{pinyin}-{employeeId}"
  employeeId: string | null;      // HR 工号
  etag: string | null;            // 用作幂等 key
  size: number | null;
  sourceEventName: string | null; // 例 "s3:ObjectCreated:Put"
  receivedAt: string;             // ISO
};
```

样例：
```json
{
  "name": "RESUME_DOWNLOADED",
  "data": {
    "bucket": "recruit-resume-raw",
    "objectKey": "2026/04/9b3e1c7a-...-梁安琦 4年.pdf",
    "filename": "【前端开发工程师_深圳 10-15K】梁安琦 4年.pdf",
    "hrFolder": "chenyuanbei001-0000419993",
    "employeeId": "0000419993",
    "etag": "169cc79bb4020e688a8b15ffa30931d3",
    "size": 299304,
    "sourceEventName": "s3:ObjectCreated:Put",
    "receivedAt": "2026-04-27T05:31:27.358Z"
  }
}
```

**已知缺口**：原 ontology `events_20260423.json` 中 `RESUME_DOWNLOADED` 含 `jd_id` (required)，但 handoff 真实 payload 里没有。matcher 因此无法从事件直接拿 JD，**临时方案见 §6.1（从 filename 推断）**。

### 3.2 `RESUME_PROCESSED`（输出 #1）

**严格对齐 handoff §3，含 RAAS Prisma 期望的所有字段**：

```ts
type ResumeProcessedData = {
  // 来源信息（直接透传 RESUME_DOWNLOADED）
  bucket: string;
  objectKey: string;
  filename: string;
  hrFolder: string | null;
  employeeId: string | null;
  etag: string | null;
  size: number | null;
  sourceEventName: string | null;
  receivedAt: string;

  // LLM 解析结果（4 对象嵌套，对齐 raas Prisma model）
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
    work_history: Array<{ title?: string; company?: string; startDate?: string; endDate?: string; description?: string }> | null;
    education_history: Array<{ degree?: string; field?: string; institution?: string; graduationYear?: string }> | null;
    project_history: unknown[] | null;
  };
  runtime: {
    current_title: string | null;
    current_company: string | null;
  };

  // 元数据
  parsedAt: string;          // ISO
  parserVersion: string;     // "robohire@v1+map-2026-04-27"
};
```

> ⚠️ **不**在 AO 这边生成 `candidate_id` / `resume_id` / `candidate_expectation_id`。
> raas 的 dedup 决定 INSERT 新 ID 还是关联已存在候选人。

### 3.3 `MATCH_PASSED_NEED_INTERVIEW` / `MATCH_PASSED_NO_INTERVIEW` / `MATCH_FAILED`（输出 #2）

**沿用 schema workflow 10 三个 triggered_event，payload 形状统一**：

```ts
type MatchEventData = {
  // 来源关联
  bucket: string;
  objectKey: string;
  filename: string;
  etag: string | null;

  // 候选人参考（不是 ID，是名/手机用作快速识别）
  candidate_ref: {
    name: string | null;
    mobile: string | null;
    email: string | null;
  };

  // JD 来源
  jd_source: "filename-inferred" | "raas-api" | "minio-bucket";  // PoC 用第一种
  jd_text: string;                          // 给 RoboHire 喂的 JD 文本
  jd_id: string | null;                     // 暂为 null，等 RAAS 给

  // 匹配结果
  match: {
    score: number;                          // 0-100
    recommendation: "STRONG_MATCH" | "GOOD_MATCH" | "PARTIAL_MATCH" | "WEAK_MATCH";
    summary: string;
    technicalSkills: { score: number; matchedSkills: string[]; missingSkills: string[] };
    experienceLevel: { score: number; required: string; candidate: string; assessment: string };
    mustHave: { extracted: { skills: string[]; experience: string[] }; matched: string[] };
    niceToHave: { extracted: { skills: string[]; certifications: string[] }; matched: string[] };
  };

  outcome: "MATCH_PASSED_NEED_INTERVIEW" | "MATCH_PASSED_NO_INTERVIEW" | "MATCH_FAILED";

  // Audit
  matchedAt: string;
  robohireRequestId: string;
};
```

发送时 `name` 字段就是 `outcome`，确保 schema 一致：
```ts
await step.sendEvent('emit-match', {
  name: outcome,                    // 三个 outcome 之一
  data: { ...matchEventData, outcome }
});
```

---

## 4. Function ① — `resume-parser-agent`

### 4.1 步骤定义

| # | step.run 名 | 类型 | 实现 | 失败处理 |
|---|---|---|---|---|
| 1 | `fetch-from-minio` | tool | `minioClient.getObject(bucket, objectKey)` → Buffer | 抛 `NonRetryableError`（key 不存在不重试） |
| 2 | `extract-text` | tool | PDF → `pdf-parse`；docx → `mammoth`；其他 → utf-8 | 抛 NonRetryable |
| 3 | `robohire-parse` | tool | `POST /api/v1/parse-resume`（multipart, file=PDF buffer） | 5xx/429 重试；4xx NonRetryable |
| 4 | `map-to-raas-schema` | logic | RoboHire 输出 → handoff §3 的 4 对象嵌套（详见 §5） | 不应失败 |
| 5 | `sanity-check` | logic | `hasStructuredResumePayload(parsed)` 来自 handoff §6.6 代码 | 抛 Error，不发事件 |
| 6 | `emit-resume-processed` | — | `step.sendEvent('RESUME_PROCESSED', { ... })` | — |

### 4.2 `hasStructuredResumePayload` 完整实现

直接抄 handoff §6.6（来自 raas `resume-uploaded.function.ts:112-127`）：

```ts
function hasStructuredResumePayload(parsed: any): boolean {
  const c = parsed?.candidate ?? {};
  const ce = parsed?.candidate_expectation ?? {};
  const r = parsed?.resume ?? {};
  const rt = parsed?.runtime ?? {};
  const nonEmpty = (v: any) => typeof v === 'string' && v.trim().length > 0;
  return Boolean(
    nonEmpty(c.name) ||
      nonEmpty(c.mobile) ||
      nonEmpty(c.email) ||
      nonEmpty(ce.expected_position) ||
      nonEmpty(rt.current_title) ||
      nonEmpty(rt.current_company) ||
      (Array.isArray(r.skills_extracted) && r.skills_extracted.length > 0)
  );
}
```

### 4.3 关键 Inngest 配置

```ts
inngest.createFunction(
  {
    id: 'resume-parser-agent',
    name: 'Resume Parser Agent',
    retries: 0,                      // D5: LLM 不重试
    idempotency: 'event.data.etag',  // D6: MinIO etag 幂等
  },
  { event: 'RESUME_DOWNLOADED' },
  async ({ event, step, logger }) => { /* ... */ }
);
```

---

## 5. RoboHire → RAAS Schema 映射层

**这是 D3 的核心成本**：RoboHire 输出和 raas Prisma 期望的字段不完全对齐，需要一个翻译层。

### 5.1 字段映射表

| RAAS 字段 | RoboHire 来源 | 映射策略 |
|---|---|---|
| `candidate.name` | `data.name` | 直接 |
| `candidate.mobile` | `data.phone` | 字符串清洗（移除空格/横线） |
| `candidate.email` | `data.email` | 直接 |
| `candidate.current_location` | `data.location` | 直接 |
| `candidate.highest_acquired_degree` | `data.education[0].degree` | 取最高学历（按学位 rank） |
| `candidate.work_years` | 派生：`data.experience[]` 起止日期累加 | 计算 |
| `candidate.current_company` | `data.experience[0].company`（endDate=present 那条） | 取 endDate=present 或最新 |
| `candidate.current_title` | `data.experience[0].title`（同上） | 同上 |
| `candidate.skills` | `data.skills` | 直接 |
| `candidate.gender` | — | **null**（RoboHire 不返回，留空） |
| `candidate.birth_date` | — | **null** |
| `candidate_expectation.expected_salary_monthly_min/max` | — | **null**（RoboHire 不返回，留空） |
| `candidate_expectation.expected_cities` | — | `[]` |
| `candidate_expectation.expected_industries` | — | `[]` |
| `candidate_expectation.expected_roles` | — | `[]` |
| `candidate_expectation.expected_work_mode` | — | **null** |
| `resume.summary` | `data.summary` | 直接 |
| `resume.skills_extracted` | `data.skills` | 直接（与 candidate.skills 同源） |
| `resume.work_history` | `data.experience[]` | JSON 透传 |
| `resume.education_history` | `data.education[]` | JSON 透传 |
| `resume.project_history` | — | `[]`（RoboHire 不返回项目史） |
| `runtime.current_title` | 同 `candidate.current_title` | 直接 |
| `runtime.current_company` | 同 `candidate.current_company` | 直接 |

### 5.2 缺失字段的处置

handoff dedup 规则用 **name + mobile + email** 主键，所以以下字段缺失**不阻塞** raas dedup：
- `candidate_expectation.*`（薪资/城市/行业/岗位/工作模式）
- `candidate.gender` / `candidate.birth_date`
- `resume.project_history`

**留白策略**：缺失字段一律设 `null` 或 `[]`，**不**虚构数据。前端如果将来要展示，可以用"未填"占位。

未来可演进：
- (a) 加二次 LLM 调用专门提取这些字段
- (b) 切到公司 LLM gateway，prompt 里直接要求输出完整 schema
- (c) 接入更专业的 SaaS（如有）

### 5.3 `parserVersion` 字段约定

```ts
parserVersion: `robohire@v1+map@${MAPPING_VERSION}`
// 例: "robohire@v1+map@2026-04-27"
```

`MAPPING_VERSION` 是字段映射表的版本号；改映射表必须升版本，方便回溯哪些数据用了哪版逻辑。

---

## 6. Function ② — `resume-matcher-agent`

### 6.1 JD 来源（PoC 关键妥协）

handoff 真实 `RESUME_DOWNLOADED` payload 里没有 `jd_id`。临时方案：**从 filename 推断 JD**。

filename 模式（来自 MinIO 实际数据）：
```
【前端开发工程师_深圳 10-15K】梁安琦 4年.pdf
└── 拆出 ─→ jobTitle: "前端开发工程师"
            city: "深圳"
            salaryRange: "10-15K"
            candidateName: "梁安琦"
            yearsExp: "4年"
```

正则：
```ts
const m = filename.match(/^【(.+?)_(.+?)\s+(.+?)】(.+?)\s+(.+?)\.\w+$/);
// m[1]=jobTitle, m[2]=city, m[3]=salaryRange, m[4]=candidateName, m[5]=yearsExp
```

合成 JD 文本（喂给 RoboHire `/match-resume` 的 `jd` 字段）：
```
职位：{jobTitle}
工作地点：{city}
薪资范围：{salaryRange}
（PoC 阶段从简历文件名推断的简化 JD；待 RAAS 提供 jd_id → JD 全文对接后替换）
```

匹配不到正则时 → emit `MATCH_FAILED` with `reason: "JD inference failed"`。

**生产化路径**（写进 Q-list 给 zyjjust）：
- 让 RAAS 在 RESUME_DOWNLOADED payload 加回 `jd_id` 字段
- 或让 RAAS 提供 `GET /api/v1/jds/:id` 拉 JD 全文
- 或 RAAS 把 JD 文件放进 MinIO 并约定路径规则

### 6.2 步骤定义

| # | step.run 名 | 类型 | 实现 | 失败处理 |
|---|---|---|---|---|
| 1 | `infer-jd-from-filename` | logic | 正则解析 + 合成 JD 文本 | 解析失败 → emit MATCH_FAILED 早退 |
| 2 | `flatten-resume-text` | logic | 把 §3.2 的 4 对象嵌套压成 RoboHire `/match-resume` 期望的 `resume` plain text | — |
| 3 | `robohire-match` | tool | `POST /api/v1/match-resume`（JSON, fields: resume, jd） | 5xx/429 重试；4xx NonRetryable |
| 4 | `decide-outcome` | logic | score → 三分支映射（见 6.3） | — |
| 5 | `emit-match` | — | `step.sendEvent(outcome, { ... })` | — |

### 6.3 分流规则

| RoboHire matchScore | RoboHire recommendation | AO outcome |
|---|---|---|
| ≥ 80 | `STRONG_MATCH` | `MATCH_PASSED_NO_INTERVIEW` |
| 60–79 | `GOOD_MATCH` | `MATCH_PASSED_NEED_INTERVIEW` |
| 40–59 | `PARTIAL_MATCH` | `MATCH_FAILED` |
| 0–39 | `WEAK_MATCH` | `MATCH_FAILED` |

阈值放在配置里（`config/match-thresholds.ts`），便于 tune。

### 6.4 配置

```ts
inngest.createFunction(
  {
    id: 'resume-matcher-agent',
    name: 'Resume Matcher Agent',
    retries: 2,                              // matcher 调外部 API，可适度重试
    idempotency: 'event.data.etag',
  },
  { event: 'RESUME_PROCESSED' },
  async ({ event, step, logger }) => { /* ... */ }
);
```

---

## 7. 集成点

### 7.1 MinIO

- **S3 API**：`http://10.100.0.70:9000`（确认过：9001 是 Web Console，9000 才是 API）
- **凭证**：`minioadmin / minioadmin@321`
- **Canonical bucket**：`recruit-resume-raw`
- **SDK**：`minio` npm 包 ^8.0.x
- **关键操作**：仅 `getObject(bucket, objectKey)`，**不写不 copy**
- **Stream → Buffer**（来自 handoff §6.6）：

  ```ts
  async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  ```

### 7.2 RoboHire

- **Base URL**：`https://api.robohire.io`
- **API Key**：通过 `Authorization: Bearer ${ROBOHIRE_API_KEY}` 头部
- **两个端点**：
  - `POST /api/v1/parse-resume`（multipart，body: file=PDF binary，max 10MB）
  - `POST /api/v1/match-resume`（JSON，body: `{ resume, jd, candidatePreferences?, jobMetadata? }`）
- **延迟**：parse 3-8s，match 5-15s；client timeout 设 120s
- **缓存**：parse 按 PDF 内容哈希自动缓存；match 不缓存
- **错误**：429/5xx 返回 `requestId`，可用于 retry tracing；4xx 是 input 问题，不应重试
- **配额**：match 扣月度配额，注意监控

### 7.3 Inngest

- **总线**：`http://10.100.0.70:8288`（团队共享 dev server，与 raas_v4 共用）
- **AO client id**：`agentic-operator`（与 handoff §6.2 一致；区别于 raas_v4 的 `raas-backend`）
- **Serve endpoint**：`http://<AO_LAN_IP>:3020/api/inngest`（Next.js）
- **首次启动注册**：必须主动 POST 一次让远端发现：
  ```bash
  curl -X POST http://10.100.0.70:8288/fn/register \
    -H 'Content-Type: application/json' \
    -d '{"url":"http://172.16.1.83:3020/api/inngest"}'
  ```
- **环境变量**：
  ```
  INNGEST_DEV=http://10.100.0.70:8288
  INNGEST_BASE_URL=http://10.100.0.70:8288
  INNGEST_EVENT_KEY=dev
  INNGEST_SIGNING_KEY=dev
  ```

---

## 8. 可视化方案（不改 AO UI）

按 D8 决定，**不动** `agenticOperator/app/*` 任何文件。可视化通过下面三个层次：

### 8.1 主可视化：Inngest Dev Server UI

`http://10.100.0.70:8288`

提供：
- Stream tab：实时事件流，看到 `RESUME_DOWNLOADED` 进 → `RESUME_PROCESSED` 出 → `MATCH_PASSED_*` 出
- Functions tab：看 function 执行历史、每次运行的 step 输入输出 JSON
- Apps tab：看到 `agentic-operator` app 已注册 + 两个 function

**给 leader demo 主用这个 UI。**

### 8.2 次可视化：本项目内置 `/status` 页面

在 `resume-parser-agent/app/page.tsx` 里写一个简单的状态面板（**不在** agenticOperator 主仓）。展示：

- 服务状态：上次启动时间、function 数量
- 最近 N 次 RoboHire 调用 audit（requestId、cached、duration）—— 从 Inngest API `GET /v1/runs?function=...` 拉
- 链接到 Inngest UI 对应的 function/event

**完全独立**于 agenticOperator/app/*；通过浏览器访问 `http://localhost:3020/`（不与 :3002 冲突）。

### 8.3 三级可视化：日志

- agent stdout：`tail -f /tmp/resume-agent-dev.log` 看 `[resume-parser-agent] received bucket=...` 等业务日志
- Inngest API `/v1/events`：可程序化查询事件历史（如果需要做趋势图）

> 未来如果 AO UI 要接入：用 `/events` 页（已有 mock 实现）改成调 `http://10.100.0.70:8288/v1/events` API 即可。**不在本 PoC 范围内。**

---

## 9. 工程结构

```
resume-parser-agent/                            ← 独立 Next.js 项目
├── package.json
├── tsconfig.json
├── next.config.ts
├── .env.local                                  ← 不入 git
├── .gitignore
├── README.md
├── lib/
│   ├── inngest/
│   │   ├── client.ts                           ← Inngest client + EventSchemas
│   │   └── functions/
│   │       ├── resume-parser-agent.ts          ← Function ①
│   │       └── resume-matcher-agent.ts         ← Function ②
│   ├── minio.ts                                ← MinioClient + streamToBuffer + getResumeBuffer()
│   ├── text-extract.ts                         ← extractText(buffer, filename) → string
│   ├── robohire.ts                             ← parseResume() + matchResume()
│   ├── mappers/
│   │   ├── robohire-to-raas.ts                 ← RoboHire output → 4 对象嵌套
│   │   └── flatten-resume.ts                   ← 4 对象 → plain text（给 match 用）
│   ├── inference/
│   │   └── jd-from-filename.ts                 ← PoC 简化的 JD 推断
│   └── config/
│       └── match-thresholds.ts                 ← 80/60 阈值
├── app/
│   ├── api/inngest/route.ts                    ← Inngest serve handler
│   ├── layout.tsx
│   └── page.tsx                                ← /status 页（§8.2）
├── scripts/
│   ├── register-with-inngest.ts                ← 主动注册到远端 dev server
│   ├── publish-test-event.ts                   ← 手动触发一条 RESUME_DOWNLOADED
│   ├── list-minio-resumes.ts                   ← 列 MinIO 中可用简历
│   └── pick-test-resume.ts                     ← 从 MinIO 选一份简历的 objectKey
└── tests/                                       ← (Phase 2 加单元测试)
```

**关键约束**：
- `package.json` 端口固定 `3020`（agenticOperator 用 3002，避免冲突）
- 完全不引用 agenticOperator 主仓代码
- 独立 `node_modules`

---

## 10. 配置（`.env.local` 完整模板）

```bash
# ─── Inngest（团队共享 dev server）─────────────────────
INNGEST_DEV=http://10.100.0.70:8288
INNGEST_BASE_URL=http://10.100.0.70:8288
INNGEST_EVENT_KEY=dev
INNGEST_SIGNING_KEY=dev

# ─── MinIO（S3 API 在 9000）───────────────────────────
MINIO_ENDPOINT=10.100.0.70
MINIO_PORT=9000
MINIO_USE_SSL=false
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin@321
MINIO_DEFAULT_BUCKET=recruit-resume-raw

# ─── RoboHire ─────────────────────────────────────────
ROBOHIRE_API_KEY=rh_ed0264681b5587cfbd0e4ef556a3b1323e43444603828a0b
ROBOHIRE_BASE_URL=https://api.robohire.io

# ─── 本机注册地址（远端 Inngest 回连）──────────────────
AO_LAN_IP=172.16.1.83
AO_PORT=3020
```

---

## 11. 部署与启动

### 11.1 一次性准备

```bash
cd resume-parser-agent
npm install
```

### 11.2 启动 agent

```bash
npm run dev      # 监听 :3020
```

### 11.3 注册到远端 Inngest

```bash
npm run register
# 内部执行：
# curl -X POST http://10.100.0.70:8288/fn/register \
#   -d '{"url":"http://172.16.1.83:3020/api/inngest"}'
```

成功标志：终端打印 `{"ok":true,"app_id":"...","sync_id":"..."}` + agent 日志出现 `PUT /api/inngest 200`。

### 11.4 验证

```bash
# 1. 列 MinIO 中可用简历
npm run minio:list

# 2. 选一份发测试事件
npm run publish:test
# 默认随机选一个 recruit-resume-raw 中的 PDF 发 RESUME_DOWNLOADED
```

预期 Inngest UI 显示：
1. `RESUME_DOWNLOADED`（手动触发的）
2. function `resume-parser-agent` invoked
3. `RESUME_PROCESSED`（带 4 对象嵌套数据）
4. function `resume-matcher-agent` invoked
5. `MATCH_PASSED_*` 或 `MATCH_FAILED`

---

## 12. 实施计划

### Day 1（半天）—— 起骨架 + parser 跑通

- [ ] 1.1 项目初始化（package.json, tsconfig, next.config, .env.local）
- [ ] 1.2 EventSchemas（§3 三种事件类型）
- [ ] 1.3 `lib/minio.ts` + `streamToBuffer`
- [ ] 1.4 `lib/text-extract.ts`（pdf-parse + mammoth）
- [ ] 1.5 `lib/robohire.ts` parse 函数
- [ ] 1.6 `lib/mappers/robohire-to-raas.ts`
- [ ] 1.7 Function ① resume-parser-agent
- [ ] 1.8 `scripts/register-with-inngest.ts` + `scripts/publish-test-event.ts`
- [ ] 1.9 注册 + 用 MinIO 中真实简历跑通 parser → 看到 RESUME_PROCESSED 在 Inngest UI 出现

里程碑：手动 send 一条 RESUME_DOWNLOADED，能拿到完整 4 对象嵌套的 RESUME_PROCESSED 输出。

### Day 2（半天）—— matcher + status 页 + 端到端 demo

- [ ] 2.1 `lib/inference/jd-from-filename.ts`
- [ ] 2.2 `lib/mappers/flatten-resume.ts`
- [ ] 2.3 `lib/robohire.ts` match 函数
- [ ] 2.4 `lib/config/match-thresholds.ts`
- [ ] 2.5 Function ② resume-matcher-agent
- [ ] 2.6 `app/page.tsx` 简单 /status 页
- [ ] 2.7 端到端验证（一条事件进 → 三级输出）
- [ ] 2.8 README + demo 脚本

里程碑：一份真简历，端到端 30 秒内出 score + outcome。

---

## 13. 测试与验收

### 13.1 自测清单

- [ ] `npm run build` 通过（TypeScript strict）
- [ ] Inngest Dev UI 看到 `agentic-operator` app + 两个 function
- [ ] 手动 send `RESUME_DOWNLOADED`（payload 见 §3.1 样例），function ① 完整跑完
- [ ] step 日志显示：`bucket/objectKey/filename` + `extracted N chars` + `robohire requestId=...`
- [ ] 发出的 `RESUME_PROCESSED` payload 含 §3.2 所有字段（4 对象嵌套）
- [ ] LLM 解析失败时 `hasStructuredResumePayload` 抛错（不发空事件）
- [ ] function ② 自动接力执行
- [ ] `MATCH_PASSED_*` / `MATCH_FAILED` 中之一被发出
- [ ] 相同 etag 重复触发，function 短路（idempotency 生效）

### 13.2 与 RAAS 联调验收（zyjjust 配合）

- [ ] zyjjust 加完 webhook copy 后，从 Nextcloud 拖一份文件，bucket 字段确认是 `recruit-resume-raw`
- [ ] zyjjust 的新 RESUME_PROCESSED 订阅者能正确解析 AO 发出的 payload，dedup 流程跑通
- [ ] AO 发出 `MATCH_PASSED_NEED_INTERVIEW`，raas 后续流程（如有）能消费

---

## 14. 与 RAAS 团队的协作契约

### 14.1 AO 承担

- ✅ 订阅 `RESUME_DOWNLOADED`
- ✅ 从 MinIO 读字节
- ✅ 文本提取
- ✅ LLM 解析（用 RoboHire）
- ✅ 输出 `RESUME_PROCESSED`（payload 严格按 §3.2）
- ✅ 匹配（PoC 阶段用 filename 推断 JD）
- ✅ 输出 `MATCH_PASSED_*` / `MATCH_FAILED`（payload 按 §3.3）

### 14.2 RAAS（zyjjust）承担

- ✅ 在 webhook handler 里加 Nextcloud → canonical 的 server-side copy
- ✅ 删除旧 `resume-uploaded.function.ts`（feature flag 切换上线，避免双跑）
- ✅ 新建一个 inngest function 订阅 `RESUME_PROCESSED` 做 dedup + 写 PG
- ⚠️ 决定是否同时订阅 `MATCH_PASSED_*` —— 如果是，停掉 raas 现有 `job-matching.service.mjs`；如果不订阅，raas 现有 matching 继续跑（与 AO matcher 并行）
- 🔵 **非阻塞但建议**：在 RESUME_DOWNLOADED 加回 `jd_id` 字段（PoC 不需要，但生产化必需）

### 14.3 双方共享

- Inngest dev server `10.100.0.70:8288`（事件总线）
- MinIO `10.100.0.70:9000`（PDF 存储）
- 信号通过事件传递，**互不调用对方 HTTP API**

### 14.4 上线协调

```
T0:  AO 完成 PoC（本文档）
T+1: AO + zyjjust 联调，验收 §13.2
T+2: zyjjust feature flag = AO 模式（关闭 raas 旧 parser）
T+3: 观察 1-2 天，确认无回归
T+4: zyjjust 删除旧 parser 代码
```

---

## 15. 风险与回滚

| 风险 | 影响 | 应对 |
|---|---|---|
| RoboHire 限流（429） | matcher 卡住 | step.run 自动重试 + 监控；演示前预热缓存 |
| RoboHire LLM tail latency > 30s | function 超时 | client timeout 设 120s；Inngest function 默认 timeout 足够 |
| RoboHire 输出 schema 变化 | 映射层报错 | mapper 里所有字段访问加防御（`?.`、默认值），失败转 NonRetryable |
| MinIO 凭证失效 | 全部 function 失败 | env 集中管理，凭证 rotation 时改一处 |
| 远端 Inngest 重启丢注册 | 事件来了 AO 收不到 | `npm run register` 一键重注册；写进操作 runbook |
| AO 部署到云后无法被 10.100.0.70 反向连接 | 生产无法运行 | 改用 Inngest Cloud（managed） 或 ngrok/cloudflare tunnel |
| zyjjust 切 feature flag 时双跑 | 数据库重复写入 | feature flag 严格互斥；上线前演练切换流程 |
| filename 推断 JD 失败率高 | matcher MATCH_FAILED 假阳性 | 短期：emit 时带 `reason` 字段；中期：催 RAAS 加 jd_id |

### 15.1 回滚计划

如果 AO PoC 出现严重问题：

1. **立即**：zyjjust 把 feature flag 切回 raas 旧 parser（10 秒内生效）
2. **AO 这边**：停掉 dev server 进程（`pkill -f "next dev -p 3020"`），不影响任何其他系统
3. **数据**：AO 不写 DB，**没有需要回滚的数据**
4. **事件**：发出过的 `RESUME_PROCESSED` / `MATCH_*` 事件留在 Inngest 历史里，作为 audit；如果有副作用，由 raas 团队处理

---

## 16. 后续路线图（不在本 PoC 范围）

| 阶段 | 内容 | 预估 | 触发条件 |
|---|---|---|---|
| Phase 2 | 加 `interview-evaluator-agent`（订阅 `AI_INTERVIEW_COMPLETED`） | 1 天 | PoC 验收通过 + 业务需求 |
| Phase 3 | 加 `package-summarizer-agent`（订阅 `PACKAGE_GENERATED`） | 1 天 | 同上 |
| Phase 4 | 真正接入 jd_id → JD 全文（替换 §6.1 filename 推断） | 1-2 天 | RAAS 提供 JD 接口 |
| Phase 5 | AO `/events` 页拆 mock，接 Inngest API | 1 天 | UI 团队同意 |
| Phase 6 | 切到公司 LLM gateway 替换 RoboHire | 视情况 | 成本 / 准确性诉求 |

---

## 17. 附录

### 17.1 关键文件路径

| 用途 | 路径 |
|---|---|
| 本规约 | [`docs/resume-agent-engineering-spec.md`](./resume-agent-engineering-spec.md) |
| 上游设计分析 | [`docs/ao-resume-workflow-design.md`](./ao-resume-workflow-design.md) |
| zyjjust handoff | `~/Library/Containers/com.tencent.xinWeChat/.../resume-parser-agent-handoff.md` |
| RoboHire API 文档 | `~/Library/Containers/com.tencent.xinWeChat/.../api-external-resume-parsing-and-matching.md` |
| RAAS 现有 parser（参考，将被删） | [`Action_and_Event_Manager/raas_v4/backend/apps/api/src/modules/inngest/functions/resume-uploaded.function.ts`](../Action_and_Event_Manager/raas_v4/backend/apps/api/src/modules/inngest/functions/resume-uploaded.function.ts) |
| RAAS 现有 matcher（与 AO 并行/替换待定） | [`Action_and_Event_Manager/raas_v4/backend/apps/api/src/modules/matching/job-matching.service.mjs`](../Action_and_Event_Manager/raas_v4/backend/apps/api/src/modules/matching/job-matching.service.mjs) |
| Schema source of truth | [`Action_and_Event_Manager/data/events_20260423.json`](../Action_and_Event_Manager/data/events_20260423.json) [`actions_20260323 (1).json`](../Action_and_Event_Manager/data/actions_20260323%20(1).json) [`workflow_20260330 (1).json`](../Action_and_Event_Manager/data/workflow_20260330%20(1).json) |
| 现有简单 PoC（单 stub agent，参考） | [`resume-parser-agent/`](../resume-parser-agent/)（注：将被本项目重写覆盖） |

### 17.2 术语

| 缩写 | 全称 | 说明 |
|---|---|---|
| AO | Agentic Operator | 本仓库 |
| RAAS | Recruitment-as-a-Service | raas_v4 + Action_and_Event_Manager |
| @aem | Action_and_Event_Manager | 事件治理后端，与本 PoC 不直接交互 |
| handoff | zyjjust 提供的对接文档 | `resume-parser-agent-handoff.md` |
| canonical bucket | 规范化 bucket | `recruit-resume-raw`，所有简历最终归此 |
| dedup | deduplication | 候选人去重，由 RAAS 承担 |
| HITL | Human-in-the-loop | 本 PoC 不涉及 |

### 17.3 Match outcome 完整映射

| RoboHire score | RoboHire recommendation | AO outcome event | 业务含义 |
|---|---|---|---|
| 80–100 | `STRONG_MATCH` | `MATCH_PASSED_NO_INTERVIEW` | 直接进推荐包 |
| 60–79 | `GOOD_MATCH` | `MATCH_PASSED_NEED_INTERVIEW` | 安排面试 |
| 40–59 | `PARTIAL_MATCH` | `MATCH_FAILED` | 不通过 |
| 0–39 | `WEAK_MATCH` | `MATCH_FAILED` | 不通过 |

### 17.4 Demo 脚本（给 leader 的 2 分钟演示）

```
[00:00] "这是 AO 的事件驱动 agent demo。RAAS 那边有简历进来，
        AO 这边的两个 agent 自动接力 —— 解析 + 匹配 —— 全部走 Inngest 事件总线。"

[00:15] 屏幕 1: Inngest UI Stream 标签
        屏幕 2: agent 终端 stdout
        屏幕 3: AO /status 页面（独立于 AO 主 UI）

[00:30] 在 Inngest UI Send Event：
        {
          "name": "RESUME_DOWNLOADED",
          "data": { ...§3.1 真实样例... }
        }

[00:45] Stream 依次冒出：
        • RESUME_DOWNLOADED                             ← 触发
        • inngest/function.invoked (resume-parser-agent)
        • RESUME_PROCESSED                              ← parser 完成
        • inngest/function.invoked (resume-matcher-agent)
        • MATCH_PASSED_NO_INTERVIEW                     ← matcher 完成

[01:15] 点开 RESUME_PROCESSED：
        - candidate.name = "梁安琦"
        - candidate.skills = ["React", "TypeScript", ...]
        - resume.work_history = [...完整工作经历...]
        - parserVersion = "robohire@v1+map@2026-04-27"

[01:30] 点开 MATCH_PASSED_NO_INTERVIEW：
        - match.score = 92
        - match.recommendation = STRONG_MATCH
        - match.matchedSkills = [...]
        - robohireRequestId = req_xxx (可在 robohire.io dashboard 反查)

[01:50] "三件事可以讲：
         ① 事件驱动：每个 agent 单一职责，加新 agent 就是加新订阅
         ② 跨服务：AO 和 RAAS 共用一条事件总线，互不依赖代码
         ③ 真 LLM：RoboHire 在线 API，不是 mock"

[02:00] Q&A
```

---

**文档结束。**

下一步：执行 §12 实施计划。Day 1 开工不依赖 RAAS 任何额外输入（已有 credentials 全齐）。
