# AgenticOperator × Workflow-Studio × Event-Manager · 集成搭建设计

> 把 Workflow-Studio (WS) 真实运行态 + Event-Manager (EM) 事件**运行/审计/网关**的能力接入 Agentic Operator (AO)，让 AO 从静态原型升级为可观测、可操作的 AI 招聘舰队中枢。**所有后端落在 AO 仓 Next.js 框架内**——无独立 Express、无独立 web。
>
> **作者**：Steven · **日期**：2026-04-27 · **状态**：草案 v2 · **代号**：AO-INT-1

## 决议日志（v2，2026-04-27）

| # | 问题 | 决议 |
|---|---|---|
| Q1 | EM Editor 治理（E1–E4/Lint/AI Review）是否迁入 | **不迁**。AO 不做事件设计期工具，只做运行期视图 |
| Q2 | WS Copilot 是否随迁 | **不迁**（暂时） |
| Q3 | P3 数据库 | **本地 File system**（SQLite 单文件 `data/ao.db`，via `better-sqlite3`），暂代 PostgreSQL；migrations 路径预留切回 Postgres |
| Q4 | 后端形态 | **全部 Next.js**——API Routes (`app/api/*/route.ts`) + Inngest 通过 `inngest/next` 适配，**无独立 Express 进程** |
| Q5 | i18n 扩到 22 agent | **是**（沿 AO 现有 i18n 纪律） |

这 5 条决议触发的范围变化：
- 删除原 spec 里的 `/events/registry` 路由（Q1 → 无 EM Editor）
- 把"独立 Bridge Express + 端口 4000"全删（Q4 → Next.js API Routes 替代）
- 把"PostgreSQL 二选一"决议固定为 SQLite 文件（Q3）
- 新加 §13 "DB & 状态持久化"专节

---

## 0 · TL;DR

