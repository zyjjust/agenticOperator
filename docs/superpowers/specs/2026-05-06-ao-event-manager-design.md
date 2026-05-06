# AO Event Manager 设计

| | |
|---|---|
| 日期 | 2026-05-06 |
| 状态 | Draft（待评审） |
| 作者 | Yuhan + Claude |
| Scope | AO 主仓库 + resume-parser-agent，所有出入站事件统一经过 Event Manager（库形态） |
| 相关文档 | [event-flow-deep-dive.md](../../event-flow-deep-dive.md), [raas-alignment-payloads.md](../../raas-alignment-payloads.md) |

---

## 1. 背景与目标

### 1.1 现状

AO 现有事件流转分散在多个位置，无统一管理：

- **AO-main** (`server/inngest/client.ts`, `server/ws/agents/*`) 直接 `inngest.send`，无 schema 校验，靠 agent 内 `if (!data) throw` 保平安
- **resume-parser-agent (RPA)** (`resume-parser-agent/lib/inngest/*`) 同样直接 `inngest.send`，靠 TS 类型 + 运行时手写防御
- **raas-bridge** (`server/inngest/raas-bridge.ts`) 从 partner Inngest 拉事件后直接 `inngest.send` 进本地总线，**没有任何拦截层**
- **forwardToRaas** (`server/inngest/raas-forward.ts`) agent 内显式 POST 到 partner Inngest，每个 agent 自己管错误处理

后果：
1. 同一份 schema 校验逻辑在不同 agent 内重复（且必然漂移）
2. RAAS 如果发了一条不合规的事件，AO 要么忽略要么 agent 失败，**没有回执机制告诉 RAAS 它的事件被拒了**
3. 没有"事件流水"的统一视图（`/events` UI 现在只能读 Inngest 自己的数据）
4. 跨 app 共享事件契约靠手抄（AO-main 和 RPA 各自定义 ResumeProcessedData，已有不一致）

### 1.2 目标

引入 **Event Manager (EM)**，作为 AO 仓库内的**库形态中央闸门**。所有事件 publish 必须通过 EM，EM 负责：

1. **统一 schema 校验** — 单一注册表，所有 publisher / subscriber 引用同一份 Zod schema
2. **Filter 拦截** — gateway whitelist / blacklist / tenant scope（启用时）
3. **业务事件流水持久化** — `EventInstance` 表，UI 主数据源
4. **失败回执** — schema/filter 失败时**自动 emit `EVENT_REJECTED` 元事件**，外部平台（RAAS）订阅后能拿到 NACK
5. **去重** — 完全委托 Inngest 内置 idempotency，**EM 不自建 dedup 表**

### 1.3 非目标

- ❌ 替代 Inngest（Inngest 仍是事件总线 + 持久化引擎 + retry/step 引擎）
- ❌ 业务规则校验（黑名单、license 检查、closed JD 等仍在 agent 内）
- ❌ 取代 RAAS DB 的业务实体存储
- ❌ 立刻建独立 sidecar 服务（先库形态，等多语言 SDK / 多团队共享时再升级）

---

## 2. 架构总览

```
═══════════════════════════════════════════════════════════════════════════════
[A] 外部源
═══════════════════════════════════════════════════════════════════════════════
   RAAS Dashboard      RAAS MinIO        Partner Inngest    Other 3rd-party
   (REQUIREMENT_       (RESUME_           (ANY)             (future)
    LOGGED)             DOWNLOADED)
        │                    │                    │              │
═══════════════════════════════════════════════════════════════════════════════
[B] INGRESS ADAPTERS
═══════════════════════════════════════════════════════════════════════════════
   Webhook /api/...     raas-bridge.ts            (任何 SDK)
                                │
                                ▼
                          em.publish(name, data, opts)
                                │
═══════════════════════════════════════════════════════════════════════════════
[C] EVENT MANAGER  (library, in-process, AO 仓库内)
═══════════════════════════════════════════════════════════════════════════════
                                │
       ┌────────────────────────┼─────────────────────────┐
       ▼                        ▼                         ▼
   ① Filter           ② Schema validate           ③ Persist EventInstance
   (whitelist)        (Zod safeParse)             (audit / UI 主数据源)
       │ ✗                     │ ✗                        │
       ▼                       ▼                          │
  emit EVENT_REJECTED      emit EVENT_REJECTED            │
  (reason: filter)         (reason: schema, errors:[])    │
                                                          ▼
                                                ④ inngest.send({
                                                     id: idempotencyKey,
                                                     name, data
                                                  })
═══════════════════════════════════════════════════════════════════════════════
[D] INNGEST BUS (Docker container `ao-inngest`, port 8288)
═══════════════════════════════════════════════════════════════════════════════
   持久化 + idempotency 去重 + fan-out + retry + step-checkpoint
                                │
       ┌────────────────────────┼──────────────────────┬─────────────────────┐
       ▼                        ▼                      ▼                     ▼
═══════════════════════════════════════════════════════════════════════════════
[E] WORKFLOW AGENTS  (Inngest functions, 业务校验 only)
═══════════════════════════════════════════════════════════════════════════════
   AO RPA agents        AO-main agents          raas-backend           其它订阅者
   (3020)               (3002, legacy)          (远端 3001)            (含 EVENT_REJECTED
                                                                       订阅者)

   每个 agent 内部只做 BUSINESS validation
   Cascade emit：再回到 [C] em.publish(...)
═══════════════════════════════════════════════════════════════════════════════
[F] STORAGE
═══════════════════════════════════════════════════════════════════════════════
   Inngest SQLite       EM database          RAAS DB        Neo4j (optional)
   (ao-inngest vol)     (Postgres/SQLite)    (RAAS 自管)     (graph 关系)

   • 事件原文            • EventInstance      • Candidate    • EventDefinition
   • function runs       • EventDefinition    • Resume        schema 主册
   • step outputs        • (DLQ optional)     • JD            • Event causality
   • idempotency cache   • (Rejected opt)     • Match         • Action/Rule (已有)
```

