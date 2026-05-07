"use client";
import React, { Suspense } from "react";
import { Shell } from "@/components/shared/Shell";
import { EventsContent } from "@/components/events/EventsContent";
import { useApp } from "@/lib/i18n";

export default function EventsPage() {
  const { t } = useApp();
  return (
    <Shell crumbs={[t("nav_group_operate"), t("em_registry")]} directionTag={t("dirD") + " · 事件中枢"}>
      <Suspense fallback={null}>
        <EventsContent />
      </Suspense>
    </Shell>
  );
}
