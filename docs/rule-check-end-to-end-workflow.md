# matchResume 规则预筛 — 端到端工作流设计（含 blacklist 路径）

> **本文档目的**：定义在 `matchResumeAgent` 调用 Robohire 深度匹配**之前**插入的"规则预筛"环节的端到端工作流。明确：
>
> 1. **现有工作流的所有步骤一个不改** —— Robohire `/match-resume` 调用契约、入参 `{resume, jd}` 形式、`saveMatchResults`、`emit MATCH_*` 全部保留原样
> 2. **新增的只是"在调 Robohire 之前的一道过滤"** —— 用 LLM rule check 判定该简历是否值得让 Robohire 进行深度匹配
> 3. **过滤的输入 = Robohire 的输入** —— 候选人简历 + 客户原始需求 (resume, JD)。这份 input 在规则预筛和 Robohire 之间**不做任何修改**
> 4. **过滤决策由 RuleCheckAgent 输出的 JSON 决定** —— workflow agent 读 `overall_decision`，走 KEEP / DROP / PAUSE 三个分支
> 5. **DROP 候选人进 blacklist** —— 持久化 (candidate, JR) 失败原因，不再调 Robohire
>
> **关键约束**：Robohire `/match-resume` 仍然只接 `{resume, jd, candidatePreferences?, jobMetadata?}` —— **不加任何新字段**，不传 augmentation，不改 schema。规则预筛对 Robohire 完全透明。

---

## 0. 一图说清楚

```
RESUME_PROCESSED (来自 resumeParserAgent)
   │
   ├─ resume         = parsed.data
   ├─ job_req_id     = RAAS 关联的客户原始需求 ID
   └─ employee_id    = 招聘专员
        │
        ▼
matchResumeAgent (Workflow agent, Inngest fn)
   │
   ├─ ① getJobRequisition(job_req_id)
   │      → resume + jd 已在手 (这就是后面 Robohire 要的 input)
   │
   ├─ ② ★ NEW: RuleCheckAgent.evaluate({resume, jd, ...})       ─── 新插入的过滤层
   │      ├─ 内部:抓 ontology rules → 拼 user prompt → 调 LLM
   │      └─ 返回 RuleCheckResult { overall_decision, drop_reasons, ... }
   │
   ├─ ③ 按 overall_decision 走三分支:
   │
   │      ┌──── KEEP ────────────────────────────────────────┐
   │      │                                                   │
   │      │   ★ 用原始 (resume, jd) 调 Robohire,无任何修改     │
   │      │                                                   │
   │      │   POST /api/v1/match-resume                       │
   │      │       body: { resume, jd }   ← 原样,无 augmentation │
   │      │   ← Robohire 返回 matchScore / recommendation       │
   │      │                                                   │
   │      │   POST /api/v1/match-results  (持久化匹配结果)      │
   │      │   emit MATCH_PASSED_NEED_INTERVIEW                 │
   │      │                                                   │
   │      └───────────────────────────────────────────────────┘
   │
   │      ┌──── DROP ────────────────────────────────────────┐
   │      │                                                   │
   │      │   ★ 不调 Robohire,直接进入 blacklist               │
   │      │                                                   │
   │      │   POST /api/v1/candidate-blacklist                │
   │      │       body: { candidate_id, job_requisition_id,    │
   │      │               client_id, drop_reasons,             │
   │      │               rule_check_flags, occurred_at }      │
   │      │                                                   │
   │      │   emit MATCH_FAILED  (复用现有事件)                │
   │      │                                                   │
   │      └───────────────────────────────────────────────────┘
   │
   │      ┌──── PAUSE ───────────────────────────────────────┐
   │      │                                                   │
   │      │   ★ 暂停推进,等人工反馈                            │
   │      │                                                   │
   │      │   for each notification in result.notifications:  │
   │      │     POST /api/v1/human-tasks                      │
   │      │       body: { recipient, channel, rule_id,         │
   │      │               candidate_id, job_requisition_id,    │
   │      │               message }                            │
   │      │                                                   │
   │      │   不 emit MATCH_*  (等 HSM 反馈后重新触发 rule check)│
   │      │                                                   │
   │      └───────────────────────────────────────────────────┘
   │
   └─ function return
```

