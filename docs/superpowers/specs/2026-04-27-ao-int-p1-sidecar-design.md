# AO-INT-P1 · Sidecar 接通 · 详细设计

> **父 spec**：[2026-04-27-agentic-operator-integration-design.md](2026-04-27-agentic-operator-integration-design.md)
> **阶段**：P1（第 1–3 周）· **代号**：AO-INT-P1
> **作者**：Steven · **日期**：2026-04-27 · **状态**：草案

---

## 0 · 目标

把 AO 6 个现有页面（`/fleet` `/workflow` `/live` `/events` `/alerts` `/datasources`）从 mock 切换到 EM/WS 真实数据。**不**新增前端路由。**不**触碰 EM/WS 后端代码。**不**修改 AO 视觉设计语言。

成功定义：在第 3 周末，运营打开 `/live` 能看到正在跑的真实 run 的 SSE 实时事件流；打开 `/fleet` 看到 22 个 agent 真实的 KPI；其余页面同步切真数据。

## 1 · 范围

### 1.1 In Scope

- 新建 [`app/api/`](../../../app) 下 10 个 Route Handler
- 新建 [`server/`](../../../server) 下若干 server-only 模块（client + normalize）
- 新建 [`lib/`](../../../lib) 下数据契约 + agent 映射表 + API hooks
- 改造 6 个 `*Content.tsx` 由 mock 切真数据
- 扩 [`lib/i18n.tsx`](../../../lib/i18n.tsx)（22 agent + 新状态）
- 扩 [`app/globals.css`](../../../app/globals.css)（4 个新状态 token）
- `npm run dev` 启 4 个进程（Next + WS + EM + Inngest dev）

### 1.2 Out of Scope

- 任何新前端路由（`/inbox` `/triggers` 留给 P2）
- 任何后端代码搬迁（留给 P3）
- DB 引擎切换（WS 仍 Postgres，EM 仍 SQLite，本期不动）
- `/workflow` 拓扑结构改造（22 节点重排留给 P2）
- 认证 / 多租户（P4）
- React Flow 替换 SVG（视觉重做留给 P2 或更后）
- WS Copilot 接入（Q2 决议：不迁）
- EM Editor 治理（Q1 决议：不迁）

## 2 · P1 拓扑

```
┌─────────────────────────────────────────────────────────────────┐
│ Browser                                                         │
│   ↓ fetch / EventSource                                         │
│ Agentic Operator · Next.js 16 (port 3002)                       │
│ ┌───────────────────────────────────────────────────────────┐   │
│ │ Pages (Client Components, unchanged URL paths)            │   │
│ │   /fleet  /workflow  /live  /events  /alerts /datasources │   │
│ │   ↓ uses lib/api/*                                        │   │
│ ├───────────────────────────────────────────────────────────┤   │
│ │ app/api/  (Next.js Route Handlers — P1 = adapter)         │   │
│ │   /agents  /runs  /runs/[id]  /runs/[id]/steps  /events   │   │
│ │   /trace/[id]  /human-tasks  /alerts  /datasources        │   │
│ │   /stream  (SSE multiplexer)                              │   │
│ ├───────────────────────────────────────────────────────────┤   │
│ │ server/  (server-only modules, imported by app/api/*)     │   │
│ │   clients/{ws,em}.ts                                      │   │
│ │   normalize/{envelope,status,agents}.ts                   │   │
│ └───────────────────────────────────────────────────────────┘   │
└────────┬────────────────────────────────┬───────────────────────┘
         │ HTTP/SSE                       │ HTTP
         ▼                                ▼
┌──────────────────────┐         ┌─────────────────────────┐
│ WS server :5175      │         │ EM server :8000         │
│   (unchanged)        │         │   (unchanged)           │
│ + Inngest dev :8288  │         │                         │
└──────────────────────┘         └─────────────────────────┘
```

## 3 · 文件结构

### 3.1 新建

