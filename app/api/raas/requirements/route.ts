// /api/raas/requirements — proxy + connectivity test for the RAAS
// Internal API.
//
// GET /api/raas/requirements?employee_id=0000199059
//   → list requirements claimed by that employee
//
// GET /api/raas/requirements?employee_id=0000199059&job_requisition_id=JRQ-...
//   → return only the matching requirement (or 404)
//
// Bearer-auth happens server-side using RAAS_AGENT_API_KEY; the browser
// never sees the key. Used by /agent-demo to prefill match data.

import { NextResponse } from "next/server";
import {
  isRaasInternalApiConfigured,
  listRequirements,
  findRequirementById,
  RaasInternalApiError,
} from "@/server/raas/internal-client";

export async function GET(req: Request): Promise<Response> {
  if (!isRaasInternalApiConfigured()) {
    return NextResponse.json(
      {
        error: "NOT_CONFIGURED",
        message:
          "RAAS_INTERNAL_API_URL 或 RAAS_AGENT_API_KEY 没配置 (.env.local)",
      },
      { status: 503 },
    );
  }
  const url = new URL(req.url);
  const employeeId = url.searchParams.get("employee_id");
  const jobRequisitionId = url.searchParams.get("job_requisition_id");
  const scope = (url.searchParams.get("scope") ?? "claimed") as
    | "claimed"
    | "watched"
    | "mine";
  const status = url.searchParams.get("status") ?? undefined;
  const clientId = url.searchParams.get("client_id") ?? undefined;
  const page = Number(url.searchParams.get("page") ?? 1);
  const pageSize = Number(url.searchParams.get("page_size") ?? 20);

  if (!employeeId) {
    return NextResponse.json(
      {
        error: "BAD_REQUEST",
        message: "employee_id 必填 (query param)",
      },
      { status: 400 },
    );
  }

  try {
    if (jobRequisitionId) {
      const hit = await findRequirementById({
        jobRequisitionId,
        claimerEmployeeId: employeeId,
        scope,
        status,
        clientId,
      });
      if (!hit) {
        return NextResponse.json(
          {
            error: "NOT_FOUND",
            message: `RAAS 那边 employee_id=${employeeId} 的 ${scope} 范围内没找到 job_requisition_id=${jobRequisitionId}`,
          },
          { status: 404 },
        );
      }
      return NextResponse.json(hit);
    }
    const list = await listRequirements({
      claimerEmployeeId: employeeId,
      scope,
      status,
      clientId,
      page,
      pageSize,
    });
    return NextResponse.json(list);
  } catch (e) {
    if (e instanceof RaasInternalApiError) {
      return NextResponse.json(
        {
          error: "RAAS_API",
          status: e.status,
          message: e.message,
          hint: e.hint,
        },
        { status: e.status >= 100 && e.status < 600 ? e.status : 502 },
      );
    }
    return NextResponse.json(
      { error: "INTERNAL", message: (e as Error).message },
      { status: 500 },
    );
  }
}
