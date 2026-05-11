// /api/runs/:id/summary
//
// Returns an LLM-generated summary of a workflow run: what each agent did,
// what the run produced, where things went wrong (if anywhere). Falls back
// to a deterministic statistical render when no LLM gateway is configured
// or when the LLM call fails.
//
// In-process cache keyed by `${runId}@${lastActivityAt}` so a still-running
// run gets re-summarized when something new happens, but a finished run
// only pays the LLM cost once.

import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import {
  chatComplete,
  GatewayUnavailableError,
  isGatewayConfigured,
} from "@/server/llm/gateway";
import { AGENT_MAP, byShort } from "@/lib/agent-mapping";
import { byShortFunction } from "@/lib/agent-functions";

type RouteCtx = { params: Promise<{ id: string }> };

export type RunSummaryResponse = {
  runId: string;
  status: string;
  triggerEvent: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  agentBreakdown: AgentBreakdownRow[];
  activityCount: number;
  errorCount: number;
  text: string;
  source: "llm" | "fallback";
  modelUsed?: string;
  durationLLMms?: number;
  generatedAt: string;
};

export type AgentBreakdownRow = {
  agentName: string;
  steps: number;
  failed: number;
  totalDurationMs: number;
  lastNarrative: string | null;
};

const cache = new Map<string, RunSummaryResponse>();

function cacheKey(id: string, lastActivityAt: string): string {
  return `${id}@${lastActivityAt}`;
}

