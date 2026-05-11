"use server";

/**
 * Server action — runs `generatePrompt` against the live Ontology API.
 *
 * Kept server-side so the bearer token (`ONTOLOGY_API_TOKEN`) never reaches
 * the browser bundle. The client component calls this through React's
 * server-action transport.
 */

import { OntologyGenError } from "@/lib/ontology-gen";
import { generatePrompt } from "@/lib/ontology-gen/v4";
import type { MatchResumeRuntimeInput } from "@/lib/ontology-gen/v4";

export interface RunLiveOptions {
  actionRef: string;
  domain: string;
  client?: string;
  runtimeInput?: MatchResumeRuntimeInput;
}

export type RunLiveResult =
  | {
      ok: true;
      prompt: string;
      meta: {
        actionId: string;
        actionName: string;
        domain: string;
        client?: string;
        compiledAt: string;
        templateVersion: "v4";
        promptStrategy: string;
      };
    }
  | { ok: false; error: string; details?: unknown };

export async function runLive(opts: RunLiveOptions): Promise<RunLiveResult> {
  try {
    const obj = await generatePrompt({
      actionRef: opts.actionRef,
      domain: opts.domain,
      client: opts.client,
      runtimeInput: opts.runtimeInput,
    });
    return {
      ok: true,
      prompt: obj.prompt,
      meta: {
        actionId: obj.meta.actionId,
        actionName: obj.meta.actionName,
        domain: obj.meta.domain,
        client: obj.meta.client,
        compiledAt: obj.meta.compiledAt,
        templateVersion: obj.meta.templateVersion,
        promptStrategy: obj.meta.promptStrategy,
      },
    };
  } catch (err) {
    if (err instanceof OntologyGenError) {
      return { ok: false, error: `${err.name}: ${err.message}`, details: err.details };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
