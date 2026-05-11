# `generatePrompt` — User Guide (v4 / matchResume)

This guide covers the **canonical v4 prompt-generation surface** for the `matchResume` Action. Two audiences:

- **Consumer** (Part I) — you want to import the snapshot or call `generatePrompt` and inject candidate / job / client data into the prompt.
- **Maintainer** (Part II) — you own this codegen, need to regenerate the snapshot, extend to other Actions, or change the public types.

Scope: **matchResume only** at this stage. The same machinery applies to other Actions with single-placeholder semantics; multi-placeholder hierarchical input (the three-section CLIENT / JOB / RESUME layout) is matchResume-specific in v4.

---

# Part I — Consumer

## At a glance

| Mode | Function | Imports | When to use |
|---|---|---|---|
| **A. Snapshot import + fill** | `fillRuntimeInput(obj, input)` | `generated/v4/match-resume.action-object` + `lib/ontology-gen/v4` | Zero-fetch, deterministic. **Default.** |
| **B. Runtime resolve** | `generatePrompt({ actionRef, domain, runtimeInput? })` | `lib/ontology-gen/v4` | Live prompt against current API; the prompt picks up any rule changes since the snapshot. |

Both modes return the same `ActionObjectV4` shape:

```ts
interface ActionObjectV4 {
  prompt: string;            // markdown, ready to feed an LLM as a user message
  meta: ActionObjectMetaV4;  // actionId / actionName / domain / compiledAt / templateVersion / promptStrategy / validation
}
```

## Mode A — snapshot import + fill (recommended)

1. **Import** the static snapshot (committed to `generated/v4/`):

   ```ts
   import { matchResumeActionObject } from "@/generated/v4/match-resume.action-object";
   import { fillRuntimeInput } from "@/lib/ontology-gen/v4";
   import type {
     MatchResumeRuntimeInput,
   } from "@/generated/v4/action-object-v4.types";
   ```

2. **Build** a typed `MatchResumeRuntimeInput`:

   ```ts
   const input: MatchResumeRuntimeInput = {
     kind: "matchResume",
     client: {
       name: "腾讯",                       // → rendered as `client_name: 腾讯`
       department: "互动娱乐事业群",          // → rendered as `department: 互动娱乐事业群`
     },
     job: {
       job_requisition_id: "JR-2026-001",
       title: "高级后端工程师",
       required_skills: ["Java", "Spring Boot", "MySQL"],
       // ... any other fields the live Job_Requisition carries; all pass through verbatim
     },
     resume: {
       candidate_id: "C-12345",
       name: "Alice",
       work_experience: [/* ... */],
       // ... any other fields the live Resume carries
     },
   };
   ```

3. **Fill** and send:

   ```ts
   const ready = fillRuntimeInput(matchResumeActionObject, input);
   const response = await llm.complete({
     messages: [{ role: "user", content: ready.prompt }],
   });
   ```

## Mode B — runtime resolve

When the prompt needs to reflect the **latest** rules from the live Ontology API (not the committed snapshot):

```ts
import { generatePrompt } from "@/lib/ontology-gen/v4";

const obj = await generatePrompt({
  actionRef: "matchResume",
  domain: "RAAS-v1",
  runtimeInput: {
    kind: "matchResume",
    client: { name: "腾讯", department: "互动娱乐事业群" },
    job:    { job_requisition_id: "JR-2026-001", /* ... */ },
    resume: { candidate_id: "C-12345", /* ... */ },
  },
  // env reads:
  //   ONTOLOGY_API_BASE   (or pass apiBase)
  //   ONTOLOGY_API_TOKEN  (or pass apiToken)
});

await llm.complete({ messages: [{ role: "user", content: obj.prompt }] });
```

Without `runtimeInput`, the returned `prompt` retains the three placeholders — useful when you want to fetch once and fill with multiple candidates later.

## The runtime input contract

`MatchResumeRuntimeInput` (full shape in `generated/v4/action-object-v4.types.ts`):

