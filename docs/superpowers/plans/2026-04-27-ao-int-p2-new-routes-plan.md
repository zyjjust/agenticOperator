# AO-INT-P2 · 新路由实施计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/inbox` (HITL queue + multi-turn dialogue), `/triggers` (cron/webhook/upstream view), `/events` Firehose tab, and upgrade CmdPalette to search 4 resource types.

**Architecture:** Same Next.js 16 + 4-process sidecar topology as P1. Add 4 new API Routes (3 GET, 1 POST), 2 new pages, and extend 2 existing components (events page tabs, CommandPalette).

**Tech Stack:** Same as P1 + Next.js dynamic routes (`[id]`).

**Spec:** [`docs/superpowers/specs/2026-04-27-ao-int-p2-new-routes-design.md`](../specs/2026-04-27-ao-int-p2-new-routes-design.md)

**Pre-flight:**
- [ ] P1 acceptance verified (tag `p1-complete` exists)
- [ ] On branch `ao-int-p1` (merge later) or new `ao-int-p2`

---

## Chunk 1 · New API routes (4 endpoints, TDD)

### Task 1: Extend `lib/api/types.ts` with P2 types

**File:** `lib/api/types.ts`

Add types: `HumanTaskAction`, `HumanTaskActionResult`, `HumanTaskDetail`, `Message`, `MessagesResponse`, `TriggerDef`, `TriggersResponse`. No test (compile is the test).

Commit: `feat(p2): extend api/types.ts with P2 contracts (HITL action, messages, triggers)`

### Task 2: `wsClient` extensions

**Files:** `server/clients/ws.ts` + `server/clients/ws.test.ts`

Add `wsClient.fetchHumanTask(id)`, `resolveHumanTask(id, action)`, `fetchMessages(taskId)`, `postMessage(taskId, content)`, `openEventStream(eventName)` (single-event SSE). Mirror P1 patterns; tests with mocked fetch.

Commit: `feat(p2): wsClient adds HITL action + messages + per-event stream`

### Task 3: `POST /api/human-tasks/[id]/route.ts`

Accept `{ action: 'approve'|'reject'|'escalate', ... }`. Forward to `wsClient.resolveHumanTask`. Map errors:
- 409 if WS returns "already resolved" (`STALE` error)
- 502 if WS unreachable

Tests: 2 cases (approve OK, 409 stale).

Commit: `feat(p2): POST /api/human-tasks/[id] (approve/reject/escalate)`

### Task 4: `GET/POST /api/human-tasks/[id]/messages/route.ts`

GET returns full `{ sessionId, messages[] }`. POST accepts `{ content }`, returns increment.

Tests: 2 cases.

Commit: `feat(p2): /api/human-tasks/[id]/messages (multi-turn HITL chat)`

### Task 5: `GET /api/triggers/route.ts`

Returns 3 trigger types union. Sources:
- cron: WS run-sweeper config (or static `lib/triggers-static.ts` fallback)
- webhook: EM `/api/manager/raasEvents` route discovery (or static)
- upstream: derive from `AGENT_MAP` — events that appear in `triggersEvents` but never in any agent's `emitsEvents`

Tests: 3 cases (each kind).

Commit: `feat(p2): GET /api/triggers (cron + webhook + upstream)`

### Task 6: `GET /api/events/[name]/stream/route.ts`

Reuse P1 `/api/stream` pattern but param-route filtered to single event name.

Tests: 1 case (filter by event name passes/blocks).

Commit: `feat(p2): GET /api/events/[name]/stream (per-event SSE)`

---

## Chunk 2 · `/inbox` page

### Task 7: i18n keys for inbox

Add 13 keys × 2 langs to `lib/i18n.tsx`:
- `nav_inbox`, `inbox_title`, `inbox_facet_*` (4), `inbox_action_*` (3), `inbox_chat_*` (2), `inbox_sla_until`

