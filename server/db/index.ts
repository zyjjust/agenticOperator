// Prisma client singleton (P3 foundation).
// Server-only. Imported by Route Handlers and server-side modules.
// Replaces server/clients/{ws,em}.ts in P3 final.
//
// In dev, Next.js hot-reloads can otherwise create multiple PrismaClient
// instances; the global cache prevents that.
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

declare global {

  var __prismaClient: PrismaClient | undefined;
}

function makeClient(): PrismaClient {
  const url = process.env.DATABASE_URL ?? "file:./data/ao.db";
  // Strip "file:" prefix for the SQLite driver
  const dbPath = url.replace(/^file:/, "");
  const adapter = new PrismaBetterSqlite3({ url: dbPath });
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

export const prisma: PrismaClient =
  globalThis.__prismaClient ?? makeClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__prismaClient = prisma;
}
