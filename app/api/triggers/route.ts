import { NextResponse } from 'next/server';
import { AGENT_MAP } from '@/lib/agent-mapping';
import { TRIGGER_CATALOG } from '@/lib/triggers-static';
import { allFunctions } from '@/server/inngest/functions';
import type { TriggersResponse, TriggerDef } from '@/lib/api/types';

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const kindFilter = url.searchParams.get('kind')?.split(',');

  const triggers: TriggerDef[] = [];

  // ── Real Inngest functions (live from server/inngest/functions.ts) ──
  // These are the agents AO has actually registered with Inngest. Most
  // important entries — they show what's listening for events RIGHT NOW.
  for (const fn of allFunctions) {
    const opts: any = (fn as any)?.opts ?? (fn as any)?.options ?? {};
    const triggersList: any[] = opts.triggers ?? [];
    for (let i = 0; i < triggersList.length; i++) {
      const tg = triggersList[i];
      if (tg.event) {
        triggers.push({
          id: `inngest-${opts.id ?? "fn"}-${i}`,
          kind: 'upstream',
          name: tg.event,
          description: `Inngest function "${opts.name ?? opts.id ?? "?"}" subscribes to event ${tg.event}`,
          emits: deriveEmitsForFunction(opts.id ?? ""),
          upstreamEvent: tg.event,
          lastFiredAt: null,
          nextFireAt: null,
          fireCount24h: 0,
          errorCount24h: 0,
        });
      } else if (tg.cron) {
        triggers.push({
          id: `inngest-${opts.id ?? "fn"}-cron-${i}`,
          kind: 'cron',
          name: `${opts.name ?? opts.id ?? "?"} (cron)`,
          description: `Inngest cron function ${opts.id ?? "?"}`,
          emits: deriveEmitsForFunction(opts.id ?? ""),
          schedule: tg.cron,
          lastFiredAt: null,
          nextFireAt: null,
          fireCount24h: 0,
          errorCount24h: 0,
        });
      }
    }
  }

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
  return [...triggered].filter((e) => !emitted.has(e));
}

// For each Inngest function id like "9-1" or "10", look up emits in AGENT_MAP.
function deriveEmitsForFunction(fnId: string): string[] {
  const m = AGENT_MAP.find((a) => a.wsId === fnId);
  return m ? m.emitsEvents : [];
}

function estimateNext(_schedule: string | undefined): string {
  return new Date(Date.now() + 60_000).toISOString();
}