---

## 1. 设计原则

### 1.1 Rule check 是过滤器,不是替代品

| 角色 | 干什么 | 输出 |
|------|--------|------|
| **RuleCheckAgent** (新增) | 看 (resume, JD) + ontology 规则 → 用 LLM 判定是否值得让 Robohire 处理 | `{overall_decision: KEEP\|DROP\|PAUSE, ...}` |
| **Robohire `/match-resume`** (现有) | 深度匹配评分 (matchScore / 各维度分析) | `{matchScore, recommendation, matchAnalysis, ...}` |

两者**职责不重叠**:
- Rule check 做的是"红线 + 客户特定 + 硬性要求"的**离散逻辑判定**(命中即标记)
- Robohire 做的是"技能/经验/学历跟岗位的**模糊匹配度评估**"(打分)

规则预筛通过的候选人,**仍然交给 Robohire 做深度匹配** —— 这部分逻辑完全不变。

### 1.2 Robohire 调用契约一个字不改

| 字段 | 在 rule check 前后 | 变化 |
|------|-------------------|------|
| `POST /api/v1/match-resume` URL | 仍然是这个 path | ❌ 无变化 |
| Request body `resume` | resumeParserAgent 生成的 resumeText | ❌ 无变化 |
| Request body `jd` | flattenRequirementForMatch(jr) 生成的 JD 文本 | ❌ 无变化 |
| Request body `candidatePreferences` / `jobMetadata` | 保留 optional 字段 | ❌ 无变化 |
| Response `data` 结构 | RaasMatchResumeData 全字段 | ❌ 无变化 |
| `saveMatchResults` POST | 入参字段全部保留 | ❌ 无变化(可选扩 `rule_check_flags`) |
| `emit MATCH_PASSED_NEED_INTERVIEW` | 事件名 + payload schema | ❌ 无变化 |

**唯一新增**:KEEP 路径调用 Robohire 之前,可选地把 RuleCheckResult 的 `rule_flags` 写入 saveMatchResults(供 RAAS DB 做归档),但 Robohire 本身**不感知**。

### 1.3 DROP 路径走 blacklist —— 防止重复浪费 Robohire 配额

如果候选人 (cand_X) 因为规则 10-17 (高风险回流) 被 DROP:
- 这次不调 Robohire
- 但**下次**同一候选人投递另一个 JD 时,如果还是命中 10-17,我们应该提前知道,不该重新调 LLM

所以 blacklist 是**持久化的 (candidate_id, job_requisition_id, reason) 记录**,用来:
1. 审计(为什么这位候选人没进 Robohire)
2. 防重(下次 RESUME_PROCESSED 时优先查 blacklist,命中则 skip)
3. 数据回流(让 RAAS Dashboard 上有"被规则筛掉的候选人"清单)

### 1.4 PAUSE 路径不进 blacklist —— 它是等待状态

PAUSE 意味着"规则需要 HSM/招聘专员介入才能判定"。这种候选人不该写入 blacklist(否则下次回流时会被误拦),而是创建 humanTask 等待反馈,然后由 RAAS 的 `humanTaskResolved` 事件触发 matchResumeAgent 重跑(这次 `hsm_feedback` 非 null,规则能解析)。

---

## 2. Agent 输出在工作流中的角色

### 2.1 Agent 不做决策 —— 只填 schema

LLM 拿到 user prompt 后,只需要按 `## 5. 输出格式` 章节定义的 JSON schema 把结果填出来:

