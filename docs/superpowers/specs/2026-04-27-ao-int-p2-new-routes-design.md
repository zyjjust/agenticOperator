# AO-INT-P2 · 新路由（HITL Inbox + Triggers + Firehose）· 详细设计

> **父 spec**：[2026-04-27-agentic-operator-integration-design.md](2026-04-27-agentic-operator-integration-design.md)
> **前置**：P1 已交付，[2026-04-27-ao-int-p1-sidecar-design.md](2026-04-27-ao-int-p1-sidecar-design.md) §11 全部验收通过
> **阶段**：P2（第 4–5 周）· **代号**：AO-INT-P2
> **作者**：Steven · **日期**：2026-04-27 · **状态**：草案

---

## 0 · 目标

补领导设计里**未覆盖**的 3 个功能区，让 AO 真正能"操作"而不只是"看"：

1. `/inbox`：HITL 队列 + 多轮对话——5 个 Human agent 终于有出口 UI
2. `/triggers`：cron + webhook + upstream-emit 三类触发器统一视图——目前埋在事件表里看不见
3. `/events` 加 Firehose Tab：在不新建路由前提下，给"实时事件流"找个家
4. CmdPalette 升级：注册 4 类资源（agent / run / human-task / event）让 ⌘K 真能 2 步到达任何对象

## 1 · 范围

### 1.1 In Scope

- 新增 2 个路由：`/inbox`、`/triggers`
- `/events` 已有 6 Tab 上加第 7 个 Firehose Tab
- CmdPalette 重构：从静态 mock 命令变成动态资源搜索
- 新增 4 个 Route Handler（详见 §3）
- 扩 i18n 约 25 个新 key
- LeftNav 新增 2 项

### 1.2 Out of Scope

- WS Copilot 接入（Q2 决议：不迁）
- EM Editor（DRAFT/AI_REVIEWING/CONFIRMED 状态机 UI）（Q1 决议：不迁）
- 任何后端代码搬迁（→ P3）
- DB 引擎切换（→ P3）
- 触发器编辑（P2 只读，编辑能力留给 P4 或更后）
- HumanTask 分配 / 转派（P2 只支持 approve/reject/escalate，分配留 P4）
- React Flow（如 P1 没做，P2 仍不做；视觉重做单独立项）

## 2 · 拓扑变化

P2 不改变 P1 的形态。仍是 AO Next.js + 2 个 sidecar；只是 Route Handler 多了 4 个，前端多了 2 个 page。

```
Browser
   ↓
AO Next.js (3002)
 ├─ Pages
 │   /fleet  /workflow  /live  /events  /alerts  /datasources
 │   /inbox*    ← P2 new
 │   /triggers* ← P2 new
 ├─ app/api/
 │   (...P1 之 10 个路由保持不变)
 │   /human-tasks/[id]              ← P2 new (POST approve/reject/escalate)
 │   /human-tasks/[id]/messages     ← P2 new (POST 多轮对话)
 │   /triggers                      ← P2 new (GET 列表)
 │   /events/[name]/stream          ← P2 new (SSE 单事件实时流)
 └─ server/
     (...同 P1 不变)
```

## 3 · 新增 Route Handler

### 3.1 `POST /api/human-tasks/[id]`

**用途**：approve / reject / escalate。

**Request body**：
```ts
type HumanTaskAction =
  | { action: 'approve'; comment?: string }
  | { action: 'reject';  reason: string }
  | { action: 'escalate'; targetClient: string };  // 创建 child ChatbotSession
```

**Response 200**：
```ts
type HumanTaskActionResult = {
  task: HumanTaskDetail;       // 更新后的 task
  emittedEvents: string[];     // 由该决策触发的下游 event 名
  newChildSession?: string;    // escalate 时返
};
```

**实现**：转发给 WS `POST /api/human-task/:id/resolve`（已存在），处理响应错误归一化。

### 3.2 `GET/POST /api/human-tasks/[id]/messages`

