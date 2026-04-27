// Inngest serve adapter for Next.js App Router.
//
// P3 chunk 3 — wires the Inngest /next handler. Functions list is empty
// until chunk 2 ports the 22 agents; once ported, they auto-register via
// server/inngest/client.ts allFunctions[].
//
// Dev: works alongside `npx inngest-cli dev` (8288). The dev server
// discovers this endpoint via /api/inngest auto-introspection.
// Prod: replace with Inngest Cloud or self-hosted Inngest server.

import { serve } from "inngest/next";
import { inngest, allFunctions } from "@/server/inngest/client";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: allFunctions,
});
