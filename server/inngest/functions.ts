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

// Disabled 2026-04-29 — superseded by resume-parser-agent (port 3020).
// AO-main's sampleResumeParserAgent + resume-parser-agent both subscribed
// to RESUME_DOWNLOADED and emitted RESUME_PROCESSED in parallel, fanning
// matchResume out twice per resume. Keeping only the new parser.
// Re-enable here only if rolling back.
// import { sampleResumeParserAgent } from "../ws/agents/sample-resume-parser";

// Disabled 2026-05-06 — superseded by
// resume-parser-agent/lib/inngest/agents/create-jd-agent.ts (port 3020).
// Both apps subscribed to REQUIREMENT_LOGGED would have fired the LLM
// twice per requirement and emitted JD_GENERATED twice. Keeping only
// the new RPA version. Re-enable here only if rolling back.
// import { createJdAgent } from "../ws/agents/create-jd";

import { matchResumeAgent } from "../ws/agents/match-resume";

// Resume Download → match flow stays in AO-main (per user instruction
// 2026-05-06). New resume-parser-agent owns parser + new matcher; this
// AO-main matchResumeAgent is the legacy ws/ path kept side-by-side.
export const allFunctions = [
  // createJdAgent,            // node 4 — disabled, see comment above
  // sampleResumeParserAgent,  // node 9-1 — disabled, see comment above
  matchResumeAgent,         // node 10
];