Commit: `feat(p2): inbox i18n keys`

### Task 8: `app/inbox/page.tsx` thin shell

Standard page wrapper:
```tsx
"use client";
import { Shell } from "@/components/shared/Shell";
import { InboxContent } from "@/components/inbox/InboxContent";
import { useApp } from "@/lib/i18n";

export default function Page() {
  const { t } = useApp();
  return <Shell crumbs={[{ label: t("nav_inbox") }]} direction="Operate"><InboxContent /></Shell>;
}
```

### Task 9: `components/inbox/InboxContent.tsx` 3-column layout

Implement layout per [P2 spec §4.1.2](../specs/2026-04-27-ao-int-p2-new-routes-design.md#4.1):
- Left 280px: facets (4 buttons: 全部/我负责/即将超时/by-stage)
- Middle: HumanTask cards (real data from `/api/human-tasks?status=pending&limit=50`)
- Right 320px: selected task panel (AI opinion, payload, conversation, action buttons)

Cards driven by `fetchJson<HumanTasksResponse>('/api/human-tasks')`. Selected detail uses `fetchJson<HumanTaskDetail>('/api/human-tasks/${id}')` (need GET endpoint — extend Task 3).

Manual verification:
- [ ] Empty state: "No pending tasks" with empty Ic
- [ ] Sample task render with mock approve flow
- [ ] SLA badge color: <30min red, 30m–2h amber, >2h grey

Commit: `feat(p2): /inbox HITL queue page`

### Task 10: ChatbotSession multi-turn renderer

Component `components/inbox/ChatPane.tsx`:
- Polls `GET /api/human-tasks/[id]/messages` every 5s OR uses SSE if available
- Optimistic UI on POST: render user message immediately, await assistant response
- Renders `role: user|assistant|system|client` with distinct bubbles

Embedded in InboxContent right panel when `task.chatbotSession` flag is set.

Manual verification:
- [ ] 3-turn chat completes
- [ ] Optimistic UI: user message visible <100ms after send

Commit: `feat(p2): ChatPane multi-turn HITL dialogue renderer`

### Task 11: Action buttons + escalate flow

`components/inbox/ActionPanel.tsx`:
- Approve / Reject / Escalate buttons
- POST to `/api/human-tasks/[id]` with action
- On 409: show toast "已被 X 处理", refetch
- On escalate: open select-client dialog → POST with `targetClient`

Manual verification:
- [ ] Approve flows back through SSE → workflow continues
- [ ] Escalate creates child session (verify in payload response)

Commit: `feat(p2): /inbox action panel (approve/reject/escalate)`

### Task 12: SLA countdown + LeftNav badge

- `useTick(1000)` hook for SLA countdown
- LeftNav unread badge from `/api/human-tasks?status=pending` total

Commit: `feat(p2): SLA countdown + LeftNav unread badge`

---

## Chunk 3 · `/triggers` page

### Task 13: i18n keys for triggers

9 keys × 2 langs: `triggers_title`, `triggers_tab_*` (3), `triggers_col_*` (5).

Commit: `feat(p2): triggers i18n keys`

### Task 14: `app/triggers/page.tsx` + `lib/triggers-static.ts`

Static catalog for fallback when API can't find cron/webhook configs:
```ts
export const TRIGGER_CATALOG: Pick<TriggerDef, 'id'|'kind'|'name'|'description'|'emits'|'schedule'|'endpoint'>[] = [
  { id: 'cron-rms-sync', kind: 'cron', name: 'cron.rms-sync', description: '定时同步客户 RMS', emits: ['SCHEDULED_SYNC'], schedule: '*/5 * * * *' },
  // ...~6-8 entries
];
```

Page thin shell pattern.

### Task 15: `components/triggers/TriggersContent.tsx`

3-tab layout (Cron / Webhook / Upstream). Each tab renders a table with columns: name, emits, schedule/endpoint/upstreamEvent, last fired, next fire (cron only), 24h fire/error count.

Click row: open right drawer with full config + recent firings.

Data: `fetchJson<TriggersResponse>('/api/triggers')`.

Manual verification:
- [ ] 3 tabs render with non-empty rows
- [ ] Row click opens drawer
- [ ] Cron rows show next-fire countdown

Commit: `feat(p2): /triggers page (cron + webhook + upstream)`

---

## Chunk 4 · `/events` Firehose tab + CmdPalette + LeftNav

### Task 16: `/events` Firehose tab

Extend [`components/events/EventsContent.tsx`](../../../components/events/EventsContent.tsx) tab list to 7 (was 6). Tab `firehose` renders:
- Filter checkboxes (ok/warn/err/tool/hitl)
- Auto-scroll toggle, Pause button
- SSE feed via `useSSE('/api/events/[name]/stream')` filtered by checkboxes
- Top KPI bar: 24h DLQ hits + 24h dedup hits (call `/api/alerts?category=dlq&affected=<eventName>`)
- Browser-side LRU 200 entries

Commit: `feat(p2): /events Firehose tab (real-time + DLQ + dedup)`

### Task 17: CmdPalette resource search

Refactor [`components/shared/CommandPalette.tsx`](../../../components/shared/CommandPalette.tsx) from static command list to two-mode:
1. `>` prefix: command mode (existing)
2. Default: resource search

Resource types & queries (debounce 250ms):
- `@<query>`: agents (filter `lib/agent-mapping.ts`)
- `#<query>`: runs (`fetch /api/runs?q=<query>&limit=10`)
- `!<query>`: tasks (`fetch /api/human-tasks?q=<query>&limit=10`)
- `:<query>`: events (`fetch /api/events?q=<query>&limit=10`)
- no prefix: parallel all 4 (Promise.allSettled, group results)

Commit: `feat(p2): CmdPalette upgrades to 4-resource search`

### Task 18: LeftNav `/inbox` + `/triggers` entries

Add 2 nav items per [spec §7](../specs/2026-04-27-ao-int-p2-new-routes-design.md#7):
- Operate → Inbox (with unread badge from `/api/human-tasks` count)
- Build → Triggers

Commit: `feat(p2): LeftNav adds /inbox + /triggers`

### Task 19: P2 acceptance + tag

Run [P2 spec §9](../specs/2026-04-27-ao-int-p2-new-routes-design.md#9) checklist:
- [ ] HITL closed-loop flow (approve → SSE → workflow continues)
- [ ] ChatbotSession 3-turn dialogue
- [ ] Escalate creates child session
- [ ] Triggers 3 tabs with data
- [ ] Firehose 5s latency
- [ ] CmdPalette 4 prefixes
- [ ] LeftNav unread badge live
- [ ] SLA color thresholds
- [ ] zh/en/light/dark all combinations
- [ ] no Express/Fastify added (Q4)

Tag: `git tag p2-complete -m "AO-INT-P2: HITL + triggers + firehose + palette"`.

---

## Estimated Time

| Chunk | Tasks | Est. (focused) |
|---|---|---|
| 1 (API routes) | 6 | 1 day |
| 2 (/inbox) | 6 | 2 days |
| 3 (/triggers) | 3 | 1 day |
| 4 (firehose + palette + nav) | 3 + acceptance | 1 day |
| **Total** | 19 | **~5 days** |

## Out of Scope (deferred to P3)

- Code relocation (`Action_and_Event_Manager/` → `agenticOperator/server/`)
- DB switch to SQLite single file
- Inngest serve via `inngest/next`
- Delete `lib/events-catalog.ts` (still fallback in P2)
- Rich AlertRow / DataSource detail rendering (P1 carryover; no API yet)
- HumanTask分配 / 转派 / 通知系统 (→ P4)
- Triggers 编辑 / 启停 / 回放 (→ P4)
