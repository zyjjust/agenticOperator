# AO-INT-P1 · Sidecar 接通 · 实施计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace mock data in AO 6 pages with live data from EM/WS sidecars via Next.js Route Handlers — no new pages, no new external processes.

**Architecture:** Browser → AO Next.js (3002) → `app/api/*` Route Handlers → server-only modules (`server/clients/`, `server/normalize/`) → HTTP/SSE → WS sidecar (5175) + EM sidecar (8000) + Inngest dev (8288). All "归一化层" sits inside Next.js itself; no Express/Fastify added.

**Tech Stack:** Next.js 16 App Router · React 19 · TypeScript 5 strict · Tailwind v4 (CSS-first config) · Vitest (new) · `concurrently` (new) · `eventsource-parser` (new for SSE multiplexing)

**Spec:** [`docs/superpowers/specs/2026-04-27-ao-int-p1-sidecar-design.md`](../specs/2026-04-27-ao-int-p1-sidecar-design.md)

---

## Pre-flight

Before starting:
- [ ] Confirm sidecars are runnable: `cd Action_and_Event_Manager/workflow-studio/server && npm install && npm run dev` works on port 5175
- [ ] Confirm EM sidecar runnable: `cd Action_and_Event_Manager/packages/server && npm install && npm run dev` works on port 8000
- [ ] Confirm `npx inngest-cli@latest dev` works on port 8288
- [ ] Confirm AO dev currently works: `npm run dev` in repo root, opens http://localhost:3002/fleet
- [ ] Branch off `main`: `git checkout -b ao-int-p1`

If any sidecar is broken, fix it BEFORE starting. The plan assumes they run.

---

## Chunk 1 · Foundation: test setup + mappings + normalize utilities

Establishes test infrastructure and the pure-logic core. Everything in this chunk is unit-testable; no Next.js or HTTP yet. End-of-chunk: `npm test` passes ≥30 tests.

### Task 1: Set up Vitest

**Files:**
- Create: `vitest.config.ts`
- Modify: `package.json` (add devDeps + scripts)
- Create: `__tests__/sanity.test.ts`

- [ ] **Step 1.1: Add Vitest devDependencies**

```bash
npm install --save-dev vitest @vitest/ui happy-dom
```

- [ ] **Step 1.2: Add test scripts to `package.json`**

Edit `package.json` `"scripts"` block:
```json
"scripts": {
  "dev": "next dev -p 3002",
  "build": "next build",
  "start": "next start -p 3002",
  "lint": "next lint",
  "test": "vitest run",
  "test:watch": "vitest"
}
```

- [ ] **Step 1.3: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    globals: true,
    include: ['**/*.test.ts', '**/*.test.tsx'],
    exclude: ['node_modules', '.next', 'Action_and_Event_Manager'],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
});
```

- [ ] **Step 1.4: Write sanity test**

`__tests__/sanity.test.ts`:
```ts
import { describe, it, expect } from 'vitest';

