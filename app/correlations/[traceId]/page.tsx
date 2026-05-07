"use client";
import React, { Suspense, use } from "react";
import { Shell } from "@/components/shared/Shell";
import { CorrelationContent } from "@/components/correlation/CorrelationContent";
import { useApp } from "@/lib/i18n";

export default function CorrelationPage({
  params,
}: {
  params: Promise<{ traceId: string }>;
}) {
  const { traceId } = use(params);
  const { t } = useApp();
  const decoded = decodeURIComponent(traceId);
  return (
    <Shell
      crumbs={[t("nav_group_operate"), "因果链", decoded.slice(0, 12) + "…"]}
      directionTag={`trace · ${decoded.slice(0, 16)}`}
    >
      <Suspense fallback={null}>
        <CorrelationContent traceId={decoded} />
      </Suspense>
    </Shell>
  );
}