```
agenticOperator/
├── lib/
│   ├── agent-mapping.ts         ← 22 agent 映射表（核心事实表）
│   ├── workflow-meta.ts         ← 工作流静态 metadata（version/lastUpdated/edges）
│   └── api/
│       ├── types.ts             ← 所有 API I/O 类型
│       ├── client.ts            ← fetchJson + 错误归一化
│       └── sse.ts               ← useSSE hook（auto-reconnect）
├── server/
│   ├── clients/
│   │   ├── ws.ts                ← WS HTTP+SSE 客户端（server-only）
│   │   └── em.ts                ← EM HTTP 客户端（server-only）
│   └── normalize/
│       ├── envelope.ts          ← H1：三层信封拍平
│       ├── status.ts            ← H9：run/step status 归一化
│       └── agents.ts            ← agent_id ↔ short_name
└── app/api/
    ├── agents/route.ts
    ├── runs/route.ts
    ├── runs/[id]/route.ts
    ├── runs/[id]/steps/route.ts
    ├── events/route.ts
    ├── trace/[id]/route.ts
    ├── human-tasks/route.ts
    ├── alerts/route.ts
    ├── datasources/route.ts
    └── stream/route.ts
```

### 3.2 修改

- [`package.json`](../../../package.json)：`scripts.dev` 用 `concurrently` 并发启 4 个进程
- [`next.config.js`](../../../next.config.js)：（无变化——`app/api/*` 是同源，不需要 rewrites）
- [`lib/i18n.tsx`](../../../lib/i18n.tsx)：加 36 个新 key（详见 §6）
- [`app/globals.css`](../../../app/globals.css)：加 4 个新 token（详见 §7）
- 6 个 `components/<route>/Content.tsx`：由 mock 切真数据（详见 §8）

### 3.3 不动

- `app/<route>/page.tsx` 全部 thin shell 不变
- `components/shared/`（atoms、Ic、Shell、AppBar、LeftNav、CommandPalette）不变
- `lib/events-catalog.ts` **暂留**（最后一个被替代的，详见 §8.3）
- [`design_handoff_agentic_operator/`](../../../design_handoff_agentic_operator/)（永远不碰）
- `Action_and_Event_Manager/`（P3 之前 read-only）

## 4 · 接口边界表（10 个 Route Handler）

每个 endpoint 的 request/response schema 定型在 `lib/api/types.ts`，由 Route Handler 与页面共享。

### 4.1 `GET /api/agents`

**用途**：`/fleet` 表 22 行 + `/workflow` 节点元数据。

**Request**：无参数

**Response 200**：
```ts
type AgentsResponse = {
  agents: AgentRow[];
  generatedAt: string;  // ISO timestamp，方便调试缓存
};

type AgentRow = {
  // 静态（来自 lib/agent-mapping.ts）
  short: string;            // "ReqSync"
  wsId: string;             // "1-1"
  displayName: string;      // i18n: agent_<short_lowercase>
  stage: Stage;             // 9 值
  kind: 'auto' | 'hitl' | 'hybrid';  // H6 决议
  ownerTeam: string;        // "HSM·交付"
  version: string;          // "v1.4.2"
  // 动态（来自 WS 聚合）
  status: RunStatus;        // 7 值，H9
  p50Ms: number | null;     // 最近 1h
  runs24h: number;
  successRate: number | null;  // 0..1
  costYuan: number;
  lastActivityAt: string | null;
  spark: number[];          // 16 个 5min 桶
};

type Stage =
  | 'system' | 'requirement' | 'jd' | 'resume'
  | 'match' | 'interview' | 'eval' | 'package' | 'submit';

type RunStatus =
  | 'running' | 'suspended' | 'timed_out' | 'completed'
  | 'failed' | 'paused' | 'interrupted';
```

**实现**：
1. 从 `lib/agent-mapping.ts` 取 22 静态行
2. 并发 `WS GET /api/runs?...` 聚合每个 agent 的 24h KPI
3. `WS GET /api/activity/feed?limit=1000` 算 spark 桶
4. 用 `server/normalize/status.ts` 把 WS status 映到 `RunStatus` 7 值
5. **错误降级**：单个 agent 聚合失败，对应字段返 null，整体仍 200（页面有 placeholder UI）

