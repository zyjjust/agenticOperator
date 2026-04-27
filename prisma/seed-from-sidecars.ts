// One-shot data import: pulls live data from sidecar APIs (WS 5175 + EM 8000)
// and seeds it into ao.db via Prisma. Used during P3 transition so Route
// Handlers can switch from wsClient/emClient to prisma without losing data.
//
// Run: tsx prisma/seed-from-sidecars.ts
// Idempotent: upsert by primary key. Safe to re-run.
//
// P3 chunk 5 (after sidecars deleted) — this script becomes redundant
// because the in-process WS/EM modules write directly to ao.db.

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

const url = (process.env.DATABASE_URL ?? "file:./data/ao.db").replace(
  /^file:/,
  "",
);
const adapter = new PrismaBetterSqlite3({ url });
const prisma = new PrismaClient({ adapter });

const WS = process.env.WS_BASE_URL ?? "http://localhost:5175";
const EM = process.env.EM_BASE_URL ?? "http://localhost:8000";

// snake → camel for any object
function camelize(o: any): any {
  if (Array.isArray(o)) return o.map(camelize);
  if (o && typeof o === "object") {
    const out: any = {};
    for (const [k, v] of Object.entries(o)) {
      out[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = camelize(v);
    }
    return out;
  }
  return o;
}

async function fetchJson(url: string): Promise<any> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

async function syncRuns() {
  const r = await fetchJson(`${WS}/api/runs?limit=200`);
  const items = camelize(r.items ?? []);
  let imported = 0;
  for (const it of items) {
    await prisma.workflowRun.upsert({
      where: { id: it.id },
      update: {
        triggerEvent: it.triggerEvent,
        status: it.status,
        startedAt: new Date(it.startedAt),
        completedAt: it.completedAt ? new Date(it.completedAt) : null,
        lastActivityAt: new Date(it.lastActivityAt),
        suspendedReason: it.suspendedReason ?? null,
        triggerData: typeof it.triggerData === "string" ? it.triggerData : JSON.stringify(it.triggerData ?? {}),
      },
      create: {
        id: it.id,
        triggerEvent: it.triggerEvent,
        status: it.status,
        startedAt: new Date(it.startedAt),
        completedAt: it.completedAt ? new Date(it.completedAt) : null,
        lastActivityAt: new Date(it.lastActivityAt),
        suspendedReason: it.suspendedReason ?? null,
        triggerData: typeof it.triggerData === "string" ? it.triggerData : JSON.stringify(it.triggerData ?? {}),
      },
    });
    imported++;
  }
  return imported;
}

async function syncHumanTasks() {
  const r = await fetchJson(`${WS}/api/human-tasks`);
  const items = camelize(Array.isArray(r) ? r : []);
  let imported = 0;
  for (const it of items) {
    await prisma.humanTask.upsert({
      where: { id: it.id },
      update: {
        runId: it.runId,
        nodeId: it.nodeId,
        nodeName: it.nodeName ?? "",
        title: it.title,
        payload: typeof it.payload === "string" ? it.payload : JSON.stringify(it.payload ?? {}),
        aiOpinion: it.aiOpinion ? (typeof it.aiOpinion === "string" ? it.aiOpinion : JSON.stringify(it.aiOpinion)) : null,
        status: it.status ?? "pending",
        assignee: it.assignee ?? null,
        deadline: it.deadline ? new Date(it.deadline) : null,
      },
      create: {
        id: it.id,
        runId: it.runId,
        nodeId: it.nodeId,
        nodeName: it.nodeName ?? "",
        title: it.title,
        payload: typeof it.payload === "string" ? it.payload : JSON.stringify(it.payload ?? {}),
        aiOpinion: it.aiOpinion ? (typeof it.aiOpinion === "string" ? it.aiOpinion : JSON.stringify(it.aiOpinion)) : null,
        status: it.status ?? "pending",
        assignee: it.assignee ?? null,
        deadline: it.deadline ? new Date(it.deadline) : null,
        createdAt: it.createdAt ? new Date(it.createdAt) : new Date(),
      },
    });
    imported++;
  }
  return imported;
}

async function syncEvents() {
  try {
    const r = await fetchJson(`${EM}/api/manager/events`);
    const items = r.items ?? [];
    let imported = 0;
    for (const it of items) {
      await prisma.eventDefinition.upsert({
        where: { id: it.id },
        update: {
          name: it.name,
          description: it.description ?? "",
          payload: typeof it.payload === "string" ? it.payload : JSON.stringify(it.payload ?? {}),
          status: it.status ?? "DRAFT",
          version: it.version ?? "1.0",
          updatedAt: it.updated_at ?? new Date().toISOString(),
        },
        create: {
          id: it.id,
          name: it.name,
          description: it.description ?? "",
          payload: typeof it.payload === "string" ? it.payload : JSON.stringify(it.payload ?? {}),
          status: it.status ?? "DRAFT",
          version: it.version ?? "1.0",
          createdAt: it.created_at ?? new Date().toISOString(),
          updatedAt: it.updated_at ?? new Date().toISOString(),
        },
      });
      imported++;
    }
    return imported;
  } catch (e) {
    console.warn(`[events] EM unreachable: ${(e as Error).message}`);
    return 0;
  }
}

async function main() {
  console.log("=== Seeding ao.db from sidecars ===");
  console.log(`  WS: ${WS}`);
  console.log(`  EM: ${EM}`);
  console.log("");

  const r1 = await syncRuns();
  console.log(`✓ WorkflowRun: ${r1} rows`);

  const r2 = await syncHumanTasks();
  console.log(`✓ HumanTask: ${r2} rows`);

  const r3 = await syncEvents();
  console.log(`✓ EventDefinition: ${r3} rows`);

  console.log("");
  console.log("Done.");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
