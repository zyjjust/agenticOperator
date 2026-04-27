# P3 进度与剩余工作

> **状态**：4/5 chunk 部分或全部就绪；Chunk 2（代码搬迁，2 周）余下
> **分支**：`ao-int-p3`（基于 main，含 P1+P2+P2.5+P2 firehose fix）
> **更新**：2026-04-27（第二次 session）

---

## ✅ 已完成

### Chunk 1 · Schema 完成（21 tables）

完整 Prisma 7 schema 在 [prisma/schema.prisma](../../../prisma/schema.prisma)。
表清单：

**WS workflow (5)**: WorkflowRun, WorkflowStep, AgentActivity, HumanTask, ChatbotSession
**WS Living KB (3)**: CandidateLock, Blacklist, AgentEpisode
**WS AgentConfig (2)**: AgentConfig, AgentConfigHistory
**EM runtime/audit (3)**: AuditLog, DLQEntry, DedupCache
**EM events/gateway (2)**: EventDefinition (`events`), GatewayFilterRule
**EM outbound/ingest (5)**: OutboundEvent, RaasMessage, RejectedMessage, IngestionConfig, ExecutionTrace
**EM monitoring (1)**: HealthIncident

`npm run db:push` 一键生成；`data/ao.db` 文件大小 ~250KB（21 张表）。

### Chunk 3 · Inngest serve adapter

- [server/inngest/client.ts](../../../server/inngest/client.ts)：`new Inngest({ id: 'agentic-operator' })` + `allFunctions: any[] = []`
- [app/api/inngest/route.ts](../../../app/api/inngest/route.ts)：`serve({ client, functions: allFunctions })` from `inngest/next`
- 路由 build 出现 `ƒ /api/inngest`
- **当前 500**：`allFunctions` 为空，Inngest serve 拒绝空数组。Chunk 2 port 第 1 个 agent 后自动恢复。

### Chunk 4 部分 · 第一个 Route Handler 切到 prisma

**`/api/runs` 已切到 prisma：**
- [`app/api/runs/route.ts`](../../../app/api/runs/route.ts) 不再 import `wsClient`，直接 `prisma.workflowRun.findMany()`
- 响应 shape 不变；浏览器零改动
- Live curl 验证：14 真实 run 来自 ao.db，无 partial flag

**`prisma/seed-from-sidecars.ts`** 桥接脚本：从 WS+EM HTTP 拉真数据 upsert 到 ao.db。
- 一次跑：14 runs + 14 tasks + 20 events
- 幂等（按 id upsert）
- `npm run db:seed` 调用

---

## 🚧 剩余工作

### Chunk 4 · 剩余 13 个 Route Handler 切换（~3 天）

模板已通过 `/api/runs` 验证。每个 Handler ~30 行改动，0 UI 改动。

按依赖排序：

| Route | 当前依赖 | 切到 prisma 用什么模型 | 备注 |
|---|---|---|---|
| `/api/agents` | wsClient.fetchActivityFeed | `agentActivity.groupBy({ agentName })` 聚合 | KPI（p50/cost）仍 null 直到 Episode 数据有 |
| `/api/runs/[id]` | wsClient.fetchRun | `workflowRun.findUnique` | 简单 |
| `/api/runs/[id]/steps` | wsClient.fetchSteps（fallback到 activity）| `workflowStep.findMany({ runId })` | seed 暂不导 step；先返空数组 |
| `/api/events` | emClient.fetchEvents | `eventDefinition.findMany({ where: { status: 'ACTIVE' } })` | seed 已导 20 events |
| `/api/trace/[id]` | wsClient + emClient 并发 | `Promise.all([run, steps, activity, audit, dlq])` | 跨表 join 现在可以 SQL |
| `/api/human-tasks` | wsClient.fetchHumanTasks | `humanTask.findMany({ status: 'pending' })` | seed 已导 14 tasks |
| `/api/human-tasks/[id]` | wsClient.fetchHumanTask | `humanTask.findUnique` | 简单 |
| `/api/human-tasks/[id]` POST | wsClient.resolveHumanTask | 写到 ao.db 同时 emit Inngest event | 需 Chunk 3 Inngest 函数（chicken-and-egg）|
| `/api/human-tasks/[id]/messages` | wsClient.fetchMessages/postMessage | `chatbotSession.update` + 数组 append | LLM 调用需 Chunk 2 |
| `/api/alerts` | wsClient + emClient | `workflowRun.findMany({ status: 'timed_out' })` + `dLQEntry.findMany` | 简单 |
| `/api/datasources` | emClient.fetchHealth | 静态 catalog + （optional `healthIncident.findMany`）| 简单 |
| `/api/triggers` | 静态 + AGENT_MAP | 不变（已是无 sidecar）| 跳过 |
| `/api/stream` | wsClient.openActivityStream（SSE）| Inngest events stream / 自实现 SSE topic | **需 Chunk 2 后 Inngest 在线** |
| `/api/events/[name]/stream` | 同上 | 同上 | 同上 |

