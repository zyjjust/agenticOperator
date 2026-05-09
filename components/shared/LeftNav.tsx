"use client";
import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import { Ic, IcName } from "./Ic";
import { useApp } from "@/lib/i18n";
import { fetchJson } from "@/lib/api/client";
import type { HumanTasksResponse } from "@/lib/api/types";

type NavItem =
  | { type: "group"; title: string }
  | { type: "item"; id: string; icon: IcName; label: string; count?: string; href: string };

export function LeftNav() {
  const { t } = useApp();
  const pathname = usePathname();
  const [inboxCount, setInboxCount] = React.useState<string>("—");

  React.useEffect(() => {
    const tick = () => {
      fetchJson<HumanTasksResponse>("/api/human-tasks")
        .then((r) => setInboxCount(r.total > 0 ? String(r.total) : ""))
        .catch(() => {/* keep "—" */});
    };
    tick();
    const id = setInterval(tick, 10_000);
    return () => clearInterval(id);
  }, []);

  // IA reorg (UX review feedback):
  //   - Events / Triggers move from "Build" to "Operate" — they're observability
  //     surfaces over the runtime, not authoring tools.
  //   - "Build" reduced to Workflow editor + Sample Agent (the only real
  //     authoring surfaces today).
  //   - "Govern" gets Data Sources + Permissions + Audit + Compliance.
  //     Audit is now real (`/audit` page wired to AuditLog table); the others
  //     remain `#` until backend lands but stay in the nav as roadmap signals.
  const items: NavItem[] = [
    { type: "group", title: t("nav_group_operate") },
    { type: "item", id: "overview",   icon: "grid",     label: t("nav_overview"), href: "/overview" },
    { type: "item", id: "fleet",      icon: "cpu",      label: t("nav_fleet"), count: "22", href: "/fleet" },
    { type: "item", id: "runs",       icon: "play",     label: t("nav_runs"),  count: "—", href: "/live" },
    { type: "item", id: "inbox",      icon: "user",     label: t("nav_inbox"), count: inboxCount, href: "/inbox" },
    { type: "item", id: "events",     icon: "bolt",     label: t("nav_events"), href: "/events" },
    { type: "item", id: "triggers",   icon: "clock",    label: t("nav_triggers"), href: "/triggers" },
    { type: "item", id: "correlations", icon: "branch", label: "因果链", href: "/correlations" },
    { type: "item", id: "alerts",     icon: "alert",    label: t("nav_alerts"),count: "—", href: "/alerts" },
    { type: "group", title: t("nav_group_build") },
    { type: "item", id: "workflows",  icon: "workflow", label: t("nav_workflows"), count: "1", href: "/workflow" },
    { type: "item", id: "agent-demo", icon: "sparkle",  label: "Sample Agent", href: "/agent-demo" },
    { type: "group", title: t("nav_group_govern") },
    { type: "item", id: "integrations", icon: "plug",   label: t("nav_integrations"), href: "/datasources" },
    { type: "item", id: "audit",      icon: "book",     label: t("nav_audit"), href: "/audit" },
    { type: "item", id: "permissions",icon: "key",      label: t("nav_permissions"), href: "#" },
    { type: "item", id: "compliance", icon: "shield",   label: t("nav_compliance"), href: "#" },
  ];

  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    return pathname === href || pathname.startsWith(href + "/");
  };

  return (
    <nav
      className="w-[184px] flex-none border-r border-line bg-surface flex flex-col gap-[2px] text-[12.5px]"
      style={{ padding: "10px 8px" }}
    >
      {items.map((it, i) => {
        if (it.type === "group") {
          return (
            <div
              key={i}
              className="text-[10.5px] tracking-[0.06em] uppercase text-ink-4 font-semibold"
              style={{ padding: "10px 8px 4px" }}
            >
              {it.title}
            </div>
          );
        }
        const Icon = Ic[it.icon];
        const active = isActive(it.href);
        return (
          <Link
            key={it.id}
            href={it.href}
            className={clsx(
              "flex items-center gap-[9px] px-2 py-[6px] rounded-md cursor-pointer no-underline",
              active ? "bg-accent-bg text-[color:var(--c-accent)] font-medium" : "text-ink-2 hover:bg-panel hover:text-ink-1"
            )}
          >
            <span className="w-[14px] inline-flex"><Icon /></span>
            <span>{it.label}</span>
            {it.count && (
              <span
                className={clsx(
                  "ml-auto mono text-[10.5px]",
                  active ? "text-[color:var(--c-accent)]" : "text-ink-4"
                )}
              >
                {it.count}
              </span>
            )}
          </Link>
        );
      })}
      <div className="flex-1" />
      <div className="flex items-center gap-[9px] px-2 py-[6px] rounded-md cursor-pointer text-ink-2 hover:bg-panel hover:text-ink-1">
        <Ic.gear />
        <span>{t("nav_settings")}</span>
      </div>
    </nav>
  );
}
