"use client";
import React, { Suspense } from "react";
import { Shell } from "@/components/shared/Shell";
import { LiveContent } from "@/components/live/LiveContent";
import { useApp } from "@/lib/i18n";

export default function LivePage() {
  const { t } = useApp();
  return (
    <Shell crumbs={[t("nav_group_operate"), t("nav_runs")]} directionTag={t("dirC") + " · 一条 run 的检视台"}>
      <Suspense fallback={null}>
        <LiveContent />
      </Suspense>
    </Shell>
  );
}
