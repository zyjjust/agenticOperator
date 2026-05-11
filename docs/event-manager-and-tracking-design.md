# Agentic Operator · 事件管理与追踪深度分析

**适用版本**：AO main（`agentic-operator-main` Inngest app）+ `resume-parser-agent` runtime + RAAS shared Inngest 桥接
**最后更新**：2026-05-09
**对应代码**：`server/em/`、`server/inngest/`、`lib/event-lifecycle.ts`、`lib/events-catalog.ts`、`app/api/events/*`、`app/api/runs/[id]/{chat,trace}`、`prisma/schema.prisma`

---

## 0. 执行摘要

事件管理器(EM)的目标不是再造一个事件总线，而是在 **Inngest 这条总线之上**架一层"业务级闸门 + 业务级证据链"，让运营能像翻账本一样把任何一个候选人 / 岗位 / Run 的故事讲清楚。

| 维度 | Inngest 已经给的 | EM 必须自建的 |
|---|---|---|
| 传输 / fan-out / retry | ✅ Event bus、`step.*`、cancelOn、throttle、`id` 幂等 | — |
| Schema 校验 | ❌ 不校验 payload | ✅ Neo4j → JSON Schema → Zod，多版本回退 |
| 业务白名单 / 黑名单 | ❌ 无业务路由 | ✅ `GatewayFilterRule`（Phase 3 placeholder 已就位） |
| 业务级审计 | ⚠️ 有 run 历史，但 payload 不透明、5 天 TTL | ✅ `EventInstance` + `AuditLog`（永久 + 业务字段） |
| 因果链 | ⚠️ 有 `inngest/function.finished` 引用 | ✅ `caused_by_event_id` + entity anchor 走图 |
| 注册中心 | ❌ 无 schema registry | ✅ Neo4j 单一真相源 + 同步 worker |
| Chatbot 解释 | ❌ 无 | ✅ 工具调用 + 引用强制 + 多视角 scope |

**当前已经做完的部分**（这次不重写）：
- `em.publish()` 5 步流水线：filter→validate→dedup→persist→`inngest.send`（[server/em/publish.ts](../server/em/publish.ts)）
- Neo4j EventDefinition 同步（5 分钟 cron，content-hash 去抖动，retired/breaking 标记）
- Run-scoped 工具型 chatbot（[app/api/runs/\[id\]/chat/route.ts](../app/api/runs/[id]/chat/route.ts)）
- 28-event 硬编码兜底（cold start / off-VPN）

**这份文档要 close 的口子**：
1. 把 Inngest 原生功能与 EM 自建功能边界明确写下来，避免再有人去自己写"事件总线"。
2. 设计**实体级**(候选人 / 岗位 / Run / 事件实例) 的追踪模型，让 chatbot 不再被锁在单 run 视角。
3. 把 schema 校验从"占位 passthrough"升级为有可回滚 strict 开关的注册流程。
4. 让白名单过滤 ready-to-ship，但**默认通过**，避免开发期阻塞业务流。

---

## 0.5 层次模型 · EM 不是 Inngest 的 wrapper

> 这一节专门防一类常见误读："AO 是综合平台、EM 把 Inngest 包起来了"。**前半句对，后半句错**，方向会带偏后续设计。

正确的心智模型是 **AO 顶层平台 → EM 与 Inngest 并列两层**，不是嵌套：

```
              ┌──────────────────────────────────────────────┐
  AO (平台)   │  UI · workflow runtime · audit · KB · agent  │
              │  registry · 人工审批 · 健康 · 跨系统拼接       │
              └────────────┬─────────────┬───────────────────┘
                           │             │
                  publish 路径         consume 路径
                  (业务级闸门)         (Inngest 原生订阅)
                           │             │
                           ▼             │
                       ┌───────┐         │
                       │  EM   │  ←──────┴── EM 只挡在这一边
                       │       │            (filter / zod / dedup
                       └───┬───┘             / persist / NACK)
                           │             │
                           ▼             ▼
                     ┌──────────────────────┐
                     │       Inngest        │  事件总线本体
                     │  send · fan-out      │  agent 直接 createFunction
                     │  waitForEvent · DLQ  │  订阅，不经 EM
                     └──────────────────────┘
```

**EM 在 publish 路径上**：[server/em/publish.ts](../server/em/publish.ts) 的 5 步流水线 → 最后一步 `inngest.send()`。所有 `em.publish()` 必经此路。

**EM 不在 consume 路径上**：agent 用 Inngest 原生 `createFunction({ trigger: { event } })` 订阅（[server/inngest/client.ts](../server/inngest/client.ts) + `resume-parser-agent`），`step.waitForEvent` / `cancelOn` / retry / throttle 全部直接走 Inngest。`/api/runs/:id/trace` 也是直接打 Inngest 的 `GET /v1/events/:id/runs`，不经过 EM。

### 这个边界为什么要钉死

按"EM 包 Inngest"的模型走，下一步会**想多三件事**，每件都是工程债：

| 误读会想做的事 | 为什么不要做 |
|---|---|
| 在 EM 里重写 `waitForEvent` / `cancelOn` / retry policy | Inngest 原生功能，自己写会丢掉 dev UI replay + 增加故障点 |
| 让所有 consume 也过 EM 一道 | 把 fan-out 串行化，失去 Inngest 并行交付能力，并多一层延迟 |
| 用 EM 替代 Inngest | 物理不可能，会把 fan-out / 持久化 / 重试 / DLQ 全部重写 |

按"EM = publish 闸门"的模型走，方向就只有一条：EM 只长**业务**能力 (schema / filter / audit / lineage / NACK)，**传输**和**消费**交给 Inngest，两者不重叠也不替换。本文档 §2.1 / §2.2 两张表就是按这条边界切的。

