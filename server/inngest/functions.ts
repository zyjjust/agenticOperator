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

// Disabled 2026-05-06 — superseded by
// resume-parser-agent/lib/inngest/agents/match-resume-agent.ts (port 3020).
// New RPA matcher owns the RESUME_PROCESSED → MATCH_* flow end-to-end and
// emits payloads RAAS resume-processed-ingest accepts (status=ingested).
// The legacy ws/ matcher's payload was being skipped by RAAS as
// missing_required_fields. Keeping it side-by-side fanned MATCH_* out
// twice per resume — now switched off. Re-enable here only if rolling back.
// import { matchResumeAgent } from "../ws/agents/match-resume";

// AO-main no longer registers any Inngest functions. The full
// REQUIREMENT_LOGGED → JD_GENERATED → RESUME_DOWNLOADED → RESUME_PROCESSED
// → MATCH_* chain is owned by resume-parser-agent (port 3020). AO-main
// remains running for its UI / API routes only.
export const allFunctions: never[] = [
  // createJdAgent,            // node 4   — disabled, see comment above
  // sampleResumeParserAgent,  // node 9-1 — disabled, see comment above
  // matchResumeAgent,         // node 10  — disabled 2026-05-06
];
