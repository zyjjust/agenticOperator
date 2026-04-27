// Inngest client + function registry (P3 chunk 3 — adapter only).
//
// Functions are empty until P3 chunk 2 ports the 22 agents from
// Action_and_Event_Manager/workflow-studio/server/src/agents/. Each ported
// agent will export an `inngest.createFunction(...)` value that gets
// imported below.
//
// Until then, `app/api/inngest/route.ts` serves an empty function set
// so the route handler is wired and Inngest dev dashboard sees a worker.

import { Inngest } from "inngest";

export const inngest = new Inngest({
  id: "agentic-operator",
  // INNGEST_EVENT_KEY (prod) / inngest-cli dev (local) auto-detected
});

// Each ported agent will push its `inngest.createFunction(...)` here.
// Type intentionally loose to avoid version-coupling Inngest's internal
// FunctionConfiguration generic.
export const allFunctions: any[] = [];