- **目标产物**：AO 成为 RPO Ops 团队**唯一**入口，覆盖触发器 → 事件 → 工作流 → 运行 → 监控 → 异常 6 段；**所有代码、单一进程、单一端口（3002）、单一 SQLite 文件**。
- **路径**：`B（Sidecar 接通）→ A（仓内 Next.js 合一）`，分 4 期，**P3 之后只剩一个 Next.js 进程**。
- **不动**：AO 当前 6 个页面的设计语言、IA、设计 token、i18n、shell 形态——这是领导认可的"视觉契约"，全部保留。
- **要重写**：AO 6 页面后面的"数据来源"——从 mock 切到 Next.js API Routes（P1 内部转发到 EM/WS sidecar；P3 直接落 SQLite）。
- **要新加**：2 个路由（`/triggers`、`/inbox`）；**不**做 `/events/registry`（无 EM Editor 治理）。
- **不接管**：EM/WS 自己的 9 处实现硬伤（双层信封、bypass 网关默认值、双 DB、二元 actor 等），**统一在 `app/api/` 归一化层**消化，AO 页面只看到清洁模型。
- **后端形态**：[`app/api/*/route.ts`](../../../app)（Next.js Route Handlers）+ Inngest 通过 [`inngest/next` 适配器](https://www.inngest.com/docs/sdk/serve#nextjs)；**没有独立 Express、没有独立 web**。

---

## 1 · 背景

### 1.1 三个系统的真实定位

| 系统 | 路径 | 端口 | 真实角色 | 当前状态 |
|---|---|---|---|---|
| **AO**（Agentic Operator） | [`/`](../../..)（本仓） | 3002 | RPO Ops 控制台前端 | Next.js 16 + React 19 纯前端，全部 mock，6 页面 |
| **WS**（Workflow Studio） | [`Action_and_Event_Manager/workflow-studio/`](../../../Action_and_Event_Manager/workflow-studio/) | server 5175 / web 3001 | **运行时**：21+ Inngest agent + LLM Skills + HITL + Activity SSE | 已可跑，但 web 揉成 3 区（Canvas+Feed+Copilot）单页 |
| **EM**（Event Manager） | [`Action_and_Event_Manager/packages/`](../../../Action_and_Event_Manager/packages/) | server 8000 / web 5173 | **事件治理 + 网关**：Editor (E1–E4, Lint, AI Review) + Manager (DLQ, Audit, Gateway, Outbound) | 已可跑，165 端点，39 manager router |

### 1.2 领导诉求

把 WS 的 Workflow agents 和 EM 的功能"迁移到 AO"，让 AO 真正能驱动业务。

### 1.3 翻译

按对代码的实际盘点（[第 3 节](#3-逻辑不一致清单30) 详述），"迁移"的精确含义是：

- **AO 前端 = 唯一界面**（领导设计的 IA 不动）
- **WS server + EM server 沉到后端**（中长期合一进 AO 仓，短期保持独立 + sidecar）
- **AO 当前 mock 全部接真数据**

不是"把 WS web 的 Canvas 抠出来塞进 AO"——那是片段移植，不解决任何问题。

---

## 2 · 三系统当前架构现状

### 2.1 AO 现状

```
agenticOperator/
├── app/<route>/page.tsx           thin shell, 6 routes
├── components/
│   ├── shared/                    Shell + AppBar + LeftNav + CmdPalette + atoms + Ic
│   ├── fleet|workflow|live|events|alerts|datasources/Content.tsx
│   └── (NO data hooks, all mock)
├── lib/
│   ├── i18n.tsx                   ~200 keys, zh/en
│   └── events-catalog.ts          28 mock events
└── (no API routes, no fetch, no SSE, no test)
```

实测数据（`wc -l`）：6 页面 + shell 共 **~3500 行**；mock 数据全部内联。

### 2.2 WS 运行态实际链路

```
┌────────────────────────────┐
│ EM Conductor (Phase 6)     │
│   raas/workflow.dispatch  ─┼────► WS handleDispatchEntry
└────────────────────────────┘         │  unwrap 3-layer envelope (payload.payload.payload)
                                       │  triggerMap[event_name] → Agent[]
                                       ▼
                       ┌─────────── workflow/<EVT> ───────────┐
                       │     22 Inngest functions             │
                       │  (13 AI Agent + 9 Human Agent)       │
                       │  buildContext (history + KB +        │
                       │     ontology + rules + episode)      │
                       │  step.run → Skill (Claude/Gemini)    │
                       │  ctx.emit → emittedEvents[]          │
                       └──────────────┬───────────────────────┘
                                      │
                       ┌──── routing per EM_GATEWAY_MODE ────┐
                       │  default = 'bypass':                │
                       │    workflow/<NEXT> 内部转发         │
                       │  + raas/event.observed (审计镜像)   │
                       │  + HTTP POST → EM /events/kafka     │
                       │  terminal agent → raas/outbound     │
                       └─────────────────────────────────────┘
                                      │
                                      ▼
                  Prisma (postgresql): WorkflowRun, Step,
                                      AgentActivity, HumanTask,
                                      ChatbotSession, AgentEpisode
                                      │
                                      ▼
                  SSE /api/activity/stream  +  REST 33 routes
```

### 2.3 EM 实际链路

```
Editor (设计期)                        Manager (运行期)
─────────                              ─────────
events DRAFT → AI_REVIEWING            POST /runtime/events/kafka
       → CONFIRMED → ACTIVE            ↓
       → DEPRECATED                    Gateway filter (rules)
                                       ↓
E1 兼容变更                             Dedup cache
E2 破坏性变更                           ↓
E3 AI 载荷生成                          DLQ on failure
E4 全量 Lint (L1–L11)                  ↓
Validate / Errors / Fix                 Audit log (every event)
AI Review (Claude)                      ↓
                                       Outbound queue (Phase 7 → 客户)
events 表 + event_versions             ─────────
action_snapshots + diffs               raas_messages, dlq_entries,
                                       audit_log, outbound_events
```

---

## 3 · 逻辑不一致清单（30+）

完整清单见前期分析记录（git 历史）。本节列**会影响搭建决策**的关键 12 项，按"应该如何处理"标注。

| # | 不一致 | 出处 | 处理方针 |
|---|---|---|---|
| 1 | AO `/events` 把 Editor + Runtime + Bus 三层揉成一页 | [lib/events-catalog.ts](../../../lib/events-catalog.ts) vs EM `routes/editor/` + `routes/manager/` | **保留 `/events` 单路由**，扩 1 个 Firehose Tab 容纳运行流；不做 Editor 治理（Q1） |
| 2 | Agent 命名空间零重叠（AO 12 短名 vs WS 22 全名） | [FleetContent.tsx:25-36](../../../components/fleet/FleetContent.tsx#L25) vs [agents/index.ts](../../../Action_and_Event_Manager/workflow-studio/server/src/agents/index.ts) | **建 `lib/agent-mapping.ts`**：唯一的 short_name ↔ ws_agent_id ↔ display_name 映射；UI 全用 short_name |
| 3 | AO 把 rule 当 agent（DupeCheck、guard） | FleetContent vs `rules/blacklist.rule.ts` | **从 Fleet 删掉 DupeCheck/guard 行**，并入 `ResumeParser`/`Compliance` 行的 sub-row |
| 4 | AO Workflow 缺 5 节点（assignRecruitTasks / refineResume / 4 Human） | [WorkflowContent.tsx:24-43](../../../components/workflow/WorkflowContent.tsx#L24) | **重画 22 节点拓扑**，按 stage 9 列对齐；位置不再写死 (x,y)，从 stage+order 推算 |
| 5 | AO 缺 4 关键事件 (`RESUME_OPTIMIZED` / `PACKAGE_MISSING_INFO` / `SUBMISSION_FAILED` / `SYNC_FAILED_ALERT`) | [events-catalog.ts](../../../lib/events-catalog.ts) | **events-catalog.ts 整文件作废**，改为运行时拉 EM `/events` |
| 6 | 状态机缺 `suspended/timed_out`（HITL/SLA） | FleetContent status enum | **新加 `suspended` / `timed_out` 颜色 token**，Fleet+Live+Workflow 三处都用 |
| 7 | AO 没有 HITL 队列页 | (整页缺失) | **新增 `/inbox` 路由**，对接 WS `HumanTask` + `ChatbotSession` |
| 8 | Resume Collection actor 错位（AO 当 AI / WS 标 Human） | [resume-collection.ts:37](../../../Action_and_Event_Manager/workflow-studio/server/src/agents/resume-collection.ts#L37) | **以 WS 为准**：Human + 自动模拟器兜底；UI 上 actor 字段改为 `auto / hitl / hybrid` 三态 |
| 9 | AO 没有触发器视图（cron / webhook / upstream emit） | (整页缺失) | **新增 `/triggers` 路由** |
| 10 | AO 把 alerts 等同"待办" | [AlertsContent.tsx](../../../components/alerts/AlertsContent.tsx) | **alerts 只装"系统级异常"**（SLA/速率/质量/基础设施）；HITL 待办移 `/inbox` |
| 11 | AO 缺审计/DLQ 视图 | (整页缺失) | 不新建路由，**`/alerts` 加 2 个 facet**（dlq / audit-anomaly） |
| 12 | AO Workflow 顶栏 "v4.2 · draft" 是死字符串 | WorkflowContent.tsx:77 | **改读 `lib/agent-mapping.ts` 同目录的 `lib/workflow-meta.ts`**（静态 JSON：version + lastUpdated + nodes）；P3 后该文件可由 build script 从 SQLite 重新生成 |

---

## 4 · 不接管：EM/WS 自身 9 处硬伤

下面这些 EM/WS 实现层面已知问题，**绝不让它穿透到 AO**。统一在 [`app/api/*` 归一化层](#5-目标架构) 消化。

| # | 硬伤 | 出处 | AO 侧策略 |
|---|---|---|---|
| H1 | 三层信封 `payload.payload.payload` | [inngest-adapter.ts:509](../../../Action_and_Event_Manager/workflow-studio/server/src/engine/inngest-adapter.ts#L509) | 归一化层（`app/api/*`）在响应里**扁平化为 `event` + `business`** 两段 |
| H2 | `EM_GATEWAY_MODE` 默认 `bypass`，"网关居中"是文档谎言 | [inngest-adapter.ts:182](../../../Action_and_Event_Manager/workflow-studio/server/src/engine/inngest-adapter.ts#L182) | AO 不渲染"事件经过 EM"的拓扑，改为**显示真实路径**（条件分支：sync/bypass）|
| H3 | WS = postgresql、EM = sqlite，跨库无法 join | 两处 schema.prisma | `GET /api/trace/[id]` 跨库聚合：内部并发查 2 库 + 内存合并 |
| H4 | Inngest + Kafka + HTTP 三段桥，故障域 ×3 | inngest-adapter.ts:1212 | AO 健康面板**显式分 3 段**显示链路健康，不假装它是单一 bus |
| H5 | Terminal 事件硬编码白名单，易飘 | [inngest-adapter.ts:73](../../../Action_and_Event_Manager/workflow-studio/server/src/engine/inngest-adapter.ts#L73) | AO 不依赖该列表；从 agent metadata `terminal: true` **自动推导** |
| H6 | Actor 二元 `Agent / Human` 标签静态化 | WS agent metadata | AO 引入 **`runtime.kind: 'auto' \| 'hitl' \| 'hybrid'`**，运行时由 `pendingHumanTasks > 0` 推导 |
| H7 | EM 39 Manager 路由职责重复（chain×3、flow×2、events×3） | [routes/manager/](../../../Action_and_Event_Manager/packages/server/src/routes/manager/) | 归一化层（`app/api/*`）归并为 **≤10 个资源**：`runs / steps / activities / events / triggers / dlq / audit / human-tasks / agents / health` |
| H8 | ActivityLogger 三沉淀（memory/Prisma/SSE）易飘 | [activity-logger.ts](../../../Action_and_Event_Manager/workflow-studio/server/src/engine/activity-logger.ts) | AO 永远以 **DB 为真相源**，memory 仅作 SSE pre-buffer |
| H9 | WorkflowRun.status 7 值定义了但 UI 没用全 | schema.prisma:43 | AO **强制全用**，缺一个状态就打 placeholder badge 暴露问题 |

---

## 5 · 目标架构

### 5.1 路径选择：B → A

| 阶段 | 形态 | 何时 | 为什么 |
|---|---|---|---|
| **P0**（已完成）| AO mock-only | now | 现状 |
| **P1（B 形态）** | AO Next.js + EM/WS sidecar 独立进程 +  AO 内 `app/api/` 归一化层 | 第 1–3 周 | 最快打通"看到真实数据"，验证集成面 |
| **P2** | P1 + AO 新增 `/triggers` `/inbox` 路由 | 第 4–5 周 | 补 AO 在领导设计里**未覆盖的功能区** |
| **P3（A 形态）** | WS agents/skills/engine + EM 运行/审计/网关代码全部**作为 Next.js 模块**进入 AO 仓；SQLite 单文件 | 第 6–10 周 | 真正"AO 自洽运行 / 单进程单端口" |

> **决议要点**：领导诉求是"迁移到 AO 前端框架内"——P3 才算真正达成。但 P1 出来后业务体感已经 80%，是验证设计可行性的关键里程碑，不能跳过。
> **关键约束（Q4）**：所有"后端"以 [Next.js Route Handler](https://nextjs.org/docs/app/api-reference/file-conventions/route) 形式存在。**绝不**新增独立 Express / Fastify 进程。

### 5.2 P1（Next.js API Routes 作为归一化层）拓扑

```
┌────────────────────────────────────────────────────────────────────┐
│ Browser                                                            │
└────────────────────────────────────┬───────────────────────────────┘
                                     │
                                     ▼
┌────────────────────────────────────────────────────────────────────┐
│ Agentic Operator · Next.js 16 · port 3002                          │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ Pages (Client Components):                                   │  │
│  │   /fleet  /workflow  /live  /events  /alerts /datasources    │  │
│  │   /triggers*  /inbox*    (* = P2 new)                        │  │
│  │   ↓ data via lib/api/* (typed fetch + useSSE hook)           │  │
│  └──────────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ app/api/  (Next.js Route Handlers — P1 = adapter to sidecars)│  │
│  │   /agents       /runs        /events       /human-tasks      │  │
│  │   /trace/[id]   /alerts      /triggers     /datasources      │  │
│  │   /stream       (SSE multiplexer to WS /api/activity/stream) │  │
│  │   /inngest      (P3 only — Inngest serve adapter)            │  │
│  │   ─ 归一化双层信封、status 枚举、agent 映射、跨服务聚合 ─     │  │
│  └──────┬─────────────────────────────────────────┬─────────────┘  │
└─────────┼─────────────────────────────────────────┼────────────────┘
          │                                         │
          ▼                                         ▼
┌──────────────────────┐                 ┌─────────────────────────┐
│ WS server :5175      │                 │ EM server :8000         │
│   33 routes          │                 │   33 routes (manager+   │
│   Prisma postgresql  │                 │   editor)               │
│   Inngest dev :8288  │                 │   Prisma sqlite         │
└──────────────────────┘                 └─────────────────────────┘
   ↑ P3 删除（合并入 AO）                    ↑ P3 删除（合并入 AO）

> **P1 期间 WS 暂保 PostgreSQL**——避免一次性同时改 (1) 后端形态 + (2) DB 引擎；P3 才统一切 SQLite。
```

### 5.3 P3（A 形态）拓扑

P3 完成后**只剩一个进程**：

```
┌─────────────────────────────────────────────────────────────────┐
│ Agentic Operator · Next.js 16 · port 3002                       │
│                                                                 │
│  app/                          Pages (client components)        │
│  app/api/                      All HTTP / SSE entry points      │
│  app/api/inngest/route.ts      Inngest serve(client, functions) │
│                                                                 │
│  server/  (server-only modules, imported by app/api/*)          │
│   ├─ ws/agents/                22 agent definitions             │
│   ├─ ws/skills/                21 AI Skills                     │
│   ├─ ws/engine/                Inngest adapter (no Express)     │
│   ├─ ws/rules/                 blacklist / candidate-lock / ... │
│   ├─ em/audit/                 audit log + DLQ + dedup          │
│   ├─ em/gateway/               filter rules + outbound          │
│   └─ db/                       SQLite via better-sqlite3        │
│                                                                 │
│  data/                                                          │
│   └─ ao.db                     ← 单一 SQLite 文件               │
│                                                                 │
│  外部依赖（仅 dev 调试）：                                       │
│   - Inngest dev server (:8288)  通过 `npx inngest-cli dev`       │
│     仅本地运行函数；生产可换 Inngest Cloud 或自托管              │
└─────────────────────────────────────────────────────────────────┘
```

> **关于 Inngest 的注脚**：Next.js + Inngest 集成方式是 [`serve()` from `inngest/next`](https://www.inngest.com/docs/sdk/serve#nextjs)，所有 function 定义在 `server/ws/engine/`，HTTP 入口落在 `app/api/inngest/route.ts`。**Inngest 的执行器**（dev server / cloud）严格说仍是外部进程，但它对 AO 来说只是一个事件触发器，不是 backend——所以这里满足"AO 框架内"的语义。如果完全要去除 Inngest，方案是用 SQLite 表做简易 job queue + worker（参 §13.4），P3 可选。

### 5.4 P1 `app/api/*` 归一化层职责

不是"反向代理"——是**领域翻译层**，5 件事，全部以 Next.js Route Handler 形式存在：

1. **资源归一化**：把 EM 39 路由 + WS 33 路由折叠成 10 个 RESTful 资源（见 H7）
2. **事件扁平化**：剥三层信封 → `{ event_name, trace_id, business_payload }`
3. **跨服务聚合**：单 endpoint 返回"一个 trace 的 EM 审计 + WS 运行 + Step 列表"
4. **SSE 多路复用**：Next.js Route Handler 用 [Streaming Response](https://nextjs.org/docs/app/building-your-application/routing/route-handlers#streaming) 订 WS `/api/activity/stream` 一次，按 `runId / agentName` 过滤后扇出给浏览器
5. **静态映射**：agent_short_name ↔ ws_agent_id、stage 名归一、status 枚举归一

---

## 6 · AO 页面级规格（每页"接谁"）

### 6.1 路由总表

| 路由 | 现状 | P1 接 | P2 接 | 备注 |
|---|---|---|---|---|
| `/fleet` | mock | WS `runs` 聚合 + agent metadata | + EM `audit` 异常计数 | 12 行表 → 22 行（含 9 Human）|
| `/workflow` | 19 节点 SVG | WS `WorkflowDefinition` + `triggerMap` + 实时 `Step.status` | + Inspector 接 Validate/E4 Lint | SVG 保留，节点位从 stage 推 |
| `/live` | 10 lane swimlane mock | WS SSE Activity Feed + `WorkflowStep` 详情 | + LLM trace（`AgentEpisode`）| Decision stream 接 `narrative` |
| `/events` | 28 mock | EM `events` 列表 + 6 Tab 数据各拉真源；Tab "Firehose" 内嵌 audit/DLQ 流 | — | 不再做 Editor 治理（Q1 决议） |
| `/alerts` | mock 12 规则 | WS `run-sweeper` 输出 + EM `dlq_entries` + 速率告警 | + 告警规则编辑 | 不再混 HITL 待办 |
| `/datasources` | mock 24 连接器 | EM `routes/manager/health.ts` + `ingestion_configs` | + webhook 投递日志 | — |
| `/triggers`*  | new | cron 列表 + webhook 端点 + 上游 emit 三类 | + 触发回放 | 第三类来自 EM Gateway |
| `/inbox`*  | new | WS `HumanTask` 队列 + `ChatbotSession` 多轮 | + 分配/批注/SLA | 替代当前 alerts 的"待办"误用 |

\* = P2 新增路由

### 6.2 关键页面的"数据契约"草图

#### `/fleet`（Fleet Command）

| 列 | 现状 mock | P1 真实来源 |
|---|---|---|
| `id` | `REQ-01` | `lib/agent-mapping.ts` |
| `name` | `ReqSync` | `lib/agent-mapping.ts`（short_name）|
| `status` | `running/review/degraded/paused`（4 值）| `WorkflowRun.status` 7 值 + `agent.kind` 派生（auto/hitl/hybrid）|
| `owner` | `HSM·交付`（写死）| EM `agent_config` 表的 `owner_team` 字段 |
| `p50` | `420ms`（mock）| WS `WorkflowStep` 按 nodeId 聚合最近 1h p50 |
| `runs` | `214`（mock）| WS `WorkflowRun` count where last 24h |
| `success` | `99.1`（mock）| WS `WorkflowRun.status='completed' / total` |
| `cost` | `¥48`（mock）| WS `AgentEpisode.tokenUsage * 单价` |
| `last` | `刚刚`（mock）| WS `WorkflowRun.lastActivityAt` |
| `ver` | `v1.4.2`（mock）| EM `agent_snapshot.version` |
| `spark` | 16 个数（mock）| WS `WorkflowRun` 按 5min 桶 count |

#### `/live`（Run Theatre）

- 左侧 Run 列表 ← `GET /api/runs?status=running,suspended&limit=10`
- 中间 Swimlane ← 选中 run 的 `WorkflowStep[]` 按 nodeId 分组，时间轴 = `startedAt / completedAt`
- 右侧 Decision Stream ← SSE `?runId=...`，type=`agent_complete/decision/tool/anomaly`
- **新加**：底部 Trace Tree ← `AgentEpisode.toolTrace` JSON 渲染调用栈

#### `/workflow`（Canvas）

- 节点 ← `GET /api/agents`（22 个）按 `stage` 分 9 列；位置算法：`x = stageIndex * 180`，`y = stageOrder * 100`
- 边 ← `agents.flatMap(a => a.triggers.map(t => emitsOf(t) → a))`（即"上游 emit X 的 agent → 当前 agent"）
- 节点 status badge ← 当前选中 run 的 `WorkflowStep[a.nodeId].status`（`pending|running|completed|failed|retrying`）
- Inspector 面板 ← agent metadata + 当前 run 输入 + 当前 run 输出 + Validate 结果
- **新加**：节点上 `⚠ no subscriber` 徽章 = 自动检测 `emits` 里有 agent 不订阅的事件

#### `/events`（保留 · 略扩 Tab）

事件契约 + 运行流融合视图——**不**做 DRAFT/AI_REVIEWING 编辑（Q1 决议）。Tabs 在原 6 个之外补 "Firehose"：

| Tab | 来源 |
|---|---|
| Overview | EM `events` 表（status='ACTIVE'）|
| Schema | EM `event_versions` 最新一版 + JSON Schema 渲染 |
| Subscribers | WS `triggerMap.get(eventName)` + EM `gateway_filter_rules` |
| Runs | WS `WorkflowRun` where `triggerEvent = name` 最近 24h |
| History | EM `event_versions` 时间轴（只读）|
| Logs | EM `audit_log` where `event_name = name` |
| **Firehose**（新）| 该事件名近 5min 实时流（SSE）+ DLQ 命中 + Dedup 命中 |

#### `/triggers`（新增）

3 类触发器统一视图：
- **Cron**：`cron.rms-sync` 等定时器（来自 WS `run-sweeper`/EM scheduler）
- **Webhook**：EM `routes/manager/raasEvents.ts` 暴露的入口
- **Upstream emit**：内部事件链中"无上游 agent"的事件（即被外部 emit 触发的）

#### `/inbox`（新增 · HITL 队列）

- 主表：WS `HumanTask` `status='pending'`
- 行点开：如有 `humanTaskId.chatbotSession`，展示多轮对话；否则展示 `aiOpinion + payload`
- 操作：approve / reject / escalate（创建 child `ChatbotSession`）
- SLA 倒计时：`HumanTask.deadline - now`

---

## 7 · 数据契约（AO 端）

### 7.1 `lib/api/types.ts`（新增）

只列**类型骨架**，具体字段在 P1 实现时定。

```ts
// status 归一化（H9 决议）
export type RunStatus =
  | 'running' | 'suspended' | 'timed_out' | 'completed'
  | 'failed' | 'paused' | 'interrupted';

export type StepStatus =
  | 'pending' | 'running' | 'completed' | 'failed' | 'retrying';

export type AgentKind = 'auto' | 'hitl' | 'hybrid';  // H6 决议

export type EventLifecycle =
  | 'DRAFT' | 'AI_REVIEWING' | 'CONFIRMED' | 'ACTIVE' | 'DEPRECATED';

export interface AgentRow { /* /fleet 行 */ }
export interface RunSummary { /* /live 左列 */ }
export interface StepDetail { /* /live 中列点开 */ }
export interface ActivityEvent { /* SSE 单条 */ }
export interface HumanTaskCard { /* /inbox 行 */ }
export interface TriggerDef { /* /triggers 行 */ }
export interface EventContract { /* /events 行 */ }
```

### 7.2 `lib/api/client.ts`（新增）

- `fetchJson<T>(path, init?)`：统一错误 + auth header（P4 才加，§11.1 注明）
- `useSSE<T>(path, filter)`：React 19 hook，订 SSE，自动 reconnect

### 7.3 `lib/agent-mapping.ts`（新增）

唯一的"短名 ↔ WS agent_id"事实表。

```ts
export const AGENT_MAP = [
  { short: 'ReqSync',         wsId: '1-1',    stage: 'system',      kind: 'auto',  ... },
  { short: 'ManualEntry',     wsId: '1-2',    stage: 'requirement', kind: 'hitl',  ... },
  { short: 'ReqAnalyzer',     wsId: '2',      stage: 'requirement', kind: 'auto',  ... },
  { short: 'Clarifier',       wsId: '3',      stage: 'requirement', kind: 'hybrid',... },  // 用 ChatbotSession
  { short: 'JDGenerator',     wsId: '4',      stage: 'jd',          kind: 'auto',  ... },
  { short: 'JDReviewer',      wsId: '5',      stage: 'jd',          kind: 'hitl',  ... },
  { short: 'TaskAssigner',    wsId: '6',      stage: 'jd',          kind: 'auto',  ... },
  { short: 'Publisher',       wsId: '7-1',    stage: 'jd',          kind: 'auto',  ... },
  { short: 'ManualPublish',   wsId: '7-2',    stage: 'jd',          kind: 'hitl',  ... },
  { short: 'ResumeCollector', wsId: '8',      stage: 'resume',      kind: 'hybrid',... },  // 模拟器兜底
  { short: 'ResumeParser',    wsId: '9-1',    stage: 'resume',      kind: 'auto',  ... },
  { short: 'ResumeFixer',     wsId: '9-2',    stage: 'resume',      kind: 'hitl',  ... },
  { short: 'Matcher',         wsId: '10',     stage: 'match',       kind: 'auto',  ... },
  { short: 'MatchReviewer',   wsId: '10-HITL',stage: 'match',       kind: 'hitl',  ... },
  { short: 'InterviewInviter',wsId: '11-1',   stage: 'interview',   kind: 'auto',  ... },
  { short: 'AIInterviewer',   wsId: '11-2',   stage: 'interview',   kind: 'hybrid',... },
  { short: 'Evaluator',       wsId: '12',     stage: 'eval',        kind: 'auto',  ... },
  { short: 'ResumeRefiner',   wsId: '13',     stage: 'resume',      kind: 'auto',  ... },
  { short: 'PackageBuilder',  wsId: '14-1',   stage: 'package',     kind: 'auto',  ... },
  { short: 'PackageFiller',   wsId: '14-2',   stage: 'package',     kind: 'hitl',  ... },
  { short: 'PackageReviewer', wsId: '15',     stage: 'package',     kind: 'hitl',  ... },
  { short: 'PortalSubmitter', wsId: '16',     stage: 'submit',      kind: 'auto',  ... },
];
```

22 行——对齐 WS 真实模型。AO Fleet 表从 12 行扩到 22 行。

---

## 8 · 设计原则（写在显眼处的契约）

### 8.1 不可触碰

- **`design_handoff_agentic_operator/`**：永远 reference-only（AO CLAUDE.md 规定）
- **AO 设计语言**：OKLCH token、@theme inline、atoms.tsx、Ic.tsx——**只加不删**
- **i18n 双写**：每个新 string 加 zh+en
- **Shell 形态**：AppBar 44px、LeftNav 184px、CmdPalette ⌘K

### 8.2 不接管 EM/WS 的脏

- 三层信封 → `app/api/*` 拍平
- bypass 默认 → AO 显示真实链路
- 双 DB → `app/api/trace/[id]` 聚合
- 39 路由叠加 → 10 资源
- Memory/Prisma/SSE 三沉淀 → DB 唯一真相源

### 8.3 严格状态机

- `RunStatus` 7 值、`StepStatus` 5 值、`EventLifecycle` 5 值——**任何 UI 渲染必须穷举**
- 缺色彩 token = 视为 bug（用 placeholder 暴露而不是吞掉）

### 8.4 SSE-first

- 所有"运行时数据"页面（/fleet 计数、/live 时间轴、/inbox 计数、/alerts 计数）走 SSE
- REST 只用于"打开页面初次水合"
- 归一化层（`app/api/stream/route.ts`）在服务端多路复用，不在浏览器开 N 条 SSE

---

## 9 · 分期计划

### P0 · 已完成
当前 AO mock 状态；EM/WS 各自可独立运行。

### P1 · Next.js API Routes 接通（第 1–3 周）

**目标**：AO 6 页面从 mock 切换到真实数据，新加 0 个路由；后端**只**新增 Next.js API Routes，**不**新增独立进程。

工作项（按依赖排序）：

1. **`lib/agent-mapping.ts`**：22 行映射表
2. **`lib/api/types.ts` + `lib/api/client.ts` + `lib/api/sse.ts`**：类型 + fetch + useSSE hook
3. **`server/clients/ws.ts` + `server/clients/em.ts`**：HTTP/SSE 客户端模块（**server-only**，被 `app/api/*` 导入）
4. **`server/normalize/`** 三件：`envelope.ts`（H1）、`status.ts`（H9）、`agents.ts`（agent_id ↔ short）
5. **Next.js API Routes（10 个）**——文件路径直接落 `app/api/`：
   - `app/api/agents/route.ts` `GET` — 22 行 metadata
   - `app/api/runs/route.ts` `GET` — Fleet/Live 左列
   - `app/api/runs/[id]/route.ts` `GET` — Live 中列
   - `app/api/runs/[id]/steps/route.ts` `GET` — Live 中列详情
   - `app/api/events/route.ts` `GET` — `/events` contracts
   - `app/api/trace/[id]/route.ts` `GET` — 跨 EM+WS 聚合
   - `app/api/human-tasks/route.ts` `GET` — `/inbox` 预备
   - `app/api/alerts/route.ts` `GET` — system-level only
   - `app/api/datasources/route.ts` `GET` — 连接器健康
   - `app/api/stream/route.ts` `GET` — SSE 多路复用（用 [Streaming Response](https://nextjs.org/docs/app/building-your-application/routing/route-handlers#streaming)）

   > P1 期间 **不**新建 `app/api/inngest/route.ts`——Inngest 仍由 sidecar WS 独占（5175）。该路由仅在 P3 引入。
6. **页面接管**（顺序 = 价值降序）：
   - `/live` → SSE Activity Feed（最直观，业务感强）
   - `/fleet` → 22 agent 表 + 实时 KPI
   - `/workflow` → 节点 status 实时（拓扑暂保留 19 节点 mock）
   - `/events` → ACTIVE 事件契约 + Firehose Tab
   - `/alerts` → system 级告警
   - `/datasources` → 连接器健康
7. **`/workflow` 拓扑改造**：22 节点按 stage 9 列重排（视觉变动大，放最后）

> P1 期间 `Action_and_Event_Manager/` 下的 EM/WS 仍以独立进程运行（5175/8000），通过 npm script 一起启动；`localhost:3001`（WS web）`localhost:5173`（EM web）保留作为参考，AO 是主入口。

### P2 · 新路由（第 4–5 周）

**目标**：补领导设计里未覆盖的 2 个功能区（**不**做 EM Editor，Q1 决议）。

1. `/inbox` HITL 队列 + ChatbotSession 多轮渲染
   - `app/inbox/page.tsx` + `components/inbox/InboxContent.tsx`
   - API：`app/api/human-tasks/[id]/route.ts`（`GET/POST` approve/reject/escalate）
2. `/triggers` cron + webhook + upstream-emit 三类视图
   - `app/triggers/page.tsx` + `components/triggers/TriggersContent.tsx`
   - API：`app/api/triggers/route.ts`
3. CmdPalette 注册新资源（agent_short / run_id / human_task_id / event_name 全可搜）
4. `/events` Firehose Tab 实时流接入

### P3 · 仓内 Next.js 合一（第 6–10 周）

**目标**：单进程、单端口（3002）、单一 SQLite 文件 `data/ao.db`，删除外部 EM/WS。

1. **代码搬迁**：
   - `Action_and_Event_Manager/workflow-studio/server/src/{agents,skills,engine,rules,kb,services}` → `agenticOperator/server/ws/`
   - `Action_and_Event_Manager/packages/server/src/{services/manager,routes/manager}` 中**只搬运行/审计/网关相关**：runtime / dlq / audit / gateway / outbound / dedup → `agenticOperator/server/em/`
   - **不搬**：EM Editor（`routes/editor/*`）、WS Copilot（`routes/copilot.ts`）、WS web、EM web
2. **DB 切换**（详见 §13）：
   - 新建 `prisma/schema.prisma`（合并）`provider = "sqlite"`，`url = "file:../data/ao.db"`
   - 把 WS Postgres-only 类型（如 `@db.Text`）改为 SQLite 兼容
   - `npm run db:push` 一键建表
3. **Inngest 切 Next.js 适配**：
   - `app/api/inngest/route.ts` 用 `inngest/next.serve()`
   - WS `engine/inngest-adapter.ts` 不再调 `serve as inngestServe from 'inngest/express'`
4. **HTTP 调用替换**：之前 P1 的 `server/clients/{ws,em}.ts` 客户端**全部删除**，`app/api/*` 直接 import `server/ws/...` 模块函数
5. **`npm run dev` 单命令**：只起一个 `next dev` + 一个 `inngest-cli dev`（dev 时）；prod 只起 `next start`
6. **删除**：`Action_and_Event_Manager/`（整个文件夹）从 git 移除（保留在历史 commit 里）

### P4 · 生产化（不在本 spec 范围）
认证、多租户、生产部署、监控告警接入运维平台。

---

## 10 · 验收标准（每期都有）

### P1 验收

- [ ] AO 6 页面打开都能看到**真数据**，不再有 mock 字符串泄漏
- [ ] `/live` SSE 在 WS server 重启后 **自动重连**（≤3s 内）
- [ ] `/fleet` 的 22 行能从映射表唯一确定（无重复 short_name）
- [ ] `GET /api/trace/:id` 返回 EM+WS 拼接结果，单次 ≤500ms p95
- [ ] `npm run dev` 启动 AO（3002）+ WS（5175）+ EM（8000）+ Inngest dev（8288），所有端口都通
- [ ] AO 仓**未引入** Express / Fastify / Koa 等独立 server 框架（约束 Q4）
- [ ] AO `/workflow` 节点状态会随 WS 真 run 变（红/绿/黄）
- [ ] 切中文/英文/暗色/亮色，所有新文案、新颜色都正确响应

### P2 验收

- [ ] `/inbox` 能完成 1 轮 HITL approve→事件继续流转
- [ ] `/inbox` 能展开 `ChatbotSession` 多轮对话
- [ ] `/triggers` 能展示真实 cron 任务下次触发时间
- [ ] `/events` Firehose Tab 5 秒内能看到刚才注入的事件
- [ ] CmdPalette 能搜到 4 类资源（agent / run / human-task / event）

### P3 验收

- [ ] `git clone` + `npm install` + `npm run dev` 在新机上 5 分钟内拉起
- [ ] **只启动一个 Next.js 进程 + 一个 Inngest dev** —— 不再有 EM/WS 独立 server
- [ ] WS/EM 独立 web 前端已被删除（仓内不再有 `Action_and_Event_Manager/`）
- [ ] 单一 SQLite 文件 `data/ao.db`，traceId 跨表 SQL join 可写
- [ ] `app/api/*` 不再 import `server/clients/{ws,em}.ts`（改为直接 import `server/ws/*` 模块）

---

## 11 · 风险与开放问题

### 11.1 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| WS Inngest dev server 必须独立跑 | P1 启动复杂度上升 | docker-compose 一键起 |
| EM/WS 双 DB 在 P1 不能 join，trace 查询 N+1 | `app/api/trace/[id]` 慢 | 加内存 LRU 缓存（运行 ≤30s 旧的 trace 不重查）|
| WS Copilot 不迁（Q2），运营失去对话式入口 | 操作便利性下降 | AO `CmdPalette` 是替代入口，P2 增强为可执行操作（不只是搜索）|
| 22 个 agent 节点画在 SVG 上挤 | `/workflow` 视觉退化 | P2 切 React Flow 或 stage 折叠 |

### 11.2 开放问题（v2 已闭合，见顶部决议日志）

P0 草案的 5 个开放问题在 2026-04-27 v2 全部闭合：

| # | 决议 | 影响 spec 位置 |
|---|---|---|
| Q1 | 不迁 EM Editor | §6.1 删 `/events/registry`、`/events/firehose`；§9 P2 工时 -3 天 |
| Q2 | 不迁 WS Copilot | §9 P3 不再搬 `routes/copilot.ts`；§5.3 删 Copilot 模块行 |
| Q3 | SQLite 单文件 `data/ao.db` | §13 新章节 |
| Q4 | 全 Next.js（无独立 Express） | §5 整章重写；§9 P1 用 Next.js Route Handlers；P3 改为 Next.js 模块化 |
| Q5 | i18n 扩到 22 agent | §12.2 i18n 改动追加 `agent_*` 22 keys |

新的开放问题（v2 引入）：

1. **Inngest 在 P3 是否换成自实现 SQLite job queue？**
   - 保留 Inngest：`npx inngest-cli dev` 仍是外部进程（仅 dev）
   - 自实现：见 §13.4，但要写 ~300 行 worker 代码
   - **暂定保留 Inngest**，Q1 2026 后回顾

2. **EM 网关的 `EM_GATEWAY_MODE`（H2）在 P3 是否保留**？
   - 保留 → 需要 AO 内启 EM 网关 worker
   - 不保留 → 直接走 `bypass`（默认值），P3 只搬运行/审计部分
   - **暂定不保留**（更符合"只接管运行/审计"的 Q1 决议）

---

## 12 · 附录

### 12.1 22 个 WS Agent 速查表

```
1-1  syncFromClientSystem    AI    SCHEDULED_SYNC                          → REQUIREMENT_SYNCED, SYNC_FAILED_ALERT
1-2  manualEntry             Human CLARIFICATION_INCOMPLETE                → REQUIREMENT_LOGGED
2    analyzeRequirement      AI    REQUIREMENT_SYNCED, REQUIREMENT_LOGGED  → ANALYSIS_COMPLETED, ANALYSIS_BLOCKED
3    clarifyRequirement      AI*   ANALYSIS_COMPLETED                      → CLARIFICATION_INCOMPLETE, CLARIFICATION_READY
4    createJD                AI    CLARIFICATION_READY, JD_REJECTED        → JD_GENERATED
5    jdReview                Human JD_GENERATED                            → JD_APPROVED, JD_REJECTED
6    assignRecruitTasks      AI    JD_APPROVED                             → TASK_ASSIGNED
7-1  publishJD               AI[T] TASK_ASSIGNED                           → CHANNEL_PUBLISHED, CHANNEL_PUBLISHED_FAILED
7-2  manualPublish           Human CHANNEL_PUBLISHED_FAILED                → CHANNEL_PUBLISHED
8    resumeCollection        H+sim CHANNEL_PUBLISHED                       → RESUME_DOWNLOADED
9-1  processResume           AI    RESUME_DOWNLOADED                       → RESUME_PROCESSED, RESUME_PARSE_ERROR
9-2  resumeFix               Human RESUME_PARSE_ERROR                      → RESUME_PROCESSED
10   matchResume             AI    RESUME_PROCESSED                        → MATCH_PASSED_NEED_INTERVIEW, MATCH_PASSED_NO_INTERVIEW, MATCH_FAILED
10H  matchFailureReview      Human MATCH_FAILED                            → (review action)
11-1 inviteInternalInterview AI[T] MATCH_PASSED_NEED_INTERVIEW              → INTERVIEW_INVITATION_SENT
11-2 interviewExecution      H/A   INTERVIEW_INVITATION_SENT                → AI_INTERVIEW_COMPLETED
12   evaluateInterview       AI    AI_INTERVIEW_COMPLETED                  → EVALUATION_PASSED, EVALUATION_FAILED
13   refineResume            AI    EVALUATION_PASSED, MATCH_PASSED_NO_INTERVIEW → RESUME_OPTIMIZED
14-1 generatePackage         AI    RESUME_OPTIMIZED                        → PACKAGE_GENERATED, PACKAGE_MISSING_INFO
14-2 packageSupplement       Human PACKAGE_MISSING_INFO                    → PACKAGE_GENERATED
15   packageReview           Human PACKAGE_GENERATED                       → PACKAGE_APPROVED
16   submitToClient          AI[T] PACKAGE_APPROVED                        → APPLICATION_SUBMITTED, SUBMISSION_FAILED

* = AI agent with multi-turn HITL (ChatbotSession)
[T] = terminal agent → emits raas/outbound.pending to EM Phase 7
```

### 12.2 关键文件清单（P1 落地时新建/改）

新建（Next.js Route Handlers + server-only modules）：
- `app/api/agents/route.ts`
- `app/api/runs/route.ts`
- `app/api/runs/[id]/route.ts`
- `app/api/runs/[id]/steps/route.ts`
- `app/api/events/route.ts`
- `app/api/trace/[id]/route.ts`
- `app/api/human-tasks/route.ts`
- `app/api/alerts/route.ts`
- `app/api/datasources/route.ts`
- `app/api/stream/route.ts`（SSE multiplexer · Streaming Response）
- `server/clients/ws.ts`（**server-only** —— P1 用，P3 删）
- `server/clients/em.ts`（**server-only** —— P1 用，P3 删）
- `server/normalize/envelope.ts`（H1 · 三层信封拍平）
- `server/normalize/status.ts`（H9 · run/step status 归一化）
- `server/normalize/agents.ts`（agent_id ↔ short_name）
- `lib/agent-mapping.ts`
- `lib/api/types.ts`
- `lib/api/client.ts`
- `lib/api/sse.ts`（`useSSE` hook）

改：
- [`package.json`](../../../package.json) `dev` script 并发启 next + WS（5175）+ EM（8000）+ Inngest dev（8288）；P3 后改回纯 `next dev`
- 6 个 [`*Content.tsx`](../../../components) 由 mock 切真数据
- [`lib/i18n.tsx`](../../../lib/i18n.tsx) 加 22 agent + 新状态色 + 新路由文案（Q5 决议）
- [`app/globals.css`](../../../app/globals.css) 加 `--c-suspended` `--c-timeout` 等 token

新建（P2）：
- `app/inbox/page.tsx` + `components/inbox/InboxContent.tsx`
- `app/triggers/page.tsx` + `components/triggers/TriggersContent.tsx`
- `app/api/triggers/route.ts`
- `app/api/human-tasks/[id]/route.ts`（POST approve/reject/escalate）

新建（P3）：
- `prisma/schema.prisma`（统一 SQLite，详见 §13）
- `data/ao.db`（运行时生成）
- `server/ws/agents/` ← 22 agent 文件
- `server/ws/skills/` ← 21 Skill 文件
- `server/ws/engine/inngest-adapter.ts`（去 Express 依赖）
- `server/ws/rules/`
- `server/em/audit/`
- `server/em/dlq/`
- `server/em/dedup/`
- `server/em/gateway/`（如 §11.2-Q 保留）
- `app/api/inngest/route.ts`（Inngest serve adapter）

删（P3）：
- `Action_and_Event_Manager/`（整个文件夹从 git 移除；保留在历史 commit 中）
- `agenticOperator/lib/events-catalog.ts`（mock 替代品已上线）
- `agenticOperator/server/clients/{ws,em}.ts`（HTTP 客户端不再需要）

### 12.3 引用代码位置

- AO Workflow 节点定义：[components/workflow/WorkflowContent.tsx:24-43](../../../components/workflow/WorkflowContent.tsx#L24)
- AO Fleet 表 mock：[components/fleet/FleetContent.tsx:25-36](../../../components/fleet/FleetContent.tsx#L25)
- AO 事件目录 mock：[lib/events-catalog.ts](../../../lib/events-catalog.ts)
- WS Agent 注册：[Action_and_Event_Manager/workflow-studio/server/src/agents/index.ts](../../../Action_and_Event_Manager/workflow-studio/server/src/agents/index.ts)
- WS Inngest 适配器：[Action_and_Event_Manager/workflow-studio/server/src/engine/inngest-adapter.ts](../../../Action_and_Event_Manager/workflow-studio/server/src/engine/inngest-adapter.ts)
- WS Prisma 模型：[Action_and_Event_Manager/workflow-studio/server/prisma/schema.prisma](../../../Action_and_Event_Manager/workflow-studio/server/prisma/schema.prisma)
- WS Activity SSE：[Action_and_Event_Manager/workflow-studio/server/src/routes/activity.ts](../../../Action_and_Event_Manager/workflow-studio/server/src/routes/activity.ts)
- EM Editor Agents (E1–E4)：[Action_and_Event_Manager/packages/server/src/routes/editor/agents.ts](../../../Action_and_Event_Manager/packages/server/src/routes/editor/agents.ts)
- EM Manager 路由集合：[Action_and_Event_Manager/packages/server/src/routes/manager/](../../../Action_and_Event_Manager/packages/server/src/routes/manager/)
- AO CLAUDE 约束：[CLAUDE.md](../../../CLAUDE.md)
- AO Roadmap（明确邀请这次迁移）：[README.md:170-181](../../../README.md#L170)

---

## 13 · DB & 状态持久化（Q3 决议）

### 13.1 选型：本地 File system = SQLite 单文件

**决议**：用 [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) 驱动 + Prisma ORM，单文件 `agenticOperator/data/ao.db`。

为什么 SQLite 而不是裸 JSON：
- WS 现有 schema 已 11 张表 + 多索引；裸 JSON 无 join、无索引、无并发安全
- EM 已经是 SQLite，无迁移成本
- "文件系统"语义满足：单文件、无外部进程、git 友好（用 `data/.gitignore` 排除）
- Prisma 同时兼容 SQLite + Postgres，未来切换零代码

**不选**：
- 裸 JSON / lowdb：并发写入丢数据
- LevelDB / DuckDB：需要 native binding 但不带 SQL/Prisma 兼容
- 嵌入式 Postgres：仍是独立进程，违反 Q4

### 13.2 表结构合并

把 WS Postgres schema + EM SQLite schema 中**与运行/审计/网关相关的子集**合并到一份 [`prisma/schema.prisma`](../../../prisma/schema.prisma)（P3 新建）：

来自 WS（必收）：
- `WorkflowRun`, `WorkflowStep`, `AgentActivity`
- `HumanTask`, `ChatbotSession`
- `AgentEpisode`, `AgentConfig`
- `CandidateLock`, `Blacklist`（rule 用）

来自 EM（运行/审计部分，**不含 Editor**）：
- `audit_log`, `dlq_entries`, `dedup_cache`
- `gateway_filter_rules`, `outbound_events`
- `events`（**只读 ACTIVE 状态**——AO 不做编辑，仅缓存契约）

不收（Q1 决议）：
- `event_versions`, `action_snapshots`, `action_diffs`, `agent_tasks`（这些是 Editor 治理用的）
- WS `WorkflowDefinition`（P3 暂用静态 JSON 替代 + 22 agent metadata）

**Postgres → SQLite 兼容性 fix**：
- `@db.Text` 全删（SQLite TEXT 默认无长度上限）
- `@db.VarChar(n)` 全删
- 数组类型 `String[]` → `String` 存 JSON
- `DateTime` 直接兼容
- 全文索引（如有）改为应用层过滤

### 13.3 Migration 路径

```bash
# P3 启动
npm run db:push       # → prisma db push 生成 ao.db
npm run db:seed       # → 注入 22 agent metadata + ACTIVE events 缓存

# 未来切回 Postgres（如需）
DATABASE_URL=postgresql://... \
  prisma migrate dev --name init
```

`prisma/schema.prisma` 的 datasource 块（Prisma schema 不支持 `??`，默认值放 `.env.example`）：
```prisma
datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}
```

`.env.example`：
```
# Default for local dev — override to postgresql://... in CI/prod
DATABASE_URL="file:./data/ao.db"
```

支持环境变量覆盖，CI/prod 可零代码切 Postgres（同时把 `provider` 改为 `postgresql`）。

### 13.4 是否替换 Inngest（开放问题，§11.2-1）

如果 P3 完全去 Inngest（含 dev server）：
- 需要在 SQLite 里建 `job_queue` 表（id / handler / payload / runAt / retries）
- `server/queue/worker.ts` 长 polling SELECT，并发受 SQLite WAL 限制
- 重试 / 退避策略要自己实现
- 工作量约 300 行 + 测试 3 天

暂定**保留 Inngest**：dev 时跑 `npx inngest-cli dev`（仅一个外部 binary，零配置），prod 时切 Inngest Cloud 或自托管。这条不在 P3 阻塞路径。

---

## 14 · 与领导设计契约的对齐

| 领导设计假设 | spec 如何兑现 |
|---|---|
| 6 个角色化视图（Operate / Build / Govern）| 全保留；P2 加 2 个新视图（`/inbox` 进 Operate 组、`/triggers` 进 Build 组）|
| OKLCH token + @theme inline | 不动；P1 仅扩 4 个状态 token |
| Cmd+K 命令面板 | 扩为 4 类资源全可搜（P2）|
| 中英双语 + 暗亮主题 | 全保留；新文案双写（Q5）|
| Inngest 风格事件总线 | P3 真用 Inngest；P1/P2 通过 sidecar 借用 |
| "事件即通用基底" | `/events` 保留为总线视角；`/triggers` 是入口；`/live` 是出口 |
| HITL 是一等公民 | 新加 `/inbox` 路由 + 状态色 token |
| 合规与审计可追溯 | `/events` Logs Tab + `/alerts` 异常 + `audit_log` 表 |
| **零后端依赖**（README 原话）| P1/P2 暂时违背（有 sidecar）；P3 兑现（仅一个 Next.js + 一个 SQLite 文件）|

---

**文档结束。**
