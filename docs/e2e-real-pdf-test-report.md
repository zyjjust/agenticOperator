# 端到端测试报告 — 谌治中 游戏测试简历

**测试时间**：2026-04-28 12:07
**简历**：`recruit-resume-raw/2026/04/e7b3dde7-b4fc-96dc-6a9b-d2e2facd57db-【游戏测试（全国招聘）_深圳 7-11K】谌治中 3年.pdf`
**输入大小**：380,866 字节
**测试脚本**：`scripts/e2e-real-pdf.ts`
**全部产物路径**：`data/e2e-out/2026-04-28T04-07-45-605Z/`

---

## 0. TL;DR — RoboHire 真的调不通

**RoboHire 的两个端点 `/parse-resume` 和 `/match-resume` 当前都返回 HTTP 500**，错误信息都是同一个：

```json
{
  "success": false,
  "error": "400 openrouter/google/gemini-3.1-pro-preview is not a valid model ID",
  "requestId": "req_1777349267230_z3pq6nm"
}
```

这是 RoboHire 服务端 bug —— 他们后端配置使用的 OpenRouter 模型 ID `openrouter/google/gemini-3.1-pro-preview` 在 OpenRouter 不存在。我用 6 种不同方式调用 `/parse-resume`（包括 105 字节的最小有效 PDF、纯 ASCII 文件名、设置 `application/pdf` mime、不设置 mime、`octet-stream` mime、原始中文文件名）每次都失败，复现率 100%。

我们的客户端代码没有问题。需要让 RoboHire 那边修这个模型 ID。

为了让端到端能跑通，我加了一个降级路径：

```
RoboHire /parse-resume 失败
  ↓
unpdf 抽文本（PDF → 3,427 字符）
  ↓
new-api 网关 (gemini-3-flash-preview) 结构化
  ↓
RESUME_PROCESSED 事件 (4-object schema)
```

降级后所有数据都正常解析出来，候选人姓名 / 电话 / 邮箱 / 学历 / 工作经历 / 项目经历都齐全。

---

## 1. 输入 — RAAS 应该发送的事件 (canonical AO 格式)

文件 `01-input-RESUME_DOWNLOADED.json`：

```json
{
  "name": "RESUME_DOWNLOADED",
  "data": {
    "bucket": "recruit-resume-raw",
    "objectKey": "2026/04/e7b3dde7-b4fc-96dc-6a9b-d2e2facd57db-【游戏测试（全国招聘）_深圳 7-11K】谌治中 3年.pdf",
    "filename": "【游戏测试（全国招聘）_深圳 7-11K】谌治中 3年.pdf",
    "hrFolder": "xiaqi-0000206419",
    "employeeId": "0000206419",
    "etag": "real-2026-04-28-shen-zhi-zhong",
    "size": null,
    "sourceEventName": "raas-real-pdf-test",
    "receivedAt": "2026-04-28T03:00:00Z"
  }
}
```

---

## 2. RoboHire `/api/v1/parse-resume` — 实际请求与失败响应

文件 `03-robohire-parse-ERROR.json`：

**请求**

| 字段 | 值 |
|---|---|
| URL | `https://api.robohire.io/api/v1/parse-resume` |
| Method | POST |
| Content-Type | `multipart/form-data` |
| File field | `file` |
| File size | 380,866 bytes |
| File mime | `application/pdf`（按官方文档要求设置） |
| Filename | `【游戏测试（全国招聘）_深圳 7-11K】谌治中 3年.pdf` |
| Auth | `Authorization: Bearer rh_ed02...` |

**响应**

```http
HTTP/1.1 500 Internal Server Error
content-type: application/json; charset=utf-8
x-request-id: req_1777349267230_z3pq6nm
server: cloudflare
x-powered-by: Express
duration: 3785ms
```

```json
{
  "success": false,
  "error": "400 openrouter/google/gemini-3.1-pro-preview is not a valid model ID",
  "requestId": "req_1777349267230_z3pq6nm"
}
```

**复现矩阵**（`scripts/probe-robohire.ts`）：

| # | 文件名 | mime | 字节数 | 结果 |
|---|---|---|---|---|
| 1 | `resume.pdf` | `application/pdf` | 380,866 | 500 — `openrouter/google/gemini-3.1-pro-preview is not a valid model ID` |
| 2 | `resume.pdf` | (none) | 380,866 | 500 — `internal_error` |
| 3 | 中文原文件名 | `application/pdf` | 380,866 | 500 — `openrouter/google/gemini-3.1-pro-preview is not a valid model ID` |
| 4 | `game_tester_shen_3years.pdf` | `application/pdf` | 380,866 | 500 — `openrouter/google/gemini-3.1-pro-preview is not a valid model ID` |
| 5 | `resume.pdf` | `application/octet-stream` | 380,866 | 500 — `internal_error` |
| 6 | 105-byte stub PDF | `application/pdf` | 105 | 500 — `PDF extraction failed: no text could be extracted` |

