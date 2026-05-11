import { describe, it, expect } from 'vitest';
import { extractEntityRefs, hasEntityRef } from './entity-extractor';

describe('extractEntityRefs', () => {
  it('returns empty for null / undefined / non-object', () => {
    expect(extractEntityRefs(null)).toEqual([]);
    expect(extractEntityRefs(undefined)).toEqual([]);
    expect(extractEntityRefs('foo')).toEqual([]);
    expect(extractEntityRefs(42)).toEqual([]);
  });

  it('picks up entity_type + entity_id at top level (RAAS canonical envelope)', () => {
    const out = extractEntityRefs({
      entity_type: 'JobRequisition',
      entity_id: 'jrid_abc',
      payload: {},
    });
    expect(out).toEqual([{ type: 'JobRequisition', id: 'jrid_abc' }]);
  });

  it('rejects unknown entity_type strings', () => {
    const out = extractEntityRefs({
      entity_type: 'Mystery',
      entity_id: 'x',
    });
    expect(out).toEqual([]);
  });

  it('picks up named keys: job_requisition_id', () => {
    const out = extractEntityRefs({
      payload: { job_requisition_id: 'jrid_xyz' },
    });
    expect(out).toEqual([{ type: 'JobRequisition', id: 'jrid_xyz' }]);
  });

  it('picks up named keys: jd_id, posting_id, job_posting_id', () => {
    expect(extractEntityRefs({ jd_id: 'jd_1' })).toEqual([
      { type: 'JobPosting', id: 'jd_1' },
    ]);
    expect(extractEntityRefs({ posting_id: 'p_2' })).toEqual([
      { type: 'JobPosting', id: 'p_2' },
    ]);
    expect(extractEntityRefs({ job_posting_id: 'jp_3' })).toEqual([
      { type: 'JobPosting', id: 'jp_3' },
    ]);
  });

  it('picks up named keys: candidate_id, resume_id', () => {
    expect(extractEntityRefs({ candidate_id: 'c_1' })).toEqual([
      { type: 'Candidate', id: 'c_1' },
    ]);
    expect(extractEntityRefs({ resume_id: 'r_2' })).toEqual([
      { type: 'Candidate', id: 'r_2' },
    ]);
  });

  it('walks deep into nested payload (real RAAS envelope shape)', () => {
    const envelope = {
      entity_type: 'JobRequisition',
      entity_id: 'jrid_top',
      payload: {
        client_id: 'client_x',
        raw_input_data: {
          job_requisition_id: 'jrid_nested',
          client_job_title: 'foo',
        },
      },
    };
    const out = extractEntityRefs(envelope);
    // dedupes: jrid_top appears once even though raw_input_data has the same conceptually different id
    expect(out).toContainEqual({ type: 'JobRequisition', id: 'jrid_top' });
    expect(out).toContainEqual({ type: 'JobRequisition', id: 'jrid_nested' });
  });

  it('extracts both JD and JR from a JD_GENERATED envelope', () => {
    const envelope = {
      entity_type: 'JobDescription',
      entity_id: 'jd_999',
      payload: {
        job_requisition_id: 'jrid_42',
        client_id: 'c_1',
        jd_id: 'jd_999',
      },
    };
    const out = extractEntityRefs(envelope);
    expect(out).toContainEqual({ type: 'JobPosting', id: 'jd_999' });
    expect(out).toContainEqual({ type: 'JobRequisition', id: 'jrid_42' });
    // entity_type 'JobDescription' is NOT in our type set (we use JobPosting)
    // — but jd_id picks it up, so the entity is still found.
  });

  it('dedupes identical refs', () => {
    const out = extractEntityRefs({
      job_requisition_id: 'x',
      payload: { job_requisition_id: 'x', requirement_id: 'x' },
    });
    expect(out).toEqual([{ type: 'JobRequisition', id: 'x' }]);
  });

  it('ignores empty / non-string IDs', () => {
    expect(extractEntityRefs({ job_requisition_id: '' })).toEqual([]);
    expect(extractEntityRefs({ job_requisition_id: '   ' })).toEqual([]);
    expect(extractEntityRefs({ candidate_id: 42 })).toEqual([]);
    expect(extractEntityRefs({ resume_id: null })).toEqual([]);
  });

  it('handles arrays in payload (e.g. batch operations)', () => {
    const out = extractEntityRefs({
      candidates: [{ candidate_id: 'a' }, { candidate_id: 'b' }],
    });
    expect(out).toContainEqual({ type: 'Candidate', id: 'a' });
    expect(out).toContainEqual({ type: 'Candidate', id: 'b' });
  });

  it('respects depth limit (does not crash on deeply nested data)', () => {
    let deep: any = { candidate_id: 'leaf' };
    for (let i = 0; i < 30; i++) deep = { wrap: deep };
    const out = extractEntityRefs(deep);
    // depth limit is 10 by default — leaf is at depth 30, so it's not found.
    // The important thing is that it returned without crashing.
    expect(Array.isArray(out)).toBe(true);
  });
});

describe('hasEntityRef', () => {
  it('returns true when entity ref is present', () => {
    expect(
      hasEntityRef({ entity_type: 'JobRequisition', entity_id: 'x' }, 'JobRequisition', 'x'),
    ).toBe(true);
  });

  it('returns false when type matches but id does not', () => {
    expect(
      hasEntityRef({ job_requisition_id: 'x' }, 'JobRequisition', 'y'),
    ).toBe(false);
  });

  it('returns false for unrelated payload', () => {
    expect(hasEntityRef({ foo: 'bar' }, 'JobRequisition', 'x')).toBe(false);
  });

  it('handles JSON-string input (auto-parses)', () => {
    const json = JSON.stringify({ candidate_id: 'c_1' });
    expect(hasEntityRef(json, 'Candidate', 'c_1')).toBe(true);
    expect(hasEntityRef('not-json', 'Candidate', 'c_1')).toBe(false);
  });
});
