# Match-Resume API — User Guide

REST endpoints for the resume-matching action runtime, hosted by the Rule
Builder app. Two endpoints:

| # | Method | Path | Purpose |
|---|---|---|---|
| 1 | `GET`  | `/rules/api/match-resume/rules`  | Fetch the rule tree (ActionSteps + Rules) for the `matchResume` Action from Neo4j |
| 2 | `POST` | `/rules/api/match-resume/result` | Persist a single resume-matching result to Neo4j as a new history record |

- **Base URL** — defaults to `http://<rules-builder-host>:3502`. The `/rules`
  prefix is the app's `basePath` and is part of the URL.
- **Content type** — JSON. Both request and response bodies are `application/json`.
- **Versioning** — these endpoints are versioned by the Rule Builder release
  they ship with; there is no separate API version path today.

---

## Authentication

Both endpoints require a shared-secret API key. Configure it on the server
via the env var:

```bash
MATCH_RESUME_API_KEY=<your-strong-random-key>
```

Send the key on every request via **either**:

```http
Authorization: Bearer <key>
```

```http
x-api-key: <key>
```

The server compares it against `MATCH_RESUME_API_KEY` using a
constant-time comparison. Failure modes:

| Condition | HTTP | Body |
|---|---|---|
| Server has no `MATCH_RESUME_API_KEY` env var | `500` | `{ "error": "server-misconfigured", ... }` |
| Header missing entirely | `401` | `{ "error": "unauthorized", "message": "missing api key — ..." }` |
| Key present but wrong | `401` | `{ "error": "unauthorized", "message": "invalid api key" }` |

---

## 1. `GET /rules/api/match-resume/rules`

Returns the `matchResume` Action node together with all of its `ActionStep`
nodes and the `Rule` nodes attached to each step. The graph topology is
maintained by a separate component:

```
(:Action)-[:HAS_STEP]->(:ActionStep)-[:HAS_RULE]->(:Rule)
```

### Query parameters (all optional)

| Name | Type | Default | Notes |
|---|---|---|---|
| `actionName` | string | `matchResume` | Selector by `Action.name` |
| `actionId`   | string | — | Selector by `Action.id` (takes precedence over `actionName` when set) |
| `domainId`   | string | — | When set, only Rules whose `domainId` matches are returned (e.g. `RAAS-v1`, `R7-001`) |

### Request

```http
GET /rules/api/match-resume/rules HTTP/1.1
Host: rules-builder.example.com:3502
Authorization: Bearer YOUR_API_KEY
```

```bash
curl -sS \
  -H "Authorization: Bearer $MATCH_RESUME_API_KEY" \
  "http://localhost:3502/rules/api/match-resume/rules?actionName=matchResume&domainId=RAAS-v1"
```

### Response — `200 OK`

A JSON array of Action objects matching the selector. When called with
the default `actionName=matchResume`, the array contains exactly one
Action; multiple entries appear only if multiple `Action` nodes share
the same selector value.

#### Sample response

The following is an **illustrative sample** (using the `syncFromClientSystem`
Action) showing the full nested structure: top-level Action → `action_steps[]`
→ each step's `rules[]`. The shape is the same for every Action returned
by this endpoint, including `matchResume`.

