// Inngest client (P3 chunk 3).
//
// Bare client only — no agent imports here, to avoid circular import
// when agents import this file. The function registry lives in
// server/inngest/functions.ts.

import { Inngest } from "inngest";

export const inngest = new Inngest({
  id: "agentic-operator",
  // INNGEST_EVENT_KEY (prod) / inngest-cli dev (local) auto-detected
});
