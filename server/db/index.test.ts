import { describe, it, expect } from "vitest";
import { prisma } from "./index";

// Smoke test: Prisma client instantiates against the SQLite file.
// Run order doesn't matter; we don't write data here.
describe("prisma client", () => {
  it("instantiates and exposes WorkflowRun model", () => {
    expect(prisma).toBeDefined();
    expect(typeof prisma.workflowRun.findMany).toBe("function");
    expect(typeof prisma.humanTask.findMany).toBe("function");
    expect(typeof prisma.auditLog.findMany).toBe("function");
  });
});