describe('sanity', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 1.5: Run `npm test`, expect 1 pass**

```
✓ __tests__/sanity.test.ts (1)
Test Files 1 passed
Tests 1 passed
```

- [ ] **Step 1.6: Commit**

```bash
git add package.json package-lock.json vitest.config.ts __tests__/sanity.test.ts
git commit -m "chore: add vitest test infrastructure"
```

### Task 2: Create `lib/agent-mapping.ts`

The single source of truth for the 22 agents. Spec [§7.3 of overview](../specs/2026-04-27-agentic-operator-integration-design.md) lists all 22 entries.

**Files:**
- Create: `lib/agent-mapping.ts`
- Create: `lib/agent-mapping.test.ts`

- [ ] **Step 2.1: Write the failing test**

`lib/agent-mapping.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { AGENT_MAP, byShort, byWsId } from './agent-mapping';

describe('AGENT_MAP', () => {
  it('has exactly 22 entries', () => {
    expect(AGENT_MAP).toHaveLength(22);
  });

  it('every short name is unique', () => {
    const shorts = AGENT_MAP.map(a => a.short);
    expect(new Set(shorts).size).toBe(22);
  });

  it('every wsId is unique', () => {
    const ids = AGENT_MAP.map(a => a.wsId);
    expect(new Set(ids).size).toBe(22);
  });

  it('uses only the 9 valid stages', () => {
    const validStages = new Set([
      'system','requirement','jd','resume','match','interview','eval','package','submit'
    ]);
    for (const a of AGENT_MAP) expect(validStages.has(a.stage)).toBe(true);
  });

  it('uses only the 3 valid kinds', () => {
    const validKinds = new Set(['auto','hitl','hybrid']);
    for (const a of AGENT_MAP) expect(validKinds.has(a.kind)).toBe(true);
  });

  it('byShort("Matcher") returns the matcher agent', () => {
    const a = byShort('Matcher');
    expect(a?.wsId).toBe('10');
    expect(a?.stage).toBe('match');
  });

  it('byWsId("16") returns PortalSubmitter', () => {
    const a = byWsId('16');
    expect(a?.short).toBe('PortalSubmitter');
    expect(a?.terminal).toBe(true);
  });

  it('exactly 3 agents are terminal (publishJD, inviteInterview, submitToClient)', () => {
    const terms = AGENT_MAP.filter(a => a.terminal).map(a => a.short);
    expect(terms.sort()).toEqual(['InterviewInviter','PortalSubmitter','Publisher']);
  });

  it('every agent has at least 1 trigger event OR is terminal', () => {
    for (const a of AGENT_MAP) {
      expect(a.triggersEvents.length > 0 || a.terminal).toBe(true);
    }
  });
});
```

- [ ] **Step 2.2: Run test, expect FAIL** (`AGENT_MAP not defined`)

```bash
npm test -- agent-mapping
```

- [ ] **Step 2.3: Implement `lib/agent-mapping.ts`**

```ts
export type Stage =
  | 'system' | 'requirement' | 'jd' | 'resume'
  | 'match' | 'interview' | 'eval' | 'package' | 'submit';

export type AgentKind = 'auto' | 'hitl' | 'hybrid';

export type AgentMeta = {
  short: string;
  wsId: string;
  stage: Stage;
  kind: AgentKind;
  ownerTeam: string;
  version: string;
  triggersEvents: string[];
  emitsEvents: string[];
  terminal: boolean;
};

export const AGENT_MAP: AgentMeta[] = [
  { short: 'ReqSync',          wsId: '1-1',     stage: 'system',      kind: 'auto',   ownerTeam: 'HSM·交付',     version: 'v1.4.2', triggersEvents: ['SCHEDULED_SYNC'],                                emitsEvents: ['REQUIREMENT_SYNCED','SYNC_FAILED_ALERT'],                              terminal: false },
  { short: 'ManualEntry',      wsId: '1-2',     stage: 'requirement', kind: 'hitl',   ownerTeam: 'HSM·交付',     version: 'v1.0.0', triggersEvents: ['CLARIFICATION_INCOMPLETE'],                       emitsEvents: ['REQUIREMENT_LOGGED'],                                                  terminal: false },
  { short: 'ReqAnalyzer',      wsId: '2',       stage: 'requirement', kind: 'auto',   ownerTeam: 'HSM·交付',     version: 'v2.1.0', triggersEvents: ['REQUIREMENT_SYNCED','REQUIREMENT_LOGGED'],         emitsEvents: ['ANALYSIS_COMPLETED','ANALYSIS_BLOCKED'],                               terminal: false },
  { short: 'Clarifier',        wsId: '3',       stage: 'requirement', kind: 'hybrid', ownerTeam: 'HSM·澄清',     version: 'v1.2.0', triggersEvents: ['ANALYSIS_COMPLETED'],                             emitsEvents: ['CLARIFICATION_INCOMPLETE','CLARIFICATION_READY'],                       terminal: false },
  { short: 'JDGenerator',      wsId: '4',       stage: 'jd',          kind: 'auto',   ownerTeam: 'HSM·交付',     version: 'v1.9.4', triggersEvents: ['CLARIFICATION_READY','JD_REJECTED'],               emitsEvents: ['JD_GENERATED'],                                                        terminal: false },
  { short: 'JDReviewer',       wsId: '5',       stage: 'jd',          kind: 'hitl',   ownerTeam: 'HSM·交付',     version: 'v1.0.0', triggersEvents: ['JD_GENERATED'],                                   emitsEvents: ['JD_APPROVED','JD_REJECTED'],                                           terminal: false },
  { short: 'TaskAssigner',     wsId: '6',       stage: 'jd',          kind: 'auto',   ownerTeam: '招聘运营',      version: 'v1.0.0', triggersEvents: ['JD_APPROVED'],                                    emitsEvents: ['TASK_ASSIGNED'],                                                       terminal: false },
  { short: 'Publisher',        wsId: '7-1',     stage: 'jd',          kind: 'auto',   ownerTeam: '招聘运营',      version: 'v1.2.0', triggersEvents: ['TASK_ASSIGNED'],                                  emitsEvents: ['CHANNEL_PUBLISHED','CHANNEL_PUBLISHED_FAILED'],                        terminal: true  },
  { short: 'ManualPublish',    wsId: '7-2',     stage: 'jd',          kind: 'hitl',   ownerTeam: '招聘运营',      version: 'v1.0.0', triggersEvents: ['CHANNEL_PUBLISHED_FAILED'],                       emitsEvents: ['CHANNEL_PUBLISHED'],                                                   terminal: false },
  { short: 'ResumeCollector',  wsId: '8',       stage: 'resume',      kind: 'hybrid', ownerTeam: '招聘运营',      version: 'v3.0.1', triggersEvents: ['CHANNEL_PUBLISHED'],                              emitsEvents: ['RESUME_DOWNLOADED'],                                                   terminal: false },
  { short: 'ResumeParser',     wsId: '9-1',     stage: 'resume',      kind: 'auto',   ownerTeam: '招聘运营',      version: 'v2.8.0', triggersEvents: ['RESUME_DOWNLOADED'],                              emitsEvents: ['RESUME_PROCESSED','RESUME_PARSE_ERROR'],                               terminal: false },
  { short: 'ResumeFixer',      wsId: '9-2',     stage: 'resume',      kind: 'hitl',   ownerTeam: '招聘运营',      version: 'v1.0.0', triggersEvents: ['RESUME_PARSE_ERROR'],                             emitsEvents: ['RESUME_PROCESSED'],                                                    terminal: false },
  { short: 'Matcher',          wsId: '10',      stage: 'match',       kind: 'auto',   ownerTeam: '招聘运营',      version: 'v2.3.1', triggersEvents: ['RESUME_PROCESSED'],                               emitsEvents: ['MATCH_PASSED_NEED_INTERVIEW','MATCH_PASSED_NO_INTERVIEW','MATCH_FAILED'], terminal: false },
  { short: 'MatchReviewer',    wsId: '10-HITL', stage: 'match',       kind: 'hitl',   ownerTeam: '招聘运营',      version: 'v1.0.0', triggersEvents: ['MATCH_FAILED'],                                   emitsEvents: [],                                                                      terminal: false },
  { short: 'InterviewInviter', wsId: '11-1',    stage: 'interview',   kind: 'auto',   ownerTeam: '技术招聘',      version: 'v0.7.2', triggersEvents: ['MATCH_PASSED_NEED_INTERVIEW'],                    emitsEvents: ['INTERVIEW_INVITATION_SENT'],                                           terminal: true  },
  { short: 'AIInterviewer',    wsId: '11-2',    stage: 'interview',   kind: 'hybrid', ownerTeam: '技术招聘',      version: 'v0.7.2', triggersEvents: ['INTERVIEW_INVITATION_SENT'],                      emitsEvents: ['AI_INTERVIEW_COMPLETED'],                                              terminal: false },
  { short: 'Evaluator',        wsId: '12',      stage: 'eval',        kind: 'auto',   ownerTeam: '技术招聘',      version: 'v1.6.0', triggersEvents: ['AI_INTERVIEW_COMPLETED'],                         emitsEvents: ['EVALUATION_PASSED','EVALUATION_FAILED'],                               terminal: false },
  { short: 'ResumeRefiner',    wsId: '13',      stage: 'resume',      kind: 'auto',   ownerTeam: '招聘运营',      version: 'v1.1.0', triggersEvents: ['EVALUATION_PASSED','MATCH_PASSED_NO_INTERVIEW'],   emitsEvents: ['RESUME_OPTIMIZED'],                                                    terminal: false },
  { short: 'PackageBuilder',   wsId: '14-1',    stage: 'package',     kind: 'auto',   ownerTeam: '招聘运营',      version: 'v1.1.2', triggersEvents: ['RESUME_OPTIMIZED'],                               emitsEvents: ['PACKAGE_GENERATED','PACKAGE_MISSING_INFO'],                            terminal: false },
  { short: 'PackageFiller',    wsId: '14-2',    stage: 'package',     kind: 'hitl',   ownerTeam: '招聘运营',      version: 'v1.0.0', triggersEvents: ['PACKAGE_MISSING_INFO'],                           emitsEvents: ['PACKAGE_GENERATED'],                                                   terminal: false },
  { short: 'PackageReviewer',  wsId: '15',      stage: 'package',     kind: 'hitl',   ownerTeam: 'HSM·交付',     version: 'v1.0.0', triggersEvents: ['PACKAGE_GENERATED'],                              emitsEvents: ['PACKAGE_APPROVED'],                                                    terminal: false },
  { short: 'PortalSubmitter',  wsId: '16',      stage: 'submit',      kind: 'auto',   ownerTeam: '招聘运营',      version: 'v2.0.0', triggersEvents: ['PACKAGE_APPROVED'],                               emitsEvents: ['APPLICATION_SUBMITTED','SUBMISSION_FAILED'],                           terminal: true  },
];

export function byShort(s: string): AgentMeta | undefined {
  return AGENT_MAP.find(a => a.short === s);
}

export function byWsId(id: string): AgentMeta | undefined {
  return AGENT_MAP.find(a => a.wsId === id);
}
```

- [ ] **Step 2.4: Run tests, expect 9 pass**

- [ ] **Step 2.5: Commit**

```bash
git add lib/agent-mapping.ts lib/agent-mapping.test.ts
git commit -m "feat(p1): add 22-agent mapping table (single source of truth)"
```

### Task 3: Create `lib/workflow-meta.ts`

Static workflow header metadata; replaces hardcoded `v4.2 · draft` in WorkflowContent.tsx.

**Files:**
- Create: `lib/workflow-meta.ts`
- Create: `lib/workflow-meta.test.ts`

- [ ] **Step 3.1: Write failing test**

```ts
import { describe, it, expect } from 'vitest';
import { WORKFLOW_META } from './workflow-meta';

describe('WORKFLOW_META', () => {
  it('has version, lastUpdated, and stage list', () => {
    expect(WORKFLOW_META.version).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(WORKFLOW_META.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(WORKFLOW_META.stages).toHaveLength(9);
  });
});
```

- [ ] **Step 3.2: Run, FAIL.**

- [ ] **Step 3.3: Implement**

```ts
import type { Stage } from './agent-mapping';

export const WORKFLOW_META = {
  version: 'v4.2.0',
  lastUpdated: '2026-04-27',
  status: 'active' as const,
  stages: [
    'system','requirement','jd','resume',
    'match','interview','eval','package','submit',
  ] satisfies readonly Stage[],
} as const;
```

- [ ] **Step 3.4: Test PASS, commit**

```bash
git add lib/workflow-meta.ts lib/workflow-meta.test.ts
git commit -m "feat(p1): add workflow-meta static module (replaces hardcoded version)"
```

### Task 4: Create `lib/api/types.ts`

Pure type module — no test (TypeScript compiler is the test).

**Files:** Create `lib/api/types.ts`

- [ ] **Step 4.1: Implement** ([P1 spec §4 contracts](../specs/2026-04-27-ao-int-p1-sidecar-design.md#4-接口边界表10-个-route-handler))

```ts
import type { Stage, AgentKind } from '../agent-mapping';

export type RunStatus =
  | 'running' | 'suspended' | 'timed_out' | 'completed'
  | 'failed' | 'paused' | 'interrupted';

export type StepStatus =
  | 'pending' | 'running' | 'completed' | 'failed' | 'retrying';

export type EventKind = 'trigger' | 'domain' | 'error' | 'gate';

export type AlertCategory = 'sla' | 'rate' | 'quality' | 'infra' | 'dlq';
export type AlertSeverity = 'critical' | 'high' | 'medium' | 'low';

export type ApiMeta = {
  partial?: ('ws' | 'em')[];
  generatedAt: string;
};

export type AgentRow = {
  short: string;
  wsId: string;
  displayName: string;
  stage: Stage;
  kind: AgentKind;
  ownerTeam: string;
  version: string;
  status: RunStatus | null;
  p50Ms: number | null;
  runs24h: number;
  successRate: number | null;
  costYuan: number;
  lastActivityAt: string | null;
  spark: number[];
};
export type AgentsResponse = { agents: AgentRow[]; meta: ApiMeta };

export type RunSummary = {
  id: string;
  triggerEvent: string;
  triggerData: { client: string; jdId: string };
  status: RunStatus;
  startedAt: string;
  lastActivityAt: string;
  completedAt: string | null;
  agentCount: number;
  pendingHumanTasks: number;
  suspendedReason: string | null;
};
export type RunsResponse = { runs: RunSummary[]; total: number; meta: ApiMeta };

export type StepDetail = {
  id: string;
  nodeId: string;
  agentShort: string;
  status: StepStatus;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  input: unknown | null;
  output: unknown | null;
  error: string | null;
};
export type StepsResponse = { steps: StepDetail[]; meta: ApiMeta };

export type EventContract = {
  name: string;
  stage: Stage;
  kind: EventKind;
  desc: string;
  publishers: string[];
  subscribers: string[];
  emits: string[];
  schema: object | null;
  schemaVersion: number;
  rateLastHour: number;
  errorRateLastHour: number;
};
export type EventsResponse = { events: EventContract[]; meta: ApiMeta };

export type ActivityEvent = {
  id: string;
  runId: string;
  agentShort: string;
  type: 'agent_start' | 'agent_complete' | 'agent_error' | 'human_waiting' | 'human_completed' | 'event_emitted' | 'decision' | 'tool' | 'anomaly';
  narrative: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

export type AuditEntry = {
  id: string;
  eventName: string;
  traceId: string;
  payloadDigest: string;
  createdAt: string;
};
export type DLQEntry = {
  id: string;
  eventName: string;
  reason: string;
  payload: unknown;
  createdAt: string;
};

export type TimelineEvent = {
  ts: string;
  source: 'ws' | 'em';
  kind: string;
  detail: string;
};
export type TraceResponse = {
  traceId: string;
  ws: { run: RunSummary; steps: StepDetail[]; activities: ActivityEvent[] } | null;
  em: { auditEntries: AuditEntry[]; dlqEntries: DLQEntry[]; dedupHits: number } | null;
  unifiedTimeline: TimelineEvent[];
  meta: ApiMeta;
};

export type HumanTaskCard = {
  id: string;
  runId: string;
  nodeId: string;
  agentShort: string;
  title: string;
  assignee: string | null;
  deadline: string | null;
  createdAt: string;
};
export type HumanTasksResponse = {
  total: number;
  pendingCount: number;
  recent: HumanTaskCard[];
  meta: ApiMeta;
};

export type Alert = {
  id: string;
  category: AlertCategory;
  severity: AlertSeverity;
  title: string;
  affected: string;
  triggeredAt: string;
  acked: boolean;
  ackedBy: string | null;
};
export type AlertsResponse = { alerts: Alert[]; meta: ApiMeta };

export type DataSource = {
  id: string;
  name: string;
  category: 'ats' | 'channel' | 'llm' | 'msg' | 'storage' | 'identity' | 'vector';
  status: 'ok' | 'degraded' | 'down';
  lastCheckedAt: string;
  rps: number;
  errorRate: number;
};
export type DataSourcesResponse = { sources: DataSource[]; meta: ApiMeta };

// Error envelope
export type ApiError = {
  error: 'BAD_REQUEST' | 'NOT_FOUND' | 'UPSTREAM_DOWN' | 'INTERNAL' | 'PROTOCOL';
  message: string;
  field?: string;
  traceId?: string;
};
```

- [ ] **Step 4.2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 4.3: Commit**

```bash
git add lib/api/types.ts
git commit -m "feat(p1): add API I/O type contracts (10 endpoints)"
```

### Task 5: Create `server/normalize/agents.ts`

**Files:**
- Create: `server/normalize/agents.ts`
- Create: `server/normalize/agents.test.ts`

- [ ] **Step 5.1: Write failing test**

```ts
import { describe, it, expect } from 'vitest';
import { shortFromWs, displayKey, UnknownAgentError } from './agents';

describe('shortFromWs', () => {
  it('maps "10" → "Matcher"', () => {
    expect(shortFromWs('10')).toBe('Matcher');
  });
  it('maps "11-1" → "InterviewInviter"', () => {
    expect(shortFromWs('11-1')).toBe('InterviewInviter');
  });
  it('throws UnknownAgentError for unknown wsId', () => {
    expect(() => shortFromWs('999')).toThrow(UnknownAgentError);
  });
});

describe('displayKey', () => {
  it('returns lowercase i18n key', () => {
    expect(displayKey('Matcher')).toBe('agent_matcher');
    expect(displayKey('AIInterviewer')).toBe('agent_aiinterviewer');
  });
});
```

- [ ] **Step 5.2: FAIL**

- [ ] **Step 5.3: Implement**

```ts
import { AGENT_MAP } from '../../lib/agent-mapping';

export class UnknownAgentError extends Error {
  constructor(public wsId: string) {
    super(`Unknown WS agent id: ${wsId}`);
    this.name = 'UnknownAgentError';
  }
}

export function shortFromWs(wsId: string): string {
  const m = AGENT_MAP.find(a => a.wsId === wsId);
  if (!m) throw new UnknownAgentError(wsId);
  return m.short;
}

export function displayKey(short: string): string {
  return `agent_${short.toLowerCase()}`;
}
```

- [ ] **Step 5.4: PASS, commit**

```bash
git add server/normalize/agents.ts server/normalize/agents.test.ts
git commit -m "feat(p1): add server/normalize/agents (wsId↔short mapping)"
```

### Task 6: Create `server/normalize/status.ts`

**Files:**
- Create: `server/normalize/status.ts`
- Create: `server/normalize/status.test.ts`

- [ ] **Step 6.1: Write failing test**

```ts
import { describe, it, expect } from 'vitest';
import { normalizeRunStatus, normalizeStepStatus, InvalidStatusError } from './status';

describe('normalizeRunStatus', () => {
  it.each([
    'running','suspended','timed_out','completed','failed','paused','interrupted'
  ])('accepts %s', (s) => {
    expect(normalizeRunStatus(s)).toBe(s);
  });

  it('rejects "review" (legacy mock value)', () => {
    expect(() => normalizeRunStatus('review')).toThrow(InvalidStatusError);
  });
  it('rejects unknown', () => {
    expect(() => normalizeRunStatus('xyz')).toThrow();
  });
});

describe('normalizeStepStatus', () => {
  it.each(['pending','running','completed','failed','retrying'])('accepts %s', (s) => {
    expect(normalizeStepStatus(s)).toBe(s);
  });
});
```

- [ ] **Step 6.2: FAIL**

- [ ] **Step 6.3: Implement**

```ts
import type { RunStatus, StepStatus } from '../../lib/api/types';

export class InvalidStatusError extends Error {
  constructor(value: string, kind: 'run' | 'step') {
    super(`Invalid ${kind} status: "${value}"`);
    this.name = 'InvalidStatusError';
  }
}

const RUN_STATUS = new Set<RunStatus>([
  'running','suspended','timed_out','completed','failed','paused','interrupted'
]);

const STEP_STATUS = new Set<StepStatus>([
  'pending','running','completed','failed','retrying'
]);

export function normalizeRunStatus(s: string): RunStatus {
  if (!RUN_STATUS.has(s as RunStatus)) throw new InvalidStatusError(s, 'run');
  return s as RunStatus;
}

export function normalizeStepStatus(s: string): StepStatus {
  if (!STEP_STATUS.has(s as StepStatus)) throw new InvalidStatusError(s, 'step');
  return s as StepStatus;
}
```

- [ ] **Step 6.4: PASS, commit**

```bash
git add server/normalize/status.ts server/normalize/status.test.ts
git commit -m "feat(p1): add server/normalize/status (RunStatus/StepStatus enum guards)"
```

### Task 7: Create `server/normalize/envelope.ts`

H1 mitigation: flatten the three-layer Inngest envelope from WS.

**Files:**
- Create: `server/normalize/envelope.ts`
- Create: `server/normalize/envelope.test.ts`

- [ ] **Step 7.1: Write failing test**

```ts
import { describe, it, expect } from 'vitest';
import { flatten, EnvelopeMalformedError } from './envelope';

describe('flatten', () => {
  it('extracts event/trace/business from valid 3-layer envelope', () => {
    const env = {
      payload: {
        event_name: 'REQUIREMENT_SYNCED',
        correlation_id: 'trace-abc',
        payload: {  // RaasMessage.data
          payload: { client: 'X', jdId: 'JD-1' },
        },
      },
    };
    const out = flatten(env);
    expect(out).toEqual({
      event: 'REQUIREMENT_SYNCED',
      trace: 'trace-abc',
      business: { client: 'X', jdId: 'JD-1' },
    });
  });

  it('throws when payload is missing', () => {
    expect(() => flatten({})).toThrow(EnvelopeMalformedError);
  });

  it('throws when middle payload is missing', () => {
    const env = { payload: { event_name: 'X', correlation_id: 't', payload: null } };
    expect(() => flatten(env)).toThrow(EnvelopeMalformedError);
  });

  it('throws when event_name is empty', () => {
    const env = { payload: { event_name: '', correlation_id: 't', payload: { payload: {} } } };
    expect(() => flatten(env)).toThrow(EnvelopeMalformedError);
  });
});
```

- [ ] **Step 7.2: FAIL**

- [ ] **Step 7.3: Implement**

```ts
export class EnvelopeMalformedError extends Error {
  constructor(reason: string) {
    super(`Envelope malformed: ${reason}`);
    this.name = 'EnvelopeMalformedError';
  }
}

export type FlatEvent = {
  event: string;
  trace: string;
  business: unknown;
};

export function flatten(envelope: unknown): FlatEvent {
  if (!envelope || typeof envelope !== 'object') {
    throw new EnvelopeMalformedError('envelope is not an object');
  }
  const payload = (envelope as Record<string, unknown>).payload;
  if (!payload || typeof payload !== 'object') {
    throw new EnvelopeMalformedError('layer 1 (envelope.payload) missing');
  }
  const layer1 = payload as Record<string, unknown>;
  const event = layer1.event_name;
  const trace = layer1.correlation_id;
  if (typeof event !== 'string' || event === '') {
    throw new EnvelopeMalformedError('event_name missing or empty');
  }
  if (typeof trace !== 'string') {
    throw new EnvelopeMalformedError('correlation_id missing');
  }
  const layer2 = layer1.payload;
  if (!layer2 || typeof layer2 !== 'object') {
    throw new EnvelopeMalformedError('layer 2 (RaasMessage.data) missing');
  }
  const business = (layer2 as Record<string, unknown>).payload;
  if (business === undefined) {
    throw new EnvelopeMalformedError('layer 3 (business payload) missing');
  }
  return { event, trace, business };
}
```

- [ ] **Step 7.4: PASS, commit**

```bash
git add server/normalize/envelope.ts server/normalize/envelope.test.ts
git commit -m "feat(p1): add envelope flattener (H1 mitigation)"
```

### Task 8: CSS tokens + status i18n keys

**Files:**
- Modify: `app/globals.css`
- Modify: `lib/i18n.tsx`

- [ ] **Step 8.1: Add 4 CSS tokens to `:root` and `[data-theme="dark"]`**

Find `:root {` block in `app/globals.css`. Add 4 lines:
```css
--c-suspended: oklch(0.74 0.13 70);
--c-timed-out: oklch(0.62 0.18 30);
--c-retrying: oklch(0.65 0.16 220);
--c-interrupted: oklch(0.55 0.04 260);
```

Find `[data-theme="dark"] {` block. Add 4 lines:
```css
--c-suspended: oklch(0.78 0.13 70);
--c-timed-out: oklch(0.70 0.16 30);
--c-retrying: oklch(0.70 0.14 220);
--c-interrupted: oklch(0.60 0.04 260);
```

Find `@theme inline {` block. Add 4 lines:
```css
--color-suspended: var(--c-suspended);
--color-timed-out: var(--c-timed-out);
--color-retrying: var(--c-retrying);
--color-interrupted: var(--c-interrupted);
```

- [ ] **Step 8.2: Verify build passes**

```bash
npm run build
```
Expected: build succeeds, no Tailwind warnings about undefined tokens.

- [ ] **Step 8.3: Add 14 status + 2 ui i18n keys to `lib/i18n.tsx`**

Find the `zh` and `en` dictionaries. Add to BOTH:

zh keys:
```ts
status_running: "运行中",
status_suspended: "等待 HITL",
status_timed_out: "SLA 超时",
status_completed: "已完成",
status_failed: "失败",
status_paused: "已暂停",
status_interrupted: "已中断",
step_pending: "待运行",
step_running: "运行中",
step_completed: "已完成",
step_failed: "失败",
step_retrying: "重试中",
ui_partial_data: "部分数据未到",
ui_reconnecting: "重连中",
```

en keys (mirror):
```ts
status_running: "Running",
status_suspended: "Awaiting HITL",
status_timed_out: "Timed out",
status_completed: "Completed",
status_failed: "Failed",
status_paused: "Paused",
status_interrupted: "Interrupted",
step_pending: "Pending",
step_running: "Running",
step_completed: "Completed",
step_failed: "Failed",
step_retrying: "Retrying",
ui_partial_data: "Partial data",
ui_reconnecting: "Reconnecting",
```

- [ ] **Step 8.4: Verify dev server boots, theme toggle works**

```bash
npm run dev &
sleep 5
curl -s http://localhost:3002/fleet | grep -q "fleet" && echo OK
kill %1
```

- [ ] **Step 8.5: Commit**

```bash
git add app/globals.css lib/i18n.tsx
git commit -m "feat(p1): add 4 status CSS tokens + 16 i18n keys (status/step/ui)"
```

**End of Chunk 1.** `npm test` should show ≥30 passing tests across 7 files.

---

## Chunk 2 · Server clients + browser API hooks + dev script

Adds the IO layer (server-only HTTP/SSE clients) and browser-side API hooks. End-of-chunk: dev script starts 4 concurrent processes.

### Task 9: Create `server/clients/ws.ts`

**Files:**
- Create: `server/clients/ws.ts`
- Create: `server/clients/ws.test.ts`

- [ ] **Step 9.1: Write failing tests with mocked fetch**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { wsClient, WsClientError } from './ws';

describe('wsClient', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('GET /api/runs forwards query params', async () => {
    (fetch as any).mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ runs: [{ id: 'r1', status: 'running' }], total: 1 }),
    });
    const out = await wsClient.fetchRuns({ status: ['running'], limit: 5 });
    expect(out.total).toBe(1);
    expect((fetch as any).mock.calls[0][0]).toContain('status=running');
    expect((fetch as any).mock.calls[0][0]).toContain('limit=5');
  });

  it('throws WsClientError on 5xx', async () => {
    (fetch as any).mockResolvedValueOnce({ ok: false, status: 503, statusText: 'down' });
    await expect(wsClient.fetchRuns({ limit: 1 })).rejects.toThrow(WsClientError);
  });

  it('throws WsClientError on network error', async () => {
    (fetch as any).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(wsClient.fetchRuns({ limit: 1 })).rejects.toThrow(WsClientError);
  });
});
```

- [ ] **Step 9.2: FAIL**

- [ ] **Step 9.3: Implement**

```ts
const BASE = process.env.WS_BASE_URL ?? 'http://localhost:5175';
const TIMEOUT_MS = 5000;

