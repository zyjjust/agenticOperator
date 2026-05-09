// /api/runs/:id/chat
//
// Tool-using chatbot scoped to ONE run. Implements the design we agreed
// on (see chat history 2026-05-09):
//   - Scoped to the selected run — bot can't roam the whole DB
//   - Tool-using LLM: bot picks from a fixed set of API tools, no free-form SQL
//   - Citations required: every fact comes back with which tool / which
//     row produced it (returned in `sources[]`)
//   - Read-only: no tools mutate state
//
// Two execution modes:
//   1. LLM gateway configured (AI_BASE_URL+AI_API_KEY or OPENAI_API_KEY)
//      → real tool-use loop with OpenAI-compatible function calling
//   2. No gateway → deterministic "I'm a fallback bot" router that
//      pattern-matches the question and runs the obvious tool itself.
//
// POST { messages: [{ role: 'user'|'assistant'|'system', content: string }] }
// → { reply: { role: 'assistant', content }, sources: [...], modelUsed?, error? }

import { NextResponse } from "next/server";
import OpenAI from "openai";
import { prisma } from "@/server/db";
import { isGatewayConfigured, pickGateway } from "@/server/llm/gateway";
import {
  normalizeKind,
  type LogEntry,
  type LogKind,
} from "@/lib/api/activity-types";
import { byShortFunction } from "@/lib/agent-functions";
import { AGENT_MAP, byShort } from "@/lib/agent-mapping";

type RouteCtx = { params: Promise<{ id: string }> };

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type Source = {
  /** Which tool produced the row. */
  tool: string;
  /** Free-text describing what was returned. */
  label: string;
  /** Optional pointer back into the run / activity / step / event. */
  ref?: string;
};

const MAX_TOOL_TURNS = 4;
const MAX_RECENT_ROWS = 30;

const SYSTEM_PROMPT = `You are an assistant for one workflow run inside Agentic Operator.

Hard constraints:
- You can only answer questions about THIS run (its activities, steps, events, agent stats). If the user asks about another run, system, or unrelated topic, politely refuse and explain.
- You MUST use the provided tools to fetch data. Never invent agent names, durations, or step counts.
- Every fact you state must point to which tool you called and which row/field it came from. Cite inline like "(from getActivityLog: row#3 at 14:06:12)".
- You are read-only. Never describe yourself as making changes. If the user asks you to retry / pause / mutate, refuse and tell them which UI button to click.
- Be concise — most ops questions deserve 2-4 sentences plus structured data, not paragraphs.
- Respond in the same language as the user's question (Chinese if they ask in Chinese, English otherwise).`;

export async function POST(req: Request, ctx: RouteCtx): Promise<Response> {
  const { id: runId } = await ctx.params;
  const body = (await req.json().catch(() => null)) as
    | { messages?: ChatMessage[] }
    | null;
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return NextResponse.json(
      { error: "BAD_REQUEST", message: "messages[] required" },
      { status: 400 },
    );
  }

  const run = await prisma.workflowRun.findUnique({ where: { id: runId } });
  if (!run) {
    return NextResponse.json(
      { error: "NOT_FOUND", message: `run ${runId} not found` },
      { status: 404 },
    );
  }

  // Build the run "context preamble" — given to the LLM as system context
  // so it doesn't have to call tools just to learn basics about the run.
  const preamble =
    `RUN_ID: ${runId}\n` +
    `STATUS: ${run.status}\n` +
    `TRIGGER: ${run.triggerEvent}\n` +
    `STARTED: ${run.startedAt.toISOString()}\n` +
    `${run.completedAt ? `COMPLETED: ${run.completedAt.toISOString()}\n` : ""}` +
    `Use the tools to fetch activity, agent stats, step details.`;

  if (!isGatewayConfigured()) {
    // Fallback mode — deterministic question router.
    return NextResponse.json(await fallbackAnswer(runId, body.messages));
  }

  try {
    return NextResponse.json(await runToolLoop(runId, preamble, body.messages));
  } catch (e) {
    return NextResponse.json(
      {
        error: "LLM_FAILED",
        message: (e as Error).message,
        // Best-effort fallback so the UI still shows something.
        ...(await fallbackAnswer(runId, body.messages)),
      },
      { status: 502 },
    );
  }
}

// ── Tool definitions exposed to the LLM ──────────────────────────────

type ToolName =
  | "getActivityLog"
  | "getAgentStats"
  | "getEventTrace"
  | "getRunSummary"
  | "getAgentInfo";

