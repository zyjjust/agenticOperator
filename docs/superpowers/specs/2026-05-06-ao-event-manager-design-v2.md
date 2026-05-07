# AO Event Manager 设计 v2

| | |
|---|---|
| 日期 | 2026-05-06 |
| 状态 | Draft v2（supersedes v1） |
| 作者 | Yuhan + Claude |
| Scope | AO 主仓 + resume-parser-agent；所有出入站事件统一经过 Event Manager（库形态） |
| 前置 | [v1 spec](2026-05-06-ao-event-manager-design.md), [event-flow-deep-dive.md](../../event-flow-deep-dive.md), [raas-alignment-payloads.md](../../raas-alignment-payloads.md) |

---

## 0. v2 相对 v1 的变化

### 0.1 完全继承 v1 的核心决策

- **库形态**：`em.publish()` 显式调用，不走 Inngest middleware
- **`EVENT_REJECTED` 元事件**作为失败回执通路（替代被动 DLQ 表）
- **去重委托 Inngest** `event.id` idempotency（不建 DedupCache）
- **不存在"出站边界"**：RAAS 注册到本地 Inngest，下游订阅即收
- **monorepo workspace**：`packages/em` 由 AO-main + RPA 共享
- **业务校验留 agent，schema 校验留 EM**

### 0.2 v2 新增 / 强化

| 主题 | v1 状态 | v2 决策 |
|---|---|---|
| Schema 来源 | Phase 1 hardcode in code，Phase 3 接 Neo4j | **Phase 1 同时启动 Neo4j read-only sync**（解决"Neo4j 更新 AO 不知道"原始痛点） |
| Schema 版本化 | 未涉及 | **`em.publish` 支持多版本 try-parse**；`EventInstance.schema_version_used` 字段 |
| HITL ↔ Event 关联 | 未涉及 | **`HitlTask.triggering_event_instance_id` 强制字段** |
| EM 降级模式 | §13 风险一行带过 | **专章 §14**：counter + system_status 表 + AppBar 指示灯 + `/events` SubHeader KPI |
| Causality UI 落点 | Phase 2 笼统提"Causality 子 tab" | **§13 钉死两处**：单事件详情右栏（局部）+ `/correlations/:traceId`（全局） |
| Filter 规则存储 | §13 风险行说"放配置文件" | **改为 DB 表 `gateway_filter_rule`**，Phase 3 从一开始就让 `/triggers` UI 可编辑 |
| 持久化引擎 | §12 Q2 SQLite vs Postgres 待定 | **Postgres 起步**（24 ATS × ~1.5k events/day = 36k/day，180 天保留压力大） |
| 保留期 | §12 Q8 90 天 | **180 天**（合规报告按季度，90 天切到边缘） |
| 其他 Q | Q1/Q3/Q4/Q7 待定 | **§16 全部钉死** |

---

## 1. 背景与目标

### 1.1 现状

AO 现有事件流转分散：