---

## 3. EM 职责边界

### 3.1 EM 做什么

| 责任 | 落点 | 说明 |
|---|---|---|
| envelope shape 必填字段（entity_id / event_id / trace 等） | EM | Zod 强制 |
| `payload.upload_id` 是 string、length>0 | EM | Schema 字段约束 |
| `payload.parsed.data` 是 object 不是 null | EM | Schema |
| `payload.salary_range` 格式 `\d+-\d+` | EM | Schema regex |
| 重复事件去重 | **委托 Inngest** | 用 `event.id` 当 idempotencyKey，Inngest 自带去重，EM 不再建 DedupCache |
| 客户/tenant 黑名单 | EM | Filter（启用时） |
| 入站事件来源审计 | EM | EventInstance.source |
| 事件因果链 | EM | EventInstance.caused_by_event_id |
| 失败回执（emit EVENT_REJECTED）| EM | 自动 |

### 3.2 EM 不做什么（留给 agent）

| 责任 | 落点 | 说明 |
|---|---|---|
| 候选人是否在公司黑名单 | agent | 业务规则，agent 查业务 DB |
| 该 JD 是否已关闭 | agent | 业务，agent 调 RAAS Internal API |
| 候选人简历是否已经匹配过这条 JD | agent | 业务幂等 |
| 该 recruiter 是否买了 RoboHire match license | agent | 业务 |
| RoboHire / RAAS Internal API 调用 | agent | 业务执行 |

**判定原则**：能从事件 payload + 静态规则就能判的 → EM；需要查业务 DB 或调外部 API 才能判的 → agent。

---

## 4. 实现形态选型

### 4.1 三种候选

| 形态 | 部署 | 校验时机 | 适用规模 |
|---|---|---|---|
| **A. 库（in-process SDK）** | `import { em } from '@em/sdk'` | 调用方进程内同步 | 早期，1-3 个 app |
| **B. Sidecar 服务** | 独立进程 `event-manager`，`POST :8080/publish` | 跨进程 HTTP | 多团队、多语言 SDK |
| **C. 库 + consume 侧 middleware** | A 的 publish 校验 + Inngest middleware 二次校验 | 双层 | A 到 B 的过渡 |

### 4.2 选 A（库形态）

**理由**：
1. 当前 publish 入口数有限（createJD / parser / matcher 内的 emit + raas-bridge + forwardToRaas），库形态完全够用
2. 最小工程量（一个本地 npm package 或 monorepo workspace）
3. 0 网络延迟，0 额外运维
4. 接口契约稳定（`em.publish` / `em.forward` / `em.validate`），实现可换 → 未来需要时升级到 sidecar 不改 caller

**代价**：
- AO-main 和 RPA 必须 import 同一份库（schemas 不能漂移）→ 见 §11.1 跨 app 同步策略
- 真出现绕过 EM 直接 `inngest.send` 的情况，库管不到 → 通过 lint / code review 强制

### 4.3 跨 app 共享 EM 库

三选一：

- **A1**: pnpm/npm workspace（推荐）— `packages/em` 共享给 AO-main + RPA + 未来 app
- **A2**: 私有 npm registry 发布 — 升级独立但要发版流程
- **A3**: dev 期 `npm link` symlink — 最快但易乱

**推荐 A1**。把仓库结构调整为 monorepo：

```
agenticOperator/
├── packages/
│   └── em/                        ← 新建
│       ├── src/
│       │   ├── index.ts           ← 公共 API
│       │   ├── schemas/           ← Zod 注册表
│       │   ├── filter.ts
│       │   ├── inngest-adapter.ts
│       │   └── persistence.ts
│       ├── package.json
│       └── tsconfig.json
├── server/                         ← AO-main，import @ao/em
├── resume-parser-agent/            ← RPA，import @ao/em
└── package.json (workspaces)
```

---

## 5. 事件流（6 个具体流）

### F1 — 入站成功 happy path