```json
{
  "candidate_id": "cand_a3f1",
  "job_requisition_id": "jr_x99",
  "client_id": "腾讯",
  "overall_decision": "KEEP" | "DROP" | "PAUSE",
  "drop_reasons": ["10-17:high_risk_reflux"],   // 仅 DROP 时非空
  "pause_reasons": ["10-25:huawei_under_3mo"],   // 仅 PAUSE 时非空
  "rule_flags": [
    {
      "rule_id": "10-25",
      "rule_name": "...",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS" | "FAIL" | "REVIEW" | "NOT_APPLICABLE",
      "evidence": "引用简历原文",
      "next_action": "..."
    }
  ],
  "resume_augmentation": "",   // 本设计中不使用,保留字段兼容
  "notifications": [           // 仅 PAUSE 时非空
    { "recipient": "HSM", "channel": "Email", "rule_id": "10-25", "message": "..." }
  ]
}
```

**LLM 的工作到此结束**。决策从 JSON 里读,不依赖 LLM 自主"做什么"。

### 2.2 Workflow agent 读 JSON 做决策路由

`matchResumeAgent` 拿到 RuleCheckResult 后,看 `overall_decision` 一个字段决定走哪条路径:

```ts
switch (ruleCheckResult.overall_decision) {
  case 'DROP':  // → blacklist 路径
  case 'PAUSE': // → human task 路径
  case 'KEEP':  // → Robohire 调用路径(原工作流)
}
```

**所以"agent 把 output 喂给 multi-agent 架构"的具体含义是**:RuleCheckResult JSON 被反序列化成 TypeScript 对象,workflow agent 读这个对象的字段做路由 —— **LLM 不直接调 Robohire,不直接写 blacklist,不直接创建 humanTask**,都是 workflow agent 在 LLM 输出后做的下游动作。

---

## 3. 三条决策路径详解

### 3.1 KEEP 路径 (~原现有工作流, 加 1 行 saveMatchResults 字段)

```ts
if (ruleCheckResult.overall_decision === 'KEEP') {
  // 原工作流 — 一字不改
  const matchResult = await matchResume(
    { resume: resumeText, jd: jdText },   // ★ 原始 input,无修改
    { traceId },
  );

  await saveMatchResults({
    source: 'need_interview',
    candidate_id, upload_id, job_requisition_id,
    client_id,
    matchScore:        matchResult.data.matchScore,
    recommendation:    matchResult.data.recommendation,
    matchAnalysis:     matchResult.data.matchAnalysis,
    mustHaveAnalysis:  matchResult.data.mustHaveAnalysis,
    niceToHaveAnalysis: matchResult.data.niceToHaveAnalysis,
    summary:           matchResult.data.summary,
    rule_check_flags:  ruleCheckResult.rule_flags,   // ★ 新增字段(可选,供审计)
  });

  await emit('MATCH_PASSED_NEED_INTERVIEW', {
    upload_id, job_requisition_id,
    success: true,
    data: matchResult.data,
  });
}
```

**Robohire 收到的 input 跟没有 rule check 时完全一致**。

### 3.2 DROP 路径 (新增 blacklist 写入 + 复用现有 MATCH_FAILED 事件)

```ts
if (ruleCheckResult.overall_decision === 'DROP') {
  // ★ NEW: 写 blacklist
  await addToBlacklist({
    candidate_id,
    job_requisition_id,
    client_id,
    blacklist_type:  'rule_check_drop',
    drop_reasons:    ruleCheckResult.drop_reasons,   // 例: ["10-17:high_risk_reflux"]
    rule_check_flags: ruleCheckResult.rule_flags,
    triggered_by:    'matchResumeAgent',
    occurred_at:     new Date().toISOString(),
  });

  // 复用现有 MATCH_FAILED 事件 — 下游 RAAS 已经在监听
  await emit('MATCH_FAILED', {
    upload_id,
    job_requisition_id,
    success: true,
    data: { drop_reasons: ruleCheckResult.drop_reasons },
  });

  return;   // 不调 Robohire,不写 match_results
}
```