---

## 1. 现状盘点 · 一图看完

```
                ┌──────────────────────────────────────────────────────────────┐
                │                  Inngest dev server (Docker)                 │
                │   /e/<key> 接收  ·  /v1/events  ·  /v1/events/:id/runs        │
                │   持久化 SQLite · 自动 retry · cancelOn · waitForEvent · DLQ  │
                └─────▲────────────────────────────────────────────▲───────────┘
                      │ inngest.send (idempotencyKey)              │ POST /api/inngest
                      │                                            │ (resume-parser-agent / 3020)
                      │                                            │
                ┌─────┴───────────────────────────┐         ┌──────┴───────────┐
                │      AO main (this repo)        │         │ resume-parser-   │
                │                                  │         │     agent        │
                │  ┌──────────────────────────┐   │         │  · 真正的 fn      │
                │  │  em (server/em/)          │   │         │  · 跑 RoboHire    │
                │  │  ┌────────────────────┐   │   │         │  · 跑 LLM         │
                │  │  │ publish (5 步)      │   │   │         │  · emit 下游事件   │
                │  │  │  · filter (noop)    │   │   │         └──────────────────┘
                │  │  │  · zod validate    │   │   │
                │  │  │  · dedup           │   │   │         ┌──────────────────┐
                │  │  │  · persist         │   │   │         │  RAAS shared     │
                │  │  │  · inngest.send    │   │   │         │  Inngest         │
                │  │  └─────────┬──────────┘   │   │         │  10.100.0.70:8288│
                │  │            │              │   │         └──────┬───────────┘
                │  │  ┌─────────▼──────────┐   │   │                │
                │  │  │  registry (cache)   │◄──┼───┼─ Neo4j ────────┘
                │  │  │  json→zod, multi-v │   │   │  (RAAS_LINKS_NEO4J_*)
                │  │  └────────────────────┘   │   │       │
                │  │                            │   │       │ raas-bridge (poll)
                │  │  ┌────────────────────┐   │   │       │ 5s · seen-set
                │  │  │  sync worker        │◄──┼───┼───────┘
                │  │  │  EventDefinition    │   │
                │  │  │  ↦ AO Prisma SQLite │   │
                │  │  └────────────────────┘   │
                │  └──────────────────────────┘  │
                │                                 │
                │  ┌──────────────────────────┐  │
                │  │ Prisma (data/ao.db)       │  │
                │  │  · EventDefinition         │  │  catalog cache (Neo4j synced)
                │  │  · EventInstance           │  │  per em.publish 一行
                │  │  · AuditLog                │  │  per em.publish trace_id 一行
                │  │  · WorkflowRun/Step/Activity│ │  agent runtime
                │  │  · EmSystemStatus          │  │  health + neo4j 同步 mtime
                │  │  · GatewayFilterRule       │  │  Phase 3 (今天 noop)
                │  │  · DLQEntry / RejectedMsg  │  │  外部进入失败兜底
                │  └──────────────────────────┘  │
                └────────────────────────────────┘
```

**正在被消费的 4 类来源**：

| 来源 | 路径 | 用途 |
|---|---|---|
| AO 本地 Inngest | `INNGEST_LOCAL_URL` (默认 `:8288`) | `/api/inngest-events`、`/events` Firehose、运行时 fan-out |
| RAAS shared Inngest | `RAAS_INNGEST_URL` (`10.100.0.70:8288`) | RAAS Bridge poll + `?includeShared=1` |
| Neo4j (RAAS) | `RAAS_LINKS_NEO4J_*` | Schema 注册中心，5 分钟同步进 `EventDefinition` |
| Hardcoded catalog | [lib/events-catalog.ts](../lib/events-catalog.ts) | Cold-start fallback (28 事件) |

---

## 2. Inngest 原生能力分析（**不要再造**）

> 决策原则：**Inngest 已经是事件总线 + 工作流引擎，EM 只做"业务闸门 + 业务证据链"。任何"造一个事件总线"的需求都先回头看本节。**

### 2.1 已经稳定使用的能力

| 能力 | Inngest API | AO 怎么用 | 不要在 EM 重建的原因 |
|---|---|---|---|
| **事件投递 + 幂等** | `inngest.send({ id, name, data })` | `em.publish` 第 5 步 | `id` 字段自带 5 天幂等窗口；我们再用 `externalEventId` 作为 id 即可拿到端到端去重 |
| **多订阅 fan-out** | `createFunction({ trigger: { event } })` | 在 `resume-parser-agent` 注册 fn | 不要在 AO 自己派发；让 Inngest 来 |
| **重试 + 退避** | `failureHandler` + `retries` step config | RAAS partner 端的 fn 配 | EM 永远不重试 inngest.send；交给上层 |
| **Run 历史 / 谁消费了我的事件** | `GET /v1/events/:id/runs` | `app/api/runs/[id]/trace/route.ts` 已经在用 | DB 里别再存"哪些 fn 跑了我的事件" |
| **取消 / 防抖** | `cancelOn`、`throttle`、`concurrency`、`rateLimit` | fn 声明式配置 | EM 不做业务取消 |
| **等待事件相关性** | `step.waitForEvent("BAR", { match: "data.upload_id" })` | 见 §6.1 候选人级追踪推荐用法 | 这是 Inngest 引以为傲的核心，自己写一个 watcher 不仅难，还会破坏 dev UI 的 replay |
| **同步函数调用** | `step.invoke({ function, data })` | 长链尾部需要"现在就要结果"时使用 | 不要拿 RPC 来替代 |
| **Step 持久化 / replay** | `step.run("name", fn)` | RPA agent 已经在用 | 不要在 AO 自己存 step output |
| **失败钩子** | `inngest/function.failed` system event | `lib/event-lifecycle.ts` 已经识别 | 把 DLQ 视作 Inngest 的副产品，EM 只镜像必要字段 |
| **Dev UI replay** | dev server 内置 | partner 联调用 | 不写自己的 replay 工具 |

