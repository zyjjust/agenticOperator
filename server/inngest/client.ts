// Inngest client (P3 chunk 3).
//
// Two modes via env:
//   - Shared gateway (RAAS联调): set INNGEST_BASE_URL + INNGEST_DEV to the
//     team-shared Inngest dev URL, e.g. http://10.100.0.70:8288. AO will
//     send events there AND must be registered as a serve endpoint there
//     (see scripts/register-with-inngest.ts). RAAS emits flow into AO.
//   - Local: INNGEST_DEV=1 (or unset and inngest-cli running on localhost)
//     for offline AO-only testing.
//
// No agent imports here — registry lives in server/inngest/functions.ts
// to avoid circular import (agents → client → agents).

import { Inngest } from "inngest";

// inngest@^4 reads INNGEST_DEV / INNGEST_BASE_URL automatically; we just
// pass id + (optionally) eventKey. Setting INNGEST_DEV=<url> makes both
// .send() and the serve handler use that URL as the dev server.
// Note: app id is "agentic-operator-main" to avoid colliding with the
// older sibling prototype `resume-parser-agent/` which also registers
// itself as `agentic-operator` on the same Inngest dev server. With
// distinct ids both apps get their own slot and the dev server fans
// out RESUME_DOWNLOADED to both subscribers.
export const inngest = new Inngest({
  id: "agentic-operator-main",
  eventKey: process.env.INNGEST_EVENT_KEY,
});
