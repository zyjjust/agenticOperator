"use client";
import React from "react";
import clsx from "clsx";
import { useRouter } from "next/navigation";
import { Ic } from "./Ic";
import { useApp } from "@/lib/i18n";
import { AGENT_MAP } from "@/lib/agent-mapping";
import { fetchJson } from "@/lib/api/client";
import type {
  RunsResponse,
  HumanTasksResponse,
  EventsResponse,
} from "@/lib/api/types";

type ResultKind = "agent" | "run" | "task" | "event";
type Result = {
  kind: ResultKind;
  id: string;
  label: string;
  meta?: string;
  href: string;
};

const PREFIX_TO_KIND: Record<string, ResultKind> = {
  "@": "agent",
  "#": "run",
  "!": "task",
  ":": "event",
};

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useApp();
  const router = useRouter();
  const [q, setQ] = React.useState("");
  const [results, setResults] = React.useState<Result[]>([]);
  const [activeIdx, setActiveIdx] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 10);
  }, [open]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!open) return;
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => Math.min(i + 1, results.length - 1));
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => Math.max(0, i - 1));
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const r = results[activeIdx];
        if (r) {
          router.push(r.href);
          onClose();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, results, activeIdx, router]);

  // Debounced resource search
  React.useEffect(() => {
    if (!open) return;
    const trimmed = q.trim();
    const handle = setTimeout(() => {
      runSearch(trimmed).then((r) => {
        setResults(r);
        setActiveIdx(0);
      });
    }, 250);
    return () => clearTimeout(handle);
  }, [q, open]);

  if (!open) return null;

  const grouped = groupByKind(results);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-start justify-center pt-[72px]"
      style={{ background: "rgba(15,23,42,0.20)", backdropFilter: "blur(4px)" }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-[min(560px,90%)] bg-surface border border-line rounded-lg shadow-sh-3 overflow-hidden">
        <div className="flex items-center gap-2.5 px-4 py-3.5 border-b border-line">
          <Ic.search />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("cmd_hint_search")}
            className="flex-1 border-0 outline-0 bg-transparent text-[14px] text-ink-1 placeholder:text-ink-4"
          />
          <kbd className="mono text-[10px] bg-panel border border-line rounded-sm px-1.5 py-[1px] text-ink-3">esc</kbd>
        </div>
        <div className="max-h-[340px] overflow-auto p-1.5">
          {results.length === 0 && q && (
            <div className="text-[12px] text-ink-3 px-3 py-4">无匹配 · No matches</div>
          )}
          {results.length === 0 && !q && <PrefixHints />}
          {(["agent", "run", "task", "event"] as ResultKind[]).map((kind) => {
            const items = grouped[kind] ?? [];
            if (items.length === 0) return null;
            return (
              <div key={kind}>
                <div className="text-[10.5px] tracking-[0.06em] uppercase text-ink-4 px-2.5 pt-2.5 pb-1.5">
                  {t(`cmd_group_${kind}s`)}
                </div>
                {items.map((it) => {
                  const idx = results.indexOf(it);
                  const active = idx === activeIdx;
                  return (
                    <div
                      key={`${kind}-${it.id}`}
                      onMouseEnter={() => setActiveIdx(idx)}
                      onClick={() => {
                        router.push(it.href);
                        onClose();
                      }}
                      className={clsx(
                        "flex items-center gap-2.5 px-2.5 py-2 rounded-md cursor-pointer text-[13px]",
                        active
                          ? "bg-accent-bg text-[color:var(--c-accent)]"
                          : "hover:bg-accent-bg hover:text-[color:var(--c-accent)]"
                      )}
                    >
                      <span className="w-[22px] h-[22px] grid place-items-center rounded-sm bg-panel border border-line text-ink-2">
                        <KindIcon kind={kind} />
                      </span>
                      <span>{it.label}</span>
                      {it.meta && <span className="ml-auto mono text-[10.5px] text-ink-4">{it.meta}</span>}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-3 px-3.5 py-2 border-t border-line bg-panel text-[11px] text-ink-3">
          <span>
            <kbd className="mono text-[10px] bg-surface border border-line rounded-sm px-1.5 py-[1px] text-ink-3">↑↓</kbd> {t("cmd_jump")}
          </span>
          <span>
            <kbd className="mono text-[10px] bg-surface border border-line rounded-sm px-1.5 py-[1px] text-ink-3">↵</kbd> {t("cmd_actions")}
          </span>
          <span className="ml-auto">{t("brand")}</span>
        </div>
      </div>
    </div>
  );
}

function PrefixHints() {
  return (
    <div className="text-[11.5px] text-ink-3 px-3 py-3">
      <div className="mb-1">前缀过滤 · Prefix filters:</div>
      <div className="grid grid-cols-2 gap-1 mono">
        <span><kbd className="mono text-[10px] bg-panel border border-line rounded-sm px-1 py-[1px]">@</kbd> agent</span>
        <span><kbd className="mono text-[10px] bg-panel border border-line rounded-sm px-1 py-[1px]">#</kbd> run</span>
        <span><kbd className="mono text-[10px] bg-panel border border-line rounded-sm px-1 py-[1px]">!</kbd> task</span>
        <span><kbd className="mono text-[10px] bg-panel border border-line rounded-sm px-1 py-[1px]">:</kbd> event</span>
      </div>
    </div>
  );
}

function KindIcon({ kind }: { kind: ResultKind }) {
  if (kind === "agent") return <Ic.cpu />;
  if (kind === "run") return <Ic.play />;
  if (kind === "task") return <Ic.user />;
  return <Ic.bolt />;
}

function groupByKind(results: Result[]): Partial<Record<ResultKind, Result[]>> {
  const out: Partial<Record<ResultKind, Result[]>> = {};
  for (const r of results) (out[r.kind] ||= []).push(r);
  return out;
}

async function runSearch(query: string): Promise<Result[]> {
  if (!query) return [];
  const prefix = query[0];
  const kindFilter = PREFIX_TO_KIND[prefix];
  const term = kindFilter ? query.slice(1).trim() : query;
  if (!term) return [];

  const want = (k: ResultKind) => !kindFilter || kindFilter === k;
  const tasks: Promise<Result[]>[] = [];
  if (want("agent")) tasks.push(searchAgents(term));
  if (want("run")) tasks.push(searchRuns(term));
  if (want("task")) tasks.push(searchTasks(term));
  if (want("event")) tasks.push(searchEvents(term));

  const settled = await Promise.allSettled(tasks);
  const all: Result[] = [];
  for (const s of settled) {
    if (s.status === "fulfilled") all.push(...s.value);
  }
  return all.slice(0, 20);
}

function searchAgents(term: string): Promise<Result[]> {
  const q = term.toLowerCase();
  const matches = AGENT_MAP.filter(
    (a) =>
      a.short.toLowerCase().includes(q) ||
      a.stage.includes(q) ||
      a.wsId.includes(q),
  ).slice(0, 5);
  return Promise.resolve(
    matches.map((a) => ({
      kind: "agent" as const,
      id: a.short,
      label: a.short,
      meta: `${a.stage} · ${a.kind}`,
      href: `/fleet`,
    })),
  );
}

async function searchRuns(term: string): Promise<Result[]> {
  try {
    const r = await fetchJson<RunsResponse>(`/api/runs?limit=10`);
    const q = term.toLowerCase();
    return r.runs
      .filter(
        (run) =>
          run.id.toLowerCase().includes(q) ||
          run.triggerEvent.toLowerCase().includes(q),
      )
      .slice(0, 5)
      .map((run) => ({
        kind: "run" as const,
        id: run.id,
        label: run.id,
        meta: `${run.triggerEvent} · ${run.status}`,
        href: `/live`,
      }));
  } catch {
    return [];
  }
}

async function searchTasks(term: string): Promise<Result[]> {
  try {
    const r = await fetchJson<HumanTasksResponse>(`/api/human-tasks`);
    const q = term.toLowerCase();
    return r.recent
      .filter(
        (c) =>
          c.title.toLowerCase().includes(q) ||
          c.id.toLowerCase().includes(q) ||
          c.agentShort.toLowerCase().includes(q),
      )
      .slice(0, 5)
      .map((c) => ({
        kind: "task" as const,
        id: c.id,
        label: c.title,
        meta: c.agentShort,
        href: `/inbox`,
      }));
  } catch {
    return [];
  }
}

async function searchEvents(term: string): Promise<Result[]> {
  try {
    const r = await fetchJson<EventsResponse>(`/api/events?q=${encodeURIComponent(term)}`);
    return r.events.slice(0, 5).map((e) => ({
      kind: "event" as const,
      id: e.name,
      label: e.name,
      meta: `${e.stage} · ${e.kind}`,
      href: `/events`,
    }));
  } catch {
    return [];
  }
}
