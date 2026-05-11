# 实例数据存储到 Neo4j — 规划 & V1 实施(走 Ontology API)

> **核心修正**:之前我假设 AO 直连 Neo4j 写,**这是错的**。allmetaOntology 已经有完整的 HTTP API(Studio app `:3500`,`/api/v1/ontology/*`),包括 **schema CRUD + instance CRUD + links + composite writers**。AO 走 API 写,不接触 Neo4j driver。
>
> **关键参考**:[/Users/yuhancheng/allmetaOntology/docs/ONTOLOGY-API-USER-GUIDE-BASED-ON-NEO4J.md](file:///Users/yuhancheng/allmetaOntology/docs/ONTOLOGY-API-USER-GUIDE-BASED-ON-NEO4J.md)
>
> **状态**:草案 v2(根据 ontology API guide 修正),开工前需拍板 §8 列出的 3 项。

---

## 0. 关键发现 — Ontology API 已经能做的事

读完 user guide 后,我意识到原本想自己实现的功能 **几乎都已经有 API**:

| 我们需要的 | API 已提供? | 路径 |
|-----------|-------------|------|
| 写 DataObject schema 定义(新建实例类型用) | ✅ 已有 | `POST /api/v1/ontology/objects` |
| 写实例数据(任意 `:DataObject` label 对应的 record)| ✅ 已有 | `POST /api/v1/ontology/instances/{label}` |
| 读实例 / 列表 / 过滤 | ✅ 已有 | `GET /instances/{label}?domain=…&<filter>=` |
| 建实例之间的关系 | ✅ 已有 | `POST /api/v1/ontology/links` |
| matchResume Robohire 结果专用 writer | ✅ 已有! | `POST /api/v1/ontology/actions/matchResume/results` |
| Schema 校验 + 未知字段拒绝 | ✅ 已有 | 默认开启(必须先在 DataObject 里声明字段)|
| Domain 隔离(RAAS-v1 / 别的)| ✅ 已有 | `?domain=…` |
| Bearer auth | ✅ 已有 | `ONTOLOGY_API_TOKEN` env |

**含义**:V1 大部分工作量不是写代码,而是 **schema 设计 + API 调用对接**。

---

## 1. 数据模型 — 用 DataObject schema 来定义实例类型

按 ontology API guide §5,实例数据存储分两步:

### Step 1:在 `:DataObject` 上定义"这个 label 长什么样" — 走 §1 CRUD

```http
POST /api/v1/ontology/objects
Body: {
  "domainId": "RAAS-v1",
  "id":       "RuleCheckAudit",       // ← :DataObject {id: "RuleCheckAudit"}
  "name":     "规则预筛审计",
  "primary_key": "audit_id",           // ← 必填,实例 CRUD 据此找主键字段
  "properties": [
    { "name": "audit_id",              "type": "string", "is_required": true },
    { "name": "candidate_id",          "type": "string", "is_required": true },
    { "name": "job_requisition_id",    "type": "string", "is_required": true },
    { "name": "client_id",             "type": "string" },
    { "name": "business_group",        "type": "string" },
    { "name": "overall_decision",      "type": "string" },
    { "name": "failure_reasons",       "type": "List<string>" },
    { "name": "summary",               "type": "string" },
    { "name": "llm_model",             "type": "string" },
    { "name": "llm_request_id",        "type": "string" },
    { "name": "prompt_tokens",         "type": "integer" },
    { "name": "completion_tokens",     "type": "integer" },
    { "name": "duration_ms",           "type": "integer" },
    { "name": "occurred_at",           "type": "timestamp" },
    { "name": "trace_id",              "type": "string" },
    { "name": "upload_id",             "type": "string" },
    { "name": "user_prompt",           "type": "string" },   // 完整 prompt
    { "name": "llm_raw_response",      "type": "string" }    // 完整 LLM JSON
  ]
}
```

### Step 2:每次 LLM 调用后,POST 实例数据 — 走 §5 CRUD

```http
POST /api/v1/ontology/instances/RuleCheckAudit?validate=strict
Body: {
  "domainId":            "RAAS-v1",
  "audit_id":            "rca_<uuid>",
  "candidate_id":        "cand_a3f1",
  "job_requisition_id":  "jr_x99",
  "client_id":           "腾讯",
  "business_group":      "PCG",
  "overall_decision":    "FAIL",
  "failure_reasons":     ["10-17:high_risk_reflux"],
  "summary":             "...",
  "llm_model":           "google/gemini-3-flash-preview",
  "llm_request_id":      "req_xxx",
  "prompt_tokens":       8200,
  "completion_tokens":   3100,
  "duration_ms":         17500,
  "occurred_at":         "2026-05-11T10:23:45.000Z",
  "trace_id":            "trace_xxx",
  "upload_id":           "upl_001",
  "user_prompt":         "<~16K 字符>",
  "llm_raw_response":    "<LLM 返回 JSON 字符串>"
}
```

API 自动:
- 在 Neo4j 创建 `(:RuleCheckAudit {audit_id: "rca_...", ...})` 节点
- MERGE 主键 `audit_id`(幂等,重复 POST 同 ID 不会重复写)
- 强制 schema 校验,未知字段直接 400

---

## 2. V1 需要新建的 4 个 DataObject schema

### 2.1 `RuleCheckAudit` — LLM 预筛审计(主体)

字段定义见 §1 Step 1。**这是核心节点,每次 LLM 调用 1 个**。

### 2.2 `RuleCheckFlag` — 每条规则的判定结果(详细 audit)

```jsonc
{
  "domainId":   "RAAS-v1",
  "id":         "RuleCheckFlag",
  "primary_key": "flag_id",
  "properties": [
    { "name": "flag_id",           "type": "string", "is_required": true },
    { "name": "audit_id",          "type": "string", "is_required": true },  // 反向引用 RuleCheckAudit
    { "name": "rule_id",           "type": "string", "is_required": true },  // 引用 ontology :Rule
    { "name": "rule_name",         "type": "string" },
    { "name": "applicable_client", "type": "string" },
    { "name": "severity",          "type": "string" },
    { "name": "applicable",        "type": "boolean" },
    { "name": "result",            "type": "string" },     // PASS | FAIL | NOT_APPLICABLE
    { "name": "evidence",          "type": "string" },
    { "name": "reasoning",         "type": "string" }
  ]
}
```

每个 RuleCheckAudit 对应 N 条 RuleCheckFlag(N = 该场景激活的规则数,通常 15-30 条)。

### 2.3 `CandidateBlacklist` — 预筛 FAIL 的候选人

```jsonc
{
  "domainId":   "RAAS-v1",
  "id":         "CandidateBlacklist",
  "primary_key": "blacklist_id",
  "properties": [
    { "name": "blacklist_id",       "type": "string", "is_required": true },
    { "name": "candidate_id",       "type": "string", "is_required": true },
    { "name": "job_requisition_id", "type": "string", "is_required": true },
    { "name": "client_id",          "type": "string" },
    { "name": "blacklist_type",     "type": "string" },     // "rule_check_drop" | "manual" | ...
    { "name": "triggered_by",       "type": "string" },     // "preScreenResumeAgent"
    { "name": "audit_id",           "type": "string" },     // 关联到 RuleCheckAudit
    { "name": "primary_failure",    "type": "string" },     // "10-17:high_risk_reflux"
    { "name": "all_failures",       "type": "List<string>" },
    { "name": "occurred_at",        "type": "timestamp" },
    { "name": "expires_at",         "type": "timestamp" },  // 可空,未来支持冷冻期解封
    { "name": "unblocked_at",       "type": "timestamp" },
    { "name": "unblocked_by",       "type": "string" },
    { "name": "unblocked_reason",   "type": "string" }
  ]
}
```

### 2.4 `(Reuse) Candidate_Match_Result` — Robohire 评分

**不用我们新建** —— guide §4 提到 `POST /api/v1/ontology/actions/matchResume/results` 已经能写这个。但要确认现有 `:DataObject {id: "Candidate_Match_Result"}` 的 schema 是否够用。

---

## 3. 关系建模 — 走 `/links` API

按 guide §3,Links 是 Neo4j 关系(edge),不是节点。需要建立的关系:

```http
POST /api/v1/ontology/links
Body: { "domainId": "RAAS-v1", "type": "HAS_FLAG",
        "fromId": "<RuleCheckAudit.audit_id>",
        "toId":   "<RuleCheckFlag.flag_id>" }
```

需要的关系类型:

| 关系类型 | from → to | 用途 |
|---------|----------|------|
| `HAS_FLAG` | RuleCheckAudit → RuleCheckFlag | audit 包含多个 flag |
| `EVALUATED` | RuleCheckFlag → Rule(ontology)| flag 对应哪条规则 |
| `CREATED_BY` | CandidateBlacklist → RuleCheckAudit | blacklist 由哪次 audit 产生 |
| `CAUSED_BY` | CandidateBlacklist → Rule | blacklist 的因果规则 |
| `FOR_CANDIDATE` | RuleCheckAudit → Candidate(通过 stub MERGE)| audit 对应哪个候选人 |
| `FOR_JR` | RuleCheckAudit → Job_Requisition | audit 对应哪个 JR |

**简化方案**:暂时不建 link(用属性引用),V2 再加,因为 link 的开销是每次 LLM 调用 5-6 次 API。

---

## 4. 写入流程 — RuleCheckAgent 内部

```ts
// resume-parser-agent/lib/neo4j-instance/audit-client.ts (新建)
export class OntologyApiClient {
  constructor(
    private baseUrl: string = process.env.ONTOLOGY_API_BASE ?? 'http://localhost:3500',
    private token:   string = process.env.ONTOLOGY_API_TOKEN ?? '',
    private domain:  string = 'RAAS-v1',
  ) {}

  async writeRuleCheckAudit(audit: RuleCheckAuditData): Promise<void> {
    await this.post(`/api/v1/ontology/instances/RuleCheckAudit?validate=strict`, {
      domainId: this.domain,
      ...audit,
    });
  }

  async writeRuleCheckFlags(flags: RuleCheckFlagData[]): Promise<void> {
    // bulk API
    await this.post(`/api/v1/ontology/instances/RuleCheckFlag?validate=strict`, {
      domainId: this.domain,
      items: flags,
    });
  }

  async writeBlacklist(entry: CandidateBlacklistData): Promise<void> {
    await this.post(`/api/v1/ontology/instances/CandidateBlacklist?validate=strict`, {
      domainId: this.domain,
      ...entry,
    });
  }

  async writeMatchResult(result: MatchResultData): Promise<void> {
    // 用已有的 composite writer
    await this.post(`/api/v1/ontology/actions/matchResume/results`, result);
  }

  private async post(path: string, body: unknown) {
    const r = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new OntologyApiError(r.status, err);
    }
    return r.json();
  }
}
```

### 集成进 RuleCheckAgent

```ts
export class RuleCheckAgent {
  async evaluate(input: RuleCheckPromptInput): Promise<RuleCheckResult> {
    const userPrompt = await this.actionObject.fillRuntimeInput({...});

    const t0 = Date.now();
    const response = await this.llmGateway.complete({
      system: SYSTEM_PROMPT, user: userPrompt, ...
    });
    const duration_ms = Date.now() - t0;

    const result = validateAndParse(response.text);

    // ★ NEW:同步写 Neo4j audit(失败不阻塞主流程)
    const audit_id = randomUUID();
    try {
      await this.ontologyApi.writeRuleCheckAudit({
        audit_id,
        candidate_id:        input.runtime_context.candidate_id,
        job_requisition_id:  input.job_requisition.job_requisition_id,
        client_id:           input.client.name,
        business_group:      input.client.business_group_code ?? null,
        overall_decision:    result.overall_decision,
        failure_reasons:     result.failure_reasons,
        summary:             result.summary,
        llm_model:           response.model_used,
        llm_request_id:      response.request_id,
        prompt_tokens:       response.usage?.prompt_tokens,
        completion_tokens:   response.usage?.completion_tokens,
        duration_ms,
        occurred_at:         new Date().toISOString(),
        trace_id:            input.runtime_context.trace_id,
        upload_id:           input.runtime_context.upload_id,
        user_prompt:         userPrompt,
        llm_raw_response:    response.text,
      });

      // 批量写 flags
      const flags = result.rule_flags.map(f => ({
        flag_id:           randomUUID(),
        audit_id,
        rule_id:           f.rule_id,
        rule_name:         f.rule_name,
        applicable_client: f.applicable_client,
        severity:          f.severity,
        applicable:        f.applicable,
        result:            f.result,
        evidence:          f.evidence,
        reasoning:         f.reasoning ?? '',
      }));
      await this.ontologyApi.writeRuleCheckFlags(flags);
    } catch (err) {
      // 失败不抛 — 主流程继续
      this.logger.error('Ontology API audit write failed', err);
      await this.dlq.push({ audit, flags, error: err });
    }

    return { ...result, audit_id };  // 把 audit_id 加进返回,让 caller 关联
  }
}
```

### 集成进 matchResumeAgent (wrapper pattern)

```ts
on RESUME_PROCESSED:
  const result = await ruleCheckAgent.evaluate(input);

  if (result.overall_decision === 'FAIL') {
    // ★ 写 blacklist 实例
    await ontologyApi.writeBlacklist({
      blacklist_id:       randomUUID(),
      candidate_id:       result.candidate_id,
      job_requisition_id: result.job_requisition_id,
      client_id:          result.client_id,
      blacklist_type:     'rule_check_drop',
      triggered_by:       'matchResumeAgent',
      audit_id:           result.audit_id,    // 关联到 audit
      primary_failure:    result.failure_reasons[0],
      all_failures:       result.failure_reasons,
      occurred_at:        new Date().toISOString(),
    });

    await emit('RULE_CHECK_FAILED', { ... });
    return;
  }

  // PASS 路径走原 Robohire
  const matchResult = await matchResume({ resume, jd });
  await saveMatchResults({ ..., rule_check_audit_id: result.audit_id });
  await emit('MATCH_PASSED_NEED_INTERVIEW', { ... });

  // ★ 同步写 matchResume 结果到 Neo4j(via composite writer)
  await ontologyApi.writeMatchResult({
    candidateId:   input.runtime_context.candidate_id,
    jobPositionId: input.job_requisition.job_requisition_id,
    result:        matchResult.recommendation,
    reason:        matchResult.summary,
  });
```

---

## 5. 读取场景 — 走 Ontology API,不绕 Neo4j

### 5.1 Dashboard "看候选人 X 为什么被拒"

```http
GET /api/v1/ontology/instances/CandidateBlacklist?domain=RAAS-v1&candidate_id=cand_a3f1
```

返回 `items: [{...blacklist...}]`,前端用 `audit_id` 再查 RuleCheckAudit 详情:

```http
GET /api/v1/ontology/instances/RuleCheckAudit/<audit_id>?domain=RAAS-v1
```

### 5.2 规则触发统计 — 暂时绕 API,直查 Neo4j(只读)

API guide 没提供"按 rule_id 反查 flags"的 endpoint。两种选择:

- **(a)** AO 直接 Cypher 查 Neo4j(只读)— guide 也提到 `apps/studio` 不阻止外部读
- **(b)** 走 `/instances/RuleCheckFlag?domain=…&rule_id=10-17` 的过滤(top-level equality filter)

**推荐 (b)**:用 instances 列表 API + filter,简单。

```http
GET /api/v1/ontology/instances/RuleCheckFlag?domain=RAAS-v1&rule_id=10-17&result=FAIL&limit=100
```

---

## 6. 失败处理 + 一致性

### 6.1 主流程不阻塞

RuleCheck 主流程(LLM → 决策)成功后,Neo4j 写失败**不能让主流程失败**(LLM 钱已经花了)。

```ts
try {
  await this.ontologyApi.writeRuleCheckAudit(...);
} catch (err) {
  this.logger.error(...);
  await this.dlq.push({type: 'audit', data: ..., err});
}
// 主流程继续
```

### 6.2 重试 — at-least-once + idempotent via PK

- audit_id 客户端生成(UUID),用 `MERGE` 语义,重复 POST 同 ID 不会重复写
- 用 AO SQLite 的 `dlq_entries` 表存失败的 ops,有 worker 定时重试

### 6.3 Ontology API 不可用时的降级

- Studio app (`:3500`) 挂了或网络不通 → Ontology API 502
- 主流程继续(rule check + Robohire 调用不受影响)
- 所有写入进 dlq
- 监控告警:Ontology API 失败率 > 10% 触发 SRE

---

## 7. V1 实施路径 — ~1 周

### Week 1

| Day | 任务 | 文件 |
|-----|------|------|
| **D1** | 跟陈洋对齐:Studio API base URL + ONTOLOGY_API_TOKEN 申请 + 确认 schema CRUD 权限 | 协调 |
| **D1** | 注册 3 个新 DataObject schema(RuleCheckAudit / RuleCheckFlag / CandidateBlacklist)| 一次性 curl / script |
| **D2** | OntologyApiClient 封装 + 错误处理 + dlq | `resume-parser-agent/lib/neo4j-instance/ontology-api-client.ts`(新)|
| **D2** | TS types 镜像 schema | `resume-parser-agent/lib/neo4j-instance/types.ts`(新)|
| **D3** | 集成进 RuleCheckAgent — 写 audit + flags(strict mode)| `resume-parser-agent/lib/agents/rule-check-agent.ts`(扩展)|
| **D3** | 集成进 matchResumeAgent — FAIL 写 blacklist;PASS 写 match result | `resume-parser-agent/lib/inngest/agents/match-resume-agent.ts`(扩展)|
| **D4** | E2E 测试 — 跑 POC 6 场景 + 校验 Neo4j 数据完整性 | `scripts/rule-check-poc/run-demo.ts`(扩展)+ Cypher 检查 |
| **D4** | 读取 helper(给 Dashboard 用)| `lib/neo4j-instance/audit-reader.ts`(新)|
| **D5** | 文档 + 部署 + 监控 alert 配置 | `docs/` |

### 文件清单

```
resume-parser-agent/lib/neo4j-instance/
├── ontology-api-client.ts        # HTTP client 封装(写 + 读 Ontology API)
├── types.ts                       # AuditData / FlagData / BlacklistData TS types
├── schemas.ts                     # 4 个 DataObject schema 定义(注册用)
├── dlq.ts                          # 失败队列(用 SQLite dlq_entries 表)
└── README.md

scripts/
└── register-instance-schemas.ts   # 一次性 schema 注册脚本
```

---

## 8. 拍板事项 — 3 项决策

### 8.1 🔴 ONTOLOGY_API_BASE 和 ONTOLOGY_API_TOKEN

| 问 | 默认假设 |
|----|---------|
| `ONTOLOGY_API_BASE` 在哪? | `http://localhost:3500`(dev)/ `https://?(prod)` — 需要陈洋确认 prod URL |
| `ONTOLOGY_API_TOKEN` 怎么拿? | 找陈洋开 token |
| 是不是跟 RAAS / 别的客户端共用? | 是,user guide §"Authentication" 说"shared bearer token" |

**Action**:跟陈洋对齐,加进 `.env.local`:
```
ONTOLOGY_API_BASE=http://10.100.0.70:3500   # 或 prod URL
ONTOLOGY_API_TOKEN=<陈洋发>
```

### 8.2 🟡 Domain 用哪个?

User guide 提到 `RAAS-v1` / `R7-001` 等。我们的 ontology 数据在 RAAS-v1(从规则查询确认)。

**默认假设**:`ONTOLOGY_DOMAIN=RAAS-v1`,跟现有 rule check 用的 domain 一致。

### 8.3 🟡 LLM full prompt + raw response 是否存进 audit?

- (a) **存**:audit.user_prompt(~16KB)+ llm_raw_response(~3-5KB),每条 ~20KB。日 100 次 = 2MB/天,1 年 = 730MB
- (b) **不存**:仅保留 metadata(model / tokens / duration / failure_reasons / rule_flags)
- (c) **存 MinIO**,Neo4j 只存 object_key

**默认假设**:V1 (a) 存全量,先观察实际使用率;1 年内容量上 GB 再迁 (c)

---

## 9. 跟之前我那版规划的差异

| 项 | 之前(错)| 现在(对) |
|----|---------|---------|
| 写入方式 | AO 直连 Neo4j driver,用 `neo4j-driver` 跑 Cypher | AO 调 `:3500/api/v1/ontology/...` HTTP API |
| Schema 定义 | 自己写 Cypher `CREATE INDEX` 等 | 用 `POST /objects` 注册 DataObject |
| 实例写入 | 自己写 `MERGE (n:RuleCheckAudit {...})` Cypher | 用 `POST /instances/RuleCheckAudit` |
| 关系建立 | 自己写 Cypher `MATCH ... CREATE (a)-[:REL]->(b)` | 用 `POST /links` |
| 节点 label 跟 ontology 冲突 | 担心命名冲突,要加前缀 | 不冲突 — Domain partition + label 隔离,API 已处理 |
| 部署 | 需要给 AO 加 Neo4j write 权限 | 不需要 — 只要 ONTOLOGY_API_TOKEN |
| 复杂度 | 高(driver 管理 + 错误重试 + schema migration)| 低(单纯 HTTP client)|

**最大教训**:**先看现有 API,再写代码**。allmetaOntology 已经把这层做掉了,我们只是 consumer。

---

## 10. 一句话总结

> **V1:走 Ontology API(`:3500`)写 3 类实例数据**(RuleCheckAudit / RuleCheckFlag / CandidateBlacklist),复用现有 `POST /actions/matchResume/results` 写 Robohire 结果。AO 不直连 Neo4j。代码量 ~200 行 HTTP client + schema 注册脚本,~1 周完工。开工前先跟陈洋对齐 §8.1 拿 token / base URL,然后 §8.3 拍板要不要存 full prompt(默认存)。

---

要不要接着做:
- (a) 起草发给陈洋的 IM:对齐 §8.1(API base / token / domain)+ 确认现有 Studio app 是否暴露在内网可访问
- (b) 写 §2 那 3 个 DataObject schema 注册脚本 + 跑通 curl 测试
- (c) 实际起步写 OntologyApiClient TypeScript 代码骨架
