"use client";
import React, { use } from "react";
import { Shell } from "@/components/shared/Shell";
import { EntityJourneyContent } from "@/components/entity/EntityJourneyContent";
import { isEntityType, ENTITY_LABELS } from "@/lib/entity-types";
import { useApp } from "@/lib/i18n";

type PageProps = {
  params: Promise<{ type: string; id: string }>;
};

export default function EntityPage({ params }: PageProps) {
  const { type, id } = use(params);
  const { t } = useApp();
  const validType = isEntityType(type);
  const label = validType ? ENTITY_LABELS[type] : type;
  return (
    <Shell
      crumbs={[t("nav_group_operate"), "实体历程", `${label} · ${id}`]}
      directionTag="实体追溯 · entity journey"
    >
      {validType ? (
        <EntityJourneyContent type={type} id={id} />
      ) : (
        <div className="flex-1 flex items-center justify-center text-ink-3 text-sm">
          未知实体类型 <code className="mx-1">{type}</code> · 仅支持 JobRequisition / JobPosting / Candidate
        </div>
      )}
    </Shell>
  );
}