```
[B] raas-bridge poller 拉到 partner Inngest 上的 RESUME_DOWNLOADED envelope
       ↓
[C] em.publish("RESUME_DOWNLOADED", envelope, {
       source: "raas-bridge",
       external_event_id: envelope.event_id,
    })
       ├─ ① filter pass
       ├─ ② Zod RESUME_DOWNLOADED.safeParse → ok
       ├─ ③ INSERT EventInstance(status="accepted", ...)
       ├─ ④ inngest.send({
       │       id: envelope.event_id,            ← Inngest 用此去重
       │       name: "RESUME_DOWNLOADED",
       │       data: validated_envelope
       │   })
       └─ return { accepted: true, event_id }
       ↓
[D] Inngest fan-out
       ↓
[E] RPA.resumeParserAgent → 业务执行 → cascade emit RESUME_PROCESSED (见 F5)
```

### F2 — 入站 SCHEMA 失败 → 回执 RAAS

```
[B] raas-bridge 拿到一条字段缺失的 RESUME_DOWNLOADED（如缺 payload.upload_id）
       ↓
[C] em.publish(...)
       ├─ ① filter pass
       ├─ ② safeParse → ✗
       │      Zod errors: [{ path: ["payload","upload_id"], message: "Required" }]
       ├─ ③ INSERT EventInstance(status="rejected_schema", ...)
       ├─ ④ 不调 inngest.send 原事件
       ├─ ⑤ 自动派发回执:
       │   inngest.send({
       │     name: "EVENT_REJECTED",
       │     data: {
       │       entity_type: "EventRejection",
       │       event_id: <new uuid>,
       │       payload: {
       │         original_event_id: envelope.event_id,
       │         original_event_name: "RESUME_DOWNLOADED",
       │         original_source: "raas-bridge",
       │         rejection_type: "SCHEMA_VALIDATION_FAILED",
       │         rejection_reason: "payload.upload_id is required",
       │         schema_errors: [
       │           { path: "payload.upload_id", code: "required", message: "Required" }
       │         ],
       │         payload_sample: { /* 截短的原 payload */ },
       │         rejected_at: NOW(),
       │         ingester_id: "ao/em@v1",
       │         retry_guidance: "fix payload.upload_id and resend with same event_id"
       │       }
       │     }
       │   })
       └─ return { accepted: false, reason: "schema", errors }
       ↓
[D] Inngest fan-out EVENT_REJECTED
       ↓
[E] raas-backend.event-rejected-handler 订阅 EVENT_REJECTED →
    用 original_event_id 反查 outbox → 标记 status=NACKED → HSM 报警
    AO 自己 /events UI 也订阅，DLQ 子页展示
```

### F3 — 入站 FILTER 失败 → 回执

```
[C] em.publish("REQUIREMENT_LOGGED", envelope, ...)
       ├─ ① filter.check → ✗（client_id ∉ whitelist）
       ├─ ② 不验 schema
       ├─ ③ INSERT EventInstance(status="rejected_filter", ...)
       ├─ ④ inngest.send EVENT_REJECTED
       │      payload.rejection_type = "FILTER_REJECTED"
       │      payload.rejection_reason = "client_id={X} not in whitelist"
       └─ return { accepted: false, reason: "filter" }
```

### F4 — 入站重复 → 静默（不发回执）

```
[C] em.publish("RESUME_DOWNLOADED", envelope, ...)
       ├─ ① filter pass
       ├─ ② schema pass
       ├─ ③ EventInstance 检测到 external_event_id 已存在
       │      → return { accepted: false, reason: "duplicate" }
       ├─ ④ 不调 inngest.send
       └─ 不发 EVENT_REJECTED（重复不算错误）
```

> 设计选择：RAAS 重发说明它认为前一次失败了；如果第一次实际成功，第二次静默丢就是对的（RAAS 看到第一次的成功 ack 即可）。

### F5 — Agent 内部级联（agent → 总线 → 下一个 agent）

```
[E] resumeParserAgent (RPA) 跑完 RoboHire /parse-resume
       ↓ agent 内：
   await em.publish("RESUME_PROCESSED", outboundEnvelope, {
     source: "rpa.resumeParserAgent",
     causedBy: { event_id: <inbound>, name: "RESUME_DOWNLOADED" }
   })
       ↓
[C] EM 5 步全套（包括 EventInstance.caused_by_event_id 关联）
       ↓
[D] Inngest fan-out RESUME_PROCESSED
       ↓
[E] 订阅者：
    • RPA.matchResumeAgent (新)
    • AO-main.matchResumeAgent (老 ws/，过渡保留)
    • raas-backend.resume-processed-ingest（RAAS 入库 Candidate / Resume）
```

### F6 — 出站到外部（AO → RAAS subscriber）

```
[E] matchResumeAgent emit:
   await em.publish("MATCH_PASSED_NEED_INTERVIEW", payload, {
     source: "rpa.matchResumeAgent",
     causedBy: { event_id: <RESUME_PROCESSED>, name: "RESUME_PROCESSED" }
   })
       ↓
[C] EM 5 步 → inngest.send
       ↓
[D] Inngest fan-out
       ↓
[E] raas-backend.match-result-ingest-need-interview ← 已注册到本地 Inngest
                                                      （URL: 172.16.1.143:3001/api/inngest）
                                                      自动收到，无需 forward
```

> **关键**：本地 Inngest 已经能 dispatch 到 raas-backend 的 SDK URL。所以"AO emit → RAAS 收到"在物理上和 internal cascade 完全一样，**没有"out 边界"这层概念**。`em.forward` 只在 RAAS 想用它**自己另一套 Inngest 实例**接收时才需要。

