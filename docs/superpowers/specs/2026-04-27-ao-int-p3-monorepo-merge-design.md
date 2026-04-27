# AO-INT-P3 · 仓内 Next.js 合一 + SQLite 单文件 · 详细设计

> **父 spec**：[2026-04-27-agentic-operator-integration-design.md](2026-04-27-agentic-operator-integration-design.md)
> **前置**：P1 + P2 全部验收通过
> **阶段**：P3（第 6–10 周）· **代号**：AO-INT-P3
> **作者**：Steven · **日期**：2026-04-27 · **状态**：草案

---

## 0 · 目标

兑现领导诉求"所有都在 AgenticOperator 的前端框架里实现"——P3 末：

- `git clone` 一个仓 + `npm install` + `npm run dev` 5 分钟拉起完整栈
- **只一个 Next.js 进程**（3002）+ Inngest dev binary（仅 dev）
- **只一个 SQLite 文件** `data/ao.db`
- `Action_and_Event_Manager/` 整个文件夹从仓里删除（保留在 git 历史）
- 所有 P1 P2 功能 0 退化

## 1 · 范围

### 1.1 In Scope

- 把 WS server 中**运行/审计/网关相关**的 TypeScript 模块**作为 server-only**搬入 [`agenticOperator/server/`](../../../server)
- 把 EM server 中**运行/审计/网关相关**的模块同样搬入
- 合并两份 `prisma/schema.prisma` 为一份，引擎切 SQLite
- WS Postgres 类型 → SQLite 兼容 fix
- Inngest 由 `inngest/express` 改为 `inngest/next` adapter
- `app/api/*` Route Handler 内部从 `server/clients/{ws,em}.ts` HTTP 调用，改为直接 import `server/ws/*` `server/em/*` 模块函数
- 删除 `Action_and_Event_Manager/`（含 WS web、EM web）
- 删除 P1 临时的 `server/clients/{ws,em}.ts`
- 修订 `package.json` `scripts.dev` 从 4 进程退回 1 进程（+ Inngest dev）
- 全量功能回归（P1 + P2 验收清单全跑一遍）

### 1.2 Out of Scope