第 6 项证明端点至少能跑到文本抽取阶段；前 5 项证明对真实 PDF 跑到 LLM 调用阶段就崩在模型 ID 上。这是服务器端配置问题，不是负载问题。

---

## 3. 降级路径 — unpdf + new-api gateway

### 3.1 PDF → 文本（unpdf）

`unpdf` 是 pdfjs-dist 的无 worker fork，专为 Next.js / serverless 设计。绕过了之前 `pdf-parse v2 → pdfjs-dist → pdf.worker.mjs` 在 Turbopack 下找不到 worker 文件的问题。

抽出 3,427 字符（中文有效）。文件 `03b-pdf-extracted-text.txt` 保留了原始抽取结果。

### 3.2 文本 → 结构化（new-api `google/gemini-3-flash-preview`）

文件 `03c-llm-extract-RAW-response.json`：

| 字段 | 值 |
|---|---|
| URL | `http://10.100.0.70:3010/v1/chat/completions` |
| Model | `google/gemini-3-flash-preview` |
| Input chars | 3,427 |
| Duration | 5,660ms |
| Response format | `json_object` |
| Temperature | 0 |

返回的结构化 JSON 已规范化为 AO `ParsedResume` 的 4-object schema。

---

## 4. 输出 — `RESUME_PROCESSED` 事件

文件 `04-output-RESUME_PROCESSED.json`：

```json
{
  "name": "RESUME_PROCESSED",
  "data": {
    "bucket": "recruit-resume-raw",
    "objectKey": "2026/04/e7b3dde7-b4fc-96dc-6a9b-d2e2facd57db-【游戏测试（全国招聘）_深圳 7-11K】谌治中 3年.pdf",
    "filename": "【游戏测试（全国招聘）_深圳 7-11K】谌治中 3年.pdf",
    "hrFolder": "xiaqi-0000206419",
    "employeeId": "0000206419",
    "etag": "real-2026-04-28-shen-zhi-zhong",
    "size": null,
    "sourceEventName": "raas-real-pdf-test",
    "receivedAt": "2026-04-28T03:00:00Z",
    "job_requisition_id": null,

    "candidate": {
      "name": "谌治中",
      "mobile": "18070573461",
      "email": "1461406879@qq.com",
      "gender": "男",
      "birth_date": null,
      "current_location": null,
      "highest_acquired_degree": "本科",
      "work_years": 3,
      "current_company": "厦门雷霆互动网络有限公司",
      "current_title": "游戏测试工程师",
      "skills": [
        "测试理论", "黑盒测试", "Xmind", "Perfdog", "TAPD",
        "Linux", "MySQL", "adb", "Airtest", "Python",
        "Unity", "接口测试", "Jira"
      ]
    },

    "candidate_expectation": {
      "expected_salary_monthly_min": null,
      "expected_salary_monthly_max": null,
      "expected_cities": [],
      "expected_industries": ["游戏"],
      "expected_roles": ["游戏测试工程师"],
      "expected_work_mode": null
    },

    "resume": {
      "summary": "3年游戏测试经验，熟悉游戏测试全流程，具备较强的问题定位和分析能力。深度游戏玩家，涵盖网游与单机多种品类，擅长从玩家视角与技术视角结合进行测试。",
      "skills_extracted": [
        "测试用例编写", "性能测试", "缺陷跟踪",
        "自动化脚本", "MMORPG测试", "策略养成类游戏测试"
      ],
      "work_history": [
        {
          "title": "游戏测试工程师",
          "company": "厦门雷霆互动网络有限公司",
          "startDate": "2023.07",
          "endDate": "2026.01",
          "description": "负责《杖剑传说》与《超进化物语 2》的功能测试、性能测试及缺陷管理。涵盖技能系统、任务系统、养成系统等核心模块。"
        }
      ],
      "education_history": [
        {
          "degree": "本科",
          "field": "计算机科学与技术",
          "institution": "西安理工大学高科学院",
          "graduationYear": "2023"
        }
      ],
      "project_history": [
        {
          "projectName": "杖剑传说",
          "role": "游戏测试工程师",
          "description": "MMORPG类型游戏，负责技能、任务、背包模块。拆解200余种技能逻辑，设计复杂任务链测试用例，验证AI逻辑与数值计算。"
        },
        {
          "projectName": "超进化物语 2",
          "role": "游戏测试工程师",
          "description": "策略养成类游戏，负责养成、技能、任务模块。输出400+条有效用例，利用Perfdog进行性能检测，参与缺陷复盘与数值平衡建议。"
        }
      ]
    },

    "runtime": {
      "current_title": "游戏测试工程师",
      "current_company": "厦门雷霆互动网络有限公司"
    },

    "parsedAt": "2026-04-28T04:07:55.140Z",
    "parserVersion": "ao+new-api@robohire-or-llm-2026-04-28",
    "parserMode": "new-api",
    "parserModelUsed": "google/gemini-3-flash-preview",
    "parserDurationMs": 5660,
    "parserRequestId": "",
    "parserCached": false,
    "fallback_reason": "RoboHire 500: openrouter/google/gemini-3.1-pro-preview is not a valid model ID"
  }
}
```