```json
[
  {
    "id": "1-1",
    "name": "syncFromClientSystem",
    "description": "负责自动从客户需求管理系统获取原始招聘需求数据，并同步到我司需求管理系统。该节点是招聘流程的起点之一，自动监控客户系统中的需求变化（新增、修改、删除），确保我方系统与客户系统保持数据一致性，避免信息滞后导致的招聘时效损失。",
    "action_steps": [
      {
        "order": "1",
        "name": "monitorAndFetchRequirement",
        "description": "持续监控客户需求管理系统的内容变更，识别需求创建、更新或删除的事件，获取完整的需求详情数据，包括岗位名称、职级要求、招聘人数、薪资范围、工作地点等关键信息。",
        "object_type": "tool",
        "condition": "客户需求管理系统可正常访问",
        "rules": [
          {
            "id": "1-1-1",
            "specificScenarioStage": "客户系统需求创建与更新",
            "businessLogicRuleName": "客户需求系统数据自动采集",
            "applicableClient": "通用",
            "applicableDepartment": "N/A",
            "submissionCriteria": "系统已配置客户需求系统的登录凭证，系统中已维护该客户的字段映射配置。",
            "standardizedLogicRule": "系统自动登录客户需求系统，按预设频率扫描并读取新增或更新的需求信息。系统根据该客户预配置的字段映射关系，将客户系统中的需求字段（如需求编号，需求名称、需求数岗、岗位类型、期望级别、期望到岗日期、服务BG、 工作城市、办公大厦、优先级、岗位职责、岗位要求等）自动转换为需求管理系统对应字段，调用需求系统的需求新增或更新API在后台同步创建新需求记录。若客户系统页面结构发生变更导致字段无法正常抓取，系统立即暂停采集并向系统管理员发送告警通知",
            "relatedEntities": "客户单位 (Client)\n外包招聘需求 (Job_Requisition_Specification)\n招聘岗位 (Job_Requisition)\n客户侧需求管理系统(Client_RMS_System)\nRAAS系统(RAAS_System)",
            "businessBackgroundReason": "消除人工搬运时差与错误，保障SLA响应速度。",
            "ruleSource": "内部流程",
            "executor": "Agent"
          }
        ]
      },
      {
        "order": "2",
        "name": "persistRequisitionData",
        "description": "根据查重结果执行数据库操作：若是新需求，则创建【外包招聘需求】和对应的【招聘岗位】对象；若是变更，则更新现有对象的\"计划招聘总人数\"或\"截止日期\"等字段，并记录变更日志。若是删除或关闭的需求，更新状态为终止。同步完成后生成执行报告，对失败或异常情况触发告警通知交付经理。",
        "object_type": "logic",
        "condition": "查重逻辑执行完毕",
        "rules": [
          {
            "id": "1-1-2",
            "specificScenarioStage": "客户系统需求创建与更新",
            "businessLogicRuleName": "客户需求同步数据完整性校验",
            "applicableClient": "通用",
            "applicableDepartment": "N/A",
            "submissionCriteria": "系统已从客户需求系统采集到需求数据并完成字段映射转换",
            "standardizedLogicRule": "系统在将客户需求数据同步至需求系统前，自动校验映射后的必填字段是否完整。若任一必填字段缺失或格式异常，系统暂停该条需求的同步操作，自动向HSM发送通知，明确列出缺失或异常的字段，待HSM补充确认后重新触发同步。若全部字段校验通过，系统完成同步并自动触发需求分析流程",
            "relatedEntities": "客户单位 (Client)\n外包招聘需求 (Job_Requisition_Specification)\n招聘岗位 (Job_Requisition)\n客户侧需求管理系统(Client_RMS_System)\nRAAS系统(RAAS_System)",
            "businessBackgroundReason": "防止\"垃圾进垃圾出\"，确保下游匹配算法有效性。",
            "ruleSource": "内部流程",
            "executor": "Agent"
          },
          {
            "id": "1-2-1",
            "specificScenarioStage": "线下需求创建与更新",
            "businessLogicRuleName": "线下开拓需求管理规则",
            "applicableClient": "字节",
            "applicableDepartment": "N/A",
            "submissionCriteria": "线下开拓到需求且客户系统未发布该需求。",
            "standardizedLogicRule": "HSM 在通过线下方式开拓到需求且确认客户系统尚未发布该需求后，须先在需求管理系统内创建该需求，将客户侧需求编码字段填写为临时编号（客户系统中当前在招聘但不活跃需求编码）。",
            "relatedEntities": "客户单位 (Client)\n内部员工 (Employee)\n招聘岗位 (Job_Requisition)\n外包招聘需求 (Job_Requisition_Specification)",
            "businessBackgroundReason": "在需求公开发布前提前获取机会",
            "ruleSource": "访谈沟通",
            "executor": "Human"
          }
        ]
      }
    ]
  }
]
```

#### Field shape

Per-Action fields:

| Field | Type | Source | Notes |
|---|---|---|---|
| `id` | string | `Action.id` | |
| `name` | string | `Action.name` | |
| `description` | string | `Action.description` | Empty string when the deploy didn't set it |
| `action_steps` | array | (computed) | Empty array when the Action exists but has no `HAS_STEP` edges |

Per-step fields (each entry in `action_steps`):

| Field | Type | Source |
|---|---|---|
| `order` | string | `ActionStep.order` |
| `name` | string | `ActionStep.name` |
| `description` | string | `ActionStep.description` |
| `object_type` | string | `ActionStep.object_type` |
| `condition` | string | `ActionStep.condition` |
| `rules` | array | (computed) — empty when no `HAS_RULE` edges or when the `domainId` filter excluded all of them |

Per-rule fields (each entry in `rules`):

| Field | Type | Source |
|---|---|---|
| `id` | string | `Rule.id` |
| `specificScenarioStage` | string | `Rule.specificScenarioStage` |
| `businessLogicRuleName` | string | `Rule.businessLogicRuleName` |
| `applicableClient` | string | `Rule.applicableClient` |
| `applicableDepartment` | string | `Rule.applicableDepartment` |
| `submissionCriteria` | string | `Rule.submissionCriteria` |
| `standardizedLogicRule` | string | `Rule.standardizedLogicRule` |
| `relatedEntities` | string | `Rule.relatedEntities` array, joined with `\n`. Each line is `"中文名 (Object_ID)"` |
| `businessBackgroundReason` | string | `Rule.businessBackgroundReason` |
| `ruleSource` | string | `Rule.ruleSource` |
| `executor` | string | `Rule.executor` |

`Rule.domainId` is used internally to filter results when the `domainId`
query param is supplied; it is **not** echoed in the response.

### Response — error cases

| HTTP | `error` | Meaning |
|---|---|---|
| `400` | n/a | Malformed query string (unlikely — every param is optional) |
| `401` | `unauthorized` | Missing / invalid API key |
| `404` | `Action not found in Neo4j: ...` | No `Action` node matched the selector |
| `500` | `server-misconfigured` | Server's `MATCH_RESUME_API_KEY` env var is unset |
| `502` | (Neo4j error string) | Neo4j unreachable, auth failed, query crashed, etc. |