- EM Editor 治理（Q1 决议：不迁）
- WS Copilot（Q2 决议：不迁）
- Postgres 切回（保留路径，不在本期执行）
- Inngest 替换为自实现 SQLite job queue（开放问题，本期保留 Inngest）
- 认证 / 多租户 / 生产部署（→ P4）
- 性能优化（除非低于 P1/P2 已设预算）
- WS 中"editor 触发器"（routes/editor/*）相关代码——**全部删**，因 EM Editor 不迁

## 2 · 拓扑变化

### 2.1 P3 之前（P2 末）

```
[Browser] → AO Next.js (3002) → 4 进程拓扑（WS 5175 / EM 8000 / Inngest 8288）
                              + 2 sidecar DBs (Postgres + sqlite)
```

### 2.2 P3 之后

```
[Browser] → AO Next.js (3002)
              ├─ app/  (pages + Route Handlers)
              ├─ server/  (server-only modules, 由 Route Handlers 直接 import)
              │   ├─ ws/agents/      ← 22 agent 定义
              │   ├─ ws/skills/      ← 21 Skill
              │   ├─ ws/engine/      ← Inngest adapter (无 Express)
              │   ├─ ws/rules/
              │   ├─ ws/kb/          ← Living KB（如保留）
              │   ├─ em/audit/
              │   ├─ em/dlq/
              │   ├─ em/dedup/
              │   ├─ em/gateway/     ← 视开放问题决议
              │   └─ db/             ← Prisma client
              ├─ prisma/schema.prisma   ← 单一 schema
              └─ data/ao.db             ← 单一 SQLite 文件

外部依赖（仅 dev）：
  - npx inngest-cli dev (8288)   ← 触发 Inngest functions 的事件总线
                                   生产替换为 Inngest Cloud 或自托管
```

## 3 · 代码搬迁清单

### 3.1 从 WS 搬入 → `server/ws/`

| 源（`Action_and_Event_Manager/workflow-studio/server/src/`）| 目标（`agenticOperator/server/`）|
|---|---|
| `agents/` 22 文件（含 helpers/）| `ws/agents/` |
| `skills/` 21 文件 | `ws/skills/` |
| `engine/inngest-adapter.ts` | `ws/engine/inngest-adapter.ts` （改造，见 §5）|
| `engine/agent-metadata.ts` | `ws/engine/agent-metadata.ts` |
| `engine/agent-failure-handler.ts` | `ws/engine/agent-failure-handler.ts` |
| `engine/run-sweeper.ts` | `ws/engine/run-sweeper.ts` |
| `engine/activity-logger.ts` | `ws/engine/activity-logger.ts` |
| `engine/workflow-engine.ts`（接口）| `ws/engine/workflow-engine.ts` |
| `engine/inngest-event-schemas.ts` | `ws/engine/inngest-event-schemas.ts` |
| `rules/` 全部 | `ws/rules/` |
| `kb/context-retriever.ts`（如保留）| `ws/kb/` |
| `services/event-validator.ts` | `ws/services/event-validator.ts` |
| `services/agent-config.service.ts` | `ws/services/agent-config.service.ts` |
| `services/human-task.store.ts` | `ws/services/human-task.store.ts` |
| `services/ontology-context.ts` | `ws/services/ontology-context.ts` |
| `services/ground-truth-seeds.ts` | `ws/services/ground-truth-seeds.ts` |
| `episodes/episode-writer.service.ts` | `ws/episodes/episode-writer.service.ts` |
| `ai/` 全部（base-skill / providers / structured-output / etc.）| `ws/ai/` |
| `clients/neo4j*.ts`（如保留 Neo4j）| `ws/clients/` |
| `db.ts` | （并入 `server/db/index.ts`）|

### 3.2 从 EM 搬入 → `server/em/`

| 源（`Action_and_Event_Manager/packages/server/src/`）| 目标 |
|---|---|
| `services/manager/` 中 audit / dlq / dedup / gateway / outbound 相关 | `em/audit/`, `em/dlq/`, `em/dedup/`, `em/gateway/`, `em/outbound/` |
| `routes/manager/{audit,dlq,dedup,gateway,outbound}.ts` | **不搬路由**——逻辑入 `app/api/*` Route Handler 直接调 service |
| `utils/correlationId.ts` 等 | `em/utils/` |
| `db.ts` | （并入 `server/db/index.ts`）|

### 3.3 不搬（删除）

- WS：`routes/copilot.ts`、`copilot/*`、`generator/*`、`studio/*`、`fixtures/*`、`__tests__/*`（保留并入 AO 自己的测试）、`routes/*` 其他（被 Route Handler 替代）
- WS web 整个 `workflow-studio/web/`
- EM：`routes/editor/*`（含 E1–E4）、`services/editor/*`（含 lint / aiReview）、整个 `packages/web/`
- 旧 Python 模块（`event_editor/`、`event_manager/`、`shared/`、`frontend/`、`simulator/`）已是死代码，一并删

### 3.4 删除时机

第 9 周（P3 验收前 1 周）一次性 `git rm -r Action_and_Event_Manager/`。在此之前先做"导入指向切换"——确保 `server/ws/*` `server/em/*` 都 import 自身相对路径，不再指向 `Action_and_Event_Manager/`。

## 4 · Prisma Schema 合并 + SQLite 兼容

### 4.1 新建 `prisma/schema.prisma`

```prisma
generator client { provider = "prisma-client-js" }

datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")  // 默认值在 .env.example: "file:./data/ao.db"
}
```

### 4.2 表合并清单

| 来源 | 模型 | 处理 |
|---|---|---|
| WS | `WorkflowDefinition` | **不搬**（用静态 `lib/workflow-meta.ts` 替代）|
| WS | `WorkflowRun` | 搬，去 `@db.Text` |
| WS | `WorkflowStep` | 搬 |
| WS | `AgentActivity` | 搬 |
| WS | `HumanTask` | 搬 |
| WS | `ChatbotSession` | 搬 |
| WS | `AgentEpisode` + `AgentEpisodeStats` + `AgentPatterns` + `AgentSpans` + `AgentBlackboard` | 搬（Living KB Layer 1/2/4）|
| WS | `AgentConfig` | 搬 |
| WS | `CandidateLock` `Blacklist` | 搬（rule 用）|
| EM | `events` | 搬，但 P3 默认**只读**（status='ACTIVE' 缓存自 P1 catalog）|
| EM | `audit_log` | 搬 |
| EM | `dlq_entries` | 搬 |
| EM | `dedup_cache` | 搬 |
| EM | `gateway_filter_rules` | 搬（如 §11 开放问题决议保留 gateway）|
| EM | `outbound_events` | 搬 |
| EM | `event_versions` | **不搬**（Q1 → 无 Editor）|
| EM | `action_snapshots`、`action_diffs`、`change_logs`、`agent_tasks` | **不搬**（Editor 治理）|
| EM | `raas_messages`、`rejected_messages` | 搬（运行时审计依赖）|
| EM | `audit_events` | 搬 |
| EM | `ingestion_configs` | 搬 |
| EM | `happy_paths`、`chain_sessions`、`chain_breakpoints` | **暂不搬**（链路回放工具，P4 再议）|
| EM | `dataset_snapshots`、`import_batches` | 暂不搬 |
| EM | `execution_traces` | 搬（监控依赖）|
| EM | `health_incidents` | 搬 |
| EM | `review_queue` | **不搬**（Editor 治理） |

最终 ≤ 25 张表（WS 14 + EM 11）。

### 4.3 Postgres → SQLite 兼容 fix 清单

| Postgres 用法 | SQLite 等效 | 影响范围 |
|---|---|---|
| `@db.Text` | 删除（SQLite TEXT 无长度上限）| WS 大量 |
| `@db.VarChar(n)` | 删除 | 少量 |
| `String[]`（数组类型）| `String` 存 JSON，应用层 parse | 极少 |
| Postgres 全文索引 | 应用层过滤或 SQLite FTS5（仅按需）| 0–1 处 |
| `@@index([col1, col2])` 多列复合 | 直接保留（SQLite 兼容）| 已有 |
| `Decimal` 精度 | `Float`（SQLite 没真正 Decimal） | 检查 cost/spend 字段 |
| `DateTime` | 兼容 | — |
| `Json` 列 | `String` + 应用层 JSON.parse/stringify | 检查所有 metadata/payload 列 |

### 4.4 Migration 步骤

1. 建空 `prisma/schema.prisma`
2. 把每一张要搬的表逐一 copy 过来，运行 `prisma format` 检查
3. 写 `prisma/seed.ts`：
   - 注入 22 agent 静态 metadata
   - 注入 ACTIVE 事件契约缓存（从 P1 已固化的 catalog）
   - 可选：注入 demo run 数据（用于 dev 体感）
4. `npm run db:push` 生成 `data/ao.db`
5. 验证：`sqlite3 data/ao.db .schema` 看每张表都在
6. 写一次性脚本（不入仓）：把 dev 机上现有 EM/WS DB 的真实数据 dump 到 `ao.db`，验证 P1/P2 功能在合并后 DB 上仍 OK

### 4.5 `.env.example`

```
# Defaults work out of the box for local dev
DATABASE_URL="file:./data/ao.db"

# AI provider keys (P3 把 WS 现有的 AI 配置带过来；不在 spec 范围深入)
ANTHROPIC_API_KEY=
GEMINI_API_KEY=

# Inngest config (dev: inngest-cli; prod: cloud or self-hosted)
INNGEST_EVENT_KEY=
INNGEST_SIGNING_KEY=
```

## 5 · Inngest 适配器改造（`inngest/next`）

### 5.1 现状（WS）

```ts
import { Inngest } from 'inngest';
import { serve as inngestServe } from 'inngest/express';
// app.use('/api/inngest', inngestServe({ client, functions }));
```

### 5.2 P3

新建 [`app/api/inngest/route.ts`](../../../app/api/inngest/route.ts)：

```ts
import { serve } from 'inngest/next';
import { inngestClient, allFunctions } from '@/server/ws/engine/inngest-client';

export const { GET, POST, PUT } = serve({
  client: inngestClient,
  functions: allFunctions,
});
```

### 5.3 改造 `server/ws/engine/inngest-adapter.ts`

- 删除 `import { serve as inngestServe } from 'inngest/express'`
- 删除 `serve()` 方法（Next.js Route Handler 接管）
- 保留 `Inngest` client 实例 + 全部 `inngest.createFunction(...)` 注册逻辑
- 暴露 `inngestClient` + `allFunctions`（被 `app/api/inngest/route.ts` 引用）

### 5.4 启动顺序

```bash
npm run dev          # 起 Next.js (3002)
npx inngest-cli dev  # 起 Inngest dev runtime (8288)
```

`scripts.dev` 用 `concurrently` 二者并起：

```json
"dev": "concurrently -n next,inngest -c blue,magenta \"next dev\" \"inngest-cli dev\""
```

### 5.5 生产部署提示（不在 P3 范围深入）

- Inngest Cloud：替换 `inngestClient = new Inngest({ id: 'ao' })` 为带 cloud key
- 自托管：单独部署 Inngest server，AO 通过 INNGEST_BASE_URL 指向

## 6 · `app/api/*` Route Handler 内部改造

### 6.1 P2 末状态

```ts
// app/api/runs/route.ts (P1 + P2)
import { wsClient } from '@/server/clients/ws';
import { normalizeRunStatus } from '@/server/normalize/status';

export async function GET(req: Request) {
  const wsRuns = await wsClient.fetchRuns(...);
  return Response.json({ runs: wsRuns.map(toRunSummary) });
}
```

### 6.2 P3 末状态

```ts
// app/api/runs/route.ts (P3)
import { listRuns } from '@/server/ws/services/runs.service';

export async function GET(req: Request) {
  const runs = await listRuns(...);  // 直接 Prisma 查询 ao.db
  return Response.json({ runs });
}
```

### 6.3 改造路径

每个 P1 P2 已有的 Route Handler 都做一次 import 切换。**不改 response 结构**——这样浏览器端零改动，验收复用 P1/P2 acceptance。

清单（10 + 4 = 14 个 Route Handler）：
- [P1] `agents` `runs` `runs/[id]` `runs/[id]/steps` `events` `trace/[id]` `human-tasks` `alerts` `datasources` `stream`
- [P2] `human-tasks/[id]` `human-tasks/[id]/messages` `triggers` `events/[name]/stream`

每个改造 ≤30 行，5 天内全部切完。

### 6.4 删除

切完所有 import 后：
```bash
rm -rf server/clients/
```

`server/normalize/` 保留（业务级归一化仍有价值，比如 envelope flatten 在 P3 也用得上——只是数据从 in-process Inngest 来，envelope 不再三层；但归一化函数 ABI 不变）。

## 7 · 启动脚本简化

### 7.1 `package.json` 变更

```diff
"scripts": {
- "dev": "concurrently -n next,ws,em,inngest ... 4 个进程",
+ "dev": "concurrently -n next,inngest -c blue,magenta \"next dev -p 3002\" \"inngest-cli dev\"",
  "build": "prisma generate && next build",
  "start": "next start -p 3002",
- "lint": "next lint"
+ "lint": "next lint",
+ "db:push": "prisma db push",
+ "db:seed": "tsx prisma/seed.ts",
+ "db:reset": "rm -f data/ao.db && npm run db:push && npm run db:seed"
},
"devDependencies": {
+ "prisma": "^6.3.0",
+ "@prisma/client": "^6.3.0",
+ "better-sqlite3": "^11.0.0",
+ "concurrently": "^9.0.0",
+ "tsx": "^4.19.0"
},
"dependencies": {
+ "inngest": "^3.31.0",
+ "@anthropic-ai/sdk": "^0.39.0",
+ "@google/generative-ai": "^0.24.1",
+ "zod": "^3.24.0"
+ // …（按 WS 现有依赖移过来，去掉 express/cors）
}
```

### 7.2 `.gitignore` 增量

```
# AO P3+
data/*.db
data/*.db-journal
data/*.db-wal
data/*.db-shm
.inngest/
```

## 8 · 删除 `Action_and_Event_Manager/`

### 8.1 时机

P3 第 9 周末，全部 `app/api/*` 已切到 `server/ws/*` `server/em/*` import 之后。

### 8.2 命令

```bash
git rm -r Action_and_Event_Manager
git commit -m "AO-INT-P3: remove Action_and_Event_Manager monorepo (migrated to server/)"
```

历史保留——任何时候 `git log --follow Action_and_Event_Manager/...` 仍可查。

### 8.3 验证

删除后立即跑：
```bash
npm install && npm run db:reset && npm run dev
```

预期：3002 + 8288 起，浏览器访问 6 + 2 = 8 个路由全部正常。

## 9 · 性能预算

P3 在 P2 基础上**只能不变或更好**。新加几条因 in-process 调用而预期改善的：

| 指标 | P2 预算 | P3 预算 | 改善理由 |
|---|---|---|---|
| `/api/runs` p95 | ≤200ms | ≤100ms | 去 HTTP 跳一层 |
| `/api/trace/[id]` p95 | ≤500ms | ≤300ms | 同库可 join，无须内存合并 |
| `/api/agents` p95 | ≤300ms | ≤200ms | 同上 |
| 启动到首页 ready | ~12s（4 进程串行）| ~5s（1 进程）| 进程数减少 |
| 内存峰值 | 4 进程 ~600MB | 1 进程 ~250MB | 单进程 |

## 10 · 验收标准

- [ ] **`git clone` 5 分钟拉起**：新机克隆仓 → `npm install` → `npm run db:reset` → `npm run dev`，5 分钟内浏览器看到 `/fleet`
- [ ] **只 1 个 Next.js 进程**：`ps aux | grep node` 不出现 ws/em server，仅 next + inngest-cli
- [ ] **单 SQLite 文件**：`ls data/` 只有 `ao.db`（+ wal/journal）
- [ ] **`Action_and_Event_Manager/` 已删**：`ls` 不存在，git 历史可追溯
- [ ] **P1 全部 acceptance 仍通过**：跑 P1 §11 验收清单（11 项）
- [ ] **P2 全部 acceptance 仍通过**：跑 P2 §9 验收清单（10 项）
- [ ] **traceId 跨表 SQL join 可写**：在 sqlite3 命令行 `SELECT ... FROM workflow_runs r JOIN audit_log a ON a.trace_id = r.id`
- [ ] **P3 性能预算达标**：5 个指标实测都达 §9
- [ ] **`server/clients/{ws,em}.ts` 已删**：grep 仓内无 import 引用
- [ ] **dev 启动只起 2 个进程**：next + inngest-cli；不再有 4 进程并发
- [ ] **prod build OK**：`npm run build` + `npm run start` 单进程跑通

## 11 · 风险（P3 高于 P1/P2）

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| WS Postgres-only 类型在 SQLite 行为不同（最常见：JSON 列）| 高 | 高 | §4.3 fix 清单逐条核；新建 `prisma/migration-test.spec.ts` 跑核心 CRUD |
| 现有 dev 数据从 Postgres 迁到 SQLite 数据丢失或截断 | 中 | 中 | 一次性 dump 脚本带 dry-run；保留 Postgres backup 1 周 |
| Inngest functions 在 Next.js Route Handler 路径下注册时序问题（cold start）| 中 | 中 | 用 [Inngest Next.js best practices](https://www.inngest.com/docs/sdk/serve#nextjs)；Vercel-style cold start 测 |
| 22 agent + 21 skill 的依赖图带新 npm 包 (e.g. neo4j-driver, ts-morph)，安装大 | 中 | 低 | 只搬运行必需，砍掉 generator/studio 依赖；npm install 时间监控 ≤2min |
| 删 `Action_and_Event_Manager/` 时漏 import，build 失败 | 中 | 中 | 第 9 周删之前先 `tsc --noEmit` 全量检查；在 worktree 试删 |
| Prisma schema 合并冲突（同名表 / 字段冲突）| 低 | 中 | WS/EM 表名前缀已不同，预审一遍 |
| HumanTask `ChatbotSession` 多表关系迁过来后外键约束不通 | 低 | 中 | seed 一份完整 fixture 跑通才合并 |
| Living KB（AgentEpisode 等）数据量大，SQLite 写入慢 | 低 | 中 | 启用 SQLite WAL 模式（`PRAGMA journal_mode=WAL`）；监控写延迟 |

## 12 · 不在 P3 范围

- Postgres 切回（路径已留：env 变量 + provider 改字符串；不主动验证）
- 任何业务功能新增（产品诉求保留 P4）
- 认证 / RBAC（→ P4）
- 多租户隔离（→ P4）
- 生产部署 dockerfile / k8s manifest（→ P4）
- 监控告警接 SaaS 平台（→ P4）
- 审计合规外部对接（→ P4）

## 13 · 完成定义（一句话）

> 第 10 周末，AO 仓 `git clone` 后无外部依赖（除 npm + 一个 Inngest dev binary）即可完整运行；浏览器看到的功能与 P2 末完全一致；`Action_and_Event_Manager/` 已不存在；产品体感"AO 是一个独立完整的 RPO Ops 控制台"。
