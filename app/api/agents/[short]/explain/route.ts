// /api/agents/:short/explain
//
// Returns a natural-language explanation of an agent's job, operations and
// trigger/emit wiring. Backed by the LLM when a gateway is configured;
// falls back to a deterministic markdown rendering of the registry meta.
//
// The response is cached in-process by `short` for the lifetime of the
// node process — agent metadata changes infrequently and we'd rather pay
// the LLM cost once per dev restart than per inspector click.

import { NextResponse } from "next/server";
import {
  AGENT_FUNCTIONS,
  byShortFunction,
  fallbackAgentExplanation,
  getAgentBundle,
} from "@/lib/agent-functions";
import { byShort } from "@/lib/agent-mapping";
import {
  chatComplete,
  GatewayUnavailableError,
  isGatewayConfigured,
} from "@/server/llm/gateway";

type RouteCtx = { params: Promise<{ short: string }> };

const cache = new Map<string, ExplainResponse>();

export type ExplainResponse = {
  short: string;
  text: string;
  source: "llm" | "fallback";
  modelUsed?: string;
  durationMs?: number;
  generatedAt: string;
};

const SYSTEM_PROMPT = `你是 Agentic Operator 的运行时讲解员。
给定一个 agent 的元数据，用中文输出一份 200~350 字的解读，覆盖：
1. 这个 agent 在整个招聘工作流里负责什么（业务视角）
2. 它每次执行时具体会做哪些操作（按调用顺序列出 3~6 条）
3. 它依赖哪些工具 / 模型 / 外部系统
4. 它关注哪些上下游事件（用反引号包住事件名）
5. 一句话告诉运营人员"什么时候应该担心它"

格式：Markdown，带 ## 二级标题分段，不要写无关寒暄。`;

function buildUserPrompt(short: string): string {
  const bundle = getAgentBundle(short);
  if (!bundle) {
    return `Agent: ${short}\n（注册表中没有该 agent 的元数据 — 请只用名字推断，并指出元数据缺失。）`;
  }
  const { meta, fn } = bundle;
  return [
    `Agent: ${short}`,
    `Stage: ${meta.stage}`,
    `Kind: ${meta.kind}`,
    `Owner: ${meta.ownerTeam}`,
    `Version: ${meta.version}`,
    `Triggers: ${meta.triggersEvents.join(", ") || "(none)"}`,
    `Emits: ${meta.emitsEvents.join(", ") || "(none / terminal)"}`,
    `Summary (registry): ${fn.summary}`,
    `Typical operations:`,
    ...fn.operations.map((o) => `  - ${o}`),
    `Tools / external systems:`,
    ...fn.tools.map((t) => `  - ${t}`),
    fn.failureModes && fn.failureModes.length > 0
      ? `Failure modes:\n${fn.failureModes.map((f) => `  - ${f}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function GET(_req: Request, ctx: RouteCtx): Promise<Response> {
  const { short } = await ctx.params;

  // The agent must at least exist in the wiring map; if not, 404 — there's
  // nothing useful the LLM could say from just a name.
  if (!byShort(short) && !byShortFunction(short)) {
    return NextResponse.json(
      {
        error: "NOT_FOUND",
        message: `agent ${short} not in AGENT_MAP / AGENT_FUNCTIONS`,
      },
      { status: 404 },
    );
  }

  const cached = cache.get(short);
  if (cached) return NextResponse.json(cached);

  if (!isGatewayConfigured()) {
    const body: ExplainResponse = {
      short,
      text: fallbackAgentExplanation(short),
      source: "fallback",
      generatedAt: new Date().toISOString(),
    };
    cache.set(short, body);
    return NextResponse.json(body);
  }

  try {
    const { text, modelUsed, durationMs } = await chatComplete({
      system: SYSTEM_PROMPT,
      user: buildUserPrompt(short),
      temperature: 0.2,
      maxTokens: 700,
    });
    const body: ExplainResponse = {
      short,
      text: text || fallbackAgentExplanation(short),
      source: text ? "llm" : "fallback",
      modelUsed,
      durationMs,
      generatedAt: new Date().toISOString(),
    };
    cache.set(short, body);
    return NextResponse.json(body);
  } catch (e) {
    if (e instanceof GatewayUnavailableError) {
      // Race between isGatewayConfigured() and pickGateway() — env removed
      // mid-request. Return fallback rather than 5xx.
      const body: ExplainResponse = {
        short,
        text: fallbackAgentExplanation(short),
        source: "fallback",
        generatedAt: new Date().toISOString(),
      };
      return NextResponse.json(body);
    }
    return NextResponse.json(
      {
        error: "LLM_FAILED",
        message: (e as Error).message,
        fallback: fallbackAgentExplanation(short),
      },
      { status: 502 },
    );
  }
}

// Lets ops invalidate the cache without a process restart.
export async function DELETE(): Promise<Response> {
  cache.clear();
  return NextResponse.json({ cleared: AGENT_FUNCTIONS.length });
}
