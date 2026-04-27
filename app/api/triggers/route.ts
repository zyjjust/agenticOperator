import { NextResponse } from 'next/server';
import { AGENT_MAP } from '@/lib/agent-mapping';
import { TRIGGER_CATALOG } from '@/lib/triggers-static';
import type { TriggersResponse, TriggerDef } from '@/lib/api/types';

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const kindFilter = url.searchParams.get('kind')?.split(',');

  const triggers: TriggerDef[] = [];

  // Cron + webhook from static catalog (P2 fallback; P3 from real config).
  for (const seed of TRIGGER_CATALOG) {
    triggers.push({
      id: seed.id,
      kind: seed.kind,
      name: seed.name,
      description: seed.description,
      emits: seed.emits,
      schedule: seed.schedule,
      endpoint: seed.endpoint,
      lastFiredAt: null,
      nextFireAt: seed.kind === 'cron' ? estimateNext(seed.schedule) : null,
      fireCount24h: 0,
      errorCount24h: 0,
    });
  }

  // Upstream emits — events that some agent triggers on but no agent emits.
  // These are entry points produced by external systems (e.g., REQUIREMENT_LOGGED).
  for (const upstream of deriveUpstreamEvents()) {
    triggers.push({
      id: `upstream-${upstream}`,
      kind: 'upstream',
      name: upstream,
      description: `External emit triggers AO workflow (${upstream})`,
      emits: [upstream],
      upstreamEvent: upstream,
      lastFiredAt: null,
      nextFireAt: null,
      fireCount24h: 0,
      errorCount24h: 0,
    });
  }

  const filtered = kindFilter ? triggers.filter((t) => kindFilter.includes(t.kind)) : triggers;

  const body: TriggersResponse = {
    triggers: filtered,
    meta: { generatedAt: new Date().toISOString() },
  };
  return NextResponse.json(body);
}

function deriveUpstreamEvents(): string[] {
  const triggered = new Set<string>();
  const emitted = new Set<string>();
  for (const a of AGENT_MAP) {
    for (const e of a.triggersEvents) triggered.add(e);
    for (const e of a.emitsEvents) emitted.add(e);
  }
  // Triggered but never emitted by any agent → must come from outside.
  return [...triggered].filter((e) => !emitted.has(e));
}

// Minimal cron next-fire estimator: just adds 5 min for "*/5 * * * *" patterns.
// Real scheduling lives in WS run-sweeper; this is just for UI display.
function estimateNext(_schedule: string | undefined): string {
  return new Date(Date.now() + 60_000).toISOString();
}
