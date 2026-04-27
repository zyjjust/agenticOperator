// /api/raas-bridge/status — observability for the RAAS event bridge.
// Used by the demo UI to show whether bridging is healthy.

import { NextResponse } from "next/server";
import { getRaasBridgeStatus } from "@/server/inngest/raas-bridge";

export async function GET(): Promise<Response> {
  return NextResponse.json(getRaasBridgeStatus());
}
