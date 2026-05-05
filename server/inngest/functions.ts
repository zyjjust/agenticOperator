// Inngest function registry.
//
// All agents are ALWAYS registered with Inngest so partner can see them
// in the dashboard. Per-event behavior is gated by the agentic on/off
// toggle in `server/agentic-state.ts`:
//   - OFF  → agent receives the event but short-circuits, writes one
//            AgentActivity row "Skipped (agentic OFF)" and returns.
//   - ON   → full pipeline.
//
// Flip the toggle via:
//   POST http://localhost:3002/api/agentic {"enabled": true|false}
//   or use the toggle button on the /workflow page.

import { createJdAgent } from "../ws/agents/create-jd";
// Disabled 2026-04-29 — superseded by resume-parser-agent (port 3020). Both
// previously subscribed to RESUME_DOWNLOADED and emitted RESUME_PROCESSED in
// parallel, fanning matchResume out twice per resume. Keeping only the new
// parser. Re-enable here only if rolling back.
// import { sampleResumeParserAgent } from "../ws/agents/sample-resume-parser";
import { matchResumeAgent } from "../ws/agents/match-resume";

export const allFunctions = [
  createJdAgent,            // node 4
  // sampleResumeParserAgent,  // node 9-1 — disabled, see comment above
  matchResumeAgent,         // node 10
];