**用途**：ChatbotSession 多轮对话。

**`GET`**：返该 task 关联的 ChatbotSession 全部消息。
```ts
type Messages = { sessionId: string | null; messages: Message[] };
type Message = {
  role: 'user' | 'assistant' | 'system' | 'client';
  content: string;
  timestamp: string;
};
```

**`POST`**：用户发一条消息。
```ts
type MessagePost = { content: string };
```
返 200 + 增量后的 messages 列表（不全量，只增量）。

**实现**：转发 WS `routes/human-task.ts` 中已有的 chat 端点。

### 3.3 `GET /api/triggers`

**用途**：`/triggers` 三类触发器视图。

**Request**：`?kind=cron|webhook|upstream` (CSV; default = all)

**Response 200**：
```ts
type TriggersResponse = { triggers: TriggerDef[] };

type TriggerDef = {
  id: string;
  kind: 'cron' | 'webhook' | 'upstream';
  name: string;                 // "cron.rms-sync" / "POST /webhook/zhiying"
  description: string;
  emits: string[];              // 触发后会发的事件名
  // 因 kind 而异
  schedule?: string;            // cron expr（kind='cron'）
  endpoint?: string;            // (kind='webhook')
  upstreamEvent?: string;       // (kind='upstream'，即外部系统 emit 的事件名)
  lastFiredAt: string | null;
  nextFireAt: string | null;    // 仅 cron
  fireCount24h: number;
  errorCount24h: number;
};
```

**来源**：
- `cron` ← WS `run-sweeper` cron 列表 + `lib/triggers-static.ts`
- `webhook` ← EM `/api/manager/raasEvents` 暴露的入口（推断 + static catalog）
- `upstream` ← AGENT_MAP 中 trigger 但无 publisher 的事件名（即"被外部 emit"）

### 3.4 `GET /api/events/[name]/stream`

**用途**：`/events` Firehose Tab 实时流。

**实现**：复用 P1 `/api/stream` 但参数化为单个 event name；服务端订 WS SSE 后只转发 `event.name === [name]` 的条目。

## 4 · 页面规格

### 4.1 `/inbox` HITL 队列

#### 4.1.1 文件

- `app/inbox/page.tsx`：thin shell，`<Shell crumbs={...}><InboxContent /></Shell>`
- `components/inbox/InboxContent.tsx`：主要逻辑

#### 4.1.2 三列布局

```
┌─────────────────────────────────────────────────────────────┐
│ Sub-header: KPI strip                                       │
│   待办 12 · 即将超时 2 · 今日已处理 38 · 平均响应 22min      │
├──────────────┬──────────────────────────┬───────────────────┤
│ 左 280px     │ 中（main）              │ 右 320px         │
│ ─────        │ ────                    │ ────             │
│ Facet 筛选： │ HumanTask 列表（卡片）  │ 选中任务详情：   │
│  • 全部 12   │ ┌────────────────────┐  │  - AI 意见       │
│  • 我负责 4  │ │ #task-id  截止 2h │  │  - Payload diff  │
│  • 即将超时2 │ │ JD 审批 / ABC 公司│  │  - 多轮对话历史 │
│  • Stage:    │ │ assignee · 18min  │  │  - 操作面板：    │
│    JD 5      │ ├────────────────────┤  │    [Approve]     │
│    Package 3 │ │ ...                │  │    [Reject + 理由]│
│    Resume 4  │ │                    │  │    [Escalate ▼]  │
│              │ └────────────────────┘  │                  │
└──────────────┴──────────────────────────┴───────────────────┘
```

#### 4.1.3 数据流

- 列表 ← `/api/human-tasks?status=pending`（P1 已建，扩 query）
- 选中详情 ← `/api/human-tasks/[id]`（**P2 新加 GET 单任务**——补在 §3.1 同 file）
- 多轮对话 ← `GET /api/human-tasks/[id]/messages`
- 操作 ← `POST /api/human-tasks/[id]`
- 实时刷新（新任务到达）← P1 已有 `/api/stream` 加 `type=human_waiting` filter

