// /api/agents/:short/chat
//
// Tool-using chatbot scoped to ONE agent (cross-run). Sister to
// /api/runs/:id/chat — same prompt-caching / tool-loop / fallback shape,
// but the tool set is built for "find me instances by entity / failure"
// rather than "what happened in this one run".
//
// Tools are READ-ONLY. Like the run chat, this never mutates state.
//
// POST { messages: [{ role: 'user'|'assistant', content }] }
// → { reply, sources, modelUsed?, toolCallsExecuted? }

import { NextResponse } from "next/server";
import OpenAI from "openai";
import { prisma } from "@/server/db";
import { isGatewayConfigured, pickGateway } from "@/server/llm/gateway";
import { byShort } from "@/lib/agent-mapping";
import { byShortFunction } from "@/lib/agent-functions";
import { extractEntityRefs } from "@/lib/entity-extractor";
import { isEntityType, ENTITY_LABELS, type EntityType } from "@/lib/entity-types";

type RouteCtx = { params: Promise<{ short: string }> };

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type AgentChatSource = {
  tool: string;
  label: string;
  ref?: string;
};

export type AgentChatResponse = {
  reply: ChatMessage;
  sources: AgentChatSource[];
  modelUsed?: string;
  toolCallsExecuted?: number;
};

const MAX_TOOL_TURNS = 4;
const MAX_RECENT_ROWS = 50;
const MAX_TOOL_RESULT_BYTES = 12_000;

function systemPrompt(short: string, registryFacts: string): string {
  return `你是 Agentic Operator 中 \`${short}\` 这个 agent 的运营助手。

硬约束:
- 你的查询范围严格限定在 ${short} 经手的 run / 活动 / 实体。
  问到其他 agent 时礼貌指引用户到 /workflow 切换。
- 涉及 run / entity / step 的事实必须通过工具查询。禁止编造 ID / 数字 / 时间戳。
- 提到 entity（候选人 / JD / 需求）时，输出 markdown 链接
  [显示名](/entities/<type>/<id>)，让用户能点开历程页。
- 默认时间窗 24 小时；用户改了再换。
- 失败 / 错误优先排查，给出下一步行动建议。
- 这是只读端点：禁止给用户 retry / cancel / 改配置之类的"操作"建议，
  仅指向 /workflow 或 /live 上的对应按钮。

回答风格:
- 第一句直接给结论。
- 数字 / agent 名 / 时间戳用 **加粗**；ID / 事件名 / 状态值用 \`反引号\`。
- 1-2 项用句子，3+ 项用 bullet。
- 默认 ≤8 行，问"详细"再展开。
- 跟随用户语言（中文进 → 中文出，英文进 → 英文出）。

注册元数据 (来自 AGENT_FUNCTIONS / AGENT_MAP):
${registryFacts}`;
}