### 4.2 `GET /api/runs`

**用途**：`/live` 左侧 6 个历史 run + `/fleet` "活跃 run" 计数。

**Request**：
```
?status=running,suspended,completed   (CSV; default = all)
&limit=10                              (default 10, max 50)
&since=ISO                             (optional, default = 24h ago)
```

**Response 200**：
```ts
type RunsResponse = { runs: RunSummary[]; total: number };

type RunSummary = {
  id: string;
  triggerEvent: string;       // "REQUIREMENT_SYNCED"
  triggerData: { client: string; jdId: string };  // 简要业务标识
  status: RunStatus;
  startedAt: string;
  lastActivityAt: string;
  completedAt: string | null;
  agentCount: number;          // 总共多少 agent 参与
  pendingHumanTasks: number;   // suspended 时显示
  suspendedReason: string | null;
};
```

### 4.3 `GET /api/runs/[id]`

**用途**：`/live` 中列点开单个 run 的详情头。

**Response 200**：
```ts
type RunDetail = RunSummary & {
  trace: { traceId: string; ...EM/WS join data };
  agentsTouched: string[];     // short names
};
```

**404**：run 不存在
**503**：WS 不可达（错误信息见 §5）

### 4.4 `GET /api/runs/[id]/steps`

**用途**：`/live` swimlane 时间轴。

**Response 200**：
```ts
type StepsResponse = { steps: StepDetail[] };

type StepDetail = {
  id: string;
  nodeId: string;             // wsId
  agentShort: string;         // mapped
  status: StepStatus;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  input: unknown | null;      // 截断到 4KB
  output: unknown | null;     // 截断到 4KB
  error: string | null;
};

type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'retrying';
```

### 4.5 `GET /api/events`

**用途**：`/events` 列表 + 6 Tab。

**Request**：
```
?stage=requirement,jd,...              (CSV; default = all 9)
&kind=trigger,domain,error,gate         (CSV)
&q=REQUIREMENT                          (substring search)
```

**Response 200**：
```ts
type EventsResponse = { events: EventContract[] };

type EventContract = {
  name: string;
  stage: Stage;
  kind: 'trigger' | 'domain' | 'error' | 'gate';
  desc: string;
  publishers: string[];        // agent short names
  subscribers: string[];
  emits: string[];
  // 来自 EM
  schema: object | null;       // JSON Schema 或 null
  schemaVersion: number;
  // 来自 WS 聚合
  rateLastHour: number;
  errorRateLastHour: number;
};
```

### 4.6 `GET /api/trace/[id]`

**用途**：`/live` 详情面板"完整链路"展开。

**实现**：并发查 WS + EM；H3 决议——内存合并。

**Response 200**：
```ts
type TraceResponse = {
  traceId: string;
  ws: { run: RunSummary; steps: StepDetail[]; activities: ActivityEvent[] };
  em: {
    auditEntries: AuditEntry[];
    dlqEntries: DLQEntry[];
    dedupHits: number;
  };
  // 拼出端到端时间轴
  unifiedTimeline: TimelineEvent[];
};
```

**性能**：见 §10 P95 ≤500ms。

### 4.7 `GET /api/human-tasks`

**用途**：`/fleet` HITL 待办计数（P1 仅返计数，详细列表留 P2 `/inbox`）。

**Request**：`?status=pending&limit=10`

**Response 200**：
```ts
type HumanTasksResponse = {
  total: number;
  pendingCount: number;
  recent: HumanTaskCard[];   // 最多 10 条预览
};

type HumanTaskCard = {
  id: string;
  runId: string;
  nodeId: string;
  title: string;
  assignee: string | null;
  deadline: string | null;
  createdAt: string;
};
```

### 4.8 `GET /api/alerts`

**用途**：`/alerts` 表（系统级，**不**含 HITL 待办）。

