"use client";
import React, { Suspense } from "react";
import { Shell } from "@/components/shared/Shell";
import { AuditContent } from "@/components/audit/AuditContent";
import { useApp } from "@/lib/i18n";

export default function AuditPage() {
  const { t } = useApp();
  return (
    <Shell crumbs={[t("nav_group_govern"), t("nav_audit")]} directionTag={t("nav_audit")}>
      <Suspense fallback={null}>
        <AuditContent />
      </Suspense>
    </Shell>
  );
}