---

## 6. 失败回执机制（EVENT_REJECTED）

### 6.1 触发条件

| 触发 | 是否发回执 |
|---|---|
| Schema validation 失败 | ✅ |
| Filter 拒绝 | ✅ |
| Duplicate（external_event_id 已存在）| ❌ 静默 |
| EM 内部 bug（如 EventInstance 写表失败）| ❌ 抛异常给调用方，不发回执（避免雪崩） |

### 6.2 EVENT_REJECTED 自身 Schema（hardcoded，不进 EventDefinition 注册表）

```ts
// EVENT_REJECTED 的 schema 必须最简最稳定，自己不依赖 EM 注册表
// 直接在 EM 库内 hardcode，不通过 EventDefinition 表查
const EVENT_REJECTED_SCHEMA = z.object({
  entity_type: z.literal("EventRejection"),
  entity_id: z.string().nullable(),
  event_id: z.string(),
  payload: z.object({
    original_event_id: z.string(),
    original_event_name: z.string(),
    original_source: z.string(),
    rejection_type: z.enum([
      "SCHEMA_VALIDATION_FAILED",
      "FILTER_REJECTED",
    ]),
    rejection_reason: z.string(),
    schema_errors: z.array(z.object({
      path: z.string(),
      code: z.string(),
      message: z.string(),
    })).optional(),
    payload_sample: z.record(z.unknown()).optional(),
    rejected_at: z.string(),
    ingester_id: z.string(),
    retry_guidance: z.string().optional(),
  }),
  trace: z.object({
    trace_id: z.string().nullable(),
    request_id: z.string().nullable(),
    workflow_id: z.string().nullable(),
    parent_trace_id: z.string().nullable(),
  }).optional(),
});
```

### 6.3 防递归

`EVENT_REJECTED` 的发布**不再走完整 5 步 EM**（避免 EVENT_REJECTED 失败时再发 EVENT_REJECTED 形成递归）。直接：

```
emit EVENT_REJECTED:
  ├─ 跳过 filter（EVENT_REJECTED 永远允许）
  ├─ 跳过 schema validate（用 hardcoded schema 在 EM 库代码里 lint 时校验，运行时直接 trust）
  ├─ INSERT EventInstance（status="meta_rejection"）
  └─ inngest.send（直接调，不 wrap）
```

### 6.4 RAAS 侧消费

RAAS 写一个 fn `event-rejected-handler` 订阅 `EVENT_REJECTED`：

```ts
inngest.createFunction(
  { id: "event-rejected-handler" },
  { event: "EVENT_REJECTED" },
  async ({ event }) => {
    const p = event.data.payload;
    // 用 original_event_id 找 outbox 行
    const outboxRow = await db.outbox.findUnique({
      where: { event_id: p.original_event_id },
    });
    if (!outboxRow) return { skipped: "outbox row not found" };

    await db.outbox.update({
      where: { id: outboxRow.id },
      data: {
        status: "NACKED",
        nack_reason: p.rejection_reason,
        nack_type: p.rejection_type,
        nack_errors: p.schema_errors,
        nack_at: new Date(),
      },
    });

    // 可选：通知 HSM dashboard / 邮件告警
    if (p.rejection_type === "SCHEMA_VALIDATION_FAILED") {
      await notifyOps(`AO rejected ${p.original_event_name}: ${p.rejection_reason}`);
    }
  }
);
```

---

## 7. 存储分工

### 7.1 各类数据归属

| 数据 | 存哪 | 理由 |
|---|---|---|
| Inngest 事件原文（payload 完整 JSON）| **Inngest 自带 SQLite**（Docker volume）| Inngest 本来就为这设计，append-only / time-series 友好 |
| Function run output / step output | **Inngest 自带 SQLite** | 同上 |
| Idempotency cache | **Inngest 自带** | 用 `event.id` 触发内置去重 |
| **EM EventInstance**（业务级流水）| **EM 自己的 DB**（Postgres 或 SQLite）| 频繁查询、过滤、UI 展示 |
| **EM EventDefinition**（schema 注册）| **Neo4j**（如果项目已用）| Schema 跟 Action / Rule 是同一张概念图 |
| **Event causality 图**（A 触发 B）| **EM EventInstance.caused_by_event_id**（self-FK）+ Neo4j 投影（可选）| SQL 起步够用，复杂 graph traversal 时投影到 Neo4j |
| **业务实体**（Candidate / Resume / JD / Match）| **RAAS DB** | RAAS 已决定，不动 |
| Agent 内部审计行（旧 AgentActivity）| 保留 AO-main Prisma SQLite，**RPA 不写**（用 Inngest run output 替代）| 渐进迁移 |

### 7.2 为什么事件原文不放 Neo4j

Neo4j 强项是**图遍历**。事件原文 JSON 存它里相当于把图数据库当文档库用，性能差且浪费。