- **AO-main** ([server/inngest/client.ts](../../../server/inngest/client.ts), [server/ws/agents/*](../../../server/ws/agents/)) 直接 `inngest.send`，无 schema 校验，靠 agent 内 `if (!data) throw` 保平安
- **resume-parser-agent (RPA)** 同样直接 `inngest.send`，靠 TS 类型 + 运行时手写防御
- **raas-bridge** ([server/inngest/raas-bridge.ts](../../../server/inngest/raas-bridge.ts)) 从 partner Inngest 拉事件后直接 `inngest.send`，**无任何拦截层**
- **forwardToRaas** ([server/inngest/raas-forward.ts](../../../server/inngest/raas-forward.ts)) agent 内显式 POST 到 partner Inngest

后果：

1. 同一份 schema 校验逻辑在不同 agent 内重复（必然漂移）
2. RAAS 发不合规事件，AO 要么忽略要么 agent 失败，**无回执机制告诉 RAAS 它的事件被拒了**
3. 无统一"事件流水"视图（`/events` UI 现在只能读 Inngest 数据）
4. 跨 app 共享事件契约靠手抄（AO-main 和 RPA 各自定义 ResumeProcessedData，已不一致）
5. **Neo4j 上 EventDefinition 更新，AO 完全感知不到**（v1 spec 没解决，v2 提前到 Phase 1）

### 1.2 目标

引入 **Event Manager (EM)** 作为 AO 仓库内的**库形态中央闸门**。所有事件 publish 必须通过 EM。EM 负责：

1. **统一 schema 校验** — 单一注册表（Phase 1 起即从 Neo4j 同步 + 代码内 fallback）
2. **多版本 schema 兼容** — RAAS 灰度升级时 v1/v2 并存
3. **Filter 拦截** — gateway whitelist / blacklist / tenant scope（Phase 3，DB 表存储）
4. **业务事件流水持久化** — `EventInstance` 表，UI 主数据源
5. **失败回执** — schema/filter 失败自动 emit `EVENT_REJECTED` 元事件，RAAS 订阅拿 NACK
6. **去重** — 委托 Inngest 内置 idempotency，**EM 不自建 dedup 表**
7. **降级可见** — EM 异常 fallback 时 UI 必须可感知

### 1.3 非目标

- ❌ 替代 Inngest（Inngest 仍是事件总线 + 持久化引擎 + retry/step 引擎）
- ❌ 业务规则校验（黑名单、license 检查、closed JD 仍在 agent 内）
- ❌ 取代 RAAS DB 的业务实体存储
- ❌ Phase 1 即立刻建独立 sidecar 服务（先库形态，多语言 SDK 时再升）
- ❌ AO 端编辑事件定义（沿用 AO-INT-P3 Q1 决议：no Editor）

---

## 2. 架构总览

```
═══════════════════════════════════════════════════════════════════════════════
[A] 外部源
═══════════════════════════════════════════════════════════════════════════════
   RAAS Dashboard      RAAS MinIO        Partner Inngest    Other 3rd-party
   (REQUIREMENT_       (RESUME_           (ANY)
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
   (DB 规则)          (multi-version try-parse)   (audit / UI 主数据源)
       │ ✗                     │ ✗                        │
       ▼                       ▼                          │
  emit EVENT_REJECTED      emit EVENT_REJECTED            │
  (reason: filter)         (reason: schema, errors:[])    │
                                                          ▼
                                                ④ inngest.send({
                                                     id: idempotencyKey,
                                                     name, data
                                                  })
       ↘────────── 异常 fallback ────────↗
                  写 system_status + UI 灯
                  直接旁路 inngest.send（保业务流转）

═══════════════════════════════════════════════════════════════════════════════
[D] INNGEST BUS  (Docker container `ao-inngest`, port 8288)
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
   Inngest SQLite       EM Postgres          RAAS DB        Neo4j
   (ao-inngest vol)     (data/em.pg)          (RAAS 自管)    (graph 关系)

   • 事件原文            • EventInstance      • Candidate    • EventDefinition
   • function runs       • EventDefinition    • Resume        schema 主册（同步源）
   • step outputs        • SystemStatus        • JD            • Event causality（投影）
   • idempotency cache   • GatewayFilterRule   • Match         • Action/Rule (已有)

[G] SYNC WORKER (Phase 1 起)
═══════════════════════════════════════════════════════════════════════════════
   Neo4j (truth)  ─── 5 min cron ───>  EventDefinition (Postgres, AO 本地)
                                              │
                                              ▼
                                        em.publish 优先查表，未命中 fallback 代码 hardcode
```

---

## 3. EM 职责边界

### 3.1 EM 做什么

| 责任 | 落点 | 说明 |
|---|---|---|
| envelope shape 必填字段（entity_id / event_id / trace 等） | EM | Zod 强制 |
| `payload.upload_id` 是 string、length>0 | EM | Schema |
| `payload.parsed.data` 是 object 不是 null | EM | Schema |
| `payload.salary_range` 格式 `\d+-\d+` | EM | Schema regex |
| 多版本 schema 兼容（v1/v2 并存）| EM | tryParse 数组 |
| 重复事件去重 | **委托 Inngest** | 用 `event.id` 当 idempotencyKey |
| 客户/tenant 黑白名单 | EM | Filter 规则（Phase 3） |
| 入站事件来源审计 | EM | EventInstance.source |
| 事件因果链 | EM | EventInstance.caused_by_event_id |
| 失败回执（emit `EVENT_REJECTED`）| EM | 自动 |
| **降级状态可见**（fallback / 异常计数）| EM | SystemStatus 表 + UI 信号 |

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

## 4. 实现形态：库（in-process SDK）

### 4.1 选型理由

继承 v1 §4 决策：库形态，monorepo workspace。

```
agenticOperator/
├── packages/
│   └── em/                        ← 新建
│       ├── src/
│       │   ├── index.ts           ← 公共 API（EventManager class + 全局实例）
│       │   ├── schemas/           ← Zod 注册表（hardcode + 多版本支持）
│       │   ├── registry/          ← schema 查找：先表后代码
│       │   ├── filter.ts          ← Phase 3
│       │   ├── persistence.ts     ← Postgres via Prisma
│       │   ├── inngest-adapter.ts
│       │   ├── neo4j-sync.ts      ← Phase 1 read-only sync worker
│       │   ├── degraded-mode.ts   ← fallback 计数 + system_status
│       │   └── rejection.ts       ← EVENT_REJECTED hardcoded schema + emit
│       ├── package.json
│       └── tsconfig.json
├── server/                         ← AO-main，import @ao/em
├── resume-parser-agent/            ← RPA，import @ao/em
└── package.json (workspaces)
```

### 4.2 共享方式

**npm workspaces**（v1 决策的 A1 选项）。CI 检查 lockfile 一致防止漂移。

---

## 5. 事件流（6 个具体流）

继承 v1 §5 全部 6 个流（F1-F6）。略，参考 [v1 §5](2026-05-06-ao-event-manager-design.md#5-事件流6-个具体流)。

v2 增量补充：

### 5.7 F7 — Schema 多版本兼容（RAAS 灰度升级期）

```
[Context] AO 已升级 RESUME_PROCESSED 到 v2（多 jd fan-out 字段重构）
          RAAS 仍在发 v1
        ↓
[B] raas-bridge 拿到 v1 RESUME_PROCESSED
        ↓
[C] em.publish("RESUME_PROCESSED", envelope, {...})
       ├─ ① filter pass
       ├─ ② multi-version tryParse:
       │      try v2.safeParse → ✗
       │      try v1.safeParse → ✓
       │      schema_version_used = "1.0"
       ├─ ③ INSERT EventInstance(status="accepted", schema_version_used="1.0")
       └─ ④ inngest.send（payload 标准化为 v2 形态后再投递；agent 永远只看 v2）
```

**关键**：
- v1 → v2 升级期，**publisher 端不用一刀切**
- `schema_version_used` 字段让运营能看到"今天还有多少 v1 流量，能不能下架 v1"
- 当 `count(schema_version_used="1.0") = 0 持续 7 天` → 下架 v1 schema

---

## 6. 失败回执机制（EVENT_REJECTED）

继承 v1 §6 全部内容。略。

---

## 7. 存储分工

### 7.1 各类数据归属（v2 修订）

| 数据 | 存哪 | 理由 |
|---|---|---|
| Inngest 事件原文（payload 完整 JSON）| **Inngest 自带 SQLite**（Docker volume）| append-only 友好 |
| Function run output / step output | **Inngest 自带 SQLite** | 同上 |
| Idempotency cache | **Inngest 自带** | 用 `event.id` 触发内置去重 |
| **EM EventInstance**（业务级流水）| **EM Postgres**（`data/em.pg`，v2 改）| 频繁查询、过滤、UI 展示；24 ATS × 1.5k/day = 36k/day × 180 天保留 = 6.5M 行，SQLite 边缘 |
| **EM EventDefinition**（schema 注册）| **EM Postgres** + Neo4j 双写（Neo4j 主，AO 同步）| AO 本地 Postgres 是查询用副本；Neo4j 是真相 |
| **GatewayFilterRule**（filter 规则）| **EM Postgres** | 让 `/triggers` UI 可编辑（v2 修订，原 v1 §13 提"放配置文件"撤回） |
| **SystemStatus**（EM 健康度）| **EM Postgres** | 降级模式信号源 |
| **Event causality 图**（A 触发 B）| **EventInstance.caused_by_event_id**（self-FK）+ Neo4j 投影（Phase 3） | SQL 起步够用 |
| **业务实体**（Candidate / Resume / JD / Match）| **RAAS DB** | 不动 |
| Agent 内部审计行（旧 AgentActivity）| 保留 AO-main Prisma SQLite | 渐进迁移 |

### 7.2 为什么 Postgres 不再 SQLite

v1 §12 Q2 留作 open question，v2 钉死 **Postgres**：

- 24 ATS × ~1.5k events/day × 180 天 ≈ **6.5M rows**
- EventInstance 表常用查询是 `(name, ts DESC)` 范围扫描 — SQLite 在 multi-GB 上写并发 + 索引重建慢
- 已有 PostgreSQL 实例（Aurora，见 `/datasources` 数据源清单）
- Phase 1 用 Prisma 切换 datasource 几行配置；Phase 3+ 切回成本高
- **代价**：dev 环境多一个 docker 服务（已经有 inngest docker 了，无新增运维概念）

### 7.3 Neo4j 用法

继承 v1 §7.2 决策：

1. **EventDefinition schemas + 它们的 publisher/subscriber 关系**（节点 = 事件类型，边 = 谁发谁订）
2. **事件因果链投影**（A 事件触发 B agent 触发 C 事件）— Phase 3 起每晚批量
3. **Action / ActionStep / Rule** 沿用 EM 仓库 rules-builder

事件**原文**仍在 Inngest + EventInstance 摘要。**Neo4j 不是文档库**。

---

## 8. EM 库 API 契约

### 8.1 公共 API（v2 修订：加多版本 schema）

```ts
// @ao/em — 公共导出

export interface EventManager {
  /** Publish 一条事件（入站 or 内部 cascade 都用这个）*/
  publish<E extends EventName>(
    name: E,
    data: PayloadOf<E>,
    opts: {
      source: string;                    // "raas-bridge" / "rpa.matchResumeAgent"
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
  ): { ok: true; data: PayloadOf<E>; schema_version: string }
   | { ok: false; errors: ZodIssue[]; tried_versions: string[] };
}

export type PublishResult =
  | { accepted: true; event_id: string; schema_version_used: string }  // v2 加字段
  | {
      accepted: false;
      reason: "filter" | "schema" | "duplicate" | "em_degraded";        // v2 加 em_degraded
      details: unknown;
    };

export type ForwardResult =
  | { forwarded: true; status: number }
  | { forwarded: false; error: unknown };
```

### 8.2 `em.publish` 内部逻辑（v2 修订）

```ts
async publish(name, data, opts) {
  // 0. EM 自检（v2 新增）— 如果库本身已知降级，跳过 1-3 步直接 inngest.send 旁路
  if (this.degradedMode.isActive()) {
    this.degradedMode.incrementCounter("publish_during_degraded");
    await this.inngestClient.send({
      id: opts.idempotencyKey ?? opts.external_event_id ?? randomUUID(),
      name,
      data,
    });
    return { accepted: false, reason: "em_degraded", details: this.degradedMode.lastError() };
  }

  try {
    // 1. Filter (Phase 3，Phase 1 noop pass-through)
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

    // 2. Schema validate (multi-version, v2 修订)
    const schemaResult = this.tryParseMultiVersion(name, data);
    if (!schemaResult.ok) {
      await this.persistRejection(name, data, opts, "schema", schemaResult.errors);
      if (opts.emitRejectionOnFailure ?? true) {
        await this.emitRejection({
          original_event_name: name,
          rejection_type: "SCHEMA_VALIDATION_FAILED",
          rejection_reason: this.summarizeZodErrors(schemaResult.errors),
          schema_errors: schemaResult.errors,
          tried_versions: schemaResult.tried_versions,
          ...opts,
        });
      }
      return { accepted: false, reason: "schema", details: schemaResult.errors };
    }

    // 3. Dedup check (against EventInstance.external_event_id)
    if (opts.external_event_id) {
      const existing = await this.findInstanceByExternalId(opts.external_event_id);
      if (existing) {
        return { accepted: false, reason: "duplicate", details: existing.id };
      }
    }

    // 4. Persist EventInstance (v2 加 schema_version_used)
    const eventId = randomUUID();
    await this.persistInstance({
      id: eventId,
      name,
      source: opts.source,
      external_event_id: opts.external_event_id,
      caused_by_event_id: opts.causedBy?.event_id,
      payload_summary: this.summarize(schemaResult.data),
      schema_version_used: schemaResult.schema_version,
      status: "accepted",
      ts: new Date(),
    });

    // 5. Inngest send (用 idempotencyKey 触发 Inngest 内置去重)
    const idempotencyKey =
      opts.idempotencyKey ?? opts.external_event_id ?? eventId;
    await this.inngestClient.send({
      id: idempotencyKey,
      name,
      data: schemaResult.data,        // 标准化后投递（v1 → v2 自动升级）
    });

    return { accepted: true, event_id: eventId, schema_version_used: schemaResult.schema_version };
  } catch (err) {
    // EM 内部异常 → 进入降级模式 + fallback (v2 新增)
    this.degradedMode.activate(err);
    await this.inngestClient.send({
      id: opts.idempotencyKey ?? opts.external_event_id ?? randomUUID(),
      name,
      data,
    });
    return { accepted: false, reason: "em_degraded", details: err };
  }
}
```

### 8.3 多版本 try-parse（v2 新增）

```ts
private tryParseMultiVersion(name: EventName, data: unknown):
  | { ok: true; data: any; schema_version: string }
  | { ok: false; errors: ZodIssue[]; tried_versions: string[] }
{
  // 从注册表（先表后代码 hardcode）拿这个事件名的所有 active schema
  // 按 version 降序（最新优先）
  const candidates = this.registry.activeVersionsOf(name);
  if (candidates.length === 0) {
    return { ok: false, errors: [{ message: `no schema for ${name}` }], tried_versions: [] };
  }

  const tried: string[] = [];
  let lastErr: ZodIssue[] | null = null;
  for (const { version, schema, normalize } of candidates) {
    tried.push(version);
    const r = schema.safeParse(data);
    if (r.success) {
      // normalize 把旧版本转成最新版本的字段布局（agent 永远只看最新）
      const normalized = normalize ? normalize(r.data) : r.data;
      return { ok: true, data: normalized, schema_version: version };
    }
    lastErr = r.error.issues;
  }
  return { ok: false, errors: lastErr ?? [], tried_versions: tried };
}
```

注册示例：

```ts
// packages/em/src/schemas/resume-processed.ts
export const RESUME_PROCESSED = {
  name: "RESUME_PROCESSED",
  versions: [
    {
      version: "2.0",
      schema: z.object({ /* v2 shape */ }),
      // v2 是当前版本，没 normalize
    },
    {
      version: "1.0",
      schema: z.object({ /* v1 shape */ }),
      normalize: (v1Data) => mapV1ToV2(v1Data),
    },
  ],
};
```

---

## 9. 数据库 DDL（EM 库自管，v2 修订）

```sql
-- EventInstance: 业务级事件流水（每条 publish 一行）
CREATE TABLE event_instance (
  id                   TEXT PRIMARY KEY,             -- EM 分配的 uuid
  external_event_id    TEXT UNIQUE,                  -- 上游给的 id（入站时填）
  name                 TEXT NOT NULL,                -- "RESUME_DOWNLOADED"
  source               TEXT NOT NULL,                -- "raas-bridge" / "rpa.matchResumeAgent"
  status               TEXT NOT NULL,                -- "accepted" | "rejected_schema" | "rejected_filter" | "duplicate" | "meta_rejection" | "em_degraded"
  rejection_type       TEXT,                         -- 失败时填
  rejection_reason     TEXT,                         -- 失败时填
  schema_errors        JSONB,                        -- ZodIssue[] (v2: Postgres jsonb)
  schema_version_used  TEXT,                         -- v2 新增："1.0" | "2.0"
  caused_by_event_id   TEXT REFERENCES event_instance(id),  -- self-FK，cascade 关联
  payload_summary      JSONB,                        -- 摘要（不存全文，全文在 Inngest）
  ts                   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_event_instance_name_ts ON event_instance(name, ts DESC);
CREATE INDEX idx_event_instance_status ON event_instance(status) WHERE status != 'accepted';
CREATE INDEX idx_event_instance_caused_by ON event_instance(caused_by_event_id);
CREATE INDEX idx_event_instance_external ON event_instance(external_event_id);
CREATE INDEX idx_event_instance_schema_version ON event_instance(name, schema_version_used);  -- v2 新增

-- EventDefinition: schema 注册表
-- Phase 1 起即建表，Neo4j sync worker 喂数据；EM 库代码 hardcode 作为 fallback
CREATE TABLE event_definition (
  name                 TEXT PRIMARY KEY,
  active_versions      JSONB NOT NULL,               -- ["2.0", "1.0"] 按 version 降序
  schemas_by_version   JSONB NOT NULL,               -- { "2.0": <zod-jsonschema>, "1.0": ... }
  publishers           JSONB,                         -- string[]
  subscribers          JSONB,                         -- string[]
  description          TEXT,
  source               TEXT NOT NULL DEFAULT 'neo4j',-- 'neo4j' | 'hardcoded'
  synced_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retired_at           TIMESTAMPTZ
);

-- GatewayFilterRule: filter 规则 (v2 修订：从 config file 改为 DB 表，Phase 3 启用)
CREATE TABLE gateway_filter_rule (
  id                   TEXT PRIMARY KEY,
  rule_type            TEXT NOT NULL,                -- 'whitelist' | 'blacklist' | 'rename_map'
  event_name_pattern   TEXT NOT NULL,                -- "RESUME_*" 等通配
  client_id_pattern    TEXT,                         -- 可空：匹配 envelope.entity_id
  target_event_name    TEXT,                         -- rule_type='rename_map' 时
  enabled              BOOLEAN NOT NULL DEFAULT TRUE,
  description          TEXT,
  created_by           TEXT NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_gateway_filter_event ON gateway_filter_rule(event_name_pattern, enabled);

-- SystemStatus: EM 健康度信号（v2 新增）
CREATE TABLE em_system_status (
  id                   TEXT PRIMARY KEY DEFAULT 'singleton',  -- 单行
  state                TEXT NOT NULL DEFAULT 'healthy',       -- 'healthy' | 'degraded' | 'down'
  degraded_since       TIMESTAMPTZ,
  last_error           TEXT,
  last_error_at        TIMESTAMPTZ,
  fallback_count_1h    INT NOT NULL DEFAULT 0,                -- 滑窗 1 小时
  fallback_count_24h   INT NOT NULL DEFAULT 0,                -- 滑窗 24 小时
  publish_count_1h     INT NOT NULL DEFAULT 0,
  reject_count_1h      INT NOT NULL DEFAULT 0,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO em_system_status(id) VALUES ('singleton') ON CONFLICT DO NOTHING;
```

---

## 10. 业务校验留在 Agent

继承 v1 §10 全部内容。

### 10.4 v2 强化：HITL 任务必须带 EventInstance 关联

**HitlTask schema 强制字段**：

```prisma
// AO Prisma — 已有 HitlTask 表；v2 加一字段
model HitlTask {
  // ... 现有字段
  triggeringEventInstanceId String?   // v2 新增 — agent 创建 HITL 时必须传
  triggeringEventName       String?   // 冗余但便于查询

  @@index([triggeringEventInstanceId])
}
```

agent 创建 HITL 任务时：

```ts
// 业务规则判定需要人审 → 创建 HITL
await prisma.hitlTask.create({
  data: {
    title: "推荐包人工复核",
    triggeringEventInstanceId: event.data.event_id,    // 强制关联
    triggeringEventName: "PACKAGE_GENERATED",
    correlationId: event.data.trace?.trace_id ?? null,
    // ...
  },
});
```

UI 落点：[components/inbox/InboxContent.tsx](../../../components/inbox/InboxContent.tsx) 任务卡片底部加一行链接 `→ EVENT_X (evt_abc123)`，点击跳到事件实例 trail 页。

---

## 11. Schema 来源与版本化（v2 新增专章）

### 11.1 三层来源

```
[Layer 1] Neo4j (truth)          ← 业务团队在 EM 仓库 rules-builder UI 编辑
       │ 5 min cron
       ▼
[Layer 2] EventDefinition 表      ← AO 本地 Postgres 副本
       │ em.publish 查询
       ▼
[Layer 3] 代码 hardcode schemas   ← packages/em/src/schemas/*.ts，fallback
       │ Layer 1/2 都未命中时使用
       ▼
   tryParse multi-version
```

### 11.2 sync worker 实现

```ts
// packages/em/src/neo4j-sync.ts
import { neo4jDriver } from "./clients/neo4j";

export async function syncEventDefinitionsFromNeo4j(): Promise<{ upserted: number; errors: number }> {
  const session = neo4jDriver.session();
  try {
    const result = await session.run(`
      MATCH (e:EventDefinition)
      OPTIONAL MATCH (e)<-[:PUBLISHES]-(p)
      OPTIONAL MATCH (e)<-[:SUBSCRIBES]-(s)
      RETURN e.name AS name,
             e.active_versions AS active_versions,
             e.schemas_by_version AS schemas_by_version,
             collect(DISTINCT p.name) AS publishers,
             collect(DISTINCT s.name) AS subscribers,
             e.description AS description
    `);
    let upserted = 0;
    for (const record of result.records) {
      await prisma.eventDefinition.upsert({
        where: { name: record.get("name") },
        create: {
          name: record.get("name"),
          activeVersions: record.get("active_versions"),
          schemasByVersion: record.get("schemas_by_version"),
          publishers: record.get("publishers"),
          subscribers: record.get("subscribers"),
          description: record.get("description"),
          source: "neo4j",
        },
        update: {
          activeVersions: record.get("active_versions"),
          schemasByVersion: record.get("schemas_by_version"),
          publishers: record.get("publishers"),
          subscribers: record.get("subscribers"),
          description: record.get("description"),
          syncedAt: new Date(),
        },
      });
      upserted++;
    }
    return { upserted, errors: 0 };
  } finally {
    await session.close();
  }
}

// boot.ts
export function startNeo4jSync(): void {
  if (process.env.NEO4J_SYNC_ENABLED !== "1") {
    console.log("[em-sync] disabled (set NEO4J_SYNC_ENABLED=1)");
    return;
  }
  // 启动时跑一次（保 cold start 立即可用）
  syncEventDefinitionsFromNeo4j()
    .then((r) => console.log(`[em-sync] initial: upserted=${r.upserted} errors=${r.errors}`))
    .catch((e) => console.error("[em-sync] initial failed:", e));
  // 5 分钟 cron
  setInterval(() => {
    syncEventDefinitionsFromNeo4j()
      .then((r) => r.upserted > 0 && console.log(`[em-sync] tick: upserted=${r.upserted}`))
      .catch((e) => console.error("[em-sync] tick failed:", e));
  }, 5 * 60 * 1000);
}
```

注入：[server/init.ts](../../../server/init.ts) 的 `bootOnce()` 调用 `startNeo4jSync()`。

### 11.3 注册表查询优先级

```ts
// packages/em/src/registry/index.ts
async activeVersionsOf(name: EventName): Promise<SchemaVersion[]> {
  // 1. 优先 EventDefinition 表（Neo4j 同步过来）
  const dbRow = await prisma.eventDefinition.findUnique({ where: { name } });
  if (dbRow && dbRow.activeVersions.length > 0) {
    return dbRow.activeVersions.map((v) => ({
      version: v,
      schema: zodFromJsonSchema(dbRow.schemasByVersion[v]),
      normalize: this.codeRegistry.normalizerFor(name, v),  // normalize 函数仍在代码里
    }));
  }
  // 2. fallback 代码 hardcode
  return this.codeRegistry.activeVersionsOf(name);
}
```

**关键设计**：`normalize` 函数（v1→v2 转换器）**始终在代码里**，因为它是行为不是数据。Schema 是数据可以同步，转换函数是代码必须 PR。

### 11.4 schema 退役流程

```
Day 0   Neo4j 上把 v1 标 retired_at = NOW()，但保留 schema
Day 1+  AO 同步后 EventDefinition.active_versions 仍含 "1.0"
        em.publish 仍然接受 v1 → 标记 schema_version_used = "1.0"
Day 7   运营查 SELECT count(*) WHERE schema_version_used = "1.0" AND ts > NOW() - 7d
        如果 == 0 → Neo4j 上 retired_at 改 hard：从 active_versions 删除 "1.0"
Day 7+  AO 同步后再发 v1 → schema mismatch → EVENT_REJECTED
```

---

## 12. EM 降级模式（v2 新增专章）

### 12.1 何时进入降级

- `em.publish` 主流程异常（DB 写失败、Inngest 不可达、注册表查询超时）
- `degraded_count_in_window > THRESHOLD` 时锁定降级状态
- 通过 `/api/em/health` 探测恢复后退出降级

### 12.2 降级行为

```ts
class DegradedMode {
  private state: "healthy" | "degraded" = "healthy";
  private lastError: Error | null = null;
  private fallbackCount = 0;

  activate(err: Error): void {
    this.state = "degraded";
    this.lastError = err;
    this.fallbackCount++;
    void this.persist();
  }

  isActive(): boolean { return this.state === "degraded"; }

  async recover(): Promise<void> {
    // 由 /api/em/health 探活成功后调用
    const ok = await this.selfTest();
    if (ok) {
      this.state = "healthy";
      this.lastError = null;
      await this.persist();
    }
  }

  private async persist(): Promise<void> {
    await prisma.emSystemStatus.update({
      where: { id: "singleton" },
      data: {
        state: this.state,
        degradedSince: this.state === "degraded" ? new Date() : null,
        lastError: this.lastError?.message,
        lastErrorAt: this.lastError ? new Date() : null,
        fallbackCount24h: { increment: 1 },
        updatedAt: new Date(),
      },
    });
  }
}
```

### 12.3 UI 信号（必须三处可见）

| UI 位置 | 信号 |
|---|---|
| AppBar 全局连接点（[components/shared/AppBar.tsx](../../../components/shared/AppBar.tsx)）| 右上角 dot：绿（healthy）/ 橘（degraded < 30min）/ 红（degraded > 30min 或 down）|
| `/events` SubHeader KPI ([components/events/EventsContent.tsx](../../../components/events/EventsContent.tsx)) | 多一格 `EM accepted / rejected / fallback` |
| `/alerts` 一条特殊告警 | `state='degraded'` 时自动 firing 一条 P1 告警："EM 降级运行中，事件审计数据可能缺失" |

### 12.4 监控 + 自愈

- `/api/em/health` 每 30 秒探一次（检查 DB / Inngest / Neo4j 连通性）
- 探到所有依赖恢复后调 `degradedMode.recover()`
- Phase 2 加: 降级超过 30 分钟 → emit `EM_DEGRADED_PROLONGED` 系统事件 → 飞书通知

---

## 13. UI 落点（v2 钉死）

### 13.1 `/events` 顶部 sub-tabs

```
┌─────────────────────────────────────────────────────────────────┐
│ 事件管理                                                          │
│ ┌──────────────────────────────────────────────────────────────┐ │
│ │ KPI: events/1m | functions | DLQ | rejected | EM 健康 ...    │ │
│ └──────────────────────────────────────────────────────────────┘ │
│ [注册表] [实时流] [死信] [拒绝] [实例追踪] [因果链]               │
│                                                                  │
│  当前 sub-tab 内容                                                │
└─────────────────────────────────────────────────────────────────┘
```

| Sub-tab | 数据源 | 主要操作 |
|---|---|---|
| 注册表 | `EventDefinition` 表（Neo4j 同步源） | 只读查看 schema、版本、上下游 |
| 实时流 | Inngest API + `EventInstance` | 已有；标注 `schema_version_used` |
| 死信 | `EventInstance(status IN [rejected_schema, rejected_filter])` | 重放 / 丢弃 / 转 HITL |
| 拒绝 | `EventInstance(status = rejected_filter)` 子集 | 显示是哪条 GatewayFilterRule 命中 |
| 实例追踪 | 按 trace_id / external_event_id 搜单条 | 跳转到 §13.2 单实例页 |
| 因果链 | `EventInstance.caused_by_event_id` 聚合 | 时间线视图（见 §13.3）|

### 13.2 单事件实例页 `/events/:name/instances/:id`

**两栏布局**：

```
┌──────────────────────────────────┬───────────────────────────────────┐
│ 主区：8 步 trail（StepLog 树）       │ 右栏：上下游因果（v2 钉死位置）       │
│                                  │                                   │
│ ① 入站接收                          │  上游 1 个：                        │
│    source: raas-bridge           │    RESUME_DOWNLOADED               │
│    schema_version_used: 2.0      │    evt_abc123 (5s 前)               │
│ ② Filter pass                    │                                   │
│ ③ Schema validate ok             │  本事件: RESUME_PROCESSED            │
│ ④ Persist EventInstance          │    evt_def456 (now)                │
│ ⑤ inngest.send                   │                                   │
│   ↓ fan-out                      │  下游 N 个：                          │
│ ⑥ resumeParserAgent steps        │    MATCH_PASSED_NEED_INTERVIEW     │
│   - step.run("envelope-unwrap")  │    evt_xyz001                      │
│   - step.run("minio-fetch")      │    MATCH_PASSED_NEED_INTERVIEW     │
│   - step.run("robohire-parse")   │    evt_xyz002                      │
│   - step.run("emit RESUME_…")    │    ...                            │
│ ⑦ Outbound 出站给 raas-backend    │                                   │
│   (raas-backend.SDK 已注册)       │  HITL 任务: 1 条 (开)               │
│                                  │    "推荐包人工复核 evt_def456"      │
│ [重放] [转 HITL] [丢弃]             │  → /inbox/hitl-789               │
└──────────────────────────────────┴───────────────────────────────────┘
```

数据源：
- 主区：Inngest API `/v1/runs?event_id=...` + `EventInstance` + `StepLog`（如果 Phase 2 有）
- 右栏上下游：`EventInstance.caused_by_event_id` 自连查询
- 右栏 HITL：`HitlTask.triggeringEventInstanceId` 反查（v2 §10.4 新增）

### 13.3 因果链全局页 `/correlations/:traceId`

输入 `trace_id`（也接受 `correlationId` / `external_event_id`）→ 时间线展开所有关联事件 + Run + HITL：

```
trace: req-2041
─ 14:02:01 │ REQUIREMENT_LOGGED      evt_a01  (RAAS dashboard)
─ 14:02:03 │ JD_GENERATED             evt_a02  (createJdAgent)
─ 14:02:08 │ RUN-J2041 started       run_j2041
─ 14:03:15 │ RESUME_DOWNLOADED       evt_a03  (raas-bridge)
─ 14:03:20 │ RESUME_PROCESSED        evt_a04  (rpa.parser)
─ 14:03:21 │ ⚠ MATCH_FAILED          evt_a05  (rpa.matcher: blacklist)
─ 14:03:21 │ HITL: "申诉黑名单"        hitl_001 (open)
─ ...
```

数据源：聚合查询，按 `trace_id` JOIN `EventInstance` + `WorkflowRun` + `HitlTask` + `OutboundEvent`(如果存在)。

### 13.4 Filter 规则 UI `/triggers` 新增 sub-tab

`/triggers` 页加第 4 个 sub-tab "网关规则"，CRUD `gateway_filter_rule` 表。Phase 3 启用。

---

## 14. 业务校验 vs Schema 校验（关键区分）

继承 v1 §10.3。略。

---

## 15. 迁移计划（v2 修订版）

### Phase 1（最小可用 + 解决 Neo4j 痛点，2-3 周）

**Goal**：所有 publish 都过 EM；schema 校验生效；EVENT_REJECTED 通路打通；**Neo4j read-only sync 上线**；多版本 schema 支持；降级模式骨架。

1. **建 monorepo workspace**：`packages/em/` + 根 `package.json` 配 workspaces。AO-main + RPA 改 workspace member。
2. **`packages/em/src/schemas/`** — 手写 8 个核心事件的 Zod schema（v1 §11.1 列表）+ 每个事件 `versions[]` 数组结构（即使 Phase 1 只有 1 个版本，结构上预留多版本）。
3. **`packages/em/src/registry/`** — 注册表查询：先表后代码 fallback。
4. **`packages/em/src/index.ts`** — 实现 `EventManager` 类，含 §8.2 多版本 try-parse + 降级 fallback 路径。
5. **`packages/em/src/persistence.ts`** — Prisma + Postgres，建 `event_instance` + `event_definition` + `em_system_status` 三张表。
6. **`packages/em/src/neo4j-sync.ts`** — read-only sync worker，5 min cron（v2 新增）。
7. **`packages/em/src/degraded-mode.ts`** — 异常进降级 + persist + UI 信号源。
8. **`packages/em/src/rejection.ts`** — `EVENT_REJECTED` hardcoded schema + emit 逻辑（不递归）。
9. **改造 publish 入口**（按依赖顺序）：
   - [server/inngest/raas-bridge.ts](../../../server/inngest/raas-bridge.ts)：`inngest.send` → `em.publish`
   - [server/ws/agents/match-resume.ts](../../../server/ws/agents/match-resume.ts) 等：所有 `step.sendEvent` → `await em.publish`
   - resume-parser-agent 内所有 emit → `em.publish`
10. **改造 forward**：[server/inngest/raas-forward.ts](../../../server/inngest/raas-forward.ts) → `em.forward`，删原文件。
11. **删 agent 内 schema-shape 防御代码**（保留业务校验）。
12. **HITL 强制字段**：[server/ws/agents/](../../../server/ws/agents/) 创建 HITL 处加 `triggeringEventInstanceId`。
13. **AppBar 加 EM 健康灯**。
14. **验证清单**：
    - [ ] 跑一遍 happy path → EventInstance 写入正常
    - [ ] 故意发坏 schema → EVENT_REJECTED emit + EventInstance(status=rejected_schema)
    - [ ] 临时 fn 订阅 EVENT_REJECTED 验证回执通路
    - [ ] Neo4j 加一条新事件定义 → 5 分钟后 EventDefinition 表有
    - [ ] `em.publish` 该事件 → 校验通过
    - [ ] 关掉 DB → `em.publish` 进降级 → AppBar 灯橘 → 业务事件仍流转
    - [ ] DB 回来 → 健康灯绿

### Phase 2（UI 全量 + 多版本治理，2-4 周）

**Goal**：`/events` UI 用 EM 数据；6 个 sub-tab 全部到位；schema 多版本流量看板；RAAS 端 EVENT_REJECTED handler 闭环。

1. `/events` 顶部加 6 sub-tabs（§13.1）
2. `/events/:name/instances/:id` 单实例 trail 页（§13.2）
3. `/correlations/:traceId` 因果链页（§13.3）
4. `/inbox` 任务卡片底部加事件跳转链接（§10.4 落到 UI）
5. Schema 版本流量监控：`/events` 注册表的每条事件展开后显示"过去 24h v1: 1234, v2: 5678"
6. RAAS 写 `event-rejected-handler` fn 订阅 `EVENT_REJECTED` 更新 outbox
7. EM admin API：`POST /api/em/replay/:event_id`（用于 DLQ 重放）

### Phase 3（Filter + Causality 投影，按需）

1. **Filter 规则 DB 表 + UI**：`/triggers` 加"网关规则" sub-tab（v2 修订，原 v1 "config file" 撤回）
2. **`packages/em/src/filter.ts`** 实现规则匹配
3. **EventDefinition 同步加 publisher/subscriber 关系**到 Neo4j（双向）
4. **Event causality 每晚批量投影**到 Neo4j `(:Event)-[:CAUSED_BY]->(:Event)`

### Phase 4（升级到 sidecar 形态，远期）

继承 v1 §11.4。略。

---

## 16. 待决策点（v2 钉死）

| # | 问题 | v1 状态 | v2 决策 |
|---|---|---|---|
| 1 | monorepo workspace 还是 npm-link | open | **monorepo workspace** |
| 2 | EM 持久化 SQLite 还是 Postgres | open | **Postgres**（见 §7.2） |
| 3 | EVENT_REJECTED 对 RAAS 之外的订阅者可见 | open | **可见**（AO `/events` UI 必须订阅） |
| 4 | duplicate 入站时是否给 ack | open | **静默 + EventInstance(status=duplicate)**；RAAS 抱怨再加 EVENT_DUPLICATE_ACK |
| 5 | Phase 1 是否实现 forward | open | **不实现**（raas-backend 已注册到本地 Inngest） |
| 6 | AO-main 老 matchResumeAgent 是否走 EM | 已决：不走 | **不变** |
| 7 | EventDefinition 手写还是同步 | open | **Phase 1 即同步 read-only**（v2 提前）；Phase 3 加 publisher/subscriber 关系双向同步 |
| 8 | EventInstance 保留 90 天 | open | **180 天**（合规季度报表） |
| 9 (新)| schema 多版本兼容期上限 | — | **30 天** — 超过 30 天 v1/v2 并存触发 P2 告警 |
| 10 (新)| EM 降级超时升级路径 | — | **30 分钟** — 超过 30 min emit `EM_DEGRADED_PROLONGED` |
| 11 (新)| Neo4j sync 频率 | — | **5 分钟**；按需 `/api/em/sync-now` 触发立即同步 |

---

## 17. 风险与对策（v2 修订）

| 风险 | v1 对策 | v2 强化 |
|---|---|---|
| EM 库 bug 导致所有 publish 失败 | Phase 1 加全局 fallback：EM 异常时 console.error + 直接 inngest.send 旁路 | **§12 降级模式 + UI 三处信号 + 30 min 升级告警**（v2 强化） |
| `EVENT_REJECTED` 自身 schema 漂移 | Hardcoded 在 EM 库代码里，变更走 EM 库 major 版本号 | 不变 |
| AO-main 和 RPA 的 EM 库版本不一致 | monorepo workspace 强制；CI 检查 lockfile | 不变 |
| RAAS 的 event-rejected-handler 不接 → 回执无人收 | EM 仍然写 EventInstance + emit 进总线，AO 自己 /events UI 总能看到 | 不变 |
| 入站事件量大（>1k/s）拖慢 publish | Phase 2 用 Postgres + batch insert | **v2: Postgres 起步**，省一次迁移 |
| Filter 规则配置错把合法事件全拒 | Filter 规则集中放配置文件 | **v2: 改 DB 表 + UI 操作有 audit log**（gateway_filter_rule.created_by + 规则变更触发 `GATEWAY_RULE_CHANGED` 事件，可审计） |
| Neo4j sync worker 失败 → schema 长期过期 | — | **v2 新增**：sync_at 字段 + monitoring：`/api/em/health` 检查 `now - max(synced_at) > 1h` 时进 degraded |
| Schema 多版本兼容期没人注意 → 永久 v1 流量 | — | **v2 新增**：`schema_version_used` 流量看板 + 30 天阈值告警 |

---

## 附录 A — 端到端时间线（具体例子）

继承 v1 附录 A。略。

---

## 附录 B — EventInstance 因果链投影

继承 v1 附录 B。略。

---

## 附录 C — 事件总览矩阵

继承 v1 附录 C，加列 `schema_version_used`。

| Event | Publisher | 入 EM？ | Inngest 订阅者 | 失败时是否发 EVENT_REJECTED | 当前活跃版本 |
|---|---|---|---|---|---|
| `REQUIREMENT_LOGGED` | RAAS dashboard → raas-bridge | ✅ | createJdAgent | ✅ | 1.0 |
| `JD_GENERATED` | createJdAgent | ✅ | raas-backend.jd-generated-sync | ✅ | 1.0 |
| `RESUME_DOWNLOADED` | RAAS upload → raas-bridge | ✅ | resumeParserAgent | ✅ | 1.0 |
| `RESUME_PROCESSED` | resumeParserAgent | ✅ | matchResumeAgent (新) + matchResumeAgent (老 AO-main) + raas-backend.resume-processed-ingest | ✅ | 1.0 (Phase 1)，2.0 (Phase 2 + 计划) |
| `MATCH_PASSED_NEED_INTERVIEW` | matchResumeAgent (新) | ✅ | raas-backend.match-result-ingest-need-interview | ✅ | 1.0 |
| `MATCH_PASSED_NEED_INTERVIEW` | matchResumeAgent (老 AO-main) | 🟡 不接 EM | 同上 | N/A | N/A |
| `MATCH_PASSED_NO_INTERVIEW` | matchResumeAgent | ✅ | raas-backend | ✅ | 1.0 |
| `MATCH_FAILED` | matchResumeAgent | ✅ | raas-backend | ✅ | 1.0 |
| `JD_REJECTED` | createJdAgent (业务拒) | ✅ | createJdAgent (重试)+ raas | ✅ | 1.0 |
| `CLARIFICATION_READY` | (未实现) | ✅ | createJdAgent | ✅ | — |
| `EVENT_REJECTED` | EM 自动 | ⚠️ 跳过 EM 5 步 | raas-backend.event-rejected-handler + AO /events UI + AO `system_alert` 派生器 | ❌（防递归）| hardcoded 1.0 |
| `EM_DEGRADED_PROLONGED` (v2 新增) | EM 自动（30 min 持续降级）| ⚠️ 同上 | AO `/alerts` + 飞书通知 | ❌ | hardcoded 1.0 |
| `GATEWAY_RULE_CHANGED` (v2 新增) | EM 自动（filter 规则变更）| ✅ | AO `/audit` | ✅ | hardcoded 1.0 |

---

## 附录 D — v2 相对 v1 的代码 / 文件 增量

### D.1 新增文件

```
packages/em/src/
├── neo4j-sync.ts           ← Phase 1 核心（v2 提前）
├── degraded-mode.ts        ← Phase 1 核心（v2 新增）
├── registry/
│   ├── index.ts            ← 先表后代码 fallback
│   └── multi-version.ts    ← tryParseMultiVersion
└── schemas/
    └── version-types.ts    ← versions[] 数据结构

server/init.ts                ← +startNeo4jSync() +EM degraded 自检 cron
app/api/em/health/route.ts    ← v2 新增（探活 + 自愈）
app/api/em/sync-now/route.ts  ← v2 新增（手动触发同步）
app/api/em/replay/[id]/route.ts ← Phase 2 重放
app/api/correlations/[traceId]/route.ts ← Phase 2 因果链聚合查询

components/events/
├── DegradedBanner.tsx       ← v2 新增（顶部黄条）
├── SchemaVersionBadge.tsx   ← v2 新增（实例行的版本徽章）
├── DLQTab.tsx               ← Phase 2
├── RejectedTab.tsx          ← Phase 2
├── InstancesTab.tsx         ← Phase 2
├── CausalityTab.tsx         ← Phase 2
└── InstanceTrail.tsx        ← Phase 2 单实例页

components/correlation/
└── CorrelationTimeline.tsx  ← Phase 2

components/triggers/
└── GatewayRulesTab.tsx      ← Phase 3 (v2 修订：DB 表而不是 config file)

components/shared/
└── AppBar.tsx                ← +EM 健康灯
```

### D.2 修改文件

```
prisma/schema.prisma          ← +EventDefinition 表 +EmSystemStatus 表 +GatewayFilterRule 表 +HitlTask.triggeringEventInstanceId
components/events/EventsContent.tsx ← 拆 6 sub-tabs；删"新建/发布"按钮
components/inbox/InboxContent.tsx   ← 卡片加事件跳转
components/alerts/AlertsContent.tsx ← 接 EM_DEGRADED_PROLONGED
```

---

**END OF SPEC v2**
