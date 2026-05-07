"use client";
import React, { Suspense, use } from "react";
import { Shell } from "@/components/shared/Shell";
import { InstanceTrailContent } from "@/components/events/InstanceTrailContent";
import { useApp } from "@/lib/i18n";

export default function InstanceTrailPage({
  params,
}: {
  params: Promise<{ name: string; id: string }>;
}) {
  const { name, id } = use(params);
  const { t } = useApp();
  return (
    <Shell
      crumbs={[t("nav_group_operate"), t("nav_events"), name, id.slice(0, 8) + "…"]}
      directionTag={`实例 trail · ${name}`}
    >
      <Suspense fallback={null}>
        <InstanceTrailContent
          eventName={decodeURIComponent(name)}
          instanceId={decodeURIComponent(id)}
        />
      </Suspense>
    </Shell>
  );
}