Neo4j 的合理用法：
1. **EventDefinition schemas + 它们的 publisher/subscriber 关系**（节点 = 事件类型，边 = 谁发谁订）
2. **事件因果链投影**（A 事件触发 B agent 触发 C 事件）— 大规模时投影到 Neo4j 加速分析
3. **Action / ActionStep / Rule** 已经在 EM 仓库 rules-builder 里用上了 — 继续

事件**原文**：Inngest 自己存 + EM EventInstance 摘要存。**这两层都不该是 Neo4j**。

---

## 8. EM 库 API 契约

```ts
// @ao/em — 公共导出

export interface EventManager {
  /** Publish 一条事件（入站 or 内部 cascade 都用这个）*/
  publish<E extends EventName>(
    name: E,
    data: PayloadOf<E>,
    opts: {
      source: string;                    // "raas-bridge" / "rpa.matchResumeAgent" / ...
      external_event_id?: string;        // 入站：上游给的 id
      causedBy?: {                        // cascade：上游事件 id
        event_id: string;
        name: string;
      };
      emitRejectionOnFailure?: boolean;  // default true
      idempotencyKey?: string;           // default = external_event_id || generated UUID
    }
  ): Promise<PublishResult>;

  /** 显式向另一个 Inngest 实例转发（partner Inngest）*/
  forward<E extends EventName>(
    name: E,
    data: PayloadOf<E>,
    target: "partner",
    opts?: { idempotencyKey?: string }
  ): Promise<ForwardResult>;

  /** Consume 侧 belt-and-suspenders 校验（agent 在主流程前可选调）*/
  validate<E extends EventName>(
    name: E,
    data: unknown
  ): { ok: true; data: PayloadOf<E> }
   | { ok: false; errors: ZodIssue[] };
}

export type PublishResult =
  | { accepted: true; event_id: string }
  | {
      accepted: false;
      reason: "filter" | "schema" | "duplicate";
      details: unknown;
    };

export type ForwardResult =
  | { forwarded: true; status: number }
  | { forwarded: false; error: unknown };
```

### 8.1 `em.publish` 内部逻辑

```ts
async publish(name, data, opts) {
  // 1. Filter
  const filterResult = await this.filterCheck(name, data, opts);
  if (!filterResult.ok) {
    await this.persistRejection(name, data, opts, "filter", filterResult.reason);
    if (opts.emitRejectionOnFailure ?? true) {
      await this.emitRejection({
        original_event_name: name,
        rejection_type: "FILTER_REJECTED",
        rejection_reason: filterResult.reason,
        ...opts,
      });
    }
    return { accepted: false, reason: "filter", details: filterResult };
  }

  // 2. Schema validate
  const schemaResult = this.schemaValidate(name, data);
  if (!schemaResult.ok) {
    await this.persistRejection(name, data, opts, "schema", schemaResult.errors);
    if (opts.emitRejectionOnFailure ?? true) {
      await this.emitRejection({
        original_event_name: name,
        rejection_type: "SCHEMA_VALIDATION_FAILED",
        rejection_reason: this.summarizeZodErrors(schemaResult.errors),
        schema_errors: schemaResult.errors,
        ...opts,
      });
    }
    return { accepted: false, reason: "schema", details: schemaResult.errors };
  }

  // 3. Dedup check (against EventInstance.external_event_id)
  if (opts.external_event_id) {
    const existing = await this.findInstanceByExternalId(opts.external_event_id);
    if (existing) {
      // 静默不发 EVENT_REJECTED
      return { accepted: false, reason: "duplicate", details: existing.id };
    }
  }

  // 4. Persist EventInstance
  const eventId = randomUUID();
  await this.persistInstance({
    id: eventId,
    name,
    source: opts.source,
    external_event_id: opts.external_event_id,
    caused_by_event_id: opts.causedBy?.event_id,
    payload_summary: this.summarize(data),
    status: "accepted",
    ts: new Date(),
  });

  // 5. Inngest send (用 idempotencyKey 触发 Inngest 内置去重)
  const idempotencyKey =
    opts.idempotencyKey ?? opts.external_event_id ?? eventId;
  await this.inngestClient.send({
    id: idempotencyKey,
    name,
    data: schemaResult.data,
  });

  return { accepted: true, event_id: eventId };
}
```

---

## 9. 数据库 DDL（EM 库自管）

```sql
-- EventInstance: 业务级事件流水（每条 publish 一行）
CREATE TABLE event_instance (
  id                   TEXT PRIMARY KEY,             -- EM 分配的 uuid
  external_event_id    TEXT UNIQUE,                  -- 上游给的 id（入站时填）
  name                 TEXT NOT NULL,                -- "RESUME_DOWNLOADED" 等
  source               TEXT NOT NULL,                -- "raas-bridge" / "rpa.matchResumeAgent"
  status               TEXT NOT NULL,                -- "accepted" / "rejected_schema" / "rejected_filter" / "duplicate" / "meta_rejection"
  rejection_type       TEXT,                         -- 失败时填
  rejection_reason     TEXT,                         -- 失败时填
  schema_errors        TEXT,                         -- JSON: ZodIssue[]
  caused_by_event_id   TEXT,                         -- self-FK，cascade 关联
  payload_summary      TEXT,                         -- JSON 摘要（不存全文，全文在 Inngest）
  ts                   TIMESTAMP NOT NULL DEFAULT NOW(),

  FOREIGN KEY (caused_by_event_id) REFERENCES event_instance(id)
);

CREATE INDEX idx_event_instance_name_ts ON event_instance(name, ts DESC);
CREATE INDEX idx_event_instance_status ON event_instance(status) WHERE status != 'accepted';
CREATE INDEX idx_event_instance_caused_by ON event_instance(caused_by_event_id);
CREATE INDEX idx_event_instance_external ON event_instance(external_event_id);


-- EventDefinition: schema 注册表（可选，先用代码内 Zod 注册即可，等 UI 需要时再建表）
CREATE TABLE event_definition (
  name                 TEXT PRIMARY KEY,
  version              TEXT NOT NULL,
  schema_json          TEXT NOT NULL,                -- Zod schema 序列化
  publishers           TEXT,                         -- JSON: string[]
  subscribers          TEXT,                         -- JSON: string[]
  description          TEXT,
  retired_at           TIMESTAMP
);
```

