import { describe, it, expect } from 'vitest';
import { flatten, EnvelopeMalformedError } from './envelope';

describe('flatten', () => {
  it('extracts event/trace/business from valid 3-layer envelope', () => {
    const env = {
      payload: {
        event_name: 'REQUIREMENT_SYNCED',
        correlation_id: 'trace-abc',
        payload: {
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
    const env = {
      payload: { event_name: 'X', correlation_id: 't', payload: null },
    };
    expect(() => flatten(env)).toThrow(EnvelopeMalformedError);
  });

  it('throws when event_name is empty', () => {
    const env = {
      payload: {
        event_name: '',
        correlation_id: 't',
        payload: { payload: {} },
      },
    };
    expect(() => flatten(env)).toThrow(EnvelopeMalformedError);
  });
});
