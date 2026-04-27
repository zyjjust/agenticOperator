import { describe, it, expect } from 'vitest';
import {
  normalizeRunStatus,
  normalizeStepStatus,
  InvalidStatusError,
} from './status';

describe('normalizeRunStatus', () => {
  it.each([
    'running',
    'suspended',
    'timed_out',
    'completed',
    'failed',
    'paused',
    'interrupted',
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
  it.each(['pending', 'running', 'completed', 'failed', 'retrying'])(
    'accepts %s',
    (s) => {
      expect(normalizeStepStatus(s)).toBe(s);
    },
  );
});
