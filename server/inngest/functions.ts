// AO-main Inngest function registry.
//
// AO-main is the control-plane (UI + EM gateway + RAAS bridge); it does not
// host any agent runtimes. The full REQUIREMENT_LOGGED → JD_GENERATED →
// RESUME_DOWNLOADED → RESUME_PROCESSED → MATCH_* chain runs in
// resume-parser-agent (port 3020).

export const allFunctions: never[] = [];