---

## 2. `POST /rules/api/match-resume/result`

Persists a **new** `(:Candidate_Match_Result)` history record per call.
The record is wired into the graph with two outbound edges, both sourced
from the `(:Candidate_Match_Result)` node:

```
(:Candidate_Match_Result)-[:candidate_match_result_refers_to_candidate]->(:Candidate)
(:Candidate_Match_Result)-[:candidate_match_result_refers_to_job_requisition]->(:Job_Requisition)
```

If the `Candidate` or `Job_Requisition` nodes don't exist yet they are
`MERGE`-created (stub nodes carrying only the supplied id). Every call
adds a new history row — the endpoint never overwrites an existing one.

### Request body

```json
{
  "candidateId":    "C-100023",
  "jobPositionId":  "JR-50087",
  "result":         "匹配",
  "reason":         "候选人简历技能与岗位要求重合度 92%，期望薪资在岗位预算之内。"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `candidateId`   | string | yes | Stored as `Candidate.candidate_id` and on the result node |
| `jobPositionId` | string | yes | Stored as `Job_Requisition.job_requisition_id` and on the result node |
| `result`        | string | yes | Match outcome — typically `"匹配"`, `"不匹配"`, or `"待定"` |
| `reason`        | string | yes | Free-text justification |

### Request

```http
POST /rules/api/match-resume/result HTTP/1.1
Host: rules-builder.example.com:3502
Authorization: Bearer YOUR_API_KEY
Content-Type: application/json
```

```bash
curl -sS -X POST \
  -H "Authorization: Bearer $MATCH_RESUME_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
        "candidateId":   "C-100023",
        "jobPositionId": "JR-50087",
        "result":        "匹配",
        "reason":        "候选人简历技能与岗位要求重合度 92%。"
      }' \
  "http://localhost:3502/rules/api/match-resume/result"
```

### Response — `200 OK`

```json
{
  "candidateMatchResultId": "f3d1c8e2-2a4b-4d8c-9f1d-7e6c5b4a3f2d",
  "createdAt":              "2026-04-28T13:42:11.728+08:00"
}
```

`candidateMatchResultId` is a server-generated UUID v4 stored as
`Candidate_Match_Result.candidate_match_result_id`. `createdAt` is the
node's `datetime()` timestamp serialised as ISO 8601 with offset.

### Response — error cases

| HTTP | `error` | Meaning |
|---|---|---|
| `400` | `invalid-json` | Body is not valid JSON |
| `400` | `missing-fields` | One or more of the four required string fields is empty/absent |
| `401` | `unauthorized` | Missing / invalid API key |
| `500` | `server-misconfigured` | Server's `MATCH_RESUME_API_KEY` env var is unset |
| `502` | (Neo4j error string) | Neo4j unreachable, auth failed, write failed, etc. |

---

## Server configuration

Both endpoints read these environment variables on the Rule Builder host:

| Var | Purpose |
|---|---|
| `MATCH_RESUME_API_KEY` | Shared-secret key required by both endpoints. **No default.** Endpoints return `500` until set. |
| `NEO4J_URI` (or `NEO4J_URL`) | Bolt endpoint, e.g. `bolt://localhost:7687` |
| `NEO4J_USER` (or `NEO4J_USERNAME`) | Account |
| `NEO4J_PASSWORD` | Password |
| `NEO4J_DATABASE` | Optional — multi-db routing target |

Place them in `apps/rules-builder/.env.local` (loaded by Next.js) or
inject via your deployment environment.

---

## Curl recipes

```bash
# 1) Fetch matchResume rule tree
export KEY=$MATCH_RESUME_API_KEY
curl -sS -H "Authorization: Bearer $KEY" \
  "http://localhost:3502/rules/api/match-resume/rules" | jq

# 2) Filter rules to a specific domain
curl -sS -H "Authorization: Bearer $KEY" \
  "http://localhost:3502/rules/api/match-resume/rules?domainId=RAAS-v1" | jq

# 3) Save a match result
curl -sS -X POST \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"candidateId":"C-1","jobPositionId":"JR-1","result":"匹配","reason":"demo"}' \
  "http://localhost:3502/rules/api/match-resume/result" | jq
```

---

## Quick reference

```
GET  /rules/api/match-resume/rules
       ?actionName=  ?actionId=  ?domainId=
       Authorization: Bearer <key>          (or x-api-key: <key>)
       → 200 [ { id, name, description, action_steps: [
                 { order, name, description, object_type, condition, rules: [...] }
               ] } ]
       → 401 / 404 / 500 / 502 on error

POST /rules/api/match-resume/result
       Authorization: Bearer <key>          (or x-api-key: <key>)
       Content-Type: application/json
       { candidateId, jobPositionId, result, reason }
       → 200 { candidateMatchResultId, createdAt }
       → 400 / 401 / 500 / 502 on error
```
