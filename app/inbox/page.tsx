"use client";
import React from "react";
import { Shell } from "@/components/shared/Shell";
import { InboxContent } from "@/components/inbox/InboxContent";
import { useApp } from "@/lib/i18n";

export default function InboxPage() {
  const { t } = useApp();
  return (
    <Shell crumbs={[t("nav_group_operate"), t("nav_inbox")]} directionTag={t("nav_inbox")}>
      <InboxContent />
    </Shell>
  );
}