#### 4.1.4 ChatbotSession 渲染规则

仅当 task 关联 `humanTaskId.chatbotSession` 时显示对话面板。否则只显示 `aiOpinion + payload` 简单审批界面。

```tsx
{task.chatbotSession ? <ChatPane sessionId={...} /> : <SimpleApproval task={task} />}
```

#### 4.1.5 SLA 倒计时

`HumanTask.deadline - now` 用 `<time>` 元素 + `useTick(1000)` 自更新：
- 剩 >2h：灰色
- 剩 30m–2h：琥珀色 (`text-suspended`)
- 剩 <30m：红色 (`text-timed-out`)
- 已超时：红底白字 + ⚠

### 4.2 `/triggers` 触发器视图

#### 4.2.1 文件

- `app/triggers/page.tsx` thin shell
- `components/triggers/TriggersContent.tsx`

#### 4.2.2 布局

三 Tab 横向：`Cron` / `Webhook` / `Upstream Emit`，每 Tab 一张表。

```
┌─────────────────────────────────────────────────────────────┐
│ Sub-header                                                  │
│   Cron 6 · Webhook 12 · Upstream 8 · 24h 触发 1,204 · 错 2  │
├──────┬──────────────────────────────────────────────────────┤
│ Tab  │ Cron / Webhook / Upstream Emit                       │
├──────┴──────────────────────────────────────────────────────┤
│ name           emits          schedule       last  next  err│
│ cron.rms-sync  REQUIREMENT_   每5min         2m    3m    0  │
│ ...                                                         │
└─────────────────────────────────────────────────────────────┘
```

#### 4.2.3 行点击

打开右侧抽屉（用 `components/shared/atoms.tsx` 的 `Card` 组合），含：
- emits 事件名（点链跳 `/events?name=...`）
- 最近 10 次触发记录（点跳 `/live?run=...`）
- 配置 JSON（只读 monospace）

#### 4.2.4 P2 不做

- 编辑触发器（即新建/修改 cron 表达式、webhook 路径）
- 启停按钮
- 触发回放（即"用历史一次触发的 payload 重新发一次"）

留 P4 或更后。

### 4.3 `/events` Firehose Tab

#### 4.3.1 改动文件

- [`components/events/EventsContent.tsx`](../../../components/events/EventsContent.tsx)：在 6 Tab 后加第 7 个

#### 4.3.2 内容

选中一个事件后，Firehose Tab 内：

```
┌────────────────────────────────────────────────────────┐
│ Stream filter: [✓ ok] [✓ warn] [✓ err] [ tool] [ hitl]│
│ Auto-scroll: ▣  Pause                                  │
├────────────────────────────────────────────────────────┤
│ 14:06:12  run-2041   ReqAnalyzer   ok    payload(...)  │
│ 14:06:10  run-2042   JDGenerator   warn  retry 2/3     │
│ ...                                                    │
└────────────────────────────────────────────────────────┘
```

数据 ← SSE `/api/events/[name]/stream`。

最多保留浏览器内存中 200 条；超出 LRU 淘汰。

#### 4.3.3 DLQ + Dedup 嵌入

Firehose Tab 顶部加 2 个小 KPI：
- 该事件 24h 进 DLQ 数 ← `/api/alerts?category=dlq&affected=<eventName>`
- 该事件 24h dedup 命中数 ← 同上 category=dedup（需要 P2 扩 `/api/alerts`）

### 4.4 CmdPalette 资源升级

#### 4.4.1 改动

[`components/shared/CommandPalette.tsx`](../../../components/shared/CommandPalette.tsx) 由"静态命令列表"改为"两段式搜索"：

1. 输入 `>` 前缀 = 命令模式（保留原行为）
2. 默认 = 资源搜索模式

#### 4.4.2 资源类型与匹配规则