| Field | Type | Notes |
|---|---|---|
| `kind` | `"matchResume"` | **Discriminator** — distinguishes from generic string / Record. |
| `client.name` | `string` | Rendered as `client_name: <name>` in the CLIENT block. |
| `client.department` | `string?` | When present, adds `department: <department>` line. |
| `job.job_requisition_id` | `string` | Only hard-required Job field; everything else is property-bag. |
| `resume.candidate_id` | `string` | Only hard-required Resume field; everything else is property-bag. |

**Why so few required fields?** Upstream `Job_Requisition` and `Resume` DataObjects are schema-agnostic property-bags and evolve frequently. TS-locking every field would create constant friction. The renderer JSON-stringifies the entire job / resume object verbatim into the prompt — the LLM reads whatever fields are present.

**Casing**: TS field names are camelCase (`client.name`); the renderer maps to the prompt's snake_case format (`client_name:`).

## Caveats

1. **Avoid `{{...}}` literals inside your input.** If your `client` / `job` / `resume` values contain the strings `{{CLIENT}}`, `{{JOB}}`, `{{RESUME}}`, or `{{RUNTIME_INPUT}}`, they may interact with the placeholder substitution. The implementation substitutes in reverse order (RESUME → JOB → CLIENT) to mitigate one layer, but if you control the input data, just don't include these literals.

2. **`meta.compiledAt` is frozen at snapshot generation time.** `fillRuntimeInput` does **not** update it. If a PR diff shows only `compiledAt` changed, treat as no-op noise. Mode B's `compiledAt` reflects the current call time.

3. **`fillRuntimeInput` is synchronous and pure.** Returns a new object; never mutates the input snapshot.

4. **The snapshot lives under `generated/v4/`.** v3 snapshots (full Action mirror) live in a separate codegen commit under `generated/v3/`; don't mix imports across versions.

## Generic / advanced runtime input

`fillRuntimeInput` also accepts:

