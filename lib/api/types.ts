import type { Stage, AgentKind } from '../agent-mapping';

export type RunStatus =
  | 'running'
  | 'suspended'
  | 'timed_out'
  | 'completed'
  | 'failed'
  | 'paused'
  | 'interrupted';

export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'retrying';

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
  type:
    | 'agent_start'
    | 'agent_complete'
    | 'agent_error'
    | 'human_waiting'
    | 'human_completed'
    | 'event_emitted'
    | 'decision'
    | 'tool'
    | 'anomaly';
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

export type ApiError = {
  error: 'BAD_REQUEST' | 'NOT_FOUND' | 'UPSTREAM_DOWN' | 'INTERNAL' | 'PROTOCOL';
  message: string;
  field?: string;
  traceId?: string;
};