export class WsClientError extends Error {
  constructor(public status: number, message: string, public cause?: Error) {
    super(`WS upstream error (${status}): ${message}`);
    this.name = 'WsClientError';
  }
}

async function get<T>(path: string, query?: Record<string, string | number | string[]>): Promise<T> {
  const url = new URL(BASE + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) url.searchParams.set(k, v.join(','));
      else url.searchParams.set(k, String(v));
    }
  }
  const ctl = AbortSignal.timeout(TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url.toString(), { signal: ctl });
  } catch (e) {
    throw new WsClientError(0, (e as Error).message, e as Error);
  }
  if (!res.ok) {
    throw new WsClientError(res.status, res.statusText);
  }
  return res.json() as Promise<T>;
}

export const wsClient = {
  base: BASE,

  fetchRuns(q: { status?: string[]; limit?: number; since?: string }) {
    return get<{ runs: any[]; total: number }>('/api/runs', q as any);
  },

  fetchRun(id: string) {
    return get<any>(`/api/runs/${id}`);
  },

  fetchSteps(runId: string) {
    return get<{ steps: any[] }>(`/api/runs/${runId}/steps`);
  },

  fetchActivityFeed(q: { limit?: number; nodeId?: string; runId?: string }) {
    return get<{ items: any[]; total: number }>('/api/activity/feed', q as any);
  },

  fetchHumanTasks(q: { status?: string }) {
    return get<{ items: any[]; total: number }>('/api/human-task', q as any);
  },

  fetchHealth() {
    return get<{ status: string; uptime: number }>('/api/health');
  },

  // SSE — returns a Response for streaming; consumed by /api/stream multiplexer
  async openActivityStream(): Promise<Response> {
    const url = `${BASE}/api/activity/stream`;
    return fetch(url);
  },
};
```

- [ ] **Step 9.4: PASS**

- [ ] **Step 9.5: Live integration check** (only if WS sidecar running)

```bash
# Optional: skip if sidecar not running
node --import tsx -e "import('./server/clients/ws.ts').then(m => m.wsClient.fetchHealth().then(console.log))"
```
Expected: `{ status: 'ok', uptime: <number> }`

- [ ] **Step 9.6: Commit**

```bash
git add server/clients/ws.ts server/clients/ws.test.ts
git commit -m "feat(p1): add server/clients/ws (HTTP+SSE client to WS sidecar)"
```

### Task 10: Create `server/clients/em.ts`

Similar shape to ws.ts but for EM.

**Files:**
- Create: `server/clients/em.ts`
- Create: `server/clients/em.test.ts`

- [ ] **Step 10.1: Write tests** (mirror Task 9 with EM endpoints)

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { emClient, EmClientError } from './em';

describe('emClient', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));

  it('GET /api/manager/events list', async () => {
    (fetch as any).mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ items: [{ name: 'X' }], total: 1 }),
    });
    const out = await emClient.fetchEvents({ stage: ['jd'] });
    expect(out.total).toBe(1);
  });

  it('throws on 5xx', async () => {
    (fetch as any).mockResolvedValueOnce({ ok: false, status: 502, statusText: 'gw' });
    await expect(emClient.fetchHealth()).rejects.toThrow(EmClientError);
  });
});
```