| 前缀 | 类型 | 来源 | 跳转 |
|---|---|---|---|
| `@` | agent | `lib/agent-mapping.ts`（22 个）| `/fleet?agent=<short>` |
| `#` | run | `/api/runs?q=<query>&limit=10` | `/live?run=<id>` |
| `!` | human-task | `/api/human-tasks?q=<query>&limit=10` | `/inbox?task=<id>` |
| `:` | event | `/api/events?q=<query>&limit=10` | `/events?name=<name>` |
| 无前缀 | 全部 + fuzzy | 并发查 4 类 | （多结果选）|

#### 4.4.3 防抖 / 缓存

- 输入 250ms debounce
- 4 类查询并发；任一失败不阻塞其他
- 结果按 type 分组显示，每组最多 5 个

## 5 · 错误处理（增量）

延续 P1 §5 矩阵，新增：

| 故障 | API 行为 | UI |
|---|---|---|
| `/api/human-tasks/[id]` POST 时 task 已被他人 approved | 返 409 + `{ error: 'STALE', currentStatus, currentBy }` | inbox 弹"已被 X 处理" toast，刷新该卡片 |
| ChatbotSession 服务端会话过期（>30min idle）| 返 410 Gone | 对话面板灰显，按钮显示"会话已过期，重新发起" |
| triggers 列表跨 service 部分失败（cron OK，webhook 不可达）| 返 200 + `partial: ['webhook']` | 该 Tab 顶部条带提示 |
| Firehose SSE 浏览器内存超 200 条 | 客户端 LRU 淘汰 | 静默；底部状态栏显示"已显示 200 条（更早被淘汰）" |
| 用户在 inbox approve 时 WS sidecar 不可达 | 立即返 503，task 状态不变 | "服务不可用，请稍后重试" |

## 6 · i18n 新增 key

约 25 条，全部双写。

### 6.1 路由 / 导航

| key | zh | en |
|---|---|---|
| `nav_inbox` | 待办 | Inbox |
| `nav_triggers` | 触发器 | Triggers |

### 6.2 Inbox

| key | zh | en |
|---|---|---|
| `inbox_title` | HITL 待办 | HITL Inbox |
| `inbox_facet_all` | 全部 | All |
| `inbox_facet_mine` | 我负责 | Mine |
| `inbox_facet_overdue` | 即将超时 | Overdue soon |
| `inbox_action_approve` | 通过 | Approve |
| `inbox_action_reject` | 退回 | Reject |
| `inbox_action_escalate` | 上报客户 | Escalate to client |
| `inbox_chat_send` | 发送 | Send |
| `inbox_chat_expired` | 会话已过期 | Session expired |
| `inbox_sla_until` | 距截止 | Until deadline |

### 6.3 Triggers

| key | zh | en |
|---|---|---|
| `triggers_title` | 触发器 | Triggers |
| `triggers_tab_cron` | 定时 | Cron |
| `triggers_tab_webhook` | Webhook | Webhook |
| `triggers_tab_upstream` | 上游事件 | Upstream emit |
| `triggers_col_emits` | 触发事件 | Emits |
| `triggers_col_schedule` | 计划 | Schedule |
| `triggers_col_last` | 最近 | Last |
| `triggers_col_next` | 下次 | Next |
| `triggers_col_errors` | 错误 | Errors |

### 6.4 Events Firehose Tab

| key | zh | en |
|---|---|---|
| `evt_tab_firehose` | 实时流 | Firehose |
| `evt_firehose_pause` | 暂停 | Pause |
| `evt_firehose_resume` | 继续 | Resume |
| `evt_firehose_autoscroll` | 自动滚动 | Auto-scroll |

### 6.5 CmdPalette

| key | zh | en |
|---|---|---|
| `cmd_hint_search` | 搜索 agent / run / 待办 / 事件 | Search agent / run / task / event |
| `cmd_group_agents` | Agents | Agents |
| `cmd_group_runs` | Runs | Runs |
| `cmd_group_tasks` | Tasks | Tasks |
| `cmd_group_events` | Events | Events |

