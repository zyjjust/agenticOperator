// Inngest function registry (P3 chunk 3).
//
// Each agent module under server/ws/agents/ exports its
// inngest.createFunction(...) value. This file imports them and
// assembles the array consumed by app/api/inngest/route.ts serve().
//
// Kept separate from server/inngest/client.ts to avoid circular
// imports — agents import the client, this file imports both.

import { sampleResumeParserAgent } from "../ws/agents/sample-resume-parser";
import { matchResumeAgent } from "../ws/agents/match-resume";

// P3 chunk 2 will append the remaining ported WS agents here as they land.

export const allFunctions = [sampleResumeParserAgent, matchResumeAgent];