export async function POST(req: Request, ctx: RouteCtx): Promise<Response> {
  const { short } = await ctx.params;
  const meta = byShort(short);
  if (!meta) {
    return NextResponse.json(
      { error: "NOT_FOUND", message: `agent ${short} not in AGENT_MAP` },
      { status: 404 },
    );
  }
  const body = (await req.json().catch(() => null)) as
    | { messages?: ChatMessage[] }
    | null;
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return NextResponse.json(
      { error: "BAD_REQUEST", message: "messages[] required" },
      { status: 400 },
    );
  }

  const fn = byShortFunction(short);
  const registryFacts = [
    `Stage: ${meta.stage} · Kind: ${meta.kind} · Owner: ${meta.ownerTeam} · Version: ${meta.version}`,
    `Triggers: ${meta.triggersEvents.join(", ") || "(none)"}`,
    `Emits:    ${meta.emitsEvents.join(", ") || "(none / terminal)"}`,
    fn ? `Summary:  ${fn.summary}` : "",
    fn?.tools ? `Tools:    ${fn.tools.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  // Audit-log the user's question into AgentActivity so chatbot use shows
  // up in the agent's activity log (and auto-extractor catches it).
  const lastUser = [...body.messages].reverse().find((m) => m.role === "user");
  if (lastUser) {
    void prisma.agentActivity
      .create({
        data: {
          runId: null,
          nodeId: meta.wsId,
          agentName: short,
          type: "info",
          narrative: `🗨️ 用户问 (${short}-chat): ${lastUser.content.slice(0, 200)}${lastUser.content.length > 200 ? "…" : ""}`,
          metadata: JSON.stringify({ chatbot: true, scope: "agent", role: "user" }),
        },
      })
      .catch(() => {/* never break chat on audit failure */});
  }

  let result: AgentChatResponse;
  try {
    if (!isGatewayConfigured()) {
      result = await fallbackAnswer(short, body.messages);
    } else {
      result = await runToolLoop(short, registryFacts, body.messages);
    }
  } catch (e) {
    return NextResponse.json(
      {
        error: "LLM_FAILED",
        message: (e as Error).message,
        ...(await fallbackAnswer(short, body.messages)),
      },
      { status: 502 },
    );
  }

  void prisma.agentActivity
    .create({
      data: {
        runId: null,
        nodeId: meta.wsId,
        agentName: short,
        type: "info",
        narrative: `🤖 AI 答 (${short}-chat): ${result.reply.content.slice(0, 200)}${result.reply.content.length > 200 ? "…" : ""}`,
        metadata: JSON.stringify({
          chatbot: true,
          scope: "agent",
          role: "assistant",
          modelUsed: result.modelUsed,
          toolCallsExecuted: result.toolCallsExecuted ?? 0,
          sourcesCount: result.sources?.length ?? 0,
        }),
      },
    })
    .catch(() => {/* never break chat on audit failure */});

  return NextResponse.json(result);
}

// ── Tool definitions ───────────────────────────────────────────────────

type ToolName =
  | "search_runs_by_agent"
  | "recent_entities_by_agent"
  | "get_entity_journey"
  | "search_failures";

const TOOL_SCHEMAS = [
  {
    type: "function" as const,
    function: {
      name: "search_runs_by_agent",
      description:
        "List runs that involved this agent. Returns runId + status + start/end + duration. Use to answer 'recent runs', 'how many failed', etc.",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            description: "completed | failed | running | all (default all)",
          },
          sinceHours: {
            type: "number",
            description: "Time window (default 24, max 168)",
          },
          limit: { type: "number", description: "Max rows (default 20, max 50)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "recent_entities_by_agent",
      description:
        "Top-N most recently-touched entities by this agent. Returns type / id / display_name / lastSeenAt. Use for 'recent JDs', 'recent candidates'.",
      parameters: {
        type: "object",
        properties: {
          entityType: {
            type: "string",
            description:
              "JobRequisition | JobPosting | Candidate (default any)",
          },
          sinceHours: {
            type: "number",
            description: "Time window (default 168, max 720)",
          },
          limit: { type: "number", description: "Default 10, max 50" },
        },
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_entity_journey",
      description:
        "Get the cross-run timeline for ONE entity. Returns runs / activities (compact) / agent rollup. Use to answer detailed 'what happened to JD X' questions after recent_entities_by_agent surfaced an interesting one.",
      parameters: {
        type: "object",
        properties: {
          entityType: {
            type: "string",
            description: "JobRequisition | JobPosting | Candidate",
          },
          entityId: { type: "string" },
          days: {
            type: "number",
            description: "Default 7, max 30",
          },
        },
        required: ["entityType", "entityId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "search_failures",
      description:
        "Find failed activity rows for this agent (agent_error / step.failed / anomaly). Optional substring match against narrative or metadata.",
      parameters: {
        type: "object",
        properties: {
          contains: {
            type: "string",
            description: "Substring match against narrative",
          },
          sinceHours: {
            type: "number",
            description: "Default 24, max 168",
          },
          limit: { type: "number", description: "Default 20, max 50" },
        },
        required: [],
      },
    },
  },
];

// ── Tool implementations ───────────────────────────────────────────────

async function execTool(
  short: string,
  name: ToolName,
  args: Record<string, unknown>,
): Promise<{ result: unknown; sources: AgentChatSource[] }> {
  if (name === "search_runs_by_agent") {
    const sinceH = clamp(num(args.sinceHours, 24), 1, 168);
    const limit = clamp(num(args.limit, 20), 1, MAX_RECENT_ROWS);
    const since = new Date(Date.now() - sinceH * 3600_000);
    // Find runIds where this agent has activity in the window.
    const acts = await prisma.agentActivity.findMany({
      where: {
        agentName: short,
        createdAt: { gte: since },
        runId: { not: null },
      },
      select: { runId: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 500,
    });
    const runIds = Array.from(new Set(acts.map((a) => a.runId!).filter(Boolean)));
    if (runIds.length === 0) {
      return {
        result: { count: 0, runs: [] },
        sources: [
          { tool: name, label: `0 runs touched by ${short} in last ${sinceH}h` },
        ],
      };
    }
    const runs = await prisma.workflowRun.findMany({
      where: { id: { in: runIds } },
      orderBy: { startedAt: "desc" },
      take: limit,
    });
    const statusFilter = (args.status as string | undefined) ?? "all";
    const filtered = statusFilter === "all"
      ? runs
      : runs.filter((r) => r.status === statusFilter);
    return {
      result: {
        count: filtered.length,
        runs: filtered.map((r) => ({
          id: r.id,
          status: r.status,
          triggerEvent: r.triggerEvent,
          startedAt: r.startedAt.toISOString(),
          completedAt: r.completedAt?.toISOString() ?? null,
          durationMs: r.completedAt
            ? r.completedAt.getTime() - r.startedAt.getTime()
            : null,
        })),
      },
      sources: [
        { tool: name, label: `${filtered.length} runs by ${short}, ${sinceH}h` },
      ],
    };
  }

  if (name === "recent_entities_by_agent") {
    const sinceH = clamp(num(args.sinceHours, 168), 1, 720);
    const limit = clamp(num(args.limit, 10), 1, MAX_RECENT_ROWS);
    const onlyType = typeof args.entityType === "string" && isEntityType(args.entityType)
      ? (args.entityType as EntityType)
      : null;
    const since = new Date(Date.now() - sinceH * 3600_000);
    const rows = await prisma.agentActivity.findMany({
      where: {
        agentName: short,
        createdAt: { gte: since },
        metadata: { not: null },
      },
      orderBy: { createdAt: "desc" },
      take: 1000,
    });
    type B = { type: EntityType; id: string; lastMs: number; count: number };
    const map = new Map<string, B>();
    for (const a of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(a.metadata!);
      } catch {
        continue;
      }
      const refs = extractEntityRefs(parsed);
      for (const ref of refs) {
        if (onlyType && ref.type !== onlyType) continue;
        const k = `${ref.type}:${ref.id}`;
        let b = map.get(k);
        const ts = a.createdAt.getTime();
        if (!b) {
          b = { type: ref.type, id: ref.id, lastMs: ts, count: 0 };
          map.set(k, b);
        }
        b.count += 1;
        if (ts > b.lastMs) b.lastMs = ts;
      }
    }
    const entities = Array.from(map.values())
      .sort((a, b) => b.lastMs - a.lastMs)
      .slice(0, limit)
      .map((b) => ({
        type: b.type,
        typeLabel: ENTITY_LABELS[b.type],
        id: b.id,
        lastSeenAt: new Date(b.lastMs).toISOString(),
        activityCount: b.count,
        url: `/entities/${b.type}/${b.id}`,
      }));
    return {
      result: { count: entities.length, entities },
      sources: [
        { tool: name, label: `${entities.length} entities, ${sinceH}h` },
      ],
    };
  }

  if (name === "get_entity_journey") {
    const t = args.entityType;
    const id = args.entityId;
    if (typeof t !== "string" || !isEntityType(t) || typeof id !== "string" || !id.trim()) {
      return {
        result: { error: "BAD_ARGS", message: "entityType + entityId required" },
        sources: [],
      };
    }
    const days = clamp(num(args.days, 7), 1, 30);
    // Compact form: just the highlights, not the full payloads (token-friendly).
    const since = new Date(Date.now() - days * 86_400_000);
    const acts = await prisma.agentActivity.findMany({
      where: {
        createdAt: { gte: since },
        metadata: { not: null },
      },
      orderBy: { createdAt: "asc" },
      take: 2000,
    });
    type Hit = {
      ts: string;
      runId: string | null;
      agent: string;
      type: string;
      narrative: string;
    };
    const hits: Hit[] = [];
    for (const a of acts) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(a.metadata!);
      } catch {
        continue;
      }
      const refs = extractEntityRefs(parsed);
      if (!refs.some((r) => r.type === t && r.id === id)) continue;
      hits.push({
        ts: a.createdAt.toISOString(),
        runId: a.runId,
        agent: a.agentName,
        type: a.type,
        narrative: a.narrative.slice(0, 160),
      });
      if (hits.length >= 100) break;
    }
    const runIds = Array.from(new Set(hits.map((h) => h.runId).filter(Boolean) as string[]));
    return {
      result: {
        entity: { type: t, id, url: `/entities/${t}/${id}` },
        runCount: runIds.length,
        activityCount: hits.length,
        hits,
      },
      sources: [
        {
          tool: name,
          label: `${hits.length} hits across ${runIds.length} runs`,
          ref: `${t}:${id}`,
        },
      ],
    };
  }

  if (name === "search_failures") {
    const sinceH = clamp(num(args.sinceHours, 24), 1, 168);
    const limit = clamp(num(args.limit, 20), 1, MAX_RECENT_ROWS);
    const contains = (args.contains as string | undefined)?.trim();
    const since = new Date(Date.now() - sinceH * 3600_000);
    let rows = await prisma.agentActivity.findMany({
      where: {
        agentName: short,
        createdAt: { gte: since },
        OR: [
          { type: "agent_error" },
          { type: "step.failed" },
          { type: "anomaly" },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    if (contains) {
      const needle = contains.toLowerCase();
      rows = rows.filter(
        (r) =>
          r.narrative.toLowerCase().includes(needle) ||
          (r.metadata?.toLowerCase().includes(needle) ?? false),
      );
    }
    rows = rows.slice(0, limit);
    return {
      result: {
        count: rows.length,
        rows: rows.map((r) => ({
          id: r.id,
          ts: r.createdAt.toISOString(),
          runId: r.runId,
          type: r.type,
          narrative: r.narrative,
        })),
      },
      sources: [
        { tool: name, label: `${rows.length} failures, ${sinceH}h` },
      ],
    };
  }

  return {
    result: { error: "UNKNOWN_TOOL", name },
    sources: [],
  };
}

// ── Tool loop ────────────────────────────────────────────────────────

async function runToolLoop(
  short: string,
  registryFacts: string,
  messages: ChatMessage[],
): Promise<AgentChatResponse> {
  const cfg = pickGateway();
  const client = new OpenAI({ baseURL: cfg.baseURL, apiKey: cfg.apiKey });
  const sources: AgentChatSource[] = [];

  const convo: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt(short, registryFacts) },
    ...messages.map((m) => ({ role: m.role, content: m.content }) as OpenAI.ChatCompletionMessageParam),
  ];

  let toolCallsExecuted = 0;
  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const completion = await client.chat.completions.create({
      model: cfg.model,
      messages: convo,
      tools: TOOL_SCHEMAS,
      tool_choice: "auto",
      temperature: 0.2,
      max_tokens: 700,
    });
    const choice = completion.choices[0];
    if (!choice) break;
    const msg = choice.message;
    convo.push(msg as OpenAI.ChatCompletionMessageParam);

    const toolCalls = msg.tool_calls ?? [];
    if (toolCalls.length === 0) {
      return {
        reply: { role: "assistant", content: msg.content ?? "" },
        sources,
        modelUsed: cfg.model,
        toolCallsExecuted,
      };
    }
    for (const tc of toolCalls) {
      if (tc.type !== "function") continue;
      const name = tc.function.name as ToolName;
      let args: Record<string, unknown> = {};
      try {
        args = tc.function.arguments
          ? (JSON.parse(tc.function.arguments) as Record<string, unknown>)
          : {};
      } catch {
        // Malformed args — let LLM retry next turn.
      }
      const { result, sources: s } = await execTool(short, name, args);
      sources.push(...s);
      toolCallsExecuted++;
      convo.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(result).slice(0, MAX_TOOL_RESULT_BYTES),
      });
    }
  }
  // Tool budget exhausted.
  const final = await client.chat.completions.create({
    model: cfg.model,
    messages: [
      ...convo,
      {
        role: "user",
        content:
          "(System: tool budget exceeded. Synthesize a final answer from what you've gathered.)",
      },
    ],
    temperature: 0.2,
    max_tokens: 500,
  });
  return {
    reply: {
      role: "assistant",
      content: final.choices[0]?.message?.content ?? "(no answer)",
    },
    sources,
    modelUsed: cfg.model,
    toolCallsExecuted,
  };
}

// ── Fallback (no LLM gateway) ─────────────────────────────────────────

async function fallbackAnswer(
  short: string,
  messages: ChatMessage[],
): Promise<AgentChatResponse> {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const q = (lastUser?.content ?? "").toLowerCase();
  let chosen: ToolName = "recent_entities_by_agent";
  if (/失败|fail|error|timeout|异常/.test(q)) chosen = "search_failures";
  else if (/run|跑|历史/.test(q)) chosen = "search_runs_by_agent";
  const { result, sources } = await execTool(short, chosen, {});
  const summary =
    `(无 LLM 网关 fallback。我猜你想看 \`${chosen}\`：)\n\n\`\`\`json\n${JSON.stringify(result, null, 2).slice(0, 1800)}\n\`\`\`\n\n` +
    `如需 AI 解读，配置 AI_BASE_URL+AI_API_KEY 或 OPENAI_API_KEY 后重试。`;
  return {
    reply: { role: "assistant", content: summary },
    sources,
    modelUsed: "fallback",
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

function num(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