### 2.2 Inngest 不提供、必须 EM 补的

| 能力 | 为什么 Inngest 没有 | EM 怎么补 |
|---|---|---|
| **Payload schema 校验** | Inngest 是 schema-agnostic，`data: any` | `server/em/registry/index.ts`：Neo4j 拉 JSON Schema → 转 Zod → `safeParse` |
| **业务白名单 / 黑名单 / 路由改写** | 总线不应该懂业务 | `GatewayFilterRule` (Prisma) + `filterCheck()` hook |
| **Reject NACK 给上游 publisher** | 总线只关心交付不关心业务接受 | `EVENT_REJECTED` meta-event ([server/em/rejection.ts](../server/em/rejection.ts)) |
| **业务级 trace_id 跨系统拼接** | `id` 是 inngest 自己给的 ULID，跟业务 trace 无关 | `AuditLog.traceId` 字段 + `extractTraceId(data.trace.trace_id)` |
| **EventDefinition 注册中心** | Inngest 不维护 schema 仓库 | Neo4j → AO Prisma `EventDefinition` 同步 worker |
| **业务级 ack（事件被某个 agent 接收成功 ≠ 业务被接受）** | 仅有 fn-level ack | `EventInstance.status = accepted/rejected_*` 业务态 |
| **跨实体溯源（"这个候选人经历了什么"）** | Inngest 按事件查、不按 entity 查 | `EventInstance.causedByEventId` + entity anchor (`upload_id`/`requirement_id`) |
| **永久审计** | 5 天 TTL | `AuditLog` (append-only) + `EventInstance` (永久) |

### 2.3 容易被误解、不要踩的坑

1. **`inngest.send` 已经返回前 EM 就把行写完了** — 顺序是先 `writeAcceptedInstance` 后 `inngest.send`。failure mode 是"行写了但 send 失败"，不是反过来。退化模式 `degradedMode` 会把 send 失败也记录、返回 `em_degraded`。
2. **Idempotency 不要在 EM 自己造** — 直接把 `externalEventId` 喂给 `inngest.send({ id })`。我们的 dedup 是**业务可见性**(返回 `duplicate`)，不是物理交付去重。
3. **不要订阅 Inngest 内部事件 `inngest/*` 来做业务追踪** — `inngest/function.finished` 只能告诉你"这个 fn 跑完了"，不能告诉你 ack 是不是通过业务校验。如果要做业务级 ack，在 fn 内部 `step.run("ack", async () => em.publish("X_ACKED", ...))`。

---

## 3. EM 自建职责的细节

### 3.1 `em.publish()` 5 步流水线

| Step | 行为 | 失败处理 | 当前实现 |
|---|---|---|---|
| 0. 自检 | 已经 degraded 直接转 raw `inngest.send` | 不抛 | `degradedMode.isDegraded()` |
| 1. **Filter** | `GatewayFilterRule` 模式匹配 (whitelist / blacklist / auto_map) | 写 `EventInstance(status=rejected_filter)` + emit `EVENT_REJECTED` | **Phase 3 placeholder（noop）** |
| 2. **Schema validate** | 多版本 Zod 尝试 (latest first) | 4 路：no_schema → 看 strict；schema 错 → 一律 reject | `server/em/registry/tryParse` |
| 3. **Dedup** | `EventInstance.externalEventId` unique index | 直接返回 `{accepted:false, reason:'duplicate'}` 不发 NACK | `findInstanceByExternalId` |
| 4. **Persist** | `EventInstance(status=accepted)` + `AuditLog`（best-effort） | EventInstance 失败 → 进退化模式 | `writeAcceptedInstance + writeAudit` |
| 5. **Send** | `inngest.send({ id: externalEventId ?? eventId, name, data })` | 失败 → `degradedMode.activate()` | `server/em/publish.ts:280` |

**关键设计取舍**：
- AuditLog 是 fire-and-forget — `trace_id` 缺失不能阻塞业务事件；
- `EVENT_REJECTED` 自身**绕开**整条 5 步流水线（hardcoded schema 自检），否则递归；
- `schemaVersionUsed` 出现 `"unvalidated"` 字面值，意味着 dev 模式下未注册事件直通；UI 看到这个值就可以 banner 提醒 "未登记到 Neo4j"。

### 3.2 多版本 Schema 解析顺序

```
em.publish(name, data)
   │
   ▼
registry.resolve(name)            ← 30s in-memory cache
   │
   ├─ Prisma EventDefinition (source='neo4j')
   │      └─ schemasByVersionJson + activeVersionsJson 解析
   │            └─ json-schema-to-zod.convert()  ← 失败 fallback 到下一步
   │
   ├─ BUILTIN_SCHEMAS_BY_NAME (server/em/schemas/builtin.ts)
   │      └─ 已声明的 8 条核心事件 + normalize() upgrade hooks
   │
   └─ null  (no schema)
              ├─ EM_STRICT_SCHEMA=true → reject 'no_schema' + emit EVENT_REJECTED
              └─ default (dev)        → "unvalidated" 直通
```

> **dev 期默认 passthrough 是当前 PRD 的明确决定**：在 RAAS 那边把所有事件先在 Neo4j 上发布、AO 同步进来之前，业务流不能因 schema 而断。打开 strict 的开关在生产环境常驻 ON。

### 3.3 Filter / 白名单 / 黑名单（Phase 3 设计）

