import { describe, it, expect } from 'vitest';
import { WORKFLOW_META } from './workflow-meta';

describe('WORKFLOW_META', () => {
  it('has version, lastUpdated, and stage list', () => {
    expect(WORKFLOW_META.version).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(WORKFLOW_META.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(WORKFLOW_META.stages).toHaveLength(9);
  });
});