const TOOL_SCHEMAS = [
  {
    type: "function" as const,
    function: {
      name: "getActivityLog",
      description:
        "Fetch AgentActivity rows for THIS run, optionally filtered by kind (tool, decision, anomaly, error, step.failed, step.started, step.completed). Returns up to 30 rows newest first.",
      parameters: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            description: "Optional comma list of kinds to filter on",
          },
          limit: { type: "number", description: "Max rows (default 30)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "getAgentStats",
      description:
        "Aggregate per-agent counts for this run: how many steps each agent ran, errors, tool calls, decisions.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "getEventTrace",
      description:
        "Get the events emitted/received during this run with their downstream Inngest function runs (local bus). Useful for 'what did downstream do' / 'what RAAS did' questions.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "getRunSummary",
      description:
        "Get the high-level AI-or-statistical summary of this run (always available, fast).",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "getAgentInfo",
      description:
        "Get the registry definition + function description for one agent by short name (e.g. JDGenerator). Use when the user asks 'what does X do'.",
      parameters: {
        type: "object",
        properties: {
          short: { type: "string", description: "agent short, e.g. JDGenerator" },
        },
        required: ["short"],
      },
    },
  },
];

// ── Tool implementations (read-only) ─────────────────────────────────

async function execTool(
  runId: string,
  name: ToolName,
  args: Record<string, unknown>,
): Promise<{ result: unknown; sources: Source[] }> {
  if (name === "getActivityLog") {
    const kindFilter = (args.kind as string | undefined)
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const limit = Math.min(MAX_RECENT_ROWS, Number(args.limit) || MAX_RECENT_ROWS);
    const rows = await prisma.agentActivity.findMany({
      where: { runId },
      orderBy: { createdAt: "desc" },
      take: limit * 2,
    });
    let entries: LogEntry[] = rows.map((r) => ({
      id: r.id,
      ts: r.createdAt.toISOString(),
      agent: r.agentName || r.nodeId || "system",
      kind: normalizeKind(r.type),
      message: r.narrative,
      metadata: parseJson(r.metadata),
      runId: r.runId,
      synthetic: false,
    }));
    if (kindFilter && kindFilter.length > 0) {
      const allowed = new Set<LogKind>(kindFilter.map((k) => normalizeKind(k)));
      entries = entries.filter((e) => allowed.has(e.kind));
    }
    entries = entries.slice(0, limit);
    return {
      result: { count: entries.length, entries },
      sources: [
        {
          tool: "getActivityLog",
          label: `${entries.length} AgentActivity rows`,
          ref: runId,
        },
      ],
    };
  }

  if (name === "getAgentStats") {
    const rows = await prisma.agentActivity.findMany({
      where: { runId },
      orderBy: { createdAt: "asc" },
    });
    const byAgent = new Map<
      string,
      { steps: number; errors: number; tools: number; decisions: number; anomalies: number }
    >();
    for (const r of rows) {
      const k = r.agentName || r.nodeId || "system";
      let s = byAgent.get(k);
      if (!s) {
        s = { steps: 0, errors: 0, tools: 0, decisions: 0, anomalies: 0 };
        byAgent.set(k, s);
      }
      const kind = normalizeKind(r.type);
      if (kind === "step.completed" || kind === "step.failed") s.steps++;
      if (kind === "step.failed" || kind === "error") s.errors++;
      if (kind === "tool") s.tools++;
      if (kind === "decision") s.decisions++;
      if (kind === "anomaly") s.anomalies++;
    }
    return {
      result: Array.from(byAgent.entries()).map(([agent, s]) => ({ agent, ...s })),
      sources: [
        {
          tool: "getAgentStats",
          label: `${byAgent.size} agents touched this run`,
          ref: runId,
        },
      ],
    };
  }

  if (name === "getEventTrace") {
    // Reuse the trace endpoint's logic by going through HTTP — keeps
    // single source of truth for what counts as an event.
    const base = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3002";
    try {
      const r = await fetch(`${base}/api/runs/${encodeURIComponent(runId)}/trace`, {
        signal: AbortSignal.timeout(5_000),
      });
      const j = await r.json();
      return {
        result: j,
        sources: [
          {
            tool: "getEventTrace",
            label: `${(j.eventLane ?? []).length} events, ${(j.agentLanes ?? []).length} lanes`,
            ref: runId,
          },
        ],
      };
    } catch (e) {
      return {
        result: { error: (e as Error).message },
        sources: [{ tool: "getEventTrace", label: `error: ${(e as Error).message}` }],
      };
    }
  }

  if (name === "getRunSummary") {
    const base = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3002";
    try {
      const r = await fetch(`${base}/api/runs/${encodeURIComponent(runId)}/summary`, {
        signal: AbortSignal.timeout(20_000),
      });
      const j = await r.json();
      return {
        result: j,
        sources: [{ tool: "getRunSummary", label: `summary via ${j.source ?? "?"}`, ref: runId }],
      };
    } catch (e) {
      return {
        result: { error: (e as Error).message },
        sources: [{ tool: "getRunSummary", label: `error: ${(e as Error).message}` }],
      };
    }
  }

  if (name === "getAgentInfo") {
    const short = String(args.short ?? "");
    const meta = byShort(short);
    const fn = byShortFunction(short);
    if (!meta && !fn) {
      return {
        result: { error: `unknown agent '${short}'`, knownAgents: AGENT_MAP.map((a) => a.short) },
        sources: [{ tool: "getAgentInfo", label: `404 ${short}` }],
      };
    }
    return {
      result: { meta, fn },
      sources: [{ tool: "getAgentInfo", label: short }],
    };
  }

  return {
    result: { error: `unknown tool ${name}` },
    sources: [{ tool: name, label: "unknown tool" }],
  };
}

