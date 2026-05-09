"use client";
import React, { Suspense } from "react";
import { Shell } from "@/components/shared/Shell";
import { OverviewContent } from "@/components/overview/OverviewContent";
import { useApp } from "@/lib/i18n";

export default function OverviewPage() {
  const { t } = useApp();
  return (
    <Shell crumbs={[t("nav_group_operate"), t("nav_overview")]} directionTag="系统视角 · 系统当下整体跑得怎样">
      <Suspense fallback={null}>
        <OverviewContent />
      </Suspense>
    </Shell>
  );
}
