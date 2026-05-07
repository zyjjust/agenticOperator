"use client";
import React from "react";
import { useRouter } from "next/navigation";
import { Shell } from "@/components/shared/Shell";
import { Btn, EmptyState } from "@/components/shared/atoms";
import { Ic } from "@/components/shared/Ic";
import { useApp } from "@/lib/i18n";

export default function CorrelationsLandingPage() {
  const { t } = useApp();
  const router = useRouter();
  const [id, setId] = React.useState("");

  return (
    <Shell crumbs={[t("nav_group_operate"), "因果链"]} directionTag="跨系统时间线">
      <div className="flex-1 flex items-center justify-center">
        <EmptyState
          icon={<Ic.search />}
          title="跨系统时间线"
          hint="按 trace_id / external_event_id / WorkflowRun id / EventInstance id 串起 AuditLog · EventInstance · WorkflowRun · HumanTask 的完整流转记录。"
          action={
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (id.trim()) router.push(`/correlations/${encodeURIComponent(id.trim())}`);
              }}
              className="flex items-center gap-2"
            >
              <input
                value={id}
                onChange={(e) => setId(e.target.value)}
                placeholder="trace_id / event_id / run_id"
                autoFocus
                className="h-7 border border-line bg-panel rounded-sm mono text-[11.5px] text-ink-1 outline-none w-[280px]"
                style={{ padding: "0 8px" }}
              />
              <Btn size="sm" type="submit">查询</Btn>
            </form>
          }
        />
      </div>
    </Shell>
  );
}
