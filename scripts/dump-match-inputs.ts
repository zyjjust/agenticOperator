// Dump resume_text + jd_text exactly as matchResume hands them to
// RoboHire /match-resume. Uses the SAME flatten functions our agents
// use, so what's on disk = what RoboHire sees.
//
// Usage:
//   npx tsx scripts/dump-match-inputs.ts
//   (defaults to latest processResume run + first claimed RAAS requirement)

// Load env BEFORE the dynamic imports — internal-client reads env at
// module-load time, so we must inject env first.
import { config } from "dotenv";
config({ path: ".env.local" });

import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const OUT_DIR = "/tmp/ao-debug";

async function main() {
  // Dynamic imports so env vars from dotenv are present when these
  // modules' top-level `process.env.X` reads happen.
  const { prisma } = await import("../server/db");
  const { roboHireDataToResumeText } = await import("../server/llm/robohire");
  const { listAllRequirements, flattenRequirementForMatch } = await import(
    "../server/raas/internal-client"
  );

  mkdirSync(OUT_DIR, { recursive: true });

  // 1. Latest processResume agent_complete row → parsed.data
  const row = await prisma.agentActivity.findFirst({
    where: { agentName: "processResume", type: "agent_complete" },
    orderBy: { createdAt: "desc" },
  });
  if (!row?.metadata) throw new Error("no recent processResume agent_complete row found");
  const meta = JSON.parse(row.metadata) as { parsed?: Record<string, unknown> };
  if (!meta.parsed) throw new Error("metadata.parsed missing");

  const candidateName = (meta.parsed as any).name ?? "unknown";
  const resumeText = roboHireDataToResumeText(meta.parsed);

  // 2. Pull JDs from RAAS Internal API (claimer EMP-003).
  const jds = await listAllRequirements({
    claimerEmployeeId: "EMP-003",
    scope: "claimed",
    pageSize: 50,
  });
  if (jds.length === 0) throw new Error("RAAS returned 0 requirements for EMP-003");

  // Pick first one with non-empty content (matchable).
  const jd =
    jds.find(
      (r) =>
        !!(
          r.job_responsibility?.trim() ||
          r.job_requirement?.trim() ||
          (r.must_have_skills?.length ?? 0) > 0
        ),
    ) ?? jds[0];
  const jdText = flattenRequirementForMatch(jd);

  // 3. Write files.
  const resumePath = path.join(OUT_DIR, "resume.txt");
  const jdPath = path.join(OUT_DIR, "jd.txt");
  const metaPath = path.join(OUT_DIR, "context.json");

  writeFileSync(resumePath, resumeText);
  writeFileSync(jdPath, jdText);
  writeFileSync(
    metaPath,
    JSON.stringify(
      {
        candidate_name: candidateName,
        candidate_source: "latest processResume agent_complete row",
        candidate_activity_id: row.id,
        candidate_activity_created_at: row.createdAt.toISOString(),
        jd_job_requisition_id: jd.job_requisition_id,
        jd_title: jd.client_job_title,
        jd_source: "RAAS Internal API GET /api/v1/internal/requirements",
        resume_chars: resumeText.length,
        jd_chars: jdText.length,
      },
      null,
      2,
    ),
  );

  console.log(`✅ wrote files:`);
  console.log(`  ${resumePath}`);
  console.log(`    chars: ${resumeText.length}`);
  console.log(`    candidate: ${candidateName}`);
  console.log(`  ${jdPath}`);
  console.log(`    chars: ${jdText.length}`);
  console.log(`    jd: ${jd.client_job_title} (${jd.job_requisition_id})`);
  console.log(`  ${metaPath}`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("dump failed:", e);
  process.exit(1);
});
