# P3 Foundation · 进度与剩余工作

> **状态**：foundation 已落，余下 4-9 周工作分布在 5 个 chunk
> **分支**：`ao-int-p3`（基于 main，含 P1+P2+P2.5）
> **日期**：2026-04-27

---

## ✅ Foundation 已完成（本次提交）

1. 分支 `ao-int-p3` 创建
2. **Prisma 7 + SQLite + better-sqlite3 adapter** 装好（package.json + prisma.config.ts）
3. **prisma/schema.prisma**：10 张核心表（WorkflowRun / WorkflowStep / AgentActivity / HumanTask / ChatbotSession / CandidateLock / Blacklist / AuditLog / DLQEntry / DedupCache）
4. **`data/ao.db`** SQLite 文件创建，10 张表 schema 落地（`npm run db:push` 可重做）
5. **server/db/index.ts** Prisma client 单例（用 PrismaBetterSqlite3 adapter 满足 Prisma 7 要求）
6. **package.json** 添加 `db:push` / `db:reset` / `db:studio` 脚本
7. **.env.example** 更新 P3 默认值（SQLite 文件 + sidecar URLs 标注 P3 后无用）
8. **.gitignore** 排除 `data/*.db*` 和 `.inngest/`
9. **80 tests pass**（79 P2 + 1 prisma smoke test）；tsc clean；build green

---

## 🚧 剩余工作（5 chunks）

### Chunk 1 · Schema 完成（~2 天）

新增 ~15 张表至 [prisma/schema.prisma](../../../prisma/schema.prisma)：

**WS 还需搬：**
- `AgentEpisode`（Living KB Layer 4 — token usage / quality / decisions trace）
- `AgentEpisodeStats`（聚合统计）
- `AgentPattern`（识别出的 agent 模式）
- `AgentSpan`（OpenTelemetry-like span）
- `AgentBlackboardEntry`（agent 间协作的 blackboard）
- `AgentConfig`（per-agent 温度/prompt/路由配置）
- `AgentConfigHistory`（配置变更审计）

**EM 还需搬（runtime-only，不含 Editor）：**
- `EventDefinition`（**只读 ACTIVE 状态**——AO 不做编辑）
- `GatewayFilterRule`
- `OutboundEvent`（Phase 7 外发队列）
- `RaasMessage` + `RejectedMessage`
- `IngestionConfig`
- `HealthIncident`
- `ExecutionTrace`

每张表加完跑一次：`npm run db:push` + 写 1 个 prisma CRUD smoke test。

### Chunk 2 · 代码搬迁（~2 周）

按 [P3 spec §3.1-3.2](../specs/2026-04-27-ao-int-p3-monorepo-merge-design.md#31-从-ws-搬入--serverws) 一次性搬：

- `Action_and_Event_Manager/workflow-studio/server/src/{agents,skills,engine,rules,kb,services,episodes,ai,clients}` → `agenticOperator/server/ws/`（22 agent + 21 skill + 整个 inngest engine）
- `Action_and_Event_Manager/packages/server/src/{services/manager/{audit,dlq,dedup,gateway,outbound},routes/manager/{audit,dlq,...}}` → `agenticOperator/server/em/`

**关键调整：**
- 移除 `import { serve } from 'inngest/express'`，改用 `inngest/next` 适配器
- `prisma` 从 sidecar 重新导入到本仓 `server/db/index.ts`
- ESM `.js` 扩展名问题：搬过来后 `npm run build` 跑一次必失败，需要适配 Next.js 的 module 解析（建议改回相对 import 不带 `.js`）

### Chunk 3 · Inngest serve via Next.js（~1 天）

新建 [`app/api/inngest/route.ts`](../../../app/api/inngest):
```ts
import { serve } from 'inngest/next';
import { inngestClient, allFunctions } from '@/server/ws/engine/inngest-client';
export const { GET, POST, PUT } = serve({ client: inngestClient, functions: allFunctions });
```

启动顺序：
- dev：`next dev` + `npx inngest-cli dev` 两进程
- prod：Inngest Cloud 或自托管

### Chunk 4 · Route Handlers 切换源（~3 天）

把当前 `app/api/*` 14 个 Route Handler 内部从 `wsClient.fetch*` 改为直接 `prisma.workflowRun.findMany(...)`。

每个 Route Handler 改造 ≤30 行；不改 response shape，**浏览器端零改动**。改完一个就删除对应的 `server/clients/{ws,em}.ts` 引用。

最后整体 `rm -rf server/clients/`。

### Chunk 5 · 删除 sidecars + 收尾（~1 天）

```bash
git rm -r Action_and_Event_Manager
git commit -m "AO-INT-P3: remove sidecars (migrated to server/)"
```

修订 `package.json` `dev` script 从 4 进程降回 2 进程：
```json
"dev": "concurrently -n next,inngest -c blue,magenta \"next dev -p 3002\" \"npx -y inngest-cli@latest dev\""
```

跑 P3 acceptance（[P3 spec §10](../specs/2026-04-27-ao-int-p3-monorepo-merge-design.md#10-验收标准) 11 项）+ tag `p3-complete`。

---

## 风险与注意

| 风险 | 缓解 |
|---|---|
| WS Postgres-only 类型在 SQLite 行为不同（特别是 JSON、Decimal） | Chunk 1 每加一张表跑 CRUD smoke test |
| WS dev 数据迁过来丢/截断 | dump 脚本带 dry-run；保留 Postgres 备份 1 周 |
| Inngest functions 注册时序 | 用 [Inngest Next.js 文档](https://www.inngest.com/docs/sdk/serve#nextjs) 推荐模式 |
| 22 agent + 21 skill 的依赖图带新 npm 包（neo4j-driver、ts-morph）| 砍 generator/studio/copilot 依赖；监控 install 时间 |
| 删 sidecar 时 import 漏掉 | 第 9 周删之前先 `tsc --noEmit` 全量检查；用 worktree 试删 |
| Prisma 7 vs 6 schema 差异 | adapter API 变化（已在 foundation 处理）；migration 路径用 `db:push` 而非 `migrate dev` |

---

## 当前可继续点

下次会话从 Chunk 1 开始：

```bash
git checkout ao-int-p3
# 打开 prisma/schema.prisma，补 ~15 张表
# 每加一张就 `npm run db:push` + 写 smoke test
```

或者跳到 Chunk 2 的代码搬迁，让 schema 跟随实际使用增量补全。

**估计总剩余工时**：4–5 周聚焦工作（10 person-days schema + 10 移码 + 1 inngest + 3 route handlers + 1 cleanup）。