export async function GET(_req: Request, ctx: RouteCtx): Promise<Response> {
  const { id } = await ctx.params;
  const run = await prisma.workflowRun.findUnique({ where: { id } });
  if (!run) {
    return NextResponse.json(
      { error: "NOT_FOUND", message: `run ${id} not found` },
      { status: 404 },
    );
  }

  const key = cacheKey(id, run.lastActivityAt.toISOString());
  const cached = cache.get(key);
  if (cached) return NextResponse.json(cached);

  // Pull steps + activities. We need both — steps tell us what each
  // function did mechanically (input/output/duration); activities tell us
  // what each agent narrated to the user.
  const [steps, activities] = await Promise.all([
    prisma.workflowStep.findMany({
      where: { runId: id },
      orderBy: { startedAt: "asc" },
    }),
    prisma.agentActivity.findMany({
      where: { runId: id },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const agentBreakdown = computeAgentBreakdown(steps, activities);
  const errorCount = steps.filter((s) => s.status === "failed").length;
  const durationMs = run.completedAt
    ? run.completedAt.getTime() - run.startedAt.getTime()
    : Date.now() - run.startedAt.getTime();

  const baseShape = {
    runId: id,
    status: run.status,
    triggerEvent: run.triggerEvent,
    startedAt: run.startedAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
    durationMs,
    agentBreakdown,
    activityCount: activities.length,
    errorCount,
    generatedAt: new Date().toISOString(),
  };

  if (!isGatewayConfigured()) {
    const body: RunSummaryResponse = {
      ...baseShape,
      text: deterministicSummary(run, agentBreakdown, steps, activities),
      source: "fallback",
    };
    cache.set(key, body);
    return NextResponse.json(body);
  }

  // Skip LLM entirely when there's no AgentActivity AND no steps. The LLM
  // would hallucinate agent names from thin air (verified in production:
  // it invented `JD_Writer / Recruiter_Agent / Channel_Distributor` for an
  // empty run). Better to return an honest "no data" message + the
  // deterministic shell.
  const hasAnyAgentData = agentBreakdown.length > 0 || activities.length > 0;
  if (!hasAnyAgentData) {
    const body: RunSummaryResponse = {
      ...baseShape,
      text: emptyRunNotice(run),
      source: "fallback",
    };
    cache.set(key, body);
    return NextResponse.json(body);
  }

  try {
    const { text, modelUsed, durationMs: durationLLMms } = await chatComplete({
      system: SYSTEM_PROMPT,
      user: buildUserPrompt(run, agentBreakdown, steps, activities),
      temperature: 0.2,
      maxTokens: 900,
    });
    const body: RunSummaryResponse = {
      ...baseShape,
      text:
        text ||
        deterministicSummary(run, agentBreakdown, steps, activities),
      source: text ? "llm" : "fallback",
      modelUsed,
      durationLLMms,
    };
    cache.set(key, body);
    return NextResponse.json(body);
  } catch (e) {
    if (e instanceof GatewayUnavailableError) {
      const body: RunSummaryResponse = {
        ...baseShape,
        text: deterministicSummary(run, agentBreakdown, steps, activities),
        source: "fallback",
      };
      cache.set(key, body);
      return NextResponse.json(body);
    }
    return NextResponse.json(
      {
        error: "LLM_FAILED",
        message: (e as Error).message,
        fallback: deterministicSummary(run, agentBreakdown, steps, activities),
      },
      { status: 502 },
    );
  }
}

function computeAgentBreakdown(
  steps: Array<{
    nodeId: string;
    status: string;
    durationMs: number | null;
  }>,
  activities: Array<{
    agentName: string;
    narrative: string;
    createdAt: Date;
  }>,
): AgentBreakdownRow[] {
  const map = new Map<string, AgentBreakdownRow>();

  for (const s of steps) {
    // Map nodeId to agent short name. nodeId here is the WS short id; if
    // it's already an AGENT_MAP short, use it directly. Falls back to the
    // raw nodeId so the breakdown is still useful when the mapping fails.
    const agentName = byShort(s.nodeId)?.short ?? s.nodeId;
    const row = map.get(agentName) ?? {
      agentName,
      steps: 0,
      failed: 0,
      totalDurationMs: 0,
      lastNarrative: null,
    };
    row.steps += 1;
    if (s.status === "failed") row.failed += 1;
    if (typeof s.durationMs === "number") row.totalDurationMs += s.durationMs;
    map.set(agentName, row);
  }

  // Splice in the latest narrative per agent (so the LLM has a real quote
  // from the agent rather than just a count).
  const lastByAgent = new Map<string, string>();
  for (const a of activities) {
    lastByAgent.set(a.agentName, a.narrative);
  }
  for (const [name, narrative] of lastByAgent) {
    const row = map.get(name) ?? {
      agentName: name,
      steps: 0,
      failed: 0,
      totalDurationMs: 0,
      lastNarrative: null,
    };
    row.lastNarrative = narrative;
    map.set(name, row);
  }
  return Array.from(map.values()).sort((a, b) => b.steps - a.steps);
}

const SYSTEM_PROMPT = `你是 Agentic Operator 的运行报告生成器。
你**完全了解整个多 agent 工作流的拓扑**——每个 agent 的职责、订阅哪些事件、emit 哪些事件、谁在它的上下游。所以你的总结必须是**多 agent 视角的**，不是把每个 agent 当孤岛说一遍。

⚠ 硬约束（违反 = 输出失败）：
1. agent 名字、事件名、step 名、数字、时间戳——**只能用用户输入里出现过的**。绝不允许编造（如 \`JD_Writer\`、\`Recruiter_Agent\`、\`Channel_Distributor\`、\`Resume_Sourcing_Agent\` 这种不在 AGENT_MAP 里的虚构名字）。
2. 如果 "Per-agent breakdown" 段落为空 OR 标 "(无活动数据)"，**不要伪造工作流路径**。直接说："这条 run 在 AgentActivity 表中无任何记录，无法做多 agent 路径分析。仅有 WorkflowRun 主表的元信息（trigger、status、suspendedReason）可参考。"
3. 工作流拓扑只能引用 "Workflow topology context" 段落里实际列出的 agent。其他 agent 不存在。

格式（Markdown）：
## 概述
（1~2 句：触发事件 / 总耗时 / 整体结果 / 当前阶段。基于实际数据，不是猜测。）

## 工作流路径
**仅当**有真实 per-agent breakdown 数据时填这段：
- 用 → 串起这条 run 实际激活的 agent（必须来自 breakdown）
- 用 ⊘ 标出 "Workflow topology context" 中标 "expected but not activated" 的 agent
- 解释停滞原因（用 suspendedReason 或失败的 step.error，不要猜）

**否则**：写 "无 AgentActivity 数据，无法重建路径。请先按 README 接通 runtime 的活动日志推送（POST /api/runs/[id]/activity）。"

## 各 Agent 干了什么
**仅当** breakdown 非空时列出。每段 1~2 行：
- agent 角色（用 function summary）
- 这条 run 里具体做了什么（用 narrative）

## 异常 / 关注点
列出 step.failed / error / anomaly，没有就写 "未发现异常"。

## 下一步建议
1~2 条具体建议。如果数据为空，建议是 "接通 AgentActivity 写入" 而不是业务建议。

总长度 250~400 字。简洁优于详细。诚实优于华丽。`;

function buildUserPrompt(
  run: { id: string; triggerEvent: string; status: string; startedAt: Date; completedAt: Date | null; suspendedReason: string | null; triggerData: string },
  breakdown: AgentBreakdownRow[],
  steps: Array<{ nodeId: string; status: string; error: string | null; durationMs: number | null }>,
  activities: Array<{ agentName: string; type: string; narrative: string }>,
): string {
  const lines: string[] = [];
  lines.push(`Run id: ${run.id}`);
  lines.push(`Trigger: ${run.triggerEvent}`);
  lines.push(`Trigger data: ${run.triggerData}`);
  lines.push(`Status: ${run.status}${run.suspendedReason ? ` (suspended: ${run.suspendedReason})` : ""}`);
  lines.push(`Started: ${run.startedAt.toISOString()}`);
  lines.push(`Completed: ${run.completedAt?.toISOString() ?? "(running)"}`);
  lines.push("");

  // ── Inject the workflow topology so the LLM can reason about
  //    "expected vs actual" path. Without this it can't know which
  //    downstream agents WERE expected when this run halted.
  const involved = new Set(breakdown.map((b) => b.agentName));
  const expected = computeExpectedDownstream(involved, activities);
  lines.push("Workflow topology context (subset relevant to this run):");
  for (const a of AGENT_MAP) {
    if (!involved.has(a.short) && !expected.has(a.short)) continue;
    const fn = byShortFunction(a.short);
    const tag = involved.has(a.short)
      ? "✓ activated"
      : expected.has(a.short)
        ? "⊘ expected but not activated"
        : "—";
    lines.push(
      `- ${a.short} [${tag}] (stage=${a.stage}, kind=${a.kind})${fn ? ` — ${fn.summary}` : ""}`,
    );
    lines.push(`    triggers: ${a.triggersEvents.join(", ") || "(none)"}`);
    lines.push(`    emits: ${a.emitsEvents.join(", ") || "(terminal)"}`);
  }
  lines.push("");

  lines.push("Per-agent breakdown for this run:");
  for (const r of breakdown) {
    const fn = byShortFunction(r.agentName);
    const desc = fn ? ` — ${fn.summary}` : "";
    lines.push(
      `- ${r.agentName}: ${r.steps} step(s), ${r.failed} failed, ${r.totalDurationMs}ms total${desc}`,
    );
    if (r.lastNarrative) lines.push(`    最近: ${r.lastNarrative}`);
  }
  lines.push("");
  if (steps.some((s) => s.error)) {
    lines.push("Errors:");
    for (const s of steps.filter((s) => s.error)) {
      lines.push(`- ${s.nodeId} (${s.status}): ${s.error}`);
    }
    lines.push("");
  }
  // Cap activity log so the prompt stays bounded — last 20 entries are
  // usually most informative for "what just happened".
  const recent = activities.slice(-20);
  if (recent.length > 0) {
    lines.push("Recent activity (last 20):");
    for (const a of recent) {
      lines.push(`- [${a.agentName}/${a.type}] ${a.narrative}`);
    }
  }
  return lines.join("\n");
}

function deterministicSummary(
  run: { triggerEvent: string; status: string; suspendedReason: string | null },
  breakdown: AgentBreakdownRow[],
  steps: Array<{ nodeId: string; status: string; error: string | null }>,
  activities: Array<{ agentName: string; narrative: string }>,
): string {
  const lines: string[] = [];
  lines.push("## 概述");
  lines.push(
    `由 \`${run.triggerEvent}\` 触发，当前状态 \`${run.status}\`${run.suspendedReason ? `（${run.suspendedReason}）` : ""}。共涉及 ${breakdown.length} 个 agent，记录 ${steps.length} 个 step、${activities.length} 条 narrative。`,
  );
  lines.push("");
  lines.push("## 各 Agent 做了什么");
  if (breakdown.length === 0) {
    lines.push("- 暂无 agent 活动记录。");
  } else {
    for (const r of breakdown) {
      const fn = byShortFunction(r.agentName);
      const lastBit = r.lastNarrative ? `；最近一次：${truncate(r.lastNarrative, 80)}` : "";
      const fnBit = fn ? `（${fn.summary}）` : "";
      lines.push(
        `- **${r.agentName}** ${fnBit}：执行 ${r.steps} 个 step，累计 ${r.totalDurationMs} ms${r.failed > 0 ? `，**${r.failed} 失败**` : ""}${lastBit}`,
      );
    }
  }
  lines.push("");
  lines.push("## 异常 / 关注点");
  const failed = steps.filter((s) => s.status === "failed" || s.error);
  if (failed.length === 0) {
    lines.push("- 未发现失败 step。");
  } else {
    for (const s of failed) {
      lines.push(`- \`${s.nodeId}\`：${s.error ?? "step 状态为 failed"}`);
    }
  }
  lines.push("");
  lines.push("## 下一步建议");
  if (failed.length > 0) {
    lines.push("- 复盘失败 step 的输入与上游事件，判断是数据问题还是 agent 逻辑问题。");
  } else if (run.status === "suspended" || run.status === "paused") {
    lines.push("- 该 run 处于暂停状态，请检查 `suspendedReason` 并决定是否恢复。");
  } else if (run.status === "running") {
    lines.push("- 仍在执行中。可定期刷新本页观察进度。");
  } else {
    lines.push("- 此 run 已正常完成，可作为基准参考。");
  }
  lines.push("");
  lines.push("> 未配置 LLM 网关（AI_BASE_URL / OPENAI_API_KEY），以上内容由统计字段直接渲染。配置后可获得更具体的语义解读。");
  return lines.join("\n");
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

// Honest "no data" notice rendered when a run has 0 AgentActivity AND
// 0 WorkflowStep rows. Without this, calling the LLM on emptiness leads
// to it inventing agent names like `JD_Writer / Recruiter_Agent` that
// don't exist in AGENT_MAP.
function emptyRunNotice(run: {
  triggerEvent: string;
  status: string;
  startedAt: Date;
  suspendedReason: string | null;
}): string {
  const ageMs = Date.now() - run.startedAt.getTime();
  const ageMin = Math.round(ageMs / 60_000);
  return `## 概述
触发事件 \`${run.triggerEvent}\`，当前状态 \`${run.status}\`${
    run.suspendedReason ? `（${run.suspendedReason}）` : ""
  }。run 开始于 **${ageMin} 分钟前**。

## 数据状态
**这条 run 在 AgentActivity 表里 0 行记录**，在 WorkflowStep 表里也 0 步。无法做有意义的多 agent 路径分析或行为总结——LLM 没有可信数据可依，强行生成会产生幻觉的 agent 名（如 \`JD_Writer\` 等不存在于 AGENT_MAP 的虚构名）。

## 为什么是空的
- AO-main 已禁用所有 Inngest function（见 \`server/inngest/functions.ts\` 的 \`allFunctions: []\`），不会自己写 AgentActivity
- 实际 runtime 在 sibling 项目 \`resume-parser-agent\` (port 3020)，但它没接 AO-main 的 DB
- 所以即使 RPA agent 跑了，活动日志也不会落到这里

## 怎么修
任选其一：
1. RPA runtime 调用 \`POST /api/runs/[runId]/activity\` 把活动行 push 进来（详见路由文件注释）
2. 或者在 AO-main 的 \`server/inngest/functions.ts\` 里 re-enable agents（取消注释 \`allFunctions\` 数组）
3. 或者用 \`POST /api/runs/[runId]/activity\` 手动塞测试数据进来验证 UI

## 下一步建议
接通活动日志契约后，重新点 "重新生成"——LLM 才有真实数据做多 agent 分析。

> 这不是 LLM 不能用，是这条 run 没有数据可让它分析。`;
}

// Given the agents that ACTIVATED in this run, plus the events seen in
// activity narratives, compute which downstream agents WERE EXPECTED but
// didn't activate. This is the "should have run but didn't" set the LLM
// uses for its 工作流路径 section.
//
// Algorithm:
//   1. Collect events emitted (from activity narratives like "Published X").
//   2. Cross-reference AGENT_MAP — any agent whose triggersEvents intersects
//      with our emitted set, but isn't in the activated set, is "expected".
//   3. Cap at one hop downstream — going further is speculative without
//      knowing branch decisions.
function computeExpectedDownstream(
  activated: Set<string>,
  activities: Array<{ narrative: string; type: string }>,
): Set<string> {
  // Pull emitted-event names out of "Published EVENT_NAME · ..." narratives.
  const emitted = new Set<string>();
  for (const a of activities) {
    if (a.type !== "event_emitted" && !a.narrative.startsWith("Published")) continue;
    const m = a.narrative.match(/Published\s+([A-Z_]+)/);
    if (m) emitted.add(m[1]);
  }
  // Also consider the trigger event itself as "input" — agents subscribed
  // to it that didn't activate are notable.
  const expected = new Set<string>();
  for (const agent of AGENT_MAP) {
    if (activated.has(agent.short)) continue;
    const matches = agent.triggersEvents.some((t) => emitted.has(t));
    if (matches) expected.add(agent.short);
  }
  return expected;
}

export async function DELETE(_req: Request, ctx: RouteCtx): Promise<Response> {
  const { id } = await ctx.params;
  let cleared = 0;
  for (const k of cache.keys()) {
    if (k.startsWith(id + "@")) {
      cache.delete(k);
      cleared++;
    }
  }
  return NextResponse.json({ cleared });
}
