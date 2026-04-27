"use client";
import React from "react";
import { Shell } from "@/components/shared/Shell";
import { TriggersContent } from "@/components/triggers/TriggersContent";
import { useApp } from "@/lib/i18n";

export default function TriggersPage() {
  const { t } = useApp();
  return (
    <Shell crumbs={[t("nav_group_build"), t("nav_triggers_p2")]} directionTag={t("triggers_title")}>
      <TriggersContent />
    </Shell>
  );
}