// ── LLM tool-loop ─────────────────────────────────────────────────────

async function runToolLoop(
  runId: string,
  preamble: string,
  messages: ChatMessage[],
): Promise<{
  reply: ChatMessage;
  sources: Source[];
  modelUsed?: string;
  toolCallsExecuted?: number;
}> {
  const cfg = pickGateway();
  const client = new OpenAI({ baseURL: cfg.baseURL, apiKey: cfg.apiKey });
  const sources: Source[] = [];

  // Build conversation: system + preamble + user history.
  const convo: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT + "\n\nRun context:\n" + preamble },
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
      // LLM is done with tools — return final answer.
      return {
        reply: { role: "assistant", content: msg.content ?? "" },
        sources,
        modelUsed: cfg.model,
        toolCallsExecuted,
      };
    }

    // Execute each tool call sequentially (parallel could overload Prisma).
    for (const tc of toolCalls) {
      if (tc.type !== "function") continue;
      const name = tc.function.name as ToolName;
      let args: Record<string, unknown> = {};
      try {
        args = tc.function.arguments ? (JSON.parse(tc.function.arguments) as Record<string, unknown>) : {};
      } catch {
        // Malformed args — give the LLM the opportunity to fix.
      }
      const { result, sources: s } = await execTool(runId, name, args);
      sources.push(...s);
      toolCallsExecuted++;
      convo.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(result).slice(0, 12_000), // cap to keep tokens bounded
      });
    }
  }

  // If we exhausted MAX_TOOL_TURNS without a final answer, ask LLM for one
  // last response with no tools.
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
    reply: { role: "assistant", content: final.choices[0]?.message?.content ?? "(no answer)" },
    sources,
    modelUsed: cfg.model,
    toolCallsExecuted,
  };
}

// ── Fallback (no LLM gateway) ────────────────────────────────────────

async function fallbackAnswer(
  runId: string,
  messages: ChatMessage[],
): Promise<{ reply: ChatMessage; sources: Source[]; modelUsed?: string }> {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const q = (lastUser?.content ?? "").toLowerCase();

  // Keyword-route the question to the right tool. Honest about what we
  // can and can't do without an LLM.
  let chosen: ToolName = "getRunSummary";
  if (/log|活动|日志|narrative/.test(q)) chosen = "getActivityLog";
  else if (/agent|stat|breakdown|参与/.test(q)) chosen = "getAgentStats";
  else if (/event|事件|raas|inngest|trace/.test(q)) chosen = "getEventTrace";

  const { result, sources } = await execTool(runId, chosen, {});
  const summary =
    chosen === "getRunSummary"
      ? `(无 LLM 网关 fallback，直接给你 run 总结)\n\n${(result as { text?: string }).text ?? "—"}`
      : `(无 LLM 网关 fallback。我猜你想看 ${chosen}：)\n\`\`\`json\n${JSON.stringify(result, null, 2).slice(0, 1800)}\n\`\`\``;
  return {
    reply: { role: "assistant", content: summary },
    sources,
    modelUsed: "fallback",
  };
}

function parseJson(s: string | null): Record<string, unknown> | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