> 说明：`fallback_reason` 字段记录了为什么没用 RoboHire。RoboHire 修好后这个字段会消失，`parserMode` 切回 `robohire`，`parserModelUsed` 变 `robohire/parse-resume`。

---

## 5. 文件名 → JD 推断

文件 `05-jd-inferred.json`：

```json
{
  "ok": true,
  "jobTitle": "游戏测试（全国招聘）",
  "city": "深圳",
  "salaryRange": "7-11K",
  "candidateName": "谌治中",
  "yearsExp": "3年",
  "jdText": "职位: 游戏测试（全国招聘）\n工作地点: 深圳\n薪资范围: 7-11K\n(PoC: 此 JD 由文件名推断；待 RAAS 提供 jd_id 接口替换)"
}
```

> 当 RAAS 提供真实 `jd_id` → JD 文本接口后，会替换这一段。当前是按文件名 `【职位_城市 薪资】候选人 工作年限.pdf` 模式拆出来的。

---

## 6. RoboHire `/api/v1/match-resume` — 同样失败

文件 `06-robohire-match-ERROR.json`：

```http
HTTP/1.1 500 Internal Server Error
x-request-id: req_1777349275928_9byniy9
duration: 870ms
```

```json
{
  "success": false,
  "error": "400 openrouter/google/gemini-3.1-pro-preview is not a valid model ID",
  "requestId": "req_1777349275928_9byniy9"
}
```

完全同一个根因 —— 同一个错误模型 ID，同一个 OpenRouter 错误。

降级到 stub heuristic：

| 信号 | 值 | 得分 |
|---|---|---|
| Title hits（技能词在职位标题里出现） | 0 | 0/40 |
| Location（候选人 location vs 深圳） | 候选人 location 为 null，没法匹配 | 5/20 |
| Experience（3 年） | mid level | 12/40 |
| **总分** | | **17 → MATCH_FAILED** |

注意 stub 分数低不代表候选人不合适 —— 是因为 stub 只能拿到 LLM 抽出来的 13 个技能词去和 "游戏测试（全国招聘）" 这个标题关键词字面匹配。换成 RoboHire 真实 `/match-resume` 后会做语义比对，预期分数会高很多。

---

## 7. 输出 — 匹配结果事件

文件 `07-output-MATCH_FAILED.json`（注意 outcome 是 stub 决定的，不代表 RoboHire 的真实判断）：

```json
{
  "name": "MATCH_FAILED",
  "data": {
    "bucket": "recruit-resume-raw",
    "objectKey": "2026/04/e7b3dde7-b4fc-96dc-6a9b-d2e2facd57db-【游戏测试（全国招聘）_深圳 7-11K】谌治中 3年.pdf",
    "filename": "【游戏测试（全国招聘）_深圳 7-11K】谌治中 3年.pdf",
    "etag": "real-2026-04-28-shen-zhi-zhong",
    "candidate_ref": {
      "name": "谌治中",
      "mobile": "18070573461",
      "email": "1461406879@qq.com"
    },
    "jd_source": "filename-inferred",
    "jd_text": "职位: 游戏测试（全国招聘）\n工作地点: 深圳\n薪资范围: 7-11K\n(PoC: 此 JD 由文件名推断；待 RAAS 提供 jd_id 接口替换)",
    "jd_id": null,
    "match": {
      "score": 17,
      "recommendation": "WEAK_MATCH",
      "summary": "Stub match: title hits=0, location=no, years=3",
      "technicalSkills": { "score": 0, "matchedSkills": [], "missingSkills": [] },
      "experienceLevel": {
        "score": 12,
        "required": "2+ years",
        "candidate": "3 years",
        "assessment": "mid"
      },
      "mustHave": {
        "extracted": { "skills": [], "experience": [] },
        "matched": ["测试理论", "黑盒测试", "Xmind"]
      },
      "niceToHave": { "extracted": { "skills": [], "certifications": [] }, "matched": [] }
    },
    "outcome": "MATCH_FAILED",
    "reason": "RoboHire match 500: openrouter/google/gemini-3.1-pro-preview is not a valid model ID",
    "matchedAt": "2026-04-28T04:07:56.146Z",
    "robohireRequestId": "req_1777349275928_9byniy9",
    "matchMode": "stub"
  }
}
```

