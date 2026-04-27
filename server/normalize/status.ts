import type { RunStatus, StepStatus } from '../../lib/api/types';

export class InvalidStatusError extends Error {
  constructor(value: string, kind: 'run' | 'step') {
    super(`Invalid ${kind} status: "${value}"`);
    this.name = 'InvalidStatusError';
  }
}

const RUN_STATUS = new Set<RunStatus>([
  'running',
  'suspended',
  'timed_out',
  'completed',
  'failed',
  'paused',
  'interrupted',
]);

const STEP_STATUS = new Set<StepStatus>([
  'pending',
  'running',
  'completed',
  'failed',
  'retrying',
]);

export function normalizeRunStatus(s: string): RunStatus {
  if (!RUN_STATUS.has(s as RunStatus)) throw new InvalidStatusError(s, 'run');
  return s as RunStatus;
}

export function normalizeStepStatus(s: string): StepStatus {
  if (!STEP_STATUS.has(s as StepStatus)) throw new InvalidStatusError(s, 'step');
  return s as StepStatus;
}
