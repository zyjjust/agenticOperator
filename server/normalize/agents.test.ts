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
