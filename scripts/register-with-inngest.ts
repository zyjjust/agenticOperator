// Register the AO /api/inngest endpoint with the shared Inngest dev server
// so RAAS-emitted events flow back into THIS AO instance.
//
// Usage:
//   npx tsx scripts/register-with-inngest.ts
//   # or:
//   npm run register
//
// What it does:
//   POST http://10.100.0.70:8288/fn/register
//   { "url": "http://172.16.1.83:3002/api/inngest" }
//
// Reads INNGEST_BASE_URL + AO_LAN_IP + AO_PORT from .env.local.
// Re-run any time after the AO dev server restarts (registration is in-memory).

// dotenv only auto-loads .env, not .env.local. Load explicitly.
import { config } from "dotenv";
import path from "node:path";
config({ path: path.resolve(process.cwd(), ".env.local") });
config({ path: path.resolve(process.cwd(), ".env") });

async function main(): Promise<void> {
  const base = process.env.INNGEST_BASE_URL ?? "http://10.100.0.70:8288";
  const lanIp = process.env.AO_LAN_IP ?? "127.0.0.1";
  const port = process.env.AO_PORT ?? "3002";
  const callback = `http://${lanIp}:${port}/api/inngest`;
  const registerUrl = `${base}/fn/register`;

  console.log(`Registering AO callback with Inngest:`);
  console.log(`  Inngest server: ${base}`);
  console.log(`  AO callback:    ${callback}`);
  console.log("");

  // First sanity-check that the callback is reachable from THIS host.
  // (If localhost can't hit it, neither can 10.100.0.70.)
  try {
    const ping = await fetch(`http://localhost:${port}/api/inngest`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (!ping.ok) {
      console.warn(`⚠ Local PUT /api/inngest returned ${ping.status}; AO may not be running yet`);
    } else {
      console.log("✓ AO /api/inngest reachable from localhost");
    }
  } catch (e) {
    console.error(`✗ AO is not running on port ${port}: ${(e as Error).message}`);
    process.exit(1);
  }

  // Then ask the shared Inngest server to register us.
  try {
    const res = await fetch(registerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: callback }),
    });
    const text = await res.text();
    if (!res.ok) {
      console.error(`✗ Register failed (${res.status}): ${text}`);
      process.exit(1);
    }
    console.log(`✓ Registered:`);
    try {
      console.log(JSON.stringify(JSON.parse(text), null, 2));
    } catch {
      console.log(text);
    }
    console.log("");
    console.log(`Next: send a RESUME_DOWNLOADED event from RAAS or trigger locally:`);
    console.log(`  curl -X POST http://localhost:${port}/api/test/trigger-resume-uploaded`);
  } catch (e) {
    console.error(`✗ Couldn't reach ${registerUrl}: ${(e as Error).message}`);
    process.exit(1);
  }
}

main();
