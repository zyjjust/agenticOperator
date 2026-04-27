import "dotenv/config";
import path from "node:path";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: path.join("prisma", "schema.prisma"),
  migrations: {
    path: path.join("prisma", "migrations"),
  },
  // Direct connection from URL env var; works for both SQLite and Postgres.
  datasource: {
    url: process.env.DATABASE_URL ?? "file:./data/ao.db",
  },
});