> **注**：起步阶段 schema 直接写在 EM 库代码里（`packages/em/src/schemas/*.ts`）；EventDefinition 表是为了未来 Neo4j 同步 + UI 展示。先不建。

---

## 10. 业务校验留在 Agent

### 10.1 应该删掉的"agent 内 schema 检查代码"

例：当前 `match-resume-agent.ts` 的：

```ts
if (!uploadId) {
  throw new NonRetriableError(`missing upload_id ...`);
}
```

迁移后：**这种检查由 EM publish 侧拦截**，agent 拿到 event 时已经保证 `payload.upload_id` 是 string。删掉这行。

### 10.2 应该保留的"agent 内业务校验"

例：

```ts
// 业务校验：候选人在黑名单 → 不匹配
const blacklisted = await checkCandidateBlacklist(uploadId);
if (blacklisted) {
  await em.publish("MATCH_FAILED", { upload_id, reason: "blacklist" }, ...);
  return;
}

// 业务校验：JD 已关闭 → 跳过
const jd = await fetchJdFromRaas(jobRequisitionId);
if (jd.status === "closed") {
  await em.publish("MATCH_FAILED", { upload_id, job_requisition_id, reason: "jd-closed" }, ...);
  return;
}
```

这些不能搬到 EM。

### 10.3 关键区分：`MATCH_FAILED` vs `EVENT_REJECTED`

| | MATCH_FAILED | EVENT_REJECTED |
|---|---|---|
| 谁发 | Agent 业务规则判定 | EM 自动（schema/filter）|
| 含义 | 业务流程结果 — 简历没匹配上 | 事件结构本身错了 |
| 谁订阅 | RAAS 业务流（funnel 状态机）| RAAS outbox 处理（NACK 重发）|
| 频率 | 每条简历 × JD 都可能 | 仅协议错误时偶发 |

**不要把"missing parsed.data"从 MATCH_FAILED 改成 EVENT_REJECTED**：那是产品决策，不是清理。partner 的 funnel 状态依赖 MATCH_* 事件，把它降级成 DLQ 会让 partner 的 funnel 少一条记录。

---

## 11. 迁移计划（分阶段）

### Phase 1（最小可用，1-2 周）

**Goal**：所有 publish 都过 EM，schema 校验生效，EVENT_REJECTED 通路打通。

1. **建 monorepo workspace**：`packages/em/` 目录 + 根 `package.json` 配置 workspaces。AO-main 和 RPA 改成 workspace member。
2. **`packages/em/src/schemas/`** — 手写 6-8 个核心事件的 Zod schema：
   - `RESUME_DOWNLOADED`
   - `RESUME_PROCESSED`
   - `MATCH_PASSED_NEED_INTERVIEW`
   - `MATCH_PASSED_NO_INTERVIEW`
   - `MATCH_FAILED`
   - `REQUIREMENT_LOGGED`
   - `JD_GENERATED`
   - `EVENT_REJECTED`（hardcoded，不进注册表）
3. **`packages/em/src/index.ts`** 实现 `EventManager` 类 + `em.publish` 5 步逻辑。
4. **`packages/em/src/persistence.ts`** — 用 better-sqlite3 起步（最简单），单文件 DB `data/em.db`。Schema 见 §9。
5. **EM 库内不实现 filter**（先 noop pass-through），结构上预留接口。
6. **改造 publish 入口**（按依赖顺序）：
   - `server/inngest/raas-bridge.ts`：把 `inngest.send` 改成 `em.publish`
   - `server/ws/agents/create-jd.ts`、`server/ws/agents/match-resume.ts`：所有 `step.sendEvent` 改成 `await em.publish`
   - `resume-parser-agent/lib/inngest/agents/*`：同上
   - `resume-parser-agent/lib/inngest/functions/resume-parser-agent.ts`：同上
7. **改造 forward**：`server/inngest/raas-forward.ts` 改成 EM 库内的 `em.forward`，删除原文件。
8. **删除 agent 内 schema-shape 防御代码**（`if (!parsedData)` 那种）。**保留业务校验**。
9. **验证**：跑一遍 publish:test → 看 EventInstance 表写入正常 → 故意发坏 schema → 看 EVENT_REJECTED emit → 写一个临时 fn 订阅 EVENT_REJECTED 验证回执通路。