- [ ] **Step 10.2: Implement**

```ts
const BASE = process.env.EM_BASE_URL ?? 'http://localhost:8000';
const TIMEOUT_MS = 5000;

export class EmClientError extends Error {
  constructor(public status: number, message: string, public cause?: Error) {
    super(`EM upstream error (${status}): ${message}`);
    this.name = 'EmClientError';
  }
}

async function get<T>(path: string, query?: Record<string, any>): Promise<T> {
  const url = new URL(BASE + path);
  if (query) for (const [k,v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) url.searchParams.set(k, v.join(','));
    else url.searchParams.set(k, String(v));
  }
  const sig = AbortSignal.timeout(TIMEOUT_MS);
  let res: Response;
  try { res = await fetch(url.toString(), { signal: sig }); }
  catch (e) { throw new EmClientError(0, (e as Error).message, e as Error); }
  if (!res.ok) throw new EmClientError(res.status, res.statusText);
  return res.json() as Promise<T>;
}

export const emClient = {
  base: BASE,
  fetchEvents(q?: { stage?: string[]; q?: string }) {
    return get<{ items: any[]; total: number }>('/api/manager/events', q);
  },
  fetchAuditLog(q?: { eventName?: string; limit?: number }) {
    return get<{ items: any[]; total: number }>('/api/manager/audit', q);
  },
  fetchDLQ(q?: { eventName?: string; limit?: number }) {
    return get<{ items: any[]; total: number }>('/api/manager/dlq', q);
  },
  fetchHealth() {
    return get<{ status: string }>('/api/manager/health');
  },
};
```