**Response 200**：
```ts
type AlertsResponse = { alerts: Alert[] };

type Alert = {
  id: string;
  category: 'sla' | 'rate' | 'quality' | 'infra' | 'dlq';
  severity: 'critical' | 'high' | 'medium' | 'low';
  title: string;
  affected: string;            // agent short / event name / run id
  triggeredAt: string;
  acked: boolean;
  ackedBy: string | null;
};
```

**来源**：
- `sla` ← WS run-sweeper 输出（`status='timed_out'`）
- `rate` ← `/api/events` 聚合 rate 异常
- `quality` ← `WS AgentEpisode.qualityScore` 偏低
- `infra` ← WS/EM 健康检查
- `dlq` ← EM `dlq_entries`

### 4.9 `GET /api/datasources`

**用途**：`/datasources` 24 连接器健康。

**Response 200**：
```ts
type DataSourcesResponse = { sources: DataSource[] };

type DataSource = {
  id: string;
  name: string;
  category: 'ats' | 'channel' | 'llm' | 'msg' | 'storage' | 'identity' | 'vector';
  status: 'ok' | 'degraded' | 'down';
  lastCheckedAt: string;
  rps: number;
  errorRate: number;
  // 静态：来自 lib/datasources.ts（新建）
};
```

**注**：P1 暂以**静态 catalog + EM `/health` 探活**为来源；P2/P3 接入真实连接器配置。

### 4.10 `GET /api/stream`

**用途**：`/live` decision stream + `/fleet` 实时计数。