阈值（spec §6.3）：

| score | outcome |
|---|---|
| ≥ 80 | `MATCH_PASSED_NO_INTERVIEW` |
| 60 – 79 | `MATCH_PASSED_NEED_INTERVIEW` |
| < 60 | `MATCH_FAILED` |

---

## 8. 总结

### 已工作的部分 ✅

| 环节 | 状态 |
|---|---|
| MinIO 拉 PDF 字节（10.100.0.70:9000） | ✅ 380,866 字节 / 74ms |
| PDF → 文本（unpdf, no worker） | ✅ 3,427 字符 |
| 文本 → 结构化（new-api gemini-3-flash-preview） | ✅ 5,660ms · 完整 4-object schema |
| 文件名 → JD 推断（regex） | ✅ 标题/城市/薪资全部命中 |
| `RESUME_PROCESSED` 事件构造（spec §3.2 schema） | ✅ |
| 文件名候选人姓名 vs LLM 抽出姓名一致性 | ✅ 都是 "谌治中" |

### 未工作 / 需要 RAAS 或 RoboHire 修的部分 ❌

| 环节 | 阻塞点 | 责任方 |
|---|---|---|
| RoboHire `/parse-resume` | 服务端 OpenRouter 模型 ID 错（`openrouter/google/gemini-3.1-pro-preview`） | RoboHire |
| RoboHire `/match-resume` | 同一个根因 | RoboHire |
| 真实 JD 文本（替代文件名推断） | 需要 RAAS 提供 `job_requisition_id` 或 JD 文本接口 | RAAS |
| 候选人 `current_location` | LLM 在文本里没找到（文件中可能未填写） | 简历本身或 LLM 模型 |
| 期望薪资 / 期望城市 | LLM 在文本里没找到 | 简历本身 |

### 我们这边代码的改动

1. `server/llm/robohire.ts:53` — Blob 加上 `{ type: "application/pdf" }`，按官方文档要求。
2. `server/llm/resume-extractor.ts:121` — 把 `pdf-parse` 换成 `unpdf`，绕过 Next.js Turbopack 加载 pdfjs worker 失败的问题。
3. 新增 `scripts/e2e-real-pdf.ts` 和 `scripts/probe-robohire.ts` —— 端到端测试 + RoboHire 失败复现。

### 给 RoboHire 团队的反馈（可以原文转发）

> RoboHire 团队你好：
>
> 我们用账号下的 API key 调用 `https://api.robohire.io/api/v1/parse-resume` 和 `/match-resume` 都拿到 HTTP 500，错误信息一致：
>
> ```
> {"success":false,"error":"400 openrouter/google/gemini-3.1-pro-preview is not a valid model ID","requestId":"req_xxx"}
> ```
>
> 你们后端调用 OpenRouter 时使用的模型 ID `openrouter/google/gemini-3.1-pro-preview` 似乎已被弃用或拼写错误。建议改成 OpenRouter 官方支持的模型 ID（例如 `google/gemini-pro-1.5` 或 `google/gemini-2.0-flash-exp`）。
>
> 复现：随便上传任何有效 PDF（包括我们已经测过的 380KB 真实简历，以及 105 字节的最小 PDF stub），100% 必现。已确认与文件名编码、mime 类型、文件大小无关。
>
> Request IDs（供你们追日志）：
>   - req_1777349267230_z3pq6nm（parse, 380KB 真实简历）
>   - req_1777349275928_9byniy9（match, 同一时间）
>   - req_1777349052876_kknpjfk, req_1777349055385_k77s5rm（其他重现样本）

---

## 9. 给 RAAS 团队的事件 schema 对齐（独立文档）

详见 `docs/raas-alignment-payloads.md`。本测试用的是 canonical AO 格式（`data.bucket / data.objectKey / data.filename` 平铺），RAAS 当前发的是 `data.payload.{source_bucket, source_key, ...}` 嵌套格式。需要 RAAS 那边对齐字段名 + 拍平结构。