- [ ] **Step 10.3: PASS, commit**

```bash
git add server/clients/em.ts server/clients/em.test.ts
git commit -m "feat(p1): add server/clients/em (HTTP client to EM sidecar)"
```

### Task 11: Create `lib/api/client.ts`

Browser-side fetch helper.

**Files:**
- Create: `lib/api/client.ts`
- Create: `lib/api/client.test.ts`

- [ ] **Step 11.1: Write failing test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchJson, ApiTimeoutError } from './client';

describe('fetchJson', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));

  it('returns parsed JSON on 200', async () => {
    (fetch as any).mockResolvedValueOnce({
      ok: true, status: 200, json: async () => ({ a: 1 }),
    });
    const out = await fetchJson<{ a: number }>('/api/runs');
    expect(out.a).toBe(1);
  });

  it('throws structured error on 4xx with JSON body', async () => {
    (fetch as any).mockResolvedValueOnce({
      ok: false, status: 400,
      json: async () => ({ error: 'BAD_REQUEST', message: 'x', field: 'y' }),
    });
    await expect(fetchJson('/api/runs')).rejects.toMatchObject({
      error: 'BAD_REQUEST', field: 'y'
    });
  });
});
```

- [ ] **Step 11.2: FAIL**

- [ ] **Step 11.3: Implement**

```ts
import type { ApiError } from './types';

export class ApiTimeoutError extends Error {
  constructor() { super('Request timed out'); this.name = 'ApiTimeoutError'; }
}

const DEFAULT_TIMEOUT_MS = 5000;

export async function fetchJson<T>(
  path: string,
  init?: RequestInit & { timeoutMs?: number }
): Promise<T> {
  const timeoutMs = init?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sig = AbortSignal.timeout(timeoutMs);
  const res = await fetch(path, {
    headers: { 'Accept': 'application/json', ...(init?.headers as any) },
    signal: sig,
    ...init,
  }).catch((e) => {
    if (e?.name === 'TimeoutError') throw new ApiTimeoutError();
    throw e;
  });
  if (!res.ok) {
    let body: ApiError | null = null;
    try { body = await res.json(); } catch {}
    const err = body ?? { error: 'INTERNAL', message: res.statusText } as ApiError;
    throw err;
  }
  return res.json() as Promise<T>;
}
```

- [ ] **Step 11.4: PASS, commit**

```bash
git add lib/api/client.ts lib/api/client.test.ts
git commit -m "feat(p1): add lib/api/client (browser fetch + ApiError protocol)"
```

### Task 12: Create `lib/api/sse.ts`

React 19 hook for SSE with auto-reconnect.

**Files:**
- Create: `lib/api/sse.ts`

(No unit test in chunk 2 — SSE hooks need DOM env; covered by manual verification in chunk 4.)

- [ ] **Step 12.1: Implement**

```ts
"use client";
import * as React from 'react';

type SseState = 'connecting' | 'open' | 'reconnecting' | 'error';

export type UseSseOptions = {
  enabled?: boolean;
  reconnectDelayMs?: number;
};

export function useSSE<T = unknown>(
  url: string,
  onEvent: (data: T, eventName: string) => void,
  opts: UseSseOptions = {}
): { state: SseState; close: () => void } {
  const enabled = opts.enabled ?? true;
  const delay = opts.reconnectDelayMs ?? 3000;
  const [state, setState] = React.useState<SseState>('connecting');
  const ref = React.useRef<EventSource | null>(null);
  const cbRef = React.useRef(onEvent);
  cbRef.current = onEvent;

  React.useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (cancelled) return;
      setState('connecting');
      const es = new EventSource(url);
      ref.current = es;
      es.onopen = () => setState('open');
      es.onerror = () => {
        if (cancelled) return;
        setState('reconnecting');
        es.close();
        reconnectTimer = setTimeout(connect, delay);
      };
      // listen to all named events
      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          cbRef.current(data, ev.type || 'message');
        } catch { /* ignore parse errors */ }
      };
      // also bind known event names
      ['activity', 'heartbeat', 'error'].forEach((name) => {
        es.addEventListener(name, (ev: any) => {
          try { cbRef.current(JSON.parse(ev.data), name); } catch {}
        });
      });
    };

    connect();
    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ref.current?.close();
    };
  }, [url, enabled, delay]);

  const close = React.useCallback(() => ref.current?.close(), []);
  return { state, close };
}
```

- [ ] **Step 12.2: Verify TS compile**

```bash
npx tsc --noEmit
```

- [ ] **Step 12.3: Commit**

```bash
git add lib/api/sse.ts
git commit -m "feat(p1): add useSSE hook (auto-reconnect, named events)"
```

### Task 13: Add 22 agent i18n keys

**Files:** Modify `lib/i18n.tsx`

- [ ] **Step 13.1: Add 22 zh keys**

In zh dictionary, add (alphabetical by short name):
```ts
agent_aiinterviewer: "AI 面试官",
agent_clarifier: "需求澄清器",
agent_evaluator: "面试评估器",
agent_interviewinviter: "面试邀约器",
agent_jdgenerator: "JD 生成器",
agent_jdreviewer: "JD 审核员",
agent_manualentry: "手工录入",
agent_manualpublish: "手工发布",
agent_matcher: "人岗匹配器",
agent_matchreviewer: "匹配复审",
agent_packagebuilder: "推荐包构建",
agent_packagefiller: "推荐包补全",
agent_packagereviewer: "推荐包审核",
agent_portalsubmitter: "客户端提交",
agent_publisher: "渠道发布器",
agent_reqanalyzer: "需求分析器",
agent_reqsync: "需求同步器",
agent_resumecollector: "简历收集器",
agent_resumefixer: "简历修复",
agent_resumeparser: "简历解析器",
agent_resumerefiner: "简历优化器",
agent_taskassigner: "任务分配器",
```

- [ ] **Step 13.2: Add 22 en keys (mirror)**

```ts
agent_aiinterviewer: "AI Interviewer",
agent_clarifier: "Clarifier",
agent_evaluator: "Evaluator",
agent_interviewinviter: "Interview Inviter",
agent_jdgenerator: "JD Generator",
agent_jdreviewer: "JD Reviewer",
agent_manualentry: "Manual Entry",
agent_manualpublish: "Manual Publish",
agent_matcher: "Matcher",
agent_matchreviewer: "Match Reviewer",
agent_packagebuilder: "Package Builder",
agent_packagefiller: "Package Filler",
agent_packagereviewer: "Package Reviewer",
agent_portalsubmitter: "Portal Submitter",
agent_publisher: "Publisher",
agent_reqanalyzer: "Requirement Analyzer",
agent_reqsync: "Requirement Sync",
agent_resumecollector: "Resume Collector",
agent_resumefixer: "Resume Fixer",
agent_resumeparser: "Resume Parser",
agent_resumerefiner: "Resume Refiner",
agent_taskassigner: "Task Assigner",
```

- [ ] **Step 13.3: Verify build OK**

```bash
npm run build
```

- [ ] **Step 13.4: Commit**

```bash
git add lib/i18n.tsx
git commit -m "feat(p1): add 22 agent_* i18n keys (Q5 decision)"
```

### Task 14: Update `package.json` dev script

Run 4 processes concurrently. Inngest dev binary started via `npx`.

**Files:** Modify `package.json`

- [ ] **Step 14.1: Add concurrently**

```bash
npm install --save-dev concurrently
```

- [ ] **Step 14.2: Update scripts**

```json
"scripts": {
  "dev": "concurrently -n next,ws,em,inngest -c blue,cyan,green,magenta -k --kill-others-on-fail \"next dev -p 3002\" \"npm --prefix Action_and_Event_Manager/workflow-studio/server run dev\" \"npm --prefix Action_and_Event_Manager/packages/server run dev\" \"npx inngest-cli@latest dev\"",
  "dev:next-only": "next dev -p 3002",
  "build": "next build",
  "start": "next start -p 3002",
  "lint": "next lint",
  "test": "vitest run",
  "test:watch": "vitest"
}
```

> **Note**: `dev:next-only` is a fallback for when sidecars are managed externally.

- [ ] **Step 14.3: Verify all 4 processes start**

```bash
timeout 30 npm run dev 2>&1 | head -80
```

Expected output (within 30s) contains:
- `[next] - Local: http://localhost:3002`
- `[ws] - WS server listening on 5175`
- `[em] - Manager API listening on 8000`
- `[inngest] - Inngest dev server`