### Phase 2（UI + EventDefinition 表，2-4 周）

**Goal**：`/events` UI 用 EM 数据 + EventDefinition 表 + 失败回执的 RAAS 端 handler。

1. EM 加 `EventDefinition` 表 + 启动时 sync（从代码 schemas 序列化进表）
2. `/events` UI 加 "DLQ"、"Rejected"、"Causality" 三个子 tab，全部读 EventInstance
3. RAAS 那边写 `event-rejected-handler` fn，订阅 EVENT_REJECTED 更新 outbox
4. EM 加 admin API：`POST /em/replay/:event_id` → 重放历史事件（取自 EventInstance 摘要 + Inngest 全文 join）

### Phase 3（filter + Neo4j 同步，按需）

**Goal**：启用 gateway filter；EventDefinition 同步到 Neo4j；Event causality 投影。

1. 实现 `packages/em/src/filter.ts`（whitelist / blacklist / tenant rules）
2. EventDefinition cron sync 到 Neo4j（如果项目已用 Neo4j 做 Action / Rule）
3. Event causality（EventInstance.caused_by）每晚批量投影到 Neo4j 的 `(:Event)-[:CAUSED_BY]->(:Event)` 图

### Phase 4（升级到 sidecar 形态，远期）

**Goal**：当 EM 需要支持多语言 SDK / 跨团队时，把库换成 HTTP sidecar。

1. `packages/em/src/index.ts` 的实现换成 HTTP client，调用独立的 `event-manager` service
2. Service 端用 NestJS / Fastify 实现，schema 校验 + EventInstance 写库 + Inngest send 全部移到 service 内
3. **API 契约不变**（`em.publish` / `em.forward` / `em.validate` 同样的方法签名）
4. 各 caller 不用改代码，只换 import 实现

---

## 12. 待决策点（Open Questions）

| # | 问题 | 默认/推荐 | 决策人 |
|---|---|---|---|
| 1 | Phase 1 用 monorepo workspace 还是先 symlink/npm-link 凑合 | workspace（一次到位） | TBD |
| 2 | EM 持久化用 SQLite 还是 Postgres | 起步 SQLite（`data/em.db`），>10k events/day 时迁 Postgres | TBD |
| 3 | EVENT_REJECTED 是否对 RAAS 之外的订阅者可见 | 是（meta event 公开，AO 自己 UI 也订）| TBD |
| 4 | duplicate 入站时是否给 publisher 一个明确"我已收到过"的 ack | 现状静默；如果 RAAS 抱怨"看不到状态"再加 EVENT_DUPLICATE_ACK | TBD |
| 5 | Phase 1 是否同时实现 forward（partner Inngest 推送）| 否，因为 raas-backend 已经注册到本地 Inngest，不需要 | TBD |
| 6 | AO-main 老的 matchResumeAgent 是否也走 EM | 不走（Phase 1 不动 Resume Download 之后流程，按之前 spec 决议）| 已决 |
| 7 | EventDefinition 是手写还是从 Neo4j 同步 | Phase 1 手写；Phase 3 接 Neo4j | TBD |
| 8 | EventInstance 保留多久 | 90 天（与 Inngest 7 天 + 业务审计需求平衡）| TBD |

---

## 13. 风险与对策

| 风险 | 对策 |
|---|---|
| EM 库 bug 导致所有 publish 失败 | Phase 1 加全局 fallback：EM 异常时打 console.error + 直接 inngest.send 旁路（保业务流转，损失 EventInstance 审计）。Phase 2 关掉 fallback |
| `EVENT_REJECTED` 自身的 schema 漂移 | Hardcoded 在 EM 库代码里，**不进 EventDefinition 注册表**；变更走 EM 库 major 版本号 |
| AO-main 和 RPA 的 EM 库版本不一致 | monorepo workspace 强制用同一份 source；CI 检查 lockfile 一致 |
| RAAS 的 event-rejected-handler 不接 → 回执无人收 | EM 仍然写 EventInstance + emit 进总线，AO 自己 /events UI 总能看到 |
| 入站事件量大（>1k/s）拖慢 publish | Phase 2 用 Postgres + EventInstance 写改成 batch insert / async queue |
| Filter 规则配置错把合法事件全拒 | Filter 规则集中放配置文件，rule 命中要写入 RejectedMessage 表 + emit EVENT_REJECTED 至少有 audit 痕迹 |

---

## 附录 A — 端到端时间线（具体例子）

