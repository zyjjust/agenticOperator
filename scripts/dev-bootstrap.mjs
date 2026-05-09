#!/usr/bin/env node
// Idempotent first-run setup for `npm run dev`.
//
// Goal: a fresh `git clone` + `npm install` + `npm run dev` boots the app,
// regardless of what's missing on the partner's machine.
//
// Steps (each one is no-op when already satisfied):
//   1. Create `.env.local` from `.env.example` if missing.
//   2. Create `data/ao.db` SQLite via `prisma db push` if missing.
//   3. Best-effort start the Inngest dev container — but if Docker isn't
//      reachable, warn and continue so `next dev` still launches. The UI
//      loads fine without Inngest; only event-driven flows are inert.

import { existsSync, copyFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const log = (m) => console.log(`[bootstrap] ${m}`);
const warn = (m) => console.warn(`[bootstrap] ⚠ ${m}`);

// 1. .env.local
const envLocal = resolve(ROOT, ".env.local");
const envExample = resolve(ROOT, ".env.example");
if (!existsSync(envLocal)) {
  if (existsSync(envExample)) {
    copyFileSync(envExample, envLocal);
    log("created .env.local from .env.example — fill in API keys as needed");
  } else {
    warn(".env.example missing; cannot scaffold .env.local");
  }
}

// 2. SQLite db
const dataDir = resolve(ROOT, "data");
const dbFile = resolve(dataDir, "ao.db");
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
if (!existsSync(dbFile)) {
  log("creating data/ao.db via `prisma db push`…");
  try {
    execSync("npx prisma db push --accept-data-loss", {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env, DATABASE_URL: "file:./data/ao.db" },
    });
  } catch (e) {
    warn(`prisma db push failed: ${e.message}`);
    warn("app will boot but DB-backed routes will throw until this is fixed");
  }
}

// 3. Inngest container (soft-fail)
try {
  execSync("docker info", { cwd: ROOT, stdio: "ignore" });
} catch {
  warn("Docker daemon unreachable — skipping Inngest container");
  warn("UI will load; event stream / agent runs will be inert until you start Docker + run `npm run inngest:up`");
  log("ready");
  process.exit(0);
}
try {
  execSync("docker compose -f docker-compose.inngest.yml up -d", {
    cwd: ROOT,
    stdio: "inherit",
  });
} catch (e) {
  warn(`docker compose up failed: ${e.message}`);
  warn("continuing without Inngest container");
}

log("ready");