### 3.3 PAUSE 路径 (新增 humanTask 创建,不 emit MATCH_*)

```ts
if (ruleCheckResult.overall_decision === 'PAUSE') {
  // ★ NEW: 为每条 notification 创建一个 humanTask
  for (const note of ruleCheckResult.notifications) {
    await createHumanTask({
      recipient:           note.recipient,             // '招聘专员' | 'HSM'
      channel:             note.channel,               // 'InApp' | 'Email'
      rule_id:             note.rule_id,
      candidate_id,
      job_requisition_id,
      title:               `${note.rule_id}: 预筛挂起待确认`,
      message:             note.message,
      created_by:          'matchResumeAgent',
      pending_since:       new Date().toISOString(),
    });
  }

  // 不 emit MATCH_*,候选人停在等待状态
  // 当 HSM 在 RAAS Dashboard 处理完该 humanTask 后,RAAS 会
  // emit RESUME_REMATCH_REQUESTED 事件,matchResumeAgent 重跑
  // (这次输入的 hsm_feedback 非 null,可解析规则 10-28/10-39 等)
  return;
}
```

---

## 4. Blacklist 数据模型

### 4.1 表结构(RAAS DB 新增)

```sql
CREATE TABLE candidate_blacklist (
  id                  UUID PRIMARY KEY,
  candidate_id        VARCHAR(64) NOT NULL,
  job_requisition_id  VARCHAR(64) NOT NULL,
  client_id           VARCHAR(64) NOT NULL,

  -- 来源
  blacklist_type      ENUM('rule_check_drop', 'manual_block', 'hsm_reject', ...) NOT NULL,
  triggered_by        VARCHAR(64),    -- 'matchResumeAgent' | 'HSM' | ...

  -- 原因(JSON 数组,可多条)
  drop_reasons        JSONB,           -- ["10-17:high_risk_reflux", ...]

  -- 完整 rule_flags 快照(供审计追溯当时 LLM 怎么判的)
  rule_check_flags    JSONB,
  llm_model           VARCHAR(64),     -- 例: "google/gemini-3-flash-preview"
  llm_response_id     VARCHAR(64),     -- New-API request_id

  -- 时间戳
  occurred_at         TIMESTAMPTZ NOT NULL,
  expires_at          TIMESTAMPTZ,     -- NULL = 永久,有值 = 冷冻期到期

  -- 解封(可选)
  unblocked_at        TIMESTAMPTZ,
  unblocked_by        VARCHAR(64),
  unblocked_reason    TEXT,

  UNIQUE (candidate_id, job_requisition_id, blacklist_type)
);

CREATE INDEX idx_blacklist_lookup ON candidate_blacklist (candidate_id, job_requisition_id) WHERE unblocked_at IS NULL;
```

### 4.2 RAAS API

```http
POST /api/v1/candidate-blacklist           # 新增 / agent 调用
GET  /api/v1/candidate-blacklist?candidate_id=X&job_requisition_id=Y   # 查询 / Dashboard 用
PATCH /api/v1/candidate-blacklist/:id/unblock   # 解封 / 招聘专员手动用
```

### 4.3 防重逻辑

`matchResumeAgent` 在跑 rule check 之前,可以**先查 blacklist 短路**:

```ts
const existing = await getBlacklistEntry({ candidate_id, job_requisition_id });
if (existing && !existing.unblocked_at) {
  // 已经在 blacklist,这次 RESUME_PROCESSED 是误投或重复事件
  await emit('MATCH_FAILED', { upload_id, job_requisition_id,
                               data: { reason: 'already_blacklisted',
                                       previous_drop: existing.drop_reasons }});
  return;
}
```

这样能省掉重复的 LLM 调用(成本优化)。

---

## 5. Robohire 调用契约 — 逐字段对照

