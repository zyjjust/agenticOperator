import { describe, it, expect } from "vitest";
import { prisma } from "./index";

// Smoke test: Prisma client instantiates against the SQLite file.
// Verifies all 21 P3 chunk-1 models are reachable through the client.
// Read-only — never writes; CRUD-level tests should live next to service modules.
describe("prisma client", () => {
  it("exposes all 21 chunk-1 models", () => {
    expect(prisma).toBeDefined();

    // WS workflow runtime (5)
    expect(typeof prisma.workflowRun.findMany).toBe("function");
    expect(typeof prisma.workflowStep.findMany).toBe("function");
    expect(typeof prisma.agentActivity.findMany).toBe("function");
    expect(typeof prisma.humanTask.findMany).toBe("function");
    expect(typeof prisma.chatbotSession.findMany).toBe("function");

    // WS Living KB (3)
    expect(typeof prisma.candidateLock.findMany).toBe("function");
    expect(typeof prisma.blacklist.findMany).toBe("function");
    expect(typeof prisma.agentEpisode.findMany).toBe("function");

    // WS AgentConfig (2)
    expect(typeof prisma.agentConfig.findMany).toBe("function");
    expect(typeof prisma.agentConfigHistory.findMany).toBe("function");

    // EM runtime / audit (3)
    expect(typeof prisma.auditLog.findMany).toBe("function");
    expect(typeof prisma.dLQEntry.findMany).toBe("function");
    expect(typeof prisma.dedupCache.findMany).toBe("function");

    // EM events / gateway (2)
    expect(typeof prisma.eventDefinition.findMany).toBe("function");
    expect(typeof prisma.gatewayFilterRule.findMany).toBe("function");

    // EM outbound + ingest (5)
    expect(typeof prisma.outboundEvent.findMany).toBe("function");
    expect(typeof prisma.raasMessage.findMany).toBe("function");
    expect(typeof prisma.rejectedMessage.findMany).toBe("function");
    expect(typeof prisma.ingestionConfig.findMany).toBe("function");
    expect(typeof prisma.executionTrace.findMany).toBe("function");

    // EM monitoring (1)
    expect(typeof prisma.healthIncident.findMany).toBe("function");
  });

  it("can read empty tables (CRUD smoke)", async () => {
    const runs = await prisma.workflowRun.findMany({ take: 1 });
    expect(Array.isArray(runs)).toBe(true);
    const eps = await prisma.agentEpisode.findMany({ take: 1 });
    expect(Array.isArray(eps)).toBe(true);
    const evs = await prisma.eventDefinition.findMany({ take: 1 });
    expect(Array.isArray(evs)).toBe(true);
  });
});