- [ ] **Step 14.4: Curl all 4**

```bash
npm run dev > /tmp/ao-dev.log 2>&1 &
sleep 15
curl -s http://localhost:3002/fleet | head -c 200; echo
curl -s http://localhost:5175/api/health | head -c 200; echo
curl -s http://localhost:8000/api/manager/health | head -c 200; echo
curl -s http://localhost:8288/ | head -c 200; echo
kill %1 2>/dev/null
```

All 4 must return non-empty responses.

- [ ] **Step 14.5: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(p1): dev script orchestrates Next + WS + EM + Inngest concurrently"
```

**End of Chunk 2.** All foundation + IO layer in place. `npm test` passes ≥40 tests; `npm run dev` boots full local stack.

---

## Chunk 3 · 10 Route Handlers

Each Route Handler is a tiny adapter: parse query → call `wsClient`/`emClient` → normalize → respond. Tests use mocked clients via `vi.mock`.

### Task 15: `app/api/agents/route.ts`

**Files:**
- Create: `app/api/agents/route.ts`
- Create: `app/api/agents/route.test.ts`

- [ ] **Step 15.1: Write failing test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('@/server/clients/ws', () => ({
  wsClient: {
    fetchRuns: vi.fn(),
    fetchActivityFeed: vi.fn(),
  },
  WsClientError: class extends Error {},
}));

import { GET } from './route';
import { wsClient } from '@/server/clients/ws';

describe('GET /api/agents', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 22 agents with merged static + dynamic data', async () => {
    (wsClient.fetchRuns as any).mockResolvedValue({ runs: [], total: 0 });
    (wsClient.fetchActivityFeed as any).mockResolvedValue({ items: [], total: 0 });
    const res = await GET(new Request('http://x/api/agents'));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.agents).toHaveLength(22);
    const matcher = json.agents.find((a: any) => a.short === 'Matcher');
    expect(matcher.wsId).toBe('10');
    expect(matcher.displayName).toBe('agent_matcher');
  });

  it('on WS error: returns 200 with meta.partial=["ws"]', async () => {
    (wsClient.fetchRuns as any).mockRejectedValue(new Error('down'));
    (wsClient.fetchActivityFeed as any).mockRejectedValue(new Error('down'));
    const res = await GET(new Request('http://x/api/agents'));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.meta.partial).toEqual(['ws']);
    expect(json.agents[0].p50Ms).toBeNull();
  });
});
```

- [ ] **Step 15.2: FAIL**

- [ ] **Step 15.3: Implement**

```ts
import { NextResponse } from 'next/server';
import { AGENT_MAP } from '@/lib/agent-mapping';
import { displayKey } from '@/server/normalize/agents';
import { wsClient } from '@/server/clients/ws';
import type { AgentsResponse, AgentRow } from '@/lib/api/types';

export async function GET(_req: Request) {
  const partial: ('ws' | 'em')[] = [];
  let runsByAgent: Record<string, any[]> = {};
  let activityByAgent: Record<string, any[]> = {};

  try {
    const runs = await wsClient.fetchRuns({ limit: 1000, status: ['running','suspended','completed','failed'] });
    runsByAgent = groupByAgent(runs.runs);
  } catch { partial.push('ws'); }

  try {
    const feed = await wsClient.fetchActivityFeed({ limit: 1000 });
    activityByAgent = groupActivityByAgent(feed.items);
  } catch { if (!partial.includes('ws')) partial.push('ws'); }

  const agents: AgentRow[] = AGENT_MAP.map((a) => {
    const runs = runsByAgent[a.short] ?? [];
    const acts = activityByAgent[a.short] ?? [];
    const completedRuns = runs.filter((r) => r.status === 'completed').length;
    const totalRuns = runs.length;
    return {
      short: a.short,
      wsId: a.wsId,
      displayName: displayKey(a.short),
      stage: a.stage,
      kind: a.kind,
      ownerTeam: a.ownerTeam,
      version: a.version,
      status: partial.length > 0 ? null : pickAgentStatus(runs),
      p50Ms: partial.length > 0 ? null : computeP50(runs),
      runs24h: totalRuns,
      successRate: totalRuns > 0 ? completedRuns / totalRuns : null,
      costYuan: 0,                  // P1: 暂置 0；P3 接 AgentEpisode tokenUsage
      lastActivityAt: acts[0]?.createdAt ?? null,
      spark: bucketSpark(runs),
    };
  });

  const body: AgentsResponse = {
    agents,
    meta: { partial: partial.length ? partial : undefined, generatedAt: new Date().toISOString() },
  };
  return NextResponse.json(body);
}

// helpers — kept inline for clarity; move to server/aggregate/agents.ts if reused
function groupByAgent(_runs: any[]): Record<string, any[]> {
  // WS runs don't carry agent short — skip in P1 (returns empty groups → KPI null)
  // P3 will join via WorkflowStep.nodeId → agent
  return {};
}
function groupActivityByAgent(items: any[]): Record<string, any[]> {
  const out: Record<string, any[]> = {};
  for (const it of items) {
    const k = it.agentName ?? 'unknown';
    (out[k] ||= []).push(it);
  }
  return out;
}
function pickAgentStatus(_runs: any[]): import('@/lib/api/types').RunStatus | null {
  return null; // P1: returned by /api/runs/[id]/steps per node; agent-row status is aggregate (P3)
}
function computeP50(_runs: any[]): number | null { return null; }
function bucketSpark(_runs: any[]): number[] { return Array(16).fill(0); }
```

> **Note**: P1 sets a few KPI fields to null/0 (clearly marked) because cross-cutting aggregation requires P3-level joins. Spec acceptance just requires "no mock string" — null is acceptable per error-handling matrix.

- [ ] **Step 15.4: PASS, commit**

```bash
git add app/api/agents/route.ts app/api/agents/route.test.ts
git commit -m "feat(p1): GET /api/agents returns 22 rows with WS aggregation"
```

### Task 16: `app/api/runs/route.ts`

**Files:**
- Create: `app/api/runs/route.ts`
- Create: `app/api/runs/route.test.ts`

- [ ] **Step 16.1: Test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('@/server/clients/ws', () => ({
  wsClient: { fetchRuns: vi.fn() },
  WsClientError: class extends Error {},
}));
import { GET } from './route';
import { wsClient } from '@/server/clients/ws';

describe('GET /api/runs', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns runs from WS, normalizes status', async () => {
    (wsClient.fetchRuns as any).mockResolvedValue({
      runs: [{ id: 'r1', triggerEvent: 'X', triggerData: '{}', status: 'running', startedAt: '2026-01-01', lastActivityAt: '2026-01-01', completedAt: null, suspendedReason: null }],
      total: 1,
    });
    const res = await GET(new Request('http://x/api/runs?limit=10'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.runs[0].status).toBe('running');
  });

  it('rejects invalid status enum', async () => {
    (wsClient.fetchRuns as any).mockResolvedValue({
      runs: [{ id: 'r1', status: 'review' /* legacy mock */ }], total: 1,
    });
    const res = await GET(new Request('http://x/api/runs'));
    expect(res.status).toBe(502);
  });

  it('502 when WS unreachable', async () => {
    (wsClient.fetchRuns as any).mockRejectedValue(new Error('down'));
    const res = await GET(new Request('http://x/api/runs'));
    expect(res.status).toBe(502);
  });
});
```

- [ ] **Step 16.2: Implement**

```ts
import { NextResponse } from 'next/server';
import { wsClient, WsClientError } from '@/server/clients/ws';
import { normalizeRunStatus, InvalidStatusError } from '@/server/normalize/status';
import type { RunsResponse, RunSummary } from '@/lib/api/types';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const status = url.searchParams.get('status')?.split(',');
  const limit = Math.min(50, Number(url.searchParams.get('limit') ?? 10));
  const since = url.searchParams.get('since') ?? undefined;

  try {
    const wsRes = await wsClient.fetchRuns({ status, limit, since });
    const runs: RunSummary[] = wsRes.runs.map((r: any) => ({
      id: r.id,
      triggerEvent: r.triggerEvent,
      triggerData: parseTriggerData(r.triggerData),
      status: normalizeRunStatus(r.status),
      startedAt: r.startedAt,
      lastActivityAt: r.lastActivityAt,
      completedAt: r.completedAt ?? null,
      agentCount: 0,                  // P1: not aggregated
      pendingHumanTasks: 0,           // P1: not aggregated
      suspendedReason: r.suspendedReason ?? null,
    }));
    const body: RunsResponse = { runs, total: wsRes.total, meta: { generatedAt: new Date().toISOString() } };
    return NextResponse.json(body);
  } catch (e) {
    if (e instanceof WsClientError) return upstreamDown('WS', e.message);
    if (e instanceof InvalidStatusError) return upstreamProtocol(e.message);
    throw e;
  }
}