**做法**：每切一个 +1 commit。`/api/stream` 和 message POST 留到 Chunk 2 之后（依赖 Inngest 函数）。

### Chunk 2 · 代码搬迁（~2 周聚焦工作）

按 [P3 spec §3](../specs/2026-04-27-ao-int-p3-monorepo-merge-design.md#3-代码搬迁清单)：

```bash
# 大致步骤
mkdir -p server/ws/{agents,skills,engine,rules,services,episodes,ai}
cp -r Action_and_Event_Manager/workflow-studio/server/src/agents/*.ts server/ws/agents/
cp -r Action_and_Event_Manager/workflow-studio/server/src/skills/*.ts server/ws/skills/
# ...etc
# 然后逐文件修：
#   - 改 import 路径（去 .js 扩展名 / 去 Express）
#   - 把 import { serve } from 'inngest/express' 删掉
#   - 把 prisma client 来源切到 @/server/db
#   - 把每个 inngest.createFunction 推到 server/inngest/client.ts allFunctions
```

**关键风险**：22 agent + 21 skill 含 LLM 调用（Anthropic+Gemini）。需要把 [`@anthropic-ai/sdk`](https://www.npmjs.com/package/@anthropic-ai/sdk) + `@google/generative-ai` 加到 dependencies；环境变量 `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` 必须配。

**额外搬运**：EM `services/manager/{audit,dlq,gateway,outbound}` → `server/em/`。EM Editor 路由 (`routes/editor/`) 完全不搬（Q1）。

### Chunk 5 · 删 sidecars + 收尾（~1 天）

```bash
git rm -r Action_and_Event_Manager
# package.json: 删 dev script 里的 ws/em/inngest 子进程
# 改回:  "dev": "concurrently -n next,inngest \"next dev\" \"npx -y inngest-cli@latest dev\""
# 删 server/clients/{ws,em}.ts
git tag p3-complete
```

### 跑 P3 acceptance（[spec §10](../specs/2026-04-27-ao-int-p3-monorepo-merge-design.md#10-验收标准) 11 项）

主要项：
- [ ] `git clone` 5 分钟拉起
- [ ] 只 1 个 Next.js 进程（+ Inngest dev binary）
- [ ] data/ao.db 单文件
- [ ] `Action_and_Event_Manager/` 已删
- [ ] P1+P2 acceptance 全部仍通过
- [ ] traceId 跨表 SQL join 可写
- [ ] `server/clients/{ws,em}.ts` 已删

---

## 估算

| 已完成 | 剩余 |
|---|---|
| 4 chunks 部分（foundation + chunk 1 + chunk 3 + chunk 4 部分）| chunk 2（2 周）+ chunk 4 剩余 13 routes（3 天）+ chunk 5（1 天）|
| ~700 行代码（schema + seed + adapter + 1 route）| ~3500 行 port 代码 + ~400 行 route 改造 |

**剩余 ≈ 3 周聚焦工作**。Chunk 2 是绝对的瓶颈。

---

## 当前 ao-int-p3 分支顶端

```
52d1b78 feat(p3): chunk 4 partial — first Route Handler switches to prisma
2d9ee32 feat(p3): chunk 3 — Inngest serve adapter wired (functions empty until chunk 2)
2ba5f1d feat(p3): chunk 1 — add 11 more models, schema now at 21 tables
1985f51 Merge main (P2 Firehose fix) into ao-int-p3
3df22a9 feat(p3): foundation — Prisma 7 + SQLite + 10 core tables
```

下次会话从 Chunk 4 余下任意 route 接着切，或者攻 Chunk 2 第一波（搬 22 agent metadata 到 server/ws/agents/）。
