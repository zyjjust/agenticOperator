import { serve } from 'inngest/next';
import { inngest } from '@/lib/inngest/client';
import { matchResumeAgent } from '@/lib/inngest/agents/match-resume-agent';
import { resumeParserAgent } from '@/lib/inngest/functions/resume-parser-agent';

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [resumeParserAgent, matchResumeAgent],
});