| 字段 | 现有 (无 rule check) | 加 rule check 之后 | 变化 |
|------|---------------------|--------------------|------|
| Request URL | `POST /api/v1/match-resume` | `POST /api/v1/match-resume` | ❌ |
| Request `resume` | `buildResumeText(parsedResume)` | `buildResumeText(parsedResume)` | ❌ |
| Request `jd` | `flattenRequirementForMatch(jr)` | `flattenRequirementForMatch(jr)` | ❌ |
| Request `candidatePreferences` | optional | optional | ❌ |
| Request `jobMetadata` | optional | optional | ❌ |
| Response `data.matchScore` | 0-100 | 0-100 | ❌ |
| Response `data.recommendation` | enum | enum | ❌ |
| Response `data.matchAnalysis` | object | object | ❌ |
| **调用条件** | 每次 RESUME_PROCESSED 都调 | **仅 KEEP 时调** | ✅ |
| **调用次数 / 简历** | 1 次 (单 JD 模式) | 0-1 次 (DROP/PAUSE 跳过) | ✅ |

**Robohire 团队不需要做任何改动** —— 它甚至不知道 AO 这边加了规则预筛。

---

## 6. 端到端时序图(三个分支)

### 6.1 KEEP 分支

```
resumeParserAgent ──RESUME_PROCESSED──▶ matchResumeAgent
                                            │
                                            │ getJobRequisition(jr_id)
                                            │   ◀─── RAAS ──── { requirement, spec, ... }
                                            │
                                            │ ruleCheckAgent.evaluate({resume, jd, ...})
                                            │   ─── LLM ────────▶
                                            │   ◀─── LLM ──── { overall_decision: 'KEEP' }
                                            │
                                            │ POST /api/v1/match-resume
                                            │   ──── RAAS ──── { resume, jd }      ← 原始未修改
                                            │   ◀─── Robohire ── { matchScore: 87 }
                                            │
                                            │ POST /api/v1/match-results
                                            │   ──── RAAS ──── { source: 'need_interview', ... }
                                            │
                                            └─ emit MATCH_PASSED_NEED_INTERVIEW
```

### 6.2 DROP 分支

```
resumeParserAgent ──RESUME_PROCESSED──▶ matchResumeAgent
                                            │
                                            │ getJobRequisition(jr_id)
                                            │
                                            │ ruleCheckAgent.evaluate(...)
                                            │   ─── LLM ────────▶
                                            │   ◀─── LLM ──── { overall_decision: 'DROP',
                                            │                   drop_reasons: ['10-17:high_risk_reflux'] }
                                            │
                                            │ POST /api/v1/candidate-blacklist     ★ 不调 Robohire
                                            │   ──── RAAS ──── { candidate_id, jr_id,
                                            │                   drop_reasons,
                                            │                   rule_check_flags }
                                            │
                                            └─ emit MATCH_FAILED
```

### 6.3 PAUSE 分支

```
resumeParserAgent ──RESUME_PROCESSED──▶ matchResumeAgent
                                            │
                                            │ getJobRequisition(jr_id)
                                            │
                                            │ ruleCheckAgent.evaluate(...)
                                            │   ─── LLM ────────▶
                                            │   ◀─── LLM ──── { overall_decision: 'PAUSE',
                                            │                   notifications: [...] }
                                            │
                                            │ for each notification:                ★ 不调 Robohire
                                            │   POST /api/v1/human-tasks
                                            │     ──── RAAS ──── { recipient, channel,
                                            │                     candidate_id, jr_id, msg }
                                            │
                                            └─ (无 emit, 候选人停在等待状态)

────── 等 HSM 在 Dashboard 处理 humanTask ──────

RAAS Dashboard ──humanTaskResolved──▶ RAAS API
                                          │
                                          └─ emit RESUME_REMATCH_REQUESTED
                                                ▼
                                          matchResumeAgent (重跑)
                                                │
                                                │ ruleCheckAgent.evaluate({
                                                │   ...,
                                                │   hsm_feedback: { ... }    ★ 这次有数据了
                                                │ })
                                                │
                                                │ 规则 10-28/10-39 等可基于 hsm_feedback 判定
                                                │
                                                └─ 走 KEEP / DROP 路径(不会再 PAUSE)
```