- **`string`** — substituted verbatim into the **single** `{{RUNTIME_INPUT}}` placeholder. (matchResume's snapshot uses three placeholders instead, so a string input here is a no-op for matchResume.)
- **`Record<string, unknown>`** — JSON-stringified into a ` ```json ``` ` block, then substituted into `{{RUNTIME_INPUT}}`.

These exist for non-matchResume Actions and for legacy callers; matchResume consumers should always use the typed `MatchResumeRuntimeInput` form.

---

# Part II — Maintainer

## Architecture overview

```
                   ┌──────────────────────────────────────────────┐
                   │ Ontology API (Studio, port 3500)             │
                   │   GET /api/v1/ontology/actions/{ref}/rules   │
                   └────────────────────┬─────────────────────────┘
                                        │
                          ┌─────────────▼──────────────┐
                          │  lib/ontology-gen/fetch.ts  │ ← Action shape + invariants
                          └─────────────┬───────────────┘
                                        │ Action
                                        ▼
            ┌───────────────────────────────────────────────┐
            │  lib/ontology-gen/v4/generate-prompt.ts        │
            │    (canonical entry — async)                   │
            │                                                │
            │   1. Pick sentinel based on isMatchResumeAction│
            │      • matchResume → MATCH_RESUME_HIERARCHY    │
            │      • other       → RUNTIME_INPUT_PLACEHOLDER │
            │   2. assembleActionObjectV4_4({ runtimeInput   │
            │      = sentinel })                             │
            │   3. If runtimeInput given → fillRuntimeInput  │
            └───────────────┬───────────────────────────────┘
                            │
                            ▼ ActionObjectV4
                ┌───────────────────────────┐
                │  fill-runtime-input.ts    │ sync, pure
                └───────────────────────────┘
```

The trick: `assembleActionObjectV4_4` already accepts `runtimeInput: string` and splices it verbatim under the `## 运行时输入` heading. We pass a sentinel containing three `### ` sub-headers and three `{{...}}` placeholders. The assembler stays untouched.

## Module layout

```
lib/ontology-gen/
├── client.ts                       # HTTP helper
├── errors.ts                       # OntologyGenError hierarchy
├── fetch.ts                        # fetchAction (Ontology API → typed Action)
├── validate.ts                     # invariant assertions
├── types.public.ts / types.internal.ts
├── compile/filter.ts               # applyClientFilter (used by v4-4)
├── index.ts                        # slim re-exports (errors, fetch, types)
└── v4/
    ├── assemble.ts                 # RUNTIME_INPUT_PLACEHOLDER constant
    ├── assemble-v4-4.ts            # v4-4 prompt assembler; accepts string sentinel
    ├── types.ts                    # ActionObjectV4 / Meta / EnrichedAction
    ├── runtime-input.types.ts      # MatchResumeRuntimeInput + discriminator
    ├── placeholders.ts             # {{CLIENT}}/{{JOB}}/{{RESUME}} + sentinel + isMatchResumeAction
    ├── fill-runtime-input.ts       # sync placeholder substitution
    ├── generate-prompt.ts          # canonical async entry
    └── index.ts                    # public re-exports

generated/
└── v4/
    ├── action-object-v4.types.ts   # consumer ABI (hand-written subset of v4 types)
    └── match-resume.action-object.ts

scripts/
└── gen-v4-snapshot.ts              # CLI: fetch → assemble (with sentinel) → emit

app/dev/generate-prompt/
├── page.tsx                        # interactive preview at /dev/generate-prompt
└── actions.ts                      # server action for Live mode

docs/
└── GENERATE-PROMPT-USER-GUIDE.md   # this file
```

Note: the wider codegen system (v3 pipeline, v4-1/2/3 strategy router, legacy preview at `/dev/action-preview`, and their generated snapshots) lives in separate commits and is NOT shipped with this PR. The slim build here is everything needed for `generatePrompt` / `fillRuntimeInput` end-to-end.

## Regenerating the matchResume snapshot

```bash
# Set in .env.local:
#   ONTOLOGY_API_BASE=http://localhost:3500
#   ONTOLOGY_API_TOKEN=<bearer token>

npm run gen:v4-snapshot -- --action matchResume --domain RAAS-v1
```

This produces `generated/v4/match-resume.action-object.ts`. The script:

1. `fetchAction` against `/api/v1/ontology/actions/matchResume/rules?domain=RAAS-v1`.
2. Picks the matchResume sentinel from `placeholders.ts`.
3. `assembleActionObjectV4_4({ runtimeInput: sentinel })` — the prompt now contains `## 运行时输入\n\n### client\n\n{{CLIENT}}\n\n### 招聘岗位 (Job_Requisition)\n\n{{JOB}}\n\n### 候选人简历 (Resume)\n\n{{RESUME}}`.
4. Emits a TS module with banner + named export + default export.

**Diff hygiene**: `meta.compiledAt` advances on every run. If that's the only diff, the regen was a no-op.

## Maintainer checklist — when public ABI changes

Whenever you touch the **public surface** of `ActionObjectV4` / `ActionObjectMetaV4` / `MatchResumeRuntimeInput` (or related types):

1. Edit `lib/ontology-gen/v4/types.ts` and `lib/ontology-gen/v4/runtime-input.types.ts` (canonical source).
2. **Mirror the change** in `generated/v4/action-object-v4.types.ts` (consumer ABI — hand-written subset). The two files MUST agree on the shape; TS will surface drift via the snapshot's import.
3. Bump the `templateVersion` if the prompt **format** changes (not just rule content).
4. Re-run `npm run gen:v4-snapshot -- --action matchResume --domain RAAS-v1`.
5. `npm run build` — typecheck catches drift.

## Extending to a second Action

The current implementation hardcodes matchResume's three-placeholder pattern. Adding a second hierarchical Action (say `screenCandidate` with `{{CLIENT}} / {{INTERVIEW_PLAN}}`):

1. Define `ScreenCandidateRuntimeInput` in `runtime-input.types.ts` with `kind: "screenCandidate"` + relevant slots.
2. Add `PLACEHOLDER_INTERVIEW_PLAN` and `SCREEN_CANDIDATE_HIERARCHY_SENTINEL` to `placeholders.ts`. Reuse `PLACEHOLDER_CLIENT` if the section is identical.
3. Update `isScreenCandidateAction(action)` (mirror the predicate the assembler will use internally).
4. Extend `generate-prompt.ts`'s sentinel picker:
   ```ts
   const sentinel = isMatchResumeAction(action)     ? MATCH_RESUME_HIERARCHY_SENTINEL
                  : isScreenCandidateAction(action) ? SCREEN_CANDIDATE_HIERARCHY_SENTINEL
                  : RUNTIME_INPUT_PLACEHOLDER;
   ```
5. Extend `fillRuntimeInput.ts` with a new `isScreenCandidateRuntimeInput` branch.
6. Add the new type to `generated/v4/action-object-v4.types.ts`.
7. Run `npm run gen:v4-snapshot -- --action screenCandidate --domain RAAS-v1`.

If a third Action also needs hierarchical input, refactor the sentinel picker + discriminator branches into a small per-Action **registry** keyed by Action name. Until then YAGNI.

## Files reused (do not modify)

- `lib/ontology-gen/v4/assemble-v4-4.ts` — the v4-4 assembler is treated as immutable. We exploit its `string` branch via the sentinel pattern.
- `lib/ontology-gen/v4/assemble.ts` — `RUNTIME_INPUT_PLACEHOLDER` constant.
- `lib/ontology-gen/fetch.ts` — fetch + invariant assertions; shared with the broader codegen.

## Known caveats

- **Predicate duplication**: `placeholders.ts:isMatchResumeAction` mirrors the assembler-internal check (`id === "10" || name === "matchResume"`). Drift risk low but document if changed.
- **Snapshot vs runtime semantics**: snapshot's `meta.compiledAt` is the codegen time; the prompt body is otherwise deterministic. If you spot real prompt-body diffs across regens, investigate the upstream rule change rather than your filler logic.
- **Runtime input scrubbing**: the reverse-order replacement defends against one layer of `{{...}}` collision but not against deliberate adversarial input. If you ever route untrusted input through `fillRuntimeInput`, add an explicit scrub step that rejects or escapes `{{*}}` substrings.
- **Build coverage**: `npm run build` runs `tsc --noEmit` + lint across the entire repo. Any drift between `lib/ontology-gen/v4/types.ts` and `generated/v4/action-object-v4.types.ts` surfaces as a type error in `generated/v4/match-resume.action-object.ts`.

## Quick verification

```bash
# Regenerate snapshot
npm run gen:v4-snapshot -- --action matchResume --domain RAAS-v1

# Eyeball the placeholders
grep -E '\{\{CLIENT\}\}|\{\{JOB\}\}|\{\{RESUME\}\}' generated/v4/match-resume.action-object.ts
grep -E '### client|### 招聘岗位|### 候选人简历' generated/v4/match-resume.action-object.ts

# Typecheck end-to-end
npm run build
```

A successful round-trip:

```ts
// scratch file (do not commit)
import { matchResumeActionObject } from "@/generated/v4/match-resume.action-object";
import { fillRuntimeInput } from "@/lib/ontology-gen/v4";

const ready = fillRuntimeInput(matchResumeActionObject, {
  kind: "matchResume",
  client: { name: "腾讯", department: "互动娱乐事业群" },
  job:    { job_requisition_id: "JR-001", title: "test" },
  resume: { candidate_id: "C-1", name: "Alice" },
});

console.log(ready.prompt);
// Verify:
//   1. Three placeholders are gone.
//   2. `### client\n\nclient_name: 腾讯\ndepartment: 互动娱乐事业群` is present.
//   3. `### 招聘岗位 (Job_Requisition)\n\n```json\n{...}\n```` is present.
//   4. `### 候选人简历 (Resume)\n\n```json\n{...}\n```` is present.
```

## References

- Ontology API (lives in a companion repo / separate doc): `ONTOLOGY-API-USER-GUIDE-BASED-ON-NEO4J.md`
- v3 codegen system (separate commit): includes the full Action mirror snapshot, multi-strategy preview, and the LLM-driven transform pipeline.