```
T+0ms     RAAS Console 用户上传简历 → MinIO PUT
T+50ms    RAAS Outbox 写入待发事件
T+100ms   RAAS Inngest publish RESUME_DOWNLOADED to partner Inngest

T+5s      raas-bridge.ts 轮询拿到事件
            ↓ em.publish("RESUME_DOWNLOADED", envelope, {source:"raas-bridge"})

T+5.01s   EM ① filter pass
T+5.02s   EM ② schema validate
            ↓ CASE A: 成功 / CASE B: 失败 → EVENT_REJECTED → RAAS NACK outbox

(CASE A)
T+5.03s   EM ③ INSERT EventInstance(status="accepted")
T+5.04s   EM ④ inngest.send (id = RAAS event_id)
T+5.05s   Inngest 接收 → SQLite 持久化 → idempotency check 通过 → fan-out

T+5.10s   Inngest dispatch:
          • RPA.resumeParserAgent

T+5.20s   resumeParserAgent fn started
T+5.30s   step.run("envelope-unwrap")
T+5.50s   step.run("minio-fetch") → PDF Buffer (300KB)
T+22.0s   step.run("robohire-parse") → 结构化 data
T+22.5s   agent 业务校验：parsed.data 非空 → 继续
T+22.6s   await em.publish("RESUME_PROCESSED", outboundEnvelope, {
            source: "rpa.resumeParserAgent",
            causedBy: { event_id: <RESUME_DOWNLOADED id>, name: "RESUME_DOWNLOADED" }
          })

T+22.7s   EM 5 步全过 → EventInstance(caused_by=...) → inngest.send
T+22.8s   Inngest fan-out RESUME_PROCESSED:
          • RPA.matchResumeAgent (新)
          • AO-main.matchResumeAgent (老 ws/，过渡)
          • raas-backend.resume-processed-ingest

T+22.9s   raas-backend 用 upload_id reverse-lookup → INSERT Candidate / Resume

T+23.0s   RPA.matchResumeAgent fn started
T+23.1s   step.run("list-requirements") → GET RAAS Internal API → N 条 JD
T+23.5s ~ T+45s  循环 N 次 RoboHire /match-resume
T+45.5s   每次匹配完：
            await em.publish("MATCH_PASSED_NEED_INTERVIEW", payload, {...})
T+45.6s   EM → inngest.send → fan-out

T+45.7s   raas-backend.match-result-ingest-need-interview → 更新 Candidate.match_score
T+ 46s    全链路完成
```

---

## 附录 B — EventInstance 因果链投影

```
EventInstance graph (用 caused_by_event_id 自连)

  ┌─────────────────────────────────────┐
  │ RESUME_DOWNLOADED                    │ ← raas-bridge 入
  │   external_event_id = RAAS-uuid      │
  │   caused_by_event_id = NULL          │
  └─────────┬───────────────────────────┘
            │
            ▼
  ┌─────────────────────────────────────┐
  │ RESUME_PROCESSED                     │ ← rpa.resumeParserAgent
  │   caused_by_event_id = <↑ id>        │
  └─────────┬───────────────────────────┘
            │
            ├──────────────────────┐
            ▼                      ▼
  ┌────────────────────┐  ┌────────────────────┐
  │ MATCH_PASSED_*     │  │ MATCH_PASSED_*     │
  │ (jd_1)             │  │ (jd_2)             │
  │ caused_by = <↑ id> │  │ caused_by = <↑ id> │
  └────────────────────┘  └────────────────────┘
```

失败链路：

```
  ┌─────────────────────────────────────┐
  │ RESUME_DOWNLOADED                    │
  │   status = "rejected_schema"         │
  └─────────┬───────────────────────────┘
            │
            ▼
  ┌─────────────────────────────────────┐
  │ EVENT_REJECTED                       │ ← EM 自动 emit
  │   caused_by_event_id = <↑ id>        │
  │   payload.original_event_id = ...    │
  │   payload.rejection_type = SCHEMA    │
  └─────────────────────────────────────┘
```

---

## 附录 C — 事件总览矩阵

| Event | Publisher | 入 EM？ | Inngest 订阅者 | 失败时是否发 EVENT_REJECTED |
|---|---|---|---|---|
| `REQUIREMENT_LOGGED` | RAAS dashboard → raas-bridge | ✅ | createJdAgent | ✅ |
| `JD_GENERATED` | createJdAgent | ✅ | raas-backend.jd-generated-sync | ✅ |
| `RESUME_DOWNLOADED` | RAAS upload → raas-bridge | ✅ | resumeParserAgent | ✅ |
| `RESUME_PROCESSED` | resumeParserAgent | ✅ | matchResumeAgent (新) + matchResumeAgent (老 AO-main) + raas-backend.resume-processed-ingest | ✅ |
| `MATCH_PASSED_NEED_INTERVIEW` | matchResumeAgent (新) | ✅ | raas-backend.match-result-ingest-need-interview | ✅ |
| `MATCH_PASSED_NEED_INTERVIEW` | matchResumeAgent (老 AO-main) | 🟡 Phase 1 不接 EM | 同上 | N/A（不接 EM）|
| `MATCH_PASSED_NO_INTERVIEW` | matchResumeAgent | ✅ | raas-backend | ✅ |
| `MATCH_FAILED` | matchResumeAgent | ✅ | raas-backend | ✅ |
| `JD_REJECTED` | createJdAgent (业务拒) | ✅ | createJdAgent (重试)+ raas | ✅ |
| `CLARIFICATION_READY` | (未实现) | ✅ | createJdAgent | ✅ |
| `EVENT_REJECTED` | EM 自动 | ⚠️ 跳过 EM 5 步 | raas-backend.event-rejected-handler + AO /events UI | ❌（防递归）|

---

**END OF SPEC**