## 7 · LeftNav 改动

[`components/shared/LeftNav.tsx`](../../../components/shared/LeftNav.tsx) 在已有 3 组内加 2 项：

```
Operate
├── Fleet
├── Workflow
├── Live
├── Inbox       ← P2 new (含未读数 badge)
└── Alerts

Build
├── Workflow （已在 Operate；可选移这里）
├── Events
└── Triggers    ← P2 new

Govern
├── DataSources
└── Audit       (P3+)
```

未读数 badge 来自 `/api/human-tasks` 计数（P1 已有）；3s 轮询 + SSE 增量。

## 8 · 性能预算（增量）

| 指标 | 预算 |
|---|---|
| `/inbox` TTI | ≤2.0s |
| `/triggers` TTI | ≤1.8s |
| `/api/human-tasks/[id]` POST p95 | ≤400ms |
| `/api/triggers` p95 | ≤300ms |
| Firehose Tab SSE 首事件延迟 | ≤500ms |
| CmdPalette 输入响应（含远程查询）| ≤350ms |
| 新文案、新色彩在 zh/en + light/dark 全组合渲染正确 | 100% |

## 9 · 验收标准

- [ ] **HITL 闭环**：在 dev 环境触发一个真 HumanTask，在 `/inbox` 看到、approve 后该 run 的 `WorkflowStep.status` 变 `running` 并继续流转
- [ ] **多轮对话**：触发一个 `clarifyRequirement` 任务，在 `/inbox` 内完成 ≥3 轮往返对话
- [ ] **Escalate**：一个 task escalate 到 client，看到 child ChatbotSession 创建
- [ ] **Triggers 三 Tab 数据**：cron 列出 ≥5 个真 cron；webhook ≥3 个真 endpoint；upstream ≥2 个真 emit
- [ ] **Firehose 实时**：注入 1 个事件，2s 内出现在该事件的 Firehose Tab
- [ ] **CmdPalette 4 类**：分别用 `@matcher` `#run-` `!task-` `:RESUME_` 都能搜到结果
- [ ] **未读 badge**：新任务到达，LeftNav `/inbox` 项数字 +1，无需手动刷新
- [ ] **SLA 倒计时颜色**：手造 deadline 距离 1h、20min、超时 三种 task，看到 3 种颜色
- [ ] **i18n 双语 + 暗色全覆盖**
- [ ] **未引入新独立 server 框架**（Q4 持续约束）

## 10 · 风险

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| `/api/triggers` 数据来源分散（cron/webhook/upstream 三处推断），catalog 不全 | 高 | 中 | 静态 `lib/triggers-static.ts` 兜底；P3 后接真实配置 |
| ChatbotSession 多轮对话延迟（LLM 调用）让 inbox 显得慢 | 中 | 中 | 每条用户消息发出后立即 optimistic UI 显示，待 LLM 响应再覆盖 |
| 未读 badge 高频轮询拖慢 LeftNav | 低 | 低 | 用 SSE 增量替代轮询（P1 stream 已有 `human_waiting` 类型）|
| CmdPalette 4 类并发查询，部分失败导致结果残缺 | 中 | 低 | 每组独立显示，标"部分失败" |
| escalate 创建的 child session 与 parent 关联在 UI 上看不清 | 中 | 中 | 详情面板用"父子树状视图" |

## 11 · 不在 P2 范围

- 任何后端代码搬迁（→ P3）
- DB 切 SQLite（→ P3）
- 触发器编辑/启停（→ P4）
- HumanTask 分配 / 转派（→ P4）
- 通知系统（飞书/邮件 push）（→ P4）

## 12 · 完成定义（一句话）

> P2 末，运营在 `/inbox` 能看到、处理（approve/reject/escalate）、对话所有 HITL 任务；在 `/triggers` 能看到全部三类触发器；⌘K 真能 2 步到达任何 agent/run/task/event；这一切运行在跟 P1 同样的 4 进程拓扑下，AO 仍未自带后端。