数据模型已经存在（[prisma/schema.prisma:381](../prisma/schema.prisma#L381)）：

```prisma
model GatewayFilterRule {
  id               String  @id @default(uuid())
  ruleType         String  // whitelist | blacklist | auto_map
  eventNamePattern String  // 支持 glob: "RESUME_*" / "*_FAILED" / "X.Y"
  targetEventId    String? // auto_map 时把 incoming X 改写成 Y
  enabled          Int     @default(1)
  description      String?
  createdAt        String
}
```

**应用规则的优先级（推荐实现）**：

```
incoming event N
       │
       ▼
load all enabled rules (cached 30s, invalidate on /api/em/sync-now)
       │
       ▼
match by eventNamePattern (glob)
       │
       ├─ blacklist hit       → reject 'filter' + emit EVENT_REJECTED
       ├─ auto_map hit        → 把 N 改写成 targetEventId 继续 step 2
       ├─ whitelist 启用 + N 没命中任何 whitelist 行 → reject 'filter'
       └─ 默认 allow
```

**今天不开启**：dev 期 `filterCheck()` 返回 `{ allow: true }`（[server/em/publish.ts:65](../server/em/publish.ts#L65)）。需要打开时：
1. 实现 `filterCheck` 的真正逻辑（30 行内）；
2. 在 `/api/em/filter-rules` 提供 CRUD（admin only）；
3. 加 `EM_FILTER_ENABLED` 环境变量做整层 kill-switch。

### 3.4 失败 / 拒绝的可观测性

每条 reject 都会有三处证据：

| 证据 | 字段 / 端点 | 给谁看 |
|---|---|---|
| `EventInstance(status=rejected_*)` | `prisma.eventInstance` | UI / chatbot 找事件 lifecycle |
| `EVENT_REJECTED` meta-event | Inngest bus + `EventInstance(status=meta_rejection)` | 上游 publisher 通过订阅做反向 NACK 决策 |
| `AgentActivity` row | `agentName='RAASBridge'` 等 | 在 run timeline 里以"事件被拒"显示 |

---

## 4. 事件追踪模型 · 让 chatbot 能讲故事

> **Chatbot 的核心痛点**：现在的 `/api/runs/:id/chat` 只能讲一个 run 的故事。如果用户问"这个候选人后来怎么样了"或"这个职位发出去之后总共触发了多少次匹配"，就答不上来 —— 因为我们没有按业务实体走的索引。

### 4.1 三类相关性键 + 实体锚

```
        trace_id (跨系统串)              caused_by_event_id (因果)
              │                                    │
              │                                    │
              ▼                                    ▼
  ┌──────────────────────────────────────────────────────┐
  │                       EventInstance                  │
  │   id  externalEventId  name  source  status  ...    │
  │   causedByEventId    causedByName                    │
  └──────────────────────────────────────────────────────┘
              │
              ▼
        payloadSummary (含业务锚)
        ┌─────────────────────────┐
        │ requirement_id          │  → JobRequisition
        │ job_requisition_id      │  → JobRequisition / JD
        │ jd_id                   │  → JobDescription
        │ upload_id               │  → 候选人简历（最强锚，AO/RAAS 共用）
        │ candidate_id            │  → Candidate (RAAS 内部)
        │ application_id          │  → Application
        └─────────────────────────┘
```

**三种走图方式**（chatbot 都得会）：

| 方向 | 起点 | 走法 | 终点条件 | API |
|---|---|---|---|---|
| **forward cascade** | 任一 EventInstance | 反查 `causedByEventId == this.id` 的所有子节点，BFS | 没有更多子节点 | `/api/event-instances/:id/descendants` |
| **backward root cause** | 任一 EventInstance | 顺着 `causedByEventId` 一路向上 | `causedByEventId == null` | `/api/event-instances/:id/ancestors` |
| **entity span** | (entity_type, entity_id) | 从 `payloadSummary` LIKE 拉出所有相关 EventInstance，按 ts 排 | — | `/api/entities/:type/:id/timeline` |

> 当前没有这三个 API；**§8 的实施清单**会逐条列出来。

### 4.2 `caused_by_event_id` 怎么进 payload

[lib/event-lifecycle.ts](../lib/event-lifecycle.ts) 已经在 reader 端做了多路兼容：

```ts
const CAUSED_BY_PATHS = [
  d => d._meta?.caused_by_event_id,
  d => d._meta?.causedByEventId,
  d => d.payload?.caused_by_event_id,
  d => d.payload?.causedByEventId,
  d => d.caused_by_event_id,
  d => d.causedByEventId,
];
```

写入侧的契约（**所有 agent 必须遵守**）：

```ts
// 任何 emit 都从触发当前 run 的 event id 拷一份过去
await em.publish("MATCH_PASSED_NEED_INTERVIEW", {
  ...,
  _meta: { caused_by_event_id: triggerEvent.id }
}, {
  source: "rpa.matchResumeAgent",
  causedBy: { eventId: triggerEvent.id, name: triggerEvent.name },
  // 这一行也会写进 EventInstance.causedByEventId 列
});
```

### 4.3 Lifecycle 状态机

```
                            ┌────────────────┐
                            │ external bridge│
                            └───────┬────────┘
                                    │ em.publish (source=raas-bridge)
                                    ▼
              ┌──────────────────────────────────────┐
              │ EventInstance                         │
              │   status =                            │
              │     accepted          (业务通过)      │
              │     rejected_schema   (zod 失败)      │
              │     rejected_filter   (规则拒绝)      │
              │     duplicate         (externalId 命中)│
              │     em_degraded       (流水线降级)     │
              │     meta_rejection    (EVENT_REJECTED)│
              └─────┬────────────────────────────────┘
                    │ inngest.send 成功
                    ▼
           Inngest run 历史 (谁消费了我)
                    │
                    ▼
            agent step.run / step.waitForEvent
                    │
              ┌─────┴─────┐
              ▼           ▼
        emit cascade   completed/failed
        (caused_by 链)  (inngest/function.finished)
```

`lib/event-lifecycle.ts.classifyEvent` 把这些状态翻成 `received | emitted | completed | failed` 四态供 UI 渲染。

### 4.4 Trace ID 战术

`AuditLog.traceId` 跨系统对账，规则：

1. AO 内部的事件 → `traceId = data.trace.trace_id` 优先；缺失则 `eventId` 作为 trace。
2. RAAS bridged 进来的 → 沿用 RAAS 的 `data.trace.trace_id`，不要重新分配。
3. 工具调用 / Agent step 拿 `traceId` 做日志关联键，写进 `AgentActivity.metadata.traceId`。

> **注意**：trace_id 不等于 caused_by 链根。一个 trace 可以横跨多次 cascade；caused_by 是单一父子关系。Chatbot 在讲故事时优先用 caused_by 拼"剧情"，trace_id 用来确认"是不是同一次业务请求"。

---

## 5. Schema 校验 · Neo4j 单一真相源

### 5.1 同步流程

```
┌─────────┐  CYPHER_PULL_DEFINITIONS         ┌──────────────────────┐
│ Neo4j   │ ◄─────────────────────────────── │ event-definition-sync│  every 5 min
│ Allmeta │                                   │      (worker)        │
└─────────┘                                   └──────────┬───────────┘
                                                         │
                                                         ▼
                          ┌──────────────────────────────────────────────┐
                          │  Prisma EventDefinition                       │
                          │   · payload (JSON Schema)                     │
                          │   · schemasByVersionJson  {"1.0": {...}}       │
                          │   · publishersJson / subscribersJson           │
                          │   · contentHash (sha256, 防 noop 抖动)         │
                          │   · isBreakingChange (Allmeta 标记)            │
                          │   · retiredAt (本次没出现 → 软退役)             │
                          │   · lastChangedAt (内容真变化才推进)            │
                          └──────────────┬───────────────────────────────┘
                                         │
                                         ▼
                            registry.resolve(name)  (30s cache)
                                         │
                                         ▼
                         json-schema-to-zod (defensive, fallback to builtin)
                                         │
                                         ▼
                                   Zod schema
```

**关键开关**：

| 环境变量 | 默认 | 含义 |
|---|---|---|
| `NEO4J_SYNC_ENABLED` | `0` | `1` 开启 sync worker；off-VPN 时关掉避免 log 刷屏 |
| `NEO4J_SYNC_INTERVAL_MS` | `300000`(5min) | 同步周期 |
| `EM_STRICT_SCHEMA` | unset (dev passthrough) | `true` 时未注册事件被拒并 NACK |
| `RAAS_LINKS_NEO4J_*` | unset | 与 RAAS 共享凭据；fallback 到 `NEO4J_*` |

### 5.2 RAAS field type → JSON Schema → Zod

`buildJsonSchemaFromFields` 把 RAAS 自有 type 词表映射为 JSON Schema 子集：

| RAAS type | JSON Schema | Zod (defensive) |
|---|---|---|
| `String` / `Text` | `{type:'string'}` | `z.string()` |
| `Integer` / `Long` | `{type:'integer'}` | `z.number().int()` |
| `Float` / `Decimal` | `{type:'number'}` | `z.number()` |
| `Boolean` | `{type:'boolean'}` | `z.boolean()` |
| `Date` / `Datetime` | `{type:'string'}` | `z.string()` |
| `List<X>` | `{type:'array', items: <X>}` | `z.array(<X>)` |
| `Map<K,V>` | `{type:'object'}` | `z.record(z.unknown())` |
| `Job_Requisition` 等业务对象 | `{type:'object'}` | `z.object({}).passthrough()` |
| 未识别 | `{}` | `z.unknown()` |

转换失败时 **不阻塞 sync**，只在 `versionSources` 留下 `fallbackReason`。`/api/events?debug=raw` 可以查到原始转换报告。

### 5.3 Validation 决策树

```
em.publish(name, data)
   │
   ▼
tryParse(name, data)
   │
   ├─ ok → schemaVersionUsed = "1.0" / "2.0" 等
   │
   └─ !ok
        │
        ├─ error == 'no_schema'
        │    ├─ EM_STRICT_SCHEMA → reject 'no_schema' + emit EVENT_REJECTED
        │    └─ default          → schemaVersionUsed = "unvalidated" 通过
        │
        └─ error == 'all_versions_failed'  (有 schema 但 data 不合法)
              │
              └─ 永远 reject 'schema'
                  · EventInstance.schemaErrors = ZodIssue[]
                  · triedVersions = ["2.0", "1.0"]
                  · emit EVENT_REJECTED (含 retry guidance)
```

> 重点：**schema 命中但失败 → 一律拒**，不被 strict 开关影响。这避免"开发期降级 = 生产期数据腐败"。

---

## 6. Chatbot 自然语言追踪 · UX 契约

### 6.1 三种 scope

| Scope | 入口 | 当前状态 | 缺失 |
|---|---|---|---|
| **Run 级** ("这个 run 为什么慢") | `/api/runs/:id/chat` | ✅ 已上线 | — |
| **Entity 级** ("这个候选人发生了什么") | (设计中) `/api/entities/:type/:id/chat` | ❌ | 见 §6.4 |
| **Global firehose** ("最近 1 小时 RESUME_DOWNLOADED 的拒绝率") | (设计中) `/api/em/chat` | ❌ | 见 §6.5 |

### 6.2 Run 级现有工具盘点

[app/api/runs/\[id\]/chat/route.ts](../app/api/runs/[id]/chat/route.ts) 暴露的 tools：

| Tool | 干嘛 | 限制 |
|---|---|---|
| `getActivityLog` | `AgentActivity` 行 (按 kind 筛)，30 行 | run-scoped |
| `getAgentStats` | per-agent 步数 / errors / tools / decisions | run-scoped |
| `getEventTrace` | 调 `/api/runs/:id/trace`：事件 + Inngest fn runs | run-scoped |
| `getRunSummary` | `/api/runs/:id/summary` 高层汇总 | run-scoped |
| `getAgentInfo` | `AGENT_MAP + AGENT_FUNCTIONS` 静态注册 | global |

**约束写得够死**（避免 LLM 跑偏）：
- 每个事实必须 cite tool；
- 任何修改请求一律拒绝；
- 中文进中文出；
- ≤8 行除非用户问"细节"。

### 6.3 引用契约

```ts
type Source = {
  tool: string;     // 'getActivityLog'
  label: string;    // '5 AgentActivity rows'
  ref?: string;     // runId / eventId / traceId
};
```

每条 LLM reply 渲染下方 chips；inline 引用 `(via getEventTrace event_id=01H…)`。**没有 sources 的 reply 视为不合规**，UI 应以红色 banner 提醒。

### 6.4 Entity 级追踪（要新增的 tools）

让 chatbot 能回答 "show me the journey of upload_id=abc123" 需要：

```
┌───────────────────────────────────────────────────────────────────┐
│ NEW TOOLS                                                         │
│                                                                   │
│  getEntityTimeline({                                              │
│    entityType: "upload" | "requirement" | "jd" | "candidate",     │
│    entityId: string,                                              │
│    sinceTs?: string,                                              │
│  })                                                               │
│  → 走 EventInstance.payloadSummary LIKE / 索引 expression         │
│  → 返回按 ts 排的 EventInstance[]，含 lifecycle + cascade depth   │
│                                                                   │
│  getCausalChain({ eventInstanceId, direction: "up" | "down" })    │
│  → BFS caused_by 关系 (上行/下行)                                 │
│  → 返回邻接列表，最多 50 个节点                                    │
│                                                                   │
│  getEventDefinition(name)                                         │
│  → registry.resolve(name)：description + publishers/subscribers + │
│     active versions + schemaSource                                │
│                                                                   │
│  getRejections({ name?, since?, sourceLike?, limit? })            │
│  → EventInstance(status IN rejected_*) — 用来回答 "为什么我的事件 │
│     被拒"                                                          │
│                                                                   │
│  getWaitingAgents({ eventName, entityId? })                       │
│  → 调 Inngest /v1/events/:id/runs 看哪些 fn 在 step.waitForEvent  │
│     上没收到下游 (用 cancelOn / waitForEvent 时尤其需要)          │
└───────────────────────────────────────────────────────────────────┘
```

为了让 `payloadSummary` 真正可查，需要在 `writeAcceptedInstance` 里**额外抽几个稳定字段**（不要存全 JSON）：

```prisma
// prisma 增量
model EventInstance {
  // ... 现有字段
  uploadId        String?  @map("upload_id")        @index
  requirementId   String?  @map("requirement_id")   @index
  jdId            String?  @map("jd_id")            @index
  candidateId    String?  @map("candidate_id")      @index
  applicationId  String?  @map("application_id")    @index
}
```

抽取规则集中在 `server/em/persistence.ts`：

```ts
const ENTITY_ANCHORS = ["upload_id", "requirement_id", "jd_id", "candidate_id", "application_id"] as const;
function pickAnchors(payload: unknown): Partial<Record<typeof ENTITY_ANCHORS[number], string>> {
  if (!payload || typeof payload !== "object") return {};
  const flat = (payload as any).payload ?? payload; // RAAS envelope or direct
  const out: any = {};
  for (const k of ENTITY_ANCHORS) {
    if (typeof flat[k] === "string") out[k] = flat[k];
  }
  return out;
}
```

### 6.5 Global firehose chatbot

`/api/em/chat` 的工具必须**额外**有：

| Tool | 描述 |
|---|---|
| `getEventStats` | per-name 1m/1h 速率、reject 率、p99 latency（来自 `EmSystemStatus` + `EventInstance` group by） |
| `getCatalog` | `/api/events` 但只返摘要，让 LLM 选名字 |
| `getRaasBridgeHealth` | `getRaasBridgeStatus()` 已经有 |
| `getEmHealth` | `degradedMode.getState()` |

对话约束需要更严：**不要让 LLM 列举数据库行**，永远只让它问聚合 + top-N。

### 6.6 Chatbot 系统 prompt 升级建议

现有 prompt（[app/api/runs/\[id\]/chat/route.ts:51](../app/api/runs/[id]/chat/route.ts#L51)）已经写得不错。**Entity-scope 时**多加 4 句：

```
Hard constraints (additional):
- 你正在解释 ${entityType}=${entityId} 的故事。
- 优先使用 getEntityTimeline，然后再针对发现的 EventInstance 调 getCausalChain。
- 不要跨实体讨论；如果用户问 "他还投过别的岗位"，先 getEntityTimeline 拿到所有应聘 application_id 再说。
- "事件" 在你的回答里指 EventInstance；"agent run" 指 Inngest fn run。两者别混。
```

---

## 7. 数据模型对齐表

> 真实数据流要在这 5 张表 + 1 个外部图(Neo4j) + 1 个事件总线之间走通。

| 数据 | 主存储 | 二级索引 | API | Chatbot tool |
|---|---|---|---|---|
| Event 定义 | Neo4j `(:Event)` | `EventDefinition` (cache) | `/api/events` | `getCatalog`, `getEventDefinition` |
| Event 实例 | `EventInstance` (Prisma) | Inngest `/v1/events/:id` | `/api/event-instances/:id` (新) | `getEntityTimeline`, `getCausalChain` |
| Cascade 关系 | `EventInstance.causedByEventId` | (建议加) `@@index` | `/api/event-instances/:id/{ancestors,descendants}` (新) | `getCausalChain` |
| Trace 串联 | `AuditLog.traceId` | already indexed | `/api/correlations/:traceId` | `getCorrelation` (新) |
| Rejections | `EventInstance(status=rejected_*)` | `@@index([status])` | `/api/em/rejections` (新) | `getRejections` |
| Run / Step | `WorkflowRun` / `WorkflowStep` | already indexed | `/api/runs/:id/{trace,activity,steps}` | `getActivityLog`, `getEventTrace` |
| Agent 注册 | `AGENT_MAP`, `AGENT_FUNCTIONS` | 静态 | `/api/agents` | `getAgentInfo` |
| EM 健康 | `EmSystemStatus` (singleton) | — | `/api/em/health` | `getEmHealth` |
| RAAS Bridge | `getRaasBridgeStatus()` (in-mem) | — | `/api/raas-bridge/status` | `getRaasBridgeHealth` |
| Inngest fn runs | Inngest dev server | — | `GET /v1/events/:id/runs` (proxied) | `getEventTrace` |
| Filter rules | `GatewayFilterRule` | — | `/api/em/filter-rules` (新) | — (admin only) |

---

## 8. 实施路线 · phase by phase

> 每个 phase 都遵循 "代码改动 < 200 行 + 一次性 schema 迁移 + 文档更新"。

### Phase A — 让 EventInstance 可以被实体查（高优）

**目的**：解锁 entity-scope chatbot。

- [ ] `EventInstance` 加 5 个 entity anchor 列 + `@@index`
- [ ] `persistence.writeAcceptedInstance` 写入时抽取 anchors
- [ ] 新增 `GET /api/event-instances?uploadId=...&requirementId=...&limit=...`
- [ ] 新增 `GET /api/entities/:type/:id/timeline`
- [ ] 在 `app/api/runs/[id]/chat/route.ts` 之外新建 `/api/entities/:type/:id/chat`，复用 system prompt + 新工具

### Phase B — 因果链 API + chatbot tool

**目的**：让 chatbot 能讲 "X 触发了 Y 又触发了 Z"。

- [ ] `EventInstance.causedByEventId` 加 `@@index`（已有，但确认）
- [ ] `GET /api/event-instances/:id/{ancestors,descendants}`，BFS 50 节点上限
- [ ] 增 `getCausalChain` tool 到 entity-scope chatbot

### Phase C — Schema strict 模式 + 拒绝面板

**目的**：把 dev passthrough 升级为可生产。

- [ ] `/events` 页面加 "未注册事件" 抽屉 (筛选 `schemaVersionUsed=unvalidated`)
- [ ] `/api/em/rejections` 列表 API
- [ ] `/em` admin 页一个 toggle，写 `EmSystemStatus.strictSchemaEnabled`
- [ ] `em.publish` 读这个字段而不是只看环境变量（环境变量保留作为 hard override）
- [ ] 全量 RAAS 事件先在 Neo4j 注册之前**不要打开 strict**

### Phase D — Filter / 白名单（默认关闭）

**目的**：闸门 ready，但默认通过，避免开发期阻塞。

- [ ] `filterCheck()` 实现 glob + rule precedence (§3.3)
- [ ] `/api/em/filter-rules` CRUD（admin only）
- [ ] `/em/filter-rules` 简单管理页
- [ ] 加 `EM_FILTER_ENABLED` 环境变量做整层 kill-switch；默认 off
- [ ] 单元测试覆盖：blacklist > whitelist > auto_map > default-allow

### Phase E — Chatbot global firehose

**目的**：跨 run / 跨 entity 的运营级问答。

- [ ] `getEventStats`：在 `EventInstance` 上的 group-by（per-name × hour bucket）
- [ ] `/api/em/chat`：复用 streaming SSE，但 system prompt 强调聚合
- [ ] `/em/ask` 入口（小输入框 + 历史侧栏）

### Phase F — Lineage 可视化（可选）

- [ ] `/correlations/:traceId` 已经有，加上 EventInstance + caused_by 走图层
- [ ] 实体 timeline 视图：按 `upload_id` 横轴，每条事件竖排
- [ ] 上面叠 `getEntityTimeline` 工具结果作为 chatbot "为什么" 的解释面板

---

## 9. 风险与边界

| 风险 | 触发条件 | 兜底 |
|---|---|---|
| Neo4j off-VPN | 同步 worker 失败 | `/api/events` fallback 到 `EVENT_CATALOG` 28 条 + UI banner |
| EventInstance 暴增 | 高吞吐 | `payloadSummary` 已经截 1000 字符；考虑 `EventInstance` 90 天后归档 |
| `caused_by` 链断裂 | agent 忘了透传 | UI 显示 "孤立事件"；通过 `lib/event-lifecycle.ts` 多路径兼容 + agent code review |
| schema 已注册但 RAAS 改了字段没升版本 | 静默 mismatch | `isBreakingChange=true` 标红 + sync worker 比对 contentHash 触发 alert |
| Chatbot 被诱导查别的 run | prompt injection | scope 在 SYSTEM_PROMPT 里硬编码 + 工具实现层只接受当前 runId |
| EM 流水线挂掉 | DB / Inngest down | `degradedMode` 切换 → raw `inngest.send`，业务流量保持 |
| Filter 误杀 | 配置错 | `EM_FILTER_ENABLED=0` 全局 kill-switch |

---

## 10. 决策摘要（给 reviewer）

1. **EM 不是 Inngest 的 wrapper，是 publish 侧的闸门** —— 详见 §0.5。AO 是顶层平台；EM 与 Inngest 并列两层，consume 路径不经 EM。
2. **不再造事件总线** —— Inngest 的 `send/waitForEvent/cancelOn/throttle` 是核心，EM 不重做。
3. **EM = 业务闸门 + 业务证据链** —— 5 步流水线只为校验、去重、审计、降级，永远不重排或缓冲。
4. **Schema 真相源是 Neo4j** —— `EventDefinition` 表只是 cache；硬编码 28 条仅 cold-start fallback。
5. **dev 默认 passthrough，生产 strict** —— `EM_STRICT_SCHEMA` 控制；schema 命中失败一律拒。
6. **Filter Phase 3 ready 但默认关** —— 让数据先流起来再上规则，规则不阻塞业务联调。
7. **Chatbot 走工具调用 + 强引用** —— 每条事实必须有 cite，read-only。三个 scope（run / entity / global），共用 prompt 框架。
8. **追踪靠 caused_by + entity anchor** —— `EventInstance` 表加 5 列业务 ID 索引，让"按候选人 / 按职位查事件"是 O(index)。
9. **Trace_id 横向串系统，caused_by 纵向串因果** —— 两者不混，chatbot 讲故事时优先用 caused_by 拼剧情。

---

## 附录 A · 当前 28 条事件的 stage 分布

来自 [lib/events-catalog.ts](../lib/events-catalog.ts)：

| Stage | 事件 | trigger / domain / error / gate |
|---|---|---|
| system | `SCHEDULED_SYNC` | trigger |
| requirement | `REQUIREMENT_LOGGED`, `REQUIREMENT_SYNCED`, `ANALYSIS_COMPLETED`, `ANALYSIS_BLOCKED`, `CLARIFICATION_INCOMPLETE`, `CLARIFICATION_RETRY`, `CLARIFICATION_READY` | domain × 5, error × 1, gate × 1 |
| jd | `JD_GENERATED`, `JD_APPROVED`, `JD_REJECTED`, `CHANNEL_PUBLISHED`, `CHANNEL_PUBLISHED_FAILED`, `TASK_ASSIGNED` | domain × 4, error × 1, gate × 1 |
| resume | `RESUME_DOWNLOADED`, `RESUME_PROCESSED`, `RESUME_PARSE_ERROR`, `RESUME_INFO_MISSING`, `RESUME_LOCKED_CONFLICT` | domain × 2, error × 2, gate × 1 |
| match | `MATCH_PASSED_NEED_INTERVIEW`, `MATCH_PASSED_NO_INTERVIEW`, `MATCH_FAILED` | domain × 2, gate × 1 |
| interview | `INTERVIEW_INVITATION_SENT`, `AI_INTERVIEW_COMPLETED` | domain × 2 |
| eval | `EVALUATION_PASSED`, `EVALUATION_FAILED` | domain × 1, gate × 1 |
| package | `PACKAGE_GENERATED`, `PACKAGE_APPROVED` | domain × 2 |
| submit | `APPLICATION_SUBMITTED`, `SUBMISSION_FAILED` | domain × 1, error × 1 |

`EVENT_REJECTED` 是 EM 自身发出的 meta-event，不在 catalog。

## 附录 B · 关键文件速览

```
server/em/
  index.ts                  # 公共 barrel: em.publish/em.validate/em.registry
  publish.ts                # 5 步流水线
  validate.ts               # tryParse 包装
  rejection.ts              # EVENT_REJECTED 自包含 emit
  degraded-mode.ts          # 健康状态 + 降级 send 兜底
  persistence.ts            # EventInstance / AuditLog 写入
  registry/
    index.ts                # resolve + tryParse + 30s in-mem cache
    json-schema-to-zod.ts   # 防御式转换 (失败 fallback to builtin)
  schemas/
    builtin.ts              # 8 条核心事件硬编码 Zod
    types.ts                # EventSchemaRegistration 类型
  sync/
    event-definition-sync.ts # Neo4j 5 分钟 cron
  clients/
    neo4j.ts                # lazy driver, 5s 超时, 优雅失败

server/inngest/
  client.ts                 # Inngest({ id: "agentic-operator-main" })
  raas-bridge.ts            # 5s poll RAAS_INNGEST_URL → em.publish
  functions.ts              # 主仓库不挂 fn (在 resume-parser-agent)

lib/
  events-catalog.ts         # 28 条 cold-start fallback
  event-lifecycle.ts        # received/emitted/completed/failed 分类
  agent-mapping.ts          # 22 个 agent 的 trigger/emit
  agent-functions.ts        # agent 自然语言摘要 (chatbot grounding)

app/api/
  events/route.ts           # 事件目录 (Neo4j-first)
  events/[name]/stream/route.ts
  inngest-events/route.ts   # /v1/events 代理
  runs/[id]/chat/route.ts   # 工具型 chatbot (run-scoped)
  runs/[id]/trace/route.ts  # 跨系统 trace 聚合
  trace/[id]/route.ts       # legacy traceId 聚合
  raas-bridge/start/route.ts

prisma/schema.prisma         # EventDefinition / EventInstance / GatewayFilterRule
                             # AuditLog / DLQEntry / EmSystemStatus / WorkflowRun
```

---

**回顾**：写完这篇文档后，下一个 PR 应该是 **Phase A**（EventInstance 加 entity anchor 列），最快路径让 chatbot 可以脱离 run-scope 解释候选人 / 岗位的故事。