function parseTriggerData(s: any): { client: string; jdId: string } {
  try {
    const o = typeof s === 'string' ? JSON.parse(s) : s ?? {};
    return { client: o.client ?? '—', jdId: o.jdId ?? o.requisition_id ?? '—' };
  } catch { return { client: '—', jdId: '—' }; }
}

function upstreamDown(svc: string, msg: string) {
  return NextResponse.json(
    { error: 'UPSTREAM_DOWN', message: `${svc} unreachable: ${msg}` },
    { status: 502 },
  );
}
function upstreamProtocol(msg: string) {
  return NextResponse.json({ error: 'PROTOCOL', message: msg }, { status: 502 });
}
```

- [ ] **Step 16.3: PASS, commit**

```bash
git add app/api/runs/route.ts app/api/runs/route.test.ts
git commit -m "feat(p1): GET /api/runs (filtered by status, normalized enum)"
```

### Task 17–22: 6 more handlers (analogous shape)

For each, follow the same pattern: write test → mock client → assert shape + error path → implement → commit.

- [ ] **Step 17: `app/api/runs/[id]/route.ts`** — calls `wsClient.fetchRun(id)`; returns `RunSummary` extended with `trace + agentsTouched`. 404 if not found.

- [ ] **Step 18: `app/api/runs/[id]/steps/route.ts`** — calls `wsClient.fetchSteps(id)`; maps `nodeId → agentShort` via `shortFromWs()`; truncates input/output to 4KB; normalizes step status.

- [ ] **Step 19: `app/api/events/route.ts`** — calls `emClient.fetchEvents(...)`; merges with `lib/events-catalog.ts` as P1 fallback (label `partial: ['em']` if EM down); subscribers list cross-checked against AGENT_MAP.

- [ ] **Step 20: `app/api/trace/[id]/route.ts`** — concurrent `wsClient.fetchRun + emClient.fetchAuditLog` via `Promise.allSettled`; merge into `unifiedTimeline` sorted by ts; if either fails, populate `meta.partial`.

- [ ] **Step 21: `app/api/human-tasks/route.ts`** — calls `wsClient.fetchHumanTasks({ status: 'pending' })`; returns `{ total, pendingCount, recent }`.

- [ ] **Step 22: `app/api/alerts/route.ts`** — concurrent fetch from WS run-sweeper output (`/api/runs?status=timed_out`) + EM `dlq`; map to `Alert[]`; categorize.

- [ ] **Step 23: `app/api/datasources/route.ts`** — static catalog `lib/datasources-static.ts` (24 entries) + EM `/health` probe per category; **also create** the static catalog file in this task.

Each task ends with one commit:
```bash
git commit -m "feat(p1): GET /api/<resource>"
```

**Per-task estimated time:** 25 min × 7 tasks = ~3 hours.

### Task 24: `app/api/stream/route.ts` (SSE multiplexer)

The hardest one. Subscribes to WS SSE upstream, parses with `eventsource-parser`, filters by query, re-emits.

**Files:**
- Create: `app/api/stream/route.ts`
- Create: `app/api/stream/route.test.ts`

- [ ] **Step 24.1: Add eventsource-parser**

```bash
npm install eventsource-parser
```

- [ ] **Step 24.2: Write failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
vi.mock('@/server/clients/ws', () => {
  const items: any[] = [];
  return {
    wsClient: {
      openActivityStream: vi.fn(async () => new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('event: activity\ndata: {"runId":"r1","agentName":"Matcher","type":"decision"}\n\n'));
            controller.enqueue(new TextEncoder().encode('event: activity\ndata: {"runId":"r2","agentName":"JDGenerator","type":"tool"}\n\n'));
            controller.close();
          },
        })
      )),
    },
    WsClientError: class extends Error {},
  };
});
import { GET } from './route';

describe('GET /api/stream', () => {
  it('forwards filtered events with runId match', async () => {
    const res = await GET(new Request('http://x/api/stream?runId=r1'));
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('"runId":"r1"');
    expect(text).not.toContain('"runId":"r2"');
  });
});
```

- [ ] **Step 24.3: Implement**

```ts
import { wsClient } from '@/server/clients/ws';
import { createParser, type EventSourceMessage } from 'eventsource-parser';
import { shortFromWs, UnknownAgentError } from '@/server/normalize/agents';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const filterRunId = url.searchParams.get('runId');
  const filterAgent = url.searchParams.get('agent');
  const filterTypes = url.searchParams.get('type')?.split(',');

  const upstream = await wsClient.openActivityStream();
  if (!upstream.body) {
    return new Response('upstream has no body', { status: 502 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const parser = createParser({
        onEvent: (ev: EventSourceMessage) => {
          if (ev.event !== 'activity') return;
          let parsed: any;
          try { parsed = JSON.parse(ev.data); } catch { return; }
          if (filterRunId && parsed.runId !== filterRunId) return;
          if (filterAgent) {
            let short: string | undefined;
            try { short = parsed.agentName ? parsed.agentName : shortFromWs(parsed.nodeId); }
            catch (e) { if (e instanceof UnknownAgentError) return; }
            if (short !== filterAgent) return;
          }
          if (filterTypes && !filterTypes.includes(parsed.type)) return;

          controller.enqueue(encoder.encode(`event: activity\ndata: ${JSON.stringify(parsed)}\n\n`));
        },
      });

      const reader = upstream.body!.getReader();
      const heartbeat = setInterval(() => {
        controller.enqueue(encoder.encode(`event: heartbeat\ndata: {"t":"${new Date().toISOString()}"}\n\n`));
      }, 15000);

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          parser.feed(new TextDecoder().decode(value));
        }
      } finally {
        clearInterval(heartbeat);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
    },
  });
}
```

- [ ] **Step 24.4: PASS, commit**

```bash
git add app/api/stream/route.ts app/api/stream/route.test.ts package.json package-lock.json
git commit -m "feat(p1): GET /api/stream (SSE multiplexer w/ filter + heartbeat)"
```

**End of Chunk 3.** 10 endpoints live; `npm test` passes ≥70 tests.

---

## Chunk 4 · Page rewiring + final acceptance

Remove inline mocks; thread real data through the 6 existing pages. Visual; lighter on automated tests, heavier on manual verification.

### Task 25: Rewire `/live`

**Files:**
- Modify: `components/live/LiveContent.tsx`

- [ ] **Step 25.1: Identify mock blocks to delete**

Open [`components/live/LiveContent.tsx`](../../../components/live/LiveContent.tsx). Locate:
- Top-level `lanes` array (line 33)
- `decisions` array (lines 65–75)
- 6-row history list mock

- [ ] **Step 25.2: Replace with hooks**

Pseudo-skeleton:
```tsx
"use client";
import * as React from 'react';
import { fetchJson } from '@/lib/api/client';
import { useSSE } from '@/lib/api/sse';
import type { RunsResponse, StepsResponse, ActivityEvent } from '@/lib/api/types';
// ...existing imports

export default function LiveContent() {
  const [runs, setRuns] = React.useState<RunsResponse['runs']>([]);
  const [selectedRunId, setSelectedRunId] = React.useState<string | null>(null);
  const [steps, setSteps] = React.useState<StepsResponse['steps']>([]);
  const [activities, setActivities] = React.useState<ActivityEvent[]>([]);

  React.useEffect(() => {
    fetchJson<RunsResponse>('/api/runs?limit=6')
      .then(r => { setRuns(r.runs); if (!selectedRunId && r.runs[0]) setSelectedRunId(r.runs[0].id); })
      .catch(() => {});
  }, []);

  React.useEffect(() => {
    if (!selectedRunId) return;
    fetchJson<StepsResponse>(`/api/runs/${selectedRunId}/steps`).then(s => setSteps(s.steps)).catch(() => {});
  }, [selectedRunId]);

  const sseUrl = selectedRunId ? `/api/stream?runId=${selectedRunId}` : '';
  useSSE<ActivityEvent>(sseUrl, (data) => {
    setActivities(prev => [data, ...prev].slice(0, 200));
  }, { enabled: !!selectedRunId });

  // ...render using runs, steps, activities (replace mock with data)
}
```

