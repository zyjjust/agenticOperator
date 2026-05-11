# Agentic Operator · /workflow 页面可观测性增强设计

**适用版本**：AO main · `app/workflow/` + `app/live/` + `lib/agent-mapping.ts` · 现有 `RunChatbot` / `RealRunDetail` 基础上演进
**最后更新**：2026-05-09
**对应代码**：[components/workflow/WorkflowContent.tsx](../components/workflow/WorkflowContent.tsx) · [components/live/RunChatbot.tsx](../components/live/RunChatbot.tsx) · [components/live/RealRunDetail.tsx](../components/live/RealRunDetail.tsx) · [app/api/runs/](../app/api/runs/) · [prisma/schema.prisma](../prisma/schema.prisma)

---

## 0. 执行摘要

`/workflow` 页面目前是**视觉原型 + 真实 runtime 观测**的混合体：节点拓扑、palette、Inspector 大半字段是写死的字面量；但实时健康、跨 run 日志、AI 解读、run trace、run-scoped chatbot **都已经有真实后端在跑**。

这份设计要把这层"半真半假"完成成一个**真正可用的工作流诊断面板**，目标用户是工程师 + 高级 HSM 运营。三件事按价值与依赖排序：

| 阶段 | 名字 | 一句话 | 工作量 |
|---|---|---|---|
| **P0** | 上下游邻居视图 | 在 Inspector 显示触发我 / 我触发的 agent 列表，可点击跳转 | 0.5 天，纯前端 |
| **F2** | Entity 历程页 | 点候选人 / JD / 需求，跳到一个聚合多 run 的时间线页 | 2-3 天，前后端 |
| **F1** | Agent-scoped Chatbot | Inspector 内嵌 chatbot，可搜跨 run 实例并回链到 F2 | 3-4 天，前后端 |

> **不在范围内**：编辑 Inngest function 代码（参见 [event-manager-and-tracking-design.md](./event-manager-and-tracking-design.md)）；编辑 workflow 拓扑（需要图编辑器，单独立项）；entity-as-first-class 表（先用扫描方案）。

---

## 1. 背景：当前 /workflow 的三个真实差距

### 1.1 Inspector 大半字段不响应选中 agent

