# resume-parser-agent

Proof-of-concept event-driven agent built with **Next.js + Inngest** to validate
the agentic-workflow design with the partner's RAAS / Action_and_Event_Manager
platform. No LLM — deterministic parse stub.

## Behavior

```
resume.uploaded   (in,  published by RAAS / partner)
        │
        ▼
   logger.info("Received the resume — …")
        │
        ▼
   parse-resume step (250ms stub, deterministic)
        │
        ▼
resume.parse      (out, published by this agent)
```

Event payloads are declared via `EventSchemas` in
[lib/inngest/client.ts](lib/inngest/client.ts), so both the function and the
test publisher are type-safe.

## Stack

- Next.js 15 (App Router) on port **3010**
- Inngest 3.52 (serve handler at `app/api/inngest/route.ts`)
- TypeScript 5.9, Node.js 22+

## Run end-to-end (3 terminals)

```bash
# 1. Inngest Dev Server — the event bus shared by all services
npx inngest-cli@latest dev
#   UI: http://localhost:8288

# 2. This agent (Next.js)
cd resume-parser-agent
npm install
npm run dev
#   Next.js: http://localhost:3010
#   Inngest serve endpoint: http://localhost:3010/api/inngest
#   The dev server auto-discovers it.

# 3. Publish a test resume.uploaded (simulates the partner / RAAS)
npm run publish:test
#   or: npm run publish:test -- <resume_id> "Candidate Name"
```

In the Inngest Dev Server UI (http://localhost:8288 → **Stream**) you'll see:
1. `resume.uploaded` arrive
2. The `resume-parser` function execute
3. `resume.parse` published as a downstream event

Agent stdout prints the literal log line:
```
Received the resume — resume_id=… candidate=Ada Lovelace file=https://example.com/…
[resume-parser] parsing resume … (deterministic stub, no LLM)
[resume-parser] published resume.parse — resume_id=… skills=3 duration=257ms
```

## Wiring with the partner (RAAS / @aem/server)

The partner's server runs an Inngest client (`id: 'event-manager'`) registered
at `http://localhost:8000/api/inngest`. Both services hit the **same** local
Inngest Dev Server, so when their pipeline calls:

```ts
await inngest.send({ name: 'resume.uploaded', data: { … } });
```

Inngest fans out to every registered subscriber — including this agent. No
direct HTTP between the two services is needed; Inngest is the bus. This
proves the event-driven design works across independent services.