Keep all existing layout JSX, just replace the data sources.

- [ ] **Step 25.3: Manual verification**

```bash
npm run dev
# Browser: http://localhost:3002/live
# 1. Sees up to 6 runs in left column (real IDs, not "RUN-J2041")
# 2. Click a run — middle swimlane populates
# 3. Right decision stream auto-updates as new events flow
# 4. Kill WS sidecar (Ctrl+C in that pane); status pill shows "重连中"; restart WS, recovers
```

- [ ] **Step 25.4: Commit**

```bash
git add components/live/LiveContent.tsx
git commit -m "feat(p1): /live now drives off /api/runs + /api/stream (real data)"
```

### Task 26: Rewire `/fleet`

**Files:**
- Modify: `components/fleet/FleetContent.tsx`

- [ ] **Step 26.1: Replace mock 12-row table**

In [`FleetContent.tsx`](../../../components/fleet/FleetContent.tsx) lines ~25-36, the inline `agents` array is replaced by:

```tsx
const [agentsData, setAgentsData] = React.useState<AgentsResponse | null>(null);
React.useEffect(() => {
  fetchJson<AgentsResponse>('/api/agents').then(setAgentsData).catch(() => {});
}, []);
const agents = agentsData?.agents ?? [];
```

Loop renders 22 rows now instead of 12. KPI strip aggregates from `agents`.

- [ ] **Step 26.2: Use displayName via t()**

```tsx
{t(a.displayName)}   // a.displayName = "agent_matcher" → "人岗匹配器"
```

- [ ] **Step 26.3: Status color uses new tokens**

Update `<StatusDot status={a.status ?? 'paused'} />` to handle 7 RunStatus values; map to css `bg-{status}` classes.

- [ ] **Step 26.4: Manual verify, commit**

```bash
npm run dev # Browser /fleet — see 22 rows, real status colors, top KPIs change with data
```

```bash
git add components/fleet/FleetContent.tsx
git commit -m "feat(p1): /fleet shows 22 agents from /api/agents"
```

### Task 27: Rewire `/workflow`

**Files:**
- Modify: `components/workflow/WorkflowContent.tsx`

- [ ] **Step 27.1: Replace static version badge**

[Line 77](../../../components/workflow/WorkflowContent.tsx#L77): replace `v4.2 · draft` with:
```tsx
import { WORKFLOW_META } from '@/lib/workflow-meta';
// ...
<Badge variant="info">{WORKFLOW_META.version} · {WORKFLOW_META.status}</Badge>
```

- [ ] **Step 27.2: Bind node status to live data**

After loading the 19 nodes (still hard-coded for P1 — topology change deferred to P2):
```tsx
const [steps, setSteps] = React.useState<StepDetail[]>([]);
React.useEffect(() => {
  // Get currently active run; if any, fetch its steps
  fetchJson<RunsResponse>('/api/runs?status=running,suspended&limit=1').then(r => {
    if (r.runs[0]) fetchJson<StepsResponse>(`/api/runs/${r.runs[0].id}/steps`).then(s => setSteps(s.steps));
  });
}, []);

const stepByNode = new Map(steps.map(s => [s.agentShort, s.status]));
```

For each rendered node, look up status by short name (mock node `id` → mapped short via inline lookup); apply status-color border.

- [ ] **Step 27.3: Manual verify**

Trigger a real run (`curl POST` to WS test endpoint). Open `/workflow`. Watch nodes light up.

- [ ] **Step 27.4: Commit**

```bash
git add components/workflow/WorkflowContent.tsx
git commit -m "feat(p1): /workflow node status from live run + version from workflow-meta"
```

### Task 28: Rewire `/events`

**Files:**
- Modify: `components/events/EventsContent.tsx`

- [ ] **Step 28.1: Fetch events from `/api/events`**

```tsx
const [eventsData, setEventsData] = React.useState<EventsResponse | null>(null);
React.useEffect(() => {
  fetchJson<EventsResponse>('/api/events').then(setEventsData).catch(() => {});
}, []);
```

Replace `import { EVENT_CATALOG } from '@/lib/events-catalog'` lookups with `eventsData?.events ?? []`.

- [ ] **Step 28.2: Keep events-catalog as fallback in handler only**

In Task 19's `app/api/events/route.ts`, when EM is down, fall back to `EVENT_CATALOG`. The page itself should NOT directly import `events-catalog` anymore.

- [ ] **Step 28.3: Manual verify, commit**

Open `/events` — see events from EM. Kill EM — see fallback (catalog) data with "EM 不可达" pill.

```bash
git add components/events/EventsContent.tsx
git commit -m "feat(p1): /events drives off /api/events (with catalog fallback)"
```

### Task 29: Rewire `/alerts` + `/datasources`

**Files:**
- Modify: `components/alerts/AlertsContent.tsx`
- Modify: `components/datasources/DataSourcesContent.tsx`

- [ ] **Step 29.1: `/alerts`**

Replace mock 12-rule array with `fetchJson<AlertsResponse>('/api/alerts')`. Facet counts come from data, not hardcoded.

- [ ] **Step 29.2: `/datasources`**

Replace mock 24-connector array with `fetchJson<DataSourcesResponse>('/api/datasources')`.

- [ ] **Step 29.3: Manual verify, commit**

```bash
git add components/alerts/AlertsContent.tsx components/datasources/DataSourcesContent.tsx
git commit -m "feat(p1): /alerts and /datasources drive off real APIs"
```

### Task 30: Cleanup `lib/events-catalog.ts` + final acceptance

**Files:**
- Modify: `app/api/events/route.ts` (remove fallback if EM stable)
- Delete: `lib/events-catalog.ts` only if EM stable for 1 week (skip in P1; flag for P2)

- [ ] **Step 30.1: Mark `lib/events-catalog.ts` as fallback-only**

Add a top-of-file comment:
```ts
/**
 * @deprecated Used as fallback in app/api/events/route.ts when EM is unreachable.
 * To be deleted in P2 once /api/events is stable for 1+ week.
 * No new code should import this directly — go through /api/events.
 */
```

- [ ] **Step 30.2: Run full P1 acceptance**

Open the [P1 sub-spec §11](../specs/2026-04-27-ao-int-p1-sidecar-design.md) acceptance checklist. Tick each:

- [ ] **6 页面真数据**: grep'd no leaked `"REQ-01"` `"字节跳动"` etc. in compiled output
- [ ] **22 行 fleet 表唯一性**: visual count + `byShort()` test
- [ ] **SSE 自动重连**: kill WS, wait 5s, restart, observe `/live` recovers
- [ ] **错误降级**: kill EM only, AO still serves; `/events` shows fallback banner
- [ ] **`/api/trace/[id]` p95 ≤500ms**: 50× curl loop measure
- [ ] **`npm run dev` 4 process boot**: confirmed in Task 14
- [ ] **No express/fastify/koa added**: `grep -E '"(express|fastify|koa)"' package.json` returns nothing
- [ ] **状态色覆盖**: visual sweep across `/fleet`, `/live`, `/workflow` for each of 7 RunStatus values
- [ ] **i18n 双写**: `grep -c agent_ lib/i18n.tsx` shows ≥44 (22×2 langs)
- [ ] **暗色模式**: toggle theme on each page; new tokens render
- [ ] **`/workflow` 节点状态实时**: trigger run; watch badges update

- [ ] **Step 30.3: Final commit**

```bash
git add lib/events-catalog.ts
git commit -m "chore(p1): mark events-catalog as fallback-only (P2 will delete)"
```

- [ ] **Step 30.4: Tag the milestone**

```bash
git tag p1-complete -m "AO-INT-P1: sidecar integration complete; ready for P2"
```

---

## Chunk Summary

| Chunk | Tasks | Tests added | LOC added (est.) | Commits |
|---|---|---|---|---|
| 1 (Foundation) | 8 | ~30 | ~600 | 8 |
| 2 (IO + dev) | 6 | ~10 | ~400 | 6 |
| 3 (Route Handlers) | 10 | ~30 | ~700 | 10 |
| 4 (Pages) | 6 | manual | ~300 | 6 |
| **Total** | **30** | **~70** | **~2000** | **30** |

## Acceptance (final)

P1 complete = §11 of [P1 spec](../specs/2026-04-27-ao-int-p1-sidecar-design.md) ✅ all checked + git tag `p1-complete`.

## Out of Scope

Anything mentioned in P1 spec §13 — `/inbox`, `/triggers`, React Flow, code relocation, SQLite, auth.