[WorkflowContent.tsx:440-490](../components/workflow/WorkflowContent.tsx#L440-L490) 里 "When / Tools / Input / Output / Permissions / SLA" 都是 JSX 字面量，**点 ReqAnalyzer 也显示 JDGenerator 的内容**。只有顶部三块（health / explain / logs）是真实数据驱动的。

### 1.2 没有"上下游邻居"视图

`AGENT_MAP` 已经把每个 agent 的 `triggersEvents` / `emitsEvents` 全部维护在代码里，但 Inspector 没有任何地方展示"谁会触发我 / 我触发谁"。运营要追因果只能去 [/events](../app/events/) 翻事件目录。

### 1.3 数据层是 run-centric，无法按实体查询

[prisma/schema.prisma](../prisma/schema.prisma)：

```prisma
model WorkflowRun {
  triggerData  String   // JSON ← entity ID 在里面，没索引
}
model WorkflowStep {
  input        String?  // JSON
  output       String?  // JSON
}
```

候选人 ID / JD ID / 需求 ID 全部嵌在 JSON 字符串里。结果就是：**"显示候选人 A 经历过的所有 step"在 SQL 层没有路径**。这是 F1 / F2 都绕不开的地基问题。

---

## 2. 范围与目标用户

### 范围

| 功能 | 包括 | 不包括 |
|---|---|---|
| P0 邻居视图 | 静态读 AGENT_MAP，渲染上/下游列表，点击切 selectedId | event payload schema 显示（独立工作） |
| F2 Entity 详情页 | 候选人 / JD / 需求 三类实体的历程页；多 run 合并 timeline；step I/O 展开 | 实体当前状态镜像（属于 RAAS 边界） |
| F1 Agent Chatbot | Agent-scoped 实例搜索；返回结构化 entity 卡片；citation 跳详情页 | 跨 agent 全局搜索（用 /events） |

### 目标用户

**主要**：高级 HSM 运营 + 工程师。前者要"为什么这条 JD 卡在审批"，后者要"哪些 step 调 RAAS 时 timeout"。两者共享"实体级 timeline"这个核心视图，但默认密度不同（运营默认折叠 step，工程师默认展开）。

**次要**：客户演示。当前 Inspector 假数据虽然好看但禁不起追问。F2 落地后演示可以用真实数据，更有说服力。

---

## 3. 数据层架构

### 3.1 关键约束

- **不改 RAAS schema**。AO 是控制平面，候选人 / JD / 需求的真相源在 RAAS。AO 只持有 run 维度的过程数据。
- **不要求 agent 改代码**。F1/F2 在 AO 端从已有 `WorkflowRun` / `WorkflowStep` / `AgentActivity` 反推实体关联，不向下游 agent 提需求。
- **可逐步升级**。先用扫描方案出体验，确认查询模式后再决定是否上索引层。

### 3.2 实体类型清单

```ts
// lib/entity-types.ts (新增)
export const ENTITY_TYPES = ['JobRequisition', 'JobPosting', 'Candidate'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];
```

> JD 在数据层等同 JobPosting；UI 层显示 "JD"。需求 = JobRequisition。候选人 = Candidate。

### 3.3 Entity Extractor：从 JSON payload 抽 entity ID

实际事件 payload 用了多种 key 名（见 [create-jd-agent.ts](../resume-parser-agent/lib/inngest/agents/create-jd-agent.ts)），需要一份字段优先级表：

```ts
// lib/entity-extractor.ts (新增)
type Lookup = { type: EntityType; keys: string[] };

const LOOKUPS: Lookup[] = [
  {
    type: 'JobRequisition',
    keys: [
      'job_requisition_id',
      'requisition_id',
      'requirement_id',
      'jrid',
      // entity_id 仅当 entity_type === 'JobRequisition' 时算
    ],
  },
  {
    type: 'JobPosting',
    keys: ['job_posting_id', 'jd_id', 'posting_id'],
  },
  {
    type: 'Candidate',
    keys: ['candidate_id', 'resume_id'],
  },
];

export function extractEntityRefs(
  json: unknown,
): Array<{ type: EntityType; id: string }> {
  if (!json || typeof json !== 'object') return [];
  const out: Array<{ type: EntityType; id: string }> = [];
  // 1. 顶层 entity_type + entity_id（RAAS canonical envelope）
  // 2. payload 内的命名字段
  // 3. payload.raw_input_data 里的命名字段
  // 4. nested step output 里递归
  walk(json, (key, val, parent) => {
    if (typeof val !== 'string' || !val.trim()) return;
    if (key === 'entity_id' && typeof parent?.entity_type === 'string') {
      const t = parent.entity_type as string;
      if ((ENTITY_TYPES as readonly string[]).includes(t)) {
        out.push({ type: t as EntityType, id: val });
      }
      return;
    }
    for (const l of LOOKUPS) {
      if (l.keys.includes(key)) out.push({ type: l.type, id: val });
    }
  });
  return dedupe(out);
}
```

**关键设计**：递归 walk 是因为 step input/output 可能多层嵌套（如 `outboundEnvelope.payload.raw_input_data.job_requisition_id`）。深度限制 10 层防爆。

### 3.4 路径 A：扫描方案（先做这个）

```ts
// app/api/entities/[type]/[id]/journey/route.ts (新增)
export async function GET(req, { params }) {
  const { type, id } = await params;
  // 1. 扫近 N 天（默认 30）所有 WorkflowRun，过滤 triggerData 含此 entity
  const runs = await prisma.workflowRun.findMany({
    where: { startedAt: { gte: thirtyDaysAgo() } },
    take: 500,
    orderBy: { startedAt: 'desc' },
  });
  const matchedRuns = runs.filter((r) =>
    extractEntityRefs(safeJson(r.triggerData)).some(
      (e) => e.type === type && e.id === id,
    ),
  );
  // 2. 拉这些 run 的所有 step
  const steps = await prisma.workflowStep.findMany({
    where: { runId: { in: matchedRuns.map((r) => r.id) } },
    orderBy: [{ runId: 'asc' }, { startedAt: 'asc' }],
  });
  // 3. 进一步过滤：只保留 input/output 也涉及此 entity 的 step
  //    (一条 run 可能 fan-out 到多个 entity，避免误显示)
  const filteredSteps = steps.filter((s) => {
    const refs = [
      ...extractEntityRefs(safeJson(s.input)),
      ...extractEntityRefs(safeJson(s.output)),
    ];
    return refs.some((e) => e.type === type && e.id === id);
  });
  // 4. 合并成 timeline
  return NextResponse.json({
    entity: { type, id },
    runs: matchedRuns,
    steps: filteredSteps,
  });
}
```

**性能估算**：扫 500 run × 平均 10 step + JSON parse ≈ 50-200ms（dev 数据量）。生产 100k+ run 时挂掉，那时升路径 B。

### 3.5 路径 B：RunEntity 关联表（按需升级）

```prisma
model RunEntity {
  runId       String
  entityType  String   // "JobRequisition" | "JobPosting" | "Candidate"
  entityId    String
  role        String   // "trigger" | "step_input" | "step_output"
  stepId      String?  // null 当 role === "trigger"
  createdAt   DateTime @default(now())

  @@id([runId, entityType, entityId, role, stepId])
  @@index([entityType, entityId, createdAt])  // 按实体查 O(log n)
  @@index([runId])
}
```

**写入点**：[server/em/publish.ts](../server/em/publish.ts) 的 persist 步骤后；以及 step 收集器（如果存在）。**不改下游 agent 代码** —— extractor 在 AO 端运行。

**回填策略**：上线时跑一次 `scripts/backfill-run-entities.ts`，扫历史 WorkflowRun 全部塞进去。1M run 约 5 分钟（单线程 + transaction batch）。

### 3.6 选型决策

**先 A 后 B**。原因：

1. A 不要 schema 改动，今天就能写，跑通后才看得清查询模式。
2. 落 B 之前要先确定 `role` 维度（trigger / step_input / step_output 是否都要查？）—— A 跑过一周后用真实问题验证。
3. 切换 A → B 是纯后端事，前端 API 契约不变，无返工。

---

## 4. P0：上下游邻居视图（前端）

### 4.1 算法

```ts
// lib/agent-graph.ts (新增)
import { AGENT_MAP, type AgentMeta } from './agent-mapping';

export type Neighbor = {
  agent: AgentMeta;
  /** 共享的事件名（用于显示"via XYZ_EVENT"）。 */
  viaEvents: string[];
};

export function upstreamOf(short: string): Neighbor[] {
  const me = AGENT_MAP.find((a) => a.short === short);
  if (!me || me.triggersEvents.length === 0) return [];
  return AGENT_MAP
    .filter((a) => a.short !== short)
    .map((a) => ({
      agent: a,
      viaEvents: a.emitsEvents.filter((e) => me.triggersEvents.includes(e)),
    }))
    .filter((n) => n.viaEvents.length > 0);
}

export function downstreamOf(short: string): Neighbor[] {
  const me = AGENT_MAP.find((a) => a.short === short);
  if (!me || me.emitsEvents.length === 0) return [];
  return AGENT_MAP
    .filter((a) => a.short !== short)
    .map((a) => ({
      agent: a,
      viaEvents: a.triggersEvents.filter((e) => me.emitsEvents.includes(e)),
    }))
    .filter((n) => n.viaEvents.length > 0);
}
```

**注意**：当前 `AGENT_MAP` 还包含一些"系统外"事件（`SCHEDULED_SYNC` / `CLARIFICATION_INCOMPLETE`），它们没有 emit 它们的 agent —— 算法天然处理这种情况（upstream 列表为空）。

### 4.2 UI 形态

加一个新组件 `NeighborhoodPanel`，渲染在 Inspector 顶部，紧跟 `AgentExplainPanel` 之前：

```
┌─ 上游 · 谁会触发我 ───────────────────────────────────┐
│  ← Clarifier        via CLARIFICATION_READY           │
│  ← JDReviewer       via JD_REJECTED                   │
└────────────────────────────────────────────────────────┘
┌─ 下游 · 我触发谁 ─────────────────────────────────────┐
│  → JDReviewer       via JD_GENERATED                  │
└────────────────────────────────────────────────────────┘
```

每行点击 → 调 `setSelectedId(agent.short)`（需要把 `selectedId` 改成 short 而非 nodeId，或加映射），切换 Inspector。每行的事件名 hover 显示 tooltip："JD_GENERATED：当 JD 生成完成时触发"（从 events-catalog 拉）。

### 4.3 文件改动清单

| 文件 | 改动 | 行数估算 |
|---|---|---|
| `lib/agent-graph.ts` | 新增，导出 `upstreamOf` / `downstreamOf` | ~40 行 |
| `components/workflow/NeighborhoodPanel.tsx` | 新增组件 | ~80 行 |
| `components/workflow/WorkflowContent.tsx` | 在 `Inspector` 顶部插入 `<NeighborhoodPanel short={agentShort} onJump={setSelectedId} />`；`selectedId` 语义从 nodeId 切换到 agent short（或保持 nodeId，加 short→nodeId 反查） | ~10 行 |

### 4.4 风险与边界

- **selectedId 语义转换**：当前 `selectedId` 是 NodeDef.id（如 "jd"），不是 agent short（"JDGenerator"）。两种解法：(a) 改语义为 short；(b) 加反查 `byShortFunction(short) → nodeId`。推荐 (b)，避免影响现有 `WFNode` selected 高亮。
- **AGENT_MAP 数据真实性**：所有依赖都是它正确。如果有遗漏（比如某 agent 实际 emit 了某事件但 map 里没写），P0 显示就漂。**P0 上线时附带写一个 lint**：扫 `resume-parser-agent/lib/inngest/agents/*.ts` 提取 `step.sendEvent('...')` 调用，对比 AGENT_MAP 的 emitsEvents。漂了告警。

### 4.5 工作量

0.5 天。零后端改动，零数据迁移。

---

## 5. F2：Entity 历程页（前后端）

### 5.1 路由

```
/entities/[type]/[id]
  ↳ type: 'JobRequisition' | 'JobPosting' | 'Candidate'
  ↳ id:   实体的字符串 ID
```

`app/entities/[type]/[id]/page.tsx` 是 thin client component，渲染 `<Shell><EntityJourneyContent type={type} id={id} /></Shell>`，遵循现有页面骨架（见 CLAUDE.md "Top-level shape"）。

### 5.2 后端 API

#### 5.2.1 `GET /api/entities/:type/:id/journey`

返回此实体的完整历程：

```ts
type EntityJourneyResponse = {
  entity: { type: EntityType; id: string };
  windowDays: number;       // 默认 30
  runs: Array<{
    id: string;
    triggerEvent: string;
    status: WorkflowRunStatus;
    startedAt: string;
    completedAt: string | null;
    durationMs: number | null;
  }>;
  steps: Array<{
    id: string;
    runId: string;
    nodeId: string;        // = agent short (希望)
    stepName: string;
    status: string;
    input: unknown;        // 已 JSON.parse
    output: unknown;
    error: string | null;
    startedAt: string;
    durationMs: number | null;
    /** 此 step 出现的 entity 引用（供 UI 渲染高亮）。 */
    entityRefs: Array<{ type: EntityType; id: string }>;
  }>;
  /** 出现在哪几个 agent 名下（去重，保留首次出现的时间）。 */
  agents: Array<{ short: string; firstSeenAt: string; stepCount: number }>;
};
```

实现：见 §3.4 路径 A 草稿。新增 `lib/entity-extractor.ts`、`app/api/entities/[type]/[id]/journey/route.ts`。

#### 5.2.2 `GET /api/entities/:type/:id` (轻量摘要，用于面包屑等)

返回 `{ type, id, displayName, runCount, lastSeenAt }` —— `displayName` 优先从最近一条 step output 里挖（如 JD 的 `posting_title`），缺则回落到 ID。**这步是体验细节，但不做用户会看到一堆裸 ID。**

### 5.3 前端组件

```
components/entity/
  EntityJourneyContent.tsx      ← 顶层布局
  EntityHeader.tsx              ← 实体名称 / 类型徽章 / runCount / 最近活跃
  EntityTimeline.tsx            ← 多 run 合并的纵向时间线
  EntityStepCard.tsx            ← 单个 step 展开卡（input / output JSON viewer）
```

**EntityTimeline 视觉草图**：

```
2026-05-08 14:22  REQUIREMENT_LOGGED · run_abc123
                   └─ ReqAnalyzer · analyze-req           ✓ 12s
                      input  { entity_id, raw_input_data: {...} }
                      output { skills, seniority, comp_band }
2026-05-08 14:23  ANALYSIS_COMPLETED · run_abc123
                   └─ Clarifier · clarify-fields          ⏸ HITL 4h
2026-05-08 18:31  CLARIFICATION_READY · run_def456 (new run)
                   └─ JDGenerator · fetch-requirement     ✓ 0.4s
                   └─ JDGenerator · generate-jd           ✗ 503 → retry
                   └─ JDGenerator · generate-jd           ✓ 4.8s
                   └─ JDGenerator · sync-jd               ✓ 0.2s
                   └─ JDGenerator · emit-jd-generated     ✓ 0.05s
```

每个 step 默认折叠到一行，点击展开 input / output JSON。**对工程师**：默认全展开。**对运营**：默认全折叠，只显示 step 名 + 状态。用 `?density=compact|full` query param 控制，URL 可分享。

### 5.4 复用 RealRunDetail 的部件

```
RealRunDetail.tsx (881 行) 里已经有：
  - 时间线渲染逻辑（RunTraceTimeline）
  - JSON viewer
  - step status 徽章
  - duration 格式化
```

**抽公共**：把 `RunTraceTimeline` 拆成"接受 step[] 渲染"的纯组件，`RealRunDetail` 和 `EntityJourneyContent` 都用它。这一步会顺手把现在 `RealRunDetail` 里耦合的"按 run 分组"逻辑提取出来。

### 5.5 跳转入口

P0 完成后，Inspector 加一段"最近实例"区块（数据来自 §6.2.2 的工具，但**不强依赖 F1**）：

```
┌─ 最近 5 条经过此 agent 的实例 ──────────────────────┐
│  JD-2024-3389 · 字节跳动·高级前端  →  18:34  ✓        │
│  JD-2024-3387 · 美团·算法工程师    →  18:21  ⚠ retry │
│  ...                                                   │
└────────────────────────────────────────────────────────┘
```

每条点击 → `router.push('/entities/JobPosting/JD-2024-3389')`。

### 5.6 工作量

| 任务 | 估算 |
|---|---|
| `entity-extractor.ts` + 单测 | 0.5 天 |
| `/api/entities/:type/:id/journey` | 0.5 天 |
| `EntityJourneyContent` + Timeline 抽离 | 1 天 |
| Inspector "最近实例" 区块（含 `/api/agents/:short/recent-entities`） | 0.5 天 |
| 联调 + 边界（空数据 / 大 payload / extractor 漏字段） | 0.5 天 |
| **合计** | **2-3 天** |

### 5.7 风险

- **extractor 漏字段** 是首要风险。建议上线时跑一次 `scripts/audit-entity-coverage.ts`：扫近 7 天所有 step，统计 input/output 里 `*_id` 结尾但**不在 LOOKUPS 里**的 key，输出报告。这是个 1 小时活，值得做。
- **大 payload**：JD output 可能 30KB+ JSON。timeline 默认折叠 + lazy parse，避免一次加载全部展开。
- **JSON 安全**：`safeJson` 必须 try/catch，旧数据可能写过非 JSON 字符串到 `triggerData`。

---

## 6. F1：Agent-scoped Chatbot（前后端）

### 6.1 与 RunChatbot 的差异

| 维度 | 现有 RunChatbot | 新 AgentChatbot |
|---|---|---|
| 边界 | 一条 run | 一个 agent，跨所有 run |
| 默认时间窗 | 整条 run | 默认 24h，可问"最近一周" |
| 典型问题 | "这条 run 卡哪了" | "最近哪些 JD 在 JDGenerator 失败了" |
| 输出形态 | 文字 + step citation | 文字 + **可点击 entity 卡片**（跳 F2） |
| 工具集 | `get_steps` / `get_logs` / `get_event` | `search_runs_by_agent` / `search_entities_by_agent` / `get_entity_journey` |
| 历史持久化 | localStorage by runId | localStorage by `agent:${short}` |

### 6.2 工具集设计

后端实际暴露给 LLM 的工具：

#### 6.2.1 `search_runs_by_agent`

```ts
{
  short: string;            // 必须等于 chatbot 当前绑定的 agent
  status?: 'completed' | 'failed' | 'running' | 'all';
  sinceHours?: number;      // 默认 24，最大 168
  limit?: number;           // 默认 20，最大 100
}
=> { runs: Array<{ id, status, startedAt, durationMs, entityRefs }> }
```

#### 6.2.2 `recent_entities_by_agent`

```ts
{
  short: string;
  entityType?: EntityType;
  sinceHours?: number;      // 默认 168 (7d)
  limit?: number;           // 默认 5
}
=> { entities: Array<{ type, id, displayName, lastSeenAt, runCount }> }
```

也是 Inspector "最近实例" 区块的数据源（§5.5）。

#### 6.2.3 `get_entity_journey`

是 §5.2.1 接口的 LLM-tool 包装；让 chatbot 能"打开"一个实体回答更细的追问。返回压缩到 token-friendly 的形态（去掉大 JSON payload，保留 step 名 + 状态 + 是否有 error）。

#### 6.2.4 `search_steps_by_failure_pattern`

```ts
{
  short: string;
  errorContains?: string;   // 子串模糊匹配
  sinceHours?: number;
  limit?: number;
}
=> { steps: Array<{ runId, stepName, error, startedAt }> }
```

让 "RAAS timeout 都发生在哪些 run" 这种问题有得查。

#### 6.2.5 显式不暴露的工具

- 任何写操作。
- 跨 agent 全局查询（用 `/events` 或 site-wide chat）。
- 实体写入 / 修改。

### 6.3 后端 API

```
POST /api/agents/:short/chat
  body: { messages: ChatMessage[] }
  response: SSE stream
            event: tool_call    { tool, args }
            event: tool_result  { tool, label }
            event: text         { delta }
            event: done         { sources, modelUsed, toolCallsExecuted }
            event: error        { message }
```

实现复用 [app/api/runs/[id]/chat/route.ts](../app/api/runs/[id]/chat/route.ts) 的 SSE 框架与 LLM gateway 调用，把工具白名单和 system prompt 换掉即可。

#### system prompt 草稿

```
你是 Agentic Operator 中 ${short} 这个 agent 的运营助手。

- 你的查询范围严格限定在 ${short} 经手的 run / step / entity。
  不要尝试回答其他 agent 的问题（指引用户去 /workflow 切换）。
- 回答里凡涉及 entity / run，必须通过工具查询，禁止编造 ID。
- 提到 entity 时，输出 markdown 链接 [显示名](/entities/<type>/<id>)，
  让用户能点开 F2 详情页。
- 时间窗默认 24h，用户可改。
- 失败 / 错误优先排查，提供下一步操作建议（"看 run X 的 step Y 的 error 字段"）。

注册元数据（来自 AGENT_FUNCTIONS / AGENT_MAP）：
${injectedRegistryFacts}
```

### 6.4 前端组件

```
components/workflow/AgentChatbot.tsx   ← 新组件，复用 RunChatbot 的消息渲染原语
```

抽公共：把 `RunChatbot` 内部的 `MessageBubble` / `ToolEventTimeline` / `CitationChip` 提取到 `components/shared/chat/`，让 `AgentChatbot` 与 `RunChatbot` 共享。

Inspector 内嵌位置：在现有 `AgentExplainPanel` 和 `AgentLogsPanel` 之间，加一个 collapsible 区块"问 ${short}"。默认折叠以免抢眼。

#### 建议 chips（system prompt 之外）

```
"最近 24h 有哪些 JD 在我这里失败？"
"为什么这条 run 比平时慢 3 倍？"
"列出 RAAS 503 的 step"
"最近一周经过我的字节跳动相关 JD"
```

### 6.5 工作量

| 任务 | 估算 |
|---|---|
| 抽 `components/shared/chat/` 公共组件 | 0.5 天 |
| 4 个工具的 server 实现（含 zod 校验 + 单测） | 1 天 |
| `/api/agents/:short/chat` SSE 路由（复用 run chat 框架） | 0.5 天 |
| `AgentChatbot.tsx` + Inspector 内嵌 | 0.5 天 |
| system prompt 调优 + LLM 真实跑通 | 0.5-1 天 |
| 联调 + 边界（无 LLM 网关 fallback） | 0.5 天 |
| **合计** | **3-4 天** |

### 6.6 风险

- **LLM 编造**：单 agent prompt 里 `injectedRegistryFacts` 必须明确告诉模型"只能通过工具回答事实问题"。验收时抽 20 个真实问题人工评估。
- **token 成本**：F1 比 RunChatbot 更费 token（工具返回的 entity / step 数组更大）。设硬上限：单条回答最多 5 次工具调用，单工具最多返回 100 行。
- **RunChatbot 公共抽取**：抽过程中要小心不破坏现有 `RunChatbot`。建议先 commit 抽取作为独立 PR，再 commit `AgentChatbot`。

---

## 7. Inspector 整体改造后的最终形态

把 P0 + F1 + F2 的入口都拼上后，[WorkflowContent.tsx](../components/workflow/WorkflowContent.tsx) 里 `Inspector` 组件的结构变成：

```
Inspector
├── Header: 节点图标 + 名称 + sub
├── (新) NeighborhoodPanel              ← P0
├── AgentHealthPanel                    ← 现有
├── AgentExplainPanel                   ← 现有
├── (新) RecentEntitiesPanel            ← F2 入口
├── (新) AgentChatbot (collapsible)     ← F1
├── AgentLogsPanel                      ← 现有
├── (移除) 硬编码 When/Tools/Input/Output/SLA  ← 清理
└── (移除) 假 Save/Cancel 按钮                ← 清理
```

> **硬编码字段移除**是这次顺带做的清理。它们当前在说谎（点不同 agent 显示同样内容），不如不显示。等 event-payload-schema 工程立项再正式做"输入/输出 schema"。

---

## 8. 实施排期

| 周次 | 阶段 | 交付 | 依赖 |
|---|---|---|---|
| W1 D1 | P0 邻居视图 | Inspector 顶部多两块；点击切换 agent | 无 |
| W1 D1 | Inspector 清理 | 移除假 Save/Cancel + 假字段 | 无 |
| W1 D2-D4 | F2 后端 | extractor + journey API + 覆盖率报告 | P0 已合 |
| W1 D5 | F2 前端 | EntityJourneyContent + Timeline 抽离 | F2 后端 |
| W2 D1 | F2 入口 | Inspector "最近实例" 区块 | F2 完整 |
| W2 D2 | 公共抽取 | `components/shared/chat/` | F2 已合 |
| W2 D3-D5 | F1 | 工具集 + 后端 SSE + AgentChatbot | F2 已合（需要 entity 工具） |
| 待定 | 路径 A → B 升级 | RunEntity 表 + 回填 | 真实流量验证 A 不够用 |

总计：**约 8 个工作日**。可以两人并行（一人 P0+F2，一人 F1 + 公共抽取），缩到 5 天。

---

## 9. 验收标准

### P0
- [ ] 选中 18 个 agent 中任意一个，Inspector 都能正确显示上/下游列表
- [ ] 点击邻居 → Inspector 切换到对应 agent 且 canvas 高亮跟着切
- [ ] AGENT_MAP lint 在 CI 中跑，emitsEvents 与代码 step.sendEvent 一致

### F2
- [ ] 输入一个真实 JobRequisition / JobPosting / Candidate ID 能渲染 timeline
- [ ] 时间线按时间序合并多条 run，标注 run 边界
- [ ] step 展开后 input/output JSON 正确显示
- [ ] 大 payload (>20KB) 不卡顿
- [ ] coverage 报告显示 extractor 命中率 ≥95%
- [ ] `?density=compact` / `?density=full` 都有效

### F1
- [ ] "最近 24h JDGenerator 失败的 JD" 能正确返回真实 ID 列表
- [ ] entity 链接可点击直跳 F2
- [ ] 无 LLM 网关时 fallback 到"工具结果直出"模式（不编故事）
- [ ] 历史按 agent short 持久化，切换不串

---

## 10. 开放问题与未来工作

1. **路径 B 升级触发条件**：runs > 50k 还是查询 P95 > 1s？需要先打观测埋点（`journey API` 加 `Server-Timing` header）。
2. **Event payload schema** 是平行工作 —— 一旦 events-catalog 有 zod schema，Inspector 可以再加一个"事件契约"区块替代当前移除的 Input/Output 块。属于 [event-manager-and-tracking-design.md](./event-manager-and-tracking-design.md) 的范围。
3. **跨 agent 全局 chatbot**：F1 是单 agent。运营也会想问"过去 24h 整个流水线有什么异常"，这是站点级 chatbot，不在本设计内，但抽出的 `components/shared/chat/` 可以复用。
4. **HITL 在 timeline 的呈现**：HITL agent 的 step 经常是 "等待 4h" 这种长尾，不能简单按 duration 画。建议 timeline 对 HITL step 用特殊渲染（漏斗图标 + "等待中"标签 + 当前 actor）。
5. **路径 A 的隐私**：扫 step input/output 不可避免会读到 candidate PII。journey API 返回前应该跑 PII 脱敏（已有 `Compliance.lint`？需要确认）。**上线前必须 sign-off**。

---

## 附录 A：文件改动总清单

新增：
- `lib/agent-graph.ts`
- `lib/entity-types.ts`
- `lib/entity-extractor.ts`
- `lib/entity-extractor.test.ts`
- `app/api/entities/[type]/[id]/journey/route.ts`
- `app/api/entities/[type]/[id]/route.ts`
- `app/api/agents/[short]/recent-entities/route.ts`
- `app/api/agents/[short]/chat/route.ts`
- `app/entities/[type]/[id]/page.tsx`
- `components/workflow/NeighborhoodPanel.tsx`
- `components/workflow/RecentEntitiesPanel.tsx`
- `components/workflow/AgentChatbot.tsx`
- `components/entity/EntityJourneyContent.tsx`
- `components/entity/EntityHeader.tsx`
- `components/entity/EntityTimeline.tsx`
- `components/entity/EntityStepCard.tsx`
- `components/shared/chat/MessageBubble.tsx`
- `components/shared/chat/ToolEventTimeline.tsx`
- `components/shared/chat/CitationChip.tsx`
- `scripts/audit-entity-coverage.ts`
- `scripts/lint-agent-map-vs-code.ts`

修改：
- `components/workflow/WorkflowContent.tsx`（清理硬编码 + 嵌入新面板）
- `components/live/RunChatbot.tsx`（提取共享原语）
- `components/live/RealRunDetail.tsx`（共用 Timeline）

按需：
- `prisma/schema.prisma` 加 `RunEntity`（路径 B 时）
- `scripts/backfill-run-entities.ts`（路径 B 时）

## 附录 B：与现有文档的关系

- [event-manager-and-tracking-design.md](./event-manager-and-tracking-design.md) — 上游：定义事件总线 / EM gateway / schema registry。本设计**消费**它产出的 EventInstance / WorkflowRun。
- [end-to-end-pipeline-walkthrough.md](./end-to-end-pipeline-walkthrough.md) — 上游：流水线全貌。本设计是它的**可视化入口**。
- [ao-resume-workflow-design.md](./ao-resume-workflow-design.md) — 上游：业务流程定义。AGENT_MAP 反映它。
