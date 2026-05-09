# 2026-05-09 — Instance tracking + Quick actions for /live

## 一句话目标

把 `/live` 的"实例追踪"从 mock swimlane 升级为**真实的 run-centric 跨系统时间线**（AO + 本地 Inngest，RAAS 留位但不接），并在它上方提供 4 个**确定性的快捷问题按钮**作为 P1 chatbot 替代物——所有数据都姓"这条 run"。

## 不做什么

- ❌ NL chatbot（P2 留作后续；P1 用按钮够 80% 价值，0% 幻觉）
- ❌ RAAS Inngest 实查（VPN 依赖；预留 lane + toggle，P2 接）
- ❌ Entity profile 页（`/jds/[id]` / `/candidates/[id]`）—— 这是另一条主线
- ❌ Token / cost 跨 run 聚合到 /overview KPI 条 —— 留下一刀

## In-scope（这一刀）

### A. `/api/runs/[id]/trace` 新 endpoint
聚合**单条 run** 的跨系统时间线：

| 数据源 | 来自 | 目的 |
|---|---|---|
| `WorkflowRun` 主体 | `prisma.workflowRun.findUnique` | run 元数据、起止时间 |
| `WorkflowStep[]` | `prisma.workflowStep` | step 时间线 |
| `AgentActivity[]` | `prisma.agentActivity` | 详细活动（含 LLM/HTTP 工具调用） |
| trigger event id | activity metadata 第一条 `event_received` | 反向找上链 |
| emitted event ids | activity metadata `event_emitted` 行 | 找下链 |
| 本地 Inngest runs | `${LOCAL_INNGEST}/v1/events/{id}/runs` | 看 AO 内部 / 本地系统 functions 跑了什么 |
| RAAS Inngest runs | （预留参数 `?includeRaas=1`，本刀不实查） | P2 接 |

返回结构：
```ts
{
  run: { id, status, startedAt, completedAt, triggerEvent, triggerData },
  span: { startMs, endMs, durationMs },
  agentLanes: Array<{
    agent: string;
    blocks: Array<{
      id, kind: 'step' | 'tool' | 'decision' | 'anomaly',
      ts, durationMs?, label, status, runId?
    }>;
  }>;
  eventLane: Array<{
    eventId, name, ts, source: 'local' | 'raas',
    inngestRuns?: Array<{ runId, functionId, status, startedAt, endedAt }>;
  }>;
  raasLanes: Array<{ functionId; runs: ... }>;  // 本刀总返回 [] 占位
  meta: { generatedAt, raasIncluded, raasError? }
}
```

### B. `RunTraceTimeline.tsx` 新组件
真 swimlane，复用现有 lifecycle/health 配色。Lanes：
- Top header: trace stats（events / runs / 跨度 / 是否含 RAAS）
- Lanes 自上而下：
  1. **AO Agent lanes**（参与的每个 agent 一条）
  2. **事件总线**（events 在时间轴上的标记 + Inngest run 数）
  3. **RAAS partner lanes**（占位 + "P2 接通"提示）
- 每个 block 可点 → 详情 tooltip / chip

### C. 实例追踪 Tab + 4 快捷问题按钮
新 Tab 加在 `RealRunCenter` 的 Tabs：`[ 概览 | 实时日志 | Step 时间线 | 实例追踪 | AI 总结 ]`

实例追踪 Tab 顶部一个**快捷问题条**，4 个按钮：

| 按钮 | 实现方式 | 数据源 |
|---|---|---|
| **总结** | 复用 `/api/runs/[id]/summary`（已有 LLM endpoint） | activity + LLM |
| **为什么慢** | 确定性模板：找最长的 step / 工具调用 / 比较 baseline | trace data 客户端聚合 |
| **失败根因** | 确定性模板：列 step.failed + error 行 + 原因 | trace data |
| **RAAS 干了什么** | 确定性模板：从 emitted events 列出 + 占位 "RAAS 实查 P2 接通" | trace data |

每个按钮点开一个内联 panel（不弹 modal），显示结果 + 引用（指向 trace block）。

### D. Run 卡片化
左栏 `RunList` 行从紧凑表格改成两层卡片：

```
┌─────────────────────────────────────┐
│ ● running   17:32 · 4m 12s         │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━     │
│ 工行 · 高级后端工程师                │
│ JD-2041 · 5 step · 1 待人工          │
│ POST-FIX-...8391           ✨ AI    │
└─────────────────────────────────────┘
```

实体引用（client / JD）将来要变成 chip → 跳到 entity profile。本刀**先做卡片版式**，路由占位用 `?` href（点击不跳转，hover 提示"profile 页 P2 上线"）。

## 测试策略

- TypeScript build pass（`npm run build`）—— 路由 + 类型检查
- Existing test suite no new regressions（`npm test`，对照已知 4 个 pre-existing 失败基准）
- Manual smoke： `/live` 选一条 run，切到"实例追踪" Tab：
  - swimlane 渲染（即使无 activity，也优雅 empty state）
  - 4 个按钮可点，结果可见
  - 不报错

## Phase Out

- `Step 时间线` Tab 当前的 vertical 列表 vs `实例追踪` Tab 的横向 swimlane —— 两者**视角不同**（一个是"这一步做了什么"，一个是"按时间发生了什么"），都保留。后期可考虑合并，本刀不动。

## 文件清单

### 新建
- `app/api/runs/[id]/trace/route.ts`
- `components/live/RunTraceTimeline.tsx`
- `components/live/RunQuickActions.tsx`

### 修改
- `components/live/RealRunDetail.tsx` —— 加 Tab；接 RunTraceTimeline + RunQuickActions
- `components/live/LiveContent.tsx` —— `RunList` 改卡片版式

## 完成定义

- ✅ 新 endpoint 返回真实数据（即使无 activity，也返回正确的空骨架）
- ✅ 实例追踪 Tab 渲染真 swimlane（不是 mock）
- ✅ 4 个快捷按钮可点击；每个返回有意义的内容
- ✅ RunList 是卡片样式
- ✅ build + tests 全绿（仅已知 pre-existing 失败）
