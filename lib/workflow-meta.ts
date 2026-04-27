import type { Stage } from './agent-mapping';

export const WORKFLOW_META = {
  version: 'v4.2.0',
  lastUpdated: '2026-04-27',
  status: 'active' as const,
  stages: [
    'system',
    'requirement',
    'jd',
    'resume',
    'match',
    'interview',
    'eval',
    'package',
    'submit',
  ] satisfies readonly Stage[],
} as const;