**实现**：Next.js [Streaming Response](https://nextjs.org/docs/app/building-your-application/routing/route-handlers#streaming)；服务端订阅 WS `/api/activity/stream` 一次，按 query 过滤后扇出。

**Request**：
```
?runId=...        (optional, 不传 = 全部)
&agent=...        (optional, short name)
&type=...         (optional, ok/warn/err/tool/decision/anomaly)
```

**Response**：`text/event-stream`
```
event: activity
data: {"id":"...","runId":"...","agentShort":"Matcher","type":"decision","narrative":"...","createdAt":"..."}

event: heartbeat
data: {"t":"2026-04-27T14:00:00Z"}
```

**Heartbeat**：每 15s 一次，浏览器据此识别死连接并重连。

## 5 · 错误处理矩阵（advisory #2）

| 故障场景 | API 行为 | UI 表现 |
|---|---|---|
| WS sidecar 完全不可达 | `/api/agents` 等：返 200 + 字段 null + `meta.partial = ['ws']` | KPI 列显示 `—`，红色 dot 在右上角"WS 不可达" |
| EM sidecar 完全不可达 | `/api/agents`：仍返（不依赖 EM），`/api/events.schema`：null + meta.partial = ['em'] | 事件 Schema Tab 显示"暂不可用" |
| `/api/trace/[id]` 部分失败（EM ok，WS timeout）| 返 200 + `ws: null` + `meta.partial = ['ws']` | 时间轴只显示 EM 部分，提示"WS 数据未到" |
| WS SSE 流断 | server 侧**一次重连**（500ms），失败则给浏览器发 `event: error`；浏览器收到后 3s 内重连 | 顶栏 status pill 短暂"重连中"，自动恢复 |
| 浏览器端 fetch 超时（5s）| `lib/api/client.ts` 抛 `ApiTimeoutError` | 页面显示"加载慢"toast，自动重试 1 次 |
| Route Handler 内部异常 | 返 500 + `{ error: 'INTERNAL', traceId, message }`，记 stderr | 页面显示错误 banner，含 traceId 方便排查 |
| Route Handler 收到非法参数 | 返 400 + `{ error: 'BAD_REQUEST', field }` | 页面显示具体字段错误（开发期）/ 通用错误（生产期）|
| WS 返回三层信封但中间层缺失 | `server/normalize/envelope.ts` 抛 `EnvelopeMalformedError`，Route 返 502 | 顶栏 status pill 红色"上游协议错"|

**全局原则**：API 永远返结构化 JSON，**绝不返 HTML 错误页**；浏览器端 `client.ts` 一处统一处理 `ApiError` 子类。

## 6 · i18n key 清单（advisory #3）

新增 36 个 key，每个 zh + en 双写到 [`lib/i18n.tsx`](../../../lib/i18n.tsx)。

### 6.1 22 个 agent 显示名（key = `agent_<short_lower>`）

| key | zh | en |
|---|---|---|
| `agent_reqsync` | 需求同步器 | Requirement Sync |
| `agent_manualentry` | 手工录入 | Manual Entry |
| `agent_reqanalyzer` | 需求分析器 | Requirement Analyzer |
| `agent_clarifier` | 需求澄清器 | Clarifier |
| `agent_jdgenerator` | JD 生成器 | JD Generator |
| `agent_jdreviewer` | JD 审核员 | JD Reviewer |
| `agent_taskassigner` | 任务分配器 | Task Assigner |
| `agent_publisher` | 渠道发布器 | Publisher |
| `agent_manualpublish` | 手工发布 | Manual Publish |
| `agent_resumecollector` | 简历收集器 | Resume Collector |
| `agent_resumeparser` | 简历解析器 | Resume Parser |
| `agent_resumefixer` | 简历修复 | Resume Fixer |
| `agent_matcher` | 人岗匹配器 | Matcher |
| `agent_matchreviewer` | 匹配复审 | Match Reviewer |
| `agent_interviewinviter` | 面试邀约器 | Interview Inviter |
| `agent_aiinterviewer` | AI 面试官 | AI Interviewer |
| `agent_evaluator` | 面试评估器 | Evaluator |
| `agent_resumerefiner` | 简历优化器 | Resume Refiner |
| `agent_packagebuilder` | 推荐包构建 | Package Builder |
| `agent_packagefiller` | 推荐包补全 | Package Filler |
| `agent_packagereviewer` | 推荐包审核 | Package Reviewer |
| `agent_portalsubmitter` | 客户端提交 | Portal Submitter |

### 6.2 7 个 RunStatus 标签（key = `status_<value>`）

| key | zh | en |
|---|---|---|
| `status_running` | 运行中 | Running |
| `status_suspended` | 等待 HITL | Awaiting HITL |
| `status_timed_out` | SLA 超时 | Timed out |
| `status_completed` | 已完成 | Completed |
| `status_failed` | 失败 | Failed |
| `status_paused` | 已暂停 | Paused |
| `status_interrupted` | 已中断 | Interrupted |

### 6.3 5 个 StepStatus 标签

`step_pending` `step_running` `step_completed` `step_failed` `step_retrying`

### 6.4 2 个新通用文案

`ui_partial_data`（"部分数据未到"/ "Partial data"）
`ui_reconnecting`（"重连中"/ "Reconnecting"）

## 7 · CSS Token 扩展

[`app/globals.css`](../../../app/globals.css) 在 `:root` 和 `[data-theme="dark"]` 各加 4 行：

```css
:root {
  /* ...existing... */
  --c-suspended: oklch(0.74 0.13 70);   /* 琥珀色 */
  --c-timed-out: oklch(0.62 0.18 30);   /* 砖红 */
  --c-retrying: oklch(0.65 0.16 220);   /* 蓝灰 */
  --c-interrupted: oklch(0.55 0.04 260);/* 哑紫灰 */
}

[data-theme="dark"] {
  /* ...existing... */
  --c-suspended: oklch(0.78 0.13 70);
  --c-timed-out: oklch(0.70 0.16 30);
  --c-retrying: oklch(0.70 0.14 220);
  --c-interrupted: oklch(0.60 0.04 260);
}
```

`@theme inline { ... }` 块配套加 4 行：
```css
--color-suspended: var(--c-suspended);
--color-timed-out: var(--c-timed-out);
--color-retrying: var(--c-retrying);
--color-interrupted: var(--c-interrupted);
```

## 8 · 页面接管顺序（按价值降序）

每页接管 = (1) 替换内联 mock → 调 `lib/api/client.ts`；(2) 状态色用新 token；(3) 加 loading/error 边界。

### 8.1 第 1 周

#### `/live` （最早，业务体感最强）
- 引入 `useSSE('/api/stream')` + `useFetch('/api/runs?status=running')`
- 左 6 历史 run ← `/api/runs?limit=6`
- 中 swimlane ← `/api/runs/[id]/steps` + SSE 增量
- 右 decision stream ← SSE filter by run + type
- 删除 `LiveContent.tsx` 顶部 mock arrays

#### `/fleet`
- 22 行表 ← `/api/agents`
- 顶栏 KPI 由 22 行聚合派生
- spark 列直接渲染 16 个数

### 8.2 第 2 周

#### `/workflow`
- **拓扑结构本期不变**（仍用 19 节点 SVG mock）
- 节点 status badge ← 选中 run 的 `/api/runs/[id]/steps`
- 顶栏版本 ← `lib/workflow-meta.ts`
- 删除 [WorkflowContent.tsx:77](../../../components/workflow/WorkflowContent.tsx#L77) 死字符串 `v4.2 · draft`

#### `/events`
- 列表 ← `/api/events`
- 6 Tab 数据各拉真源（详见父 spec §6.2）
- **保留** [`lib/events-catalog.ts`](../../../lib/events-catalog.ts) 作为 fallback（`/api/events` 无法响应时）；`/api/events` 稳定 1 周后删除

### 8.3 第 3 周

#### `/alerts`
- 12 规则 → `/api/alerts`
- 删 mock，改 facet 计数为真

#### `/datasources`
- 24 连接器 ← `/api/datasources`

#### 收尾
- `lib/events-catalog.ts` 删除（`/api/events` 已稳定）
- 跑全量验收 §11

## 9 · 映射表与归一化

### 9.1 `lib/agent-mapping.ts`

完整 22 行（详见父 spec §7.3 附录），结构：

```ts
export type AgentMeta = {
  short: string;
  wsId: string;
  stage: Stage;
  kind: 'auto' | 'hitl' | 'hybrid';
  ownerTeam: string;
  version: string;
  emitsEvents: string[];     // 静态来自 WS metadata
  triggersEvents: string[];
  terminal: boolean;
};
export const AGENT_MAP: AgentMeta[] = [ /* 22 entries */ ];
export const byShort = (s: string) => AGENT_MAP.find(a => a.short === s);
export const byWsId  = (id: string) => AGENT_MAP.find(a => a.wsId === id);
```

### 9.2 `server/normalize/status.ts`

```ts
// WS WorkflowRun.status (7 values, source of truth) ← 不变
// AO 旧 mock 用过 'review' / 'degraded' → 这俩在 P1 后被淘汰
// 不变换；只校验 enum
export function normalizeRunStatus(s: string): RunStatus { ... }
export function normalizeStepStatus(s: string): StepStatus { ... }
```

### 9.3 `server/normalize/envelope.ts`

```ts
// H1 决议：吃三层信封，吐扁平
export function flatten(envelope: unknown): { event: string; trace: string; business: unknown } {
  // envelope.payload.payload.payload → business
  // envelope.payload.event_name      → event
  // envelope.payload.correlation_id  → trace
  // 任何中间层缺失 → throw EnvelopeMalformedError
}
```

### 9.4 `server/normalize/agents.ts`

```ts
import { AGENT_MAP } from '../../lib/agent-mapping.js';
export function shortFromWs(wsId: string): string {
  const m = AGENT_MAP.find(a => a.wsId === wsId);
  if (!m) throw new UnknownAgentError(wsId);
  return m.short;
}
```

## 10 · 性能预算（advisory #4）

| 指标 | 预算 | 测量方法 |
|---|---|---|
| `/api/agents` p95 | ≤300ms | route handler 内 `console.time` + curl 50 次 |
| `/api/trace/[id]` p95 | ≤500ms | 同上 |
| 其他 GET p95 | ≤200ms | 同上 |
| `/api/stream` 首事件延迟 | ≤500ms 自首字节后 | 浏览器 EventSource ready event |
| `/api/stream` 重连恢复 | ≤3s | 关 sidecar 再启的 wall clock |
| `/live` Time-to-Interactive | ≤2.5s（4G 模拟）| Lighthouse |
| `/fleet` Time-to-Interactive | ≤2.0s | Lighthouse |
| 6 页面 hydration 完成 | ≤1.5s | React DevTools profiler |
| Route Handler 内存峰值 | ≤200MB | `node --inspect` 看 heap |

预算超过任意一条 = 该项 P1 不通过。

## 11 · 验收标准

P1 验收（第 3 周末必须全 ✓）：

- [ ] **6 页面真数据**：所有 mock 字符串（"REQ-01" "字节跳动" 等）已删除或仅作 fallback
- [ ] **22 行 fleet 表唯一性**：无重复 short_name；与 `lib/agent-mapping.ts` 1:1 对应
- [ ] **SSE 自动重连**：关 WS server，3s 后再启，浏览器自恢复，UI 不需手动刷新
- [ ] **错误降级**：关 EM server 单独，AO 仍可工作（部分字段灰化），不白屏
- [ ] **`/api/trace/[id]` p95 ≤500ms**：50 次 curl 测量
- [ ] **`npm run dev` 单命令起 4 进程**：3002 + 5175 + 8000 + 8288 都可访问
- [ ] **未引入独立 server 框架**：grep `package.json` 无 express/fastify/koa（约束 Q4）
- [ ] **状态色覆盖**：7 RunStatus + 5 StepStatus 全部有色彩 token，无灰显
- [ ] **i18n 双写**：22 + 14 个新 key 在 zh/en 都存在
- [ ] **暗色模式**：6 页面切到暗色，新 token 全部正确渲染
- [ ] **`/workflow` 节点状态实时**：开一个真 run，节点 badge 跟着变（pending→running→completed）

## 12 · 风险

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| WS Inngest 三层信封实际结构跟 spec 描述不符 | 中 | 高 | P1 第 1 天先用 curl 抓真 envelope 调通 `flatten()` |
| `/api/trace/[id]` 跨 EM+WS 慢于 500ms（双 DB 没法 join）| 中 | 中 | 加内存 LRU 缓存 30s；超出预算列入 P3 优化项 |
| WS `/api/activity/stream` SSE 协议与 EventSource 不兼容（如缺 `\n\n` 分隔）| 低 | 高 | P1 第 1 天 curl 抓 stream 验证 |
| `concurrently` 起 4 进程在 Windows 行为不一致 | 低 | 低 | 文档注明 macOS/Linux 优先；Windows 加 npm-run-all 备用 |
| 关 EM 不会让 AO 白屏，但部分字段空——产品担心"看起来在跑但其实不全" | 中 | 中 | UI 顶栏明确"EM 不可达"红色 pill；不假装数据完整 |
| 真实 run 数太少（dev 环境）导致 spark 列全是 0 | 高 | 低 | seed 脚本生成 demo 数据；不阻塞 |

## 13 · 不在 P1 范围（明确清单）

- 任何 `/inbox` `/triggers` 路由（→ P2）
- HITL 多轮 ChatbotSession 对话渲染（→ P2）
- React Flow 替换 SVG（→ P2 或更晚）
- WS/EM 代码搬入 AO 仓（→ P3）
- SQLite 迁移（→ P3）
- Inngest serve adapter（→ P3）
- 删除 `Action_and_Event_Manager/`（→ P3）
- 认证、多租户（→ P4）
- 生产部署、监控告警接运维（→ P4）

## 14 · 完成定义（一句话）

> 在第 3 周末，新机 `git clone` + `npm install` + `npm run dev` 5 分钟内拉起；浏览器开 `localhost:3002`，6 页面全部展示从 EM/WS 真实拉到的数据；关 WS 不会白屏；过去 1 小时所有真 run 在 `/live` 都能复现时间轴。