---

## 7. 配套改动清单(按角色)

### 7.1 雨函 (AO 端)
- [ ] `matchResumeAgent` 增加 rule check step (调 `ruleCheckAgent.evaluate()`)
- [ ] 增加三分支处理: KEEP (走原 Robohire) / DROP (写 blacklist + emit MATCH_FAILED) / PAUSE (createHumanTask)
- [ ] 实现 `RuleCheckAgent` 类(L2 sub-agent, 见 [docs/rule-check-prompt-pipeline.md §3.6](rule-check-prompt-pipeline.md))
- [ ] 监听新事件 `RESUME_REMATCH_REQUESTED`(PAUSE 回流场景)
- [ ] 加 blacklist 短路逻辑(开调 LLM 前先查)

### 7.2 张元军 (RAAS 端)
- [ ] DB 加 `candidate_blacklist` 表(见 §4.1)
- [ ] API 新增 `POST/GET/PATCH /api/v1/candidate-blacklist`
- [ ] API 新增 `POST /api/v1/human-tasks`
- [ ] 在 Dashboard 增加 "blacklist 候选人列表" 页面 + 解封操作
- [ ] HSM 处理完 humanTask 后,publish `RESUME_REMATCH_REQUESTED` 事件回 AO

### 7.3 陈洋 (Ontology 端)
- [ ] 新增 `getRulesForMatchResume({client, business_group, studio, tags})` API
- [ ] Rule 节点加 `gating_severity` 字段(代替文本关键词推断)

### 7.4 叶洋 (Action Object 端)
- [ ] `MatchResumeActionObject.getRuleCheckPrompt()` 实现
- [ ] 51 条 rule 手工标 `gating_severity` (短期方案,陈洋补完字段后下线)

### 7.5 Robohire 团队
- [ ] **无任何改动** ✓

---

## 8. 跟其他文档的关系

| 文档 | 内容 | 跟本文档关系 |
|------|------|-------------|
| [docs/rule-check-prompt-pipeline.md](rule-check-prompt-pipeline.md) | RuleCheckAgent 的 prompt 编译流水线(L2 内部) | 本文档 §2 提到的 RuleCheckAgent 的内部实现 |
| [docs/match-resume-rule-check-prompt.md](match-resume-rule-check-prompt.md) | 规则的自然语言文本设计 | RuleCheckAgent 调用时使用的 user prompt 内容 |
| [docs/workflow-agents-inngest-spec.md](workflow-agents-inngest-spec.md) | 现有 matchResumeAgent / Robohire 工作流 | **本文档基于这份规约,仅插入 rule check 一步,其他不动** |
| [scripts/rule-check-poc/](../scripts/rule-check-poc/) | POC 跑通了 prompt 编译 + LLM 调用 | 本文档 §3.1-3.3 的 workflow 代码逻辑可直接借鉴 POC |

---

## 9. 一句话总结

> Rule check 是 Robohire 前面的**透明过滤器**。Robohire 完全不知道它存在,**入参一字不改,响应一字不变**;只是当 rule check 判定 DROP 时,这次匹配不会调到 Robohire,候选人会被写入 blacklist 留痕;当 rule check 判定 PAUSE 时,创建人工任务等待 HSM 反馈后回流。**整套机制只是省 Robohire 配额 + 提前拦风险候选人,不替代任何现有匹配能力**。

---

*生成时间:基于 [docs/workflow-agents-inngest-spec.md](workflow-agents-inngest-spec.md) Workflow A@2026-05-08 实现*
*维护人:matchResumeAgent owner (雨函) + RAAS owner (张元军) + Ontology owner (陈洋) + Action Object owner (叶洋)*
