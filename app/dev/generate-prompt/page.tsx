"use client";

/**
 * /dev/generate-prompt — preview the v4 canonical `generatePrompt` flow for matchResume.
 *
 * Two modes:
 *   - Snapshot (default): client-side `fillRuntimeInput` against the
 *     `generated/v4/match-resume.action-object.ts` static import. Live preview
 *     updates as you edit the form — no network.
 *   - Live: server action calls `generatePrompt` against the Ontology API,
 *     useful to verify the prompt reflects the latest upstream rules.
 *
 * Dev-only, URL-only (not in LeftNav). Same Next dev server on port 3002 —
 * no port conflict, different route from /dev/action-preview.
 */

import { useMemo, useState, useTransition } from "react";

import { matchResumeActionObject } from "@/generated/v4/match-resume.action-object";
import { fillRuntimeInput } from "@/lib/ontology-gen/v4";
import type {
  MatchResumeRuntimeInput,
  RuntimeJob,
  RuntimeResume,
} from "@/lib/ontology-gen/v4";

import { runLive, type RunLiveResult } from "./actions";

type Mode = "snapshot" | "live";

const DEFAULT_CLIENT_NAME = "腾讯";
const DEFAULT_CLIENT_DEPT = "互动娱乐事业群";

const DEFAULT_JOB: RuntimeJob = {
  job_requisition_id: "JR-2026-001",
  title: "高级后端工程师",
  client: "腾讯",
  department: "互动娱乐事业群",
  required_skills: ["Java", "Spring Boot", "MySQL"],
  preferred_skills: ["Kafka", "Redis"],
  min_years_experience: 5,
  education: "本科及以上",
  age_max: 40,
};

const DEFAULT_RESUME: RuntimeResume = {
  candidate_id: "C-12345",
  name: "Alice",
  date_of_birth: "1990-03-15",
  gender: "女",
  highest_education: {
    school: "复旦大学",
    degree: "本科",
    major: "计算机科学与技术",
    graduation_year: 2012,
    is_full_time: true,
  },
  work_experience: [
    {
      company: "字节跳动",
      title: "后端工程师",
      start_date: "2022-01",
      end_date: "2025-12",
      responsibilities: "负责广告投放系统服务端开发，主导亿级 QPS 接口的性能优化。",
    },
  ],
  skill_tags: ["Java", "Spring Boot", "MySQL", "Redis", "Kafka"],
  conflict_of_interest_declaration: "无亲属在腾讯任职。",
};

export default function GeneratePromptPage() {
  const [mode, setMode] = useState<Mode>("snapshot");
  const [clientName, setClientName] = useState(DEFAULT_CLIENT_NAME);
  const [clientDept, setClientDept] = useState(DEFAULT_CLIENT_DEPT);
  const [jobJson, setJobJson] = useState(() => JSON.stringify(DEFAULT_JOB, null, 2));
  const [resumeJson, setResumeJson] = useState(() => JSON.stringify(DEFAULT_RESUME, null, 2));

  // Live mode extra controls
  const [actionRef, setActionRef] = useState("matchResume");
  const [domain, setDomain] = useState("RAAS-v1");
  const [filterClient, setFilterClient] = useState("");

  const [isPending, startTransition] = useTransition();
  const [liveResult, setLiveResult] = useState<RunLiveResult | null>(null);

  // Parse the JSON inputs eagerly so the snapshot preview can update live.
  const { input, parseError } = useMemo(() => {
    try {
      const job = JSON.parse(jobJson) as RuntimeJob;
      const resume = JSON.parse(resumeJson) as RuntimeResume;
      const built: MatchResumeRuntimeInput = {
        kind: "matchResume",
        client: {
          name: clientName,
          ...(clientDept ? { department: clientDept } : {}),
        },
        job,
        resume,
      };
      return { input: built, parseError: null as string | null };
    } catch (e) {
      return { input: null, parseError: e instanceof Error ? e.message : String(e) };
    }
  }, [clientName, clientDept, jobJson, resumeJson]);

  // Snapshot-mode preview: fillRuntimeInput is sync + pure — recompute live.
  const snapshotResult = useMemo(() => {
    if (mode !== "snapshot" || !input) return null;
    try {
      const obj = fillRuntimeInput(matchResumeActionObject, input);
      return { ok: true as const, prompt: obj.prompt, meta: obj.meta };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  }, [mode, input]);

  // Live mode is on-demand: only fires when the user clicks "Run live".
  function handleRunLive() {
    if (!input) return;
    startTransition(async () => {
      const res = await runLive({
        actionRef,
        domain,
        client: filterClient || undefined,
        runtimeInput: input,
      });
      setLiveResult(res);
    });
  }

  const activeResult = mode === "snapshot" ? snapshotResult : liveResult;

  return (
    <main className="min-h-screen bg-bg p-6 font-sans text-ink-1">
      <header className="mb-4">
        <h1 className="text-lg font-semibold text-ink-1">
          Generate Prompt <span className="ml-2 text-xs font-normal text-ink-3">— v4 matchResume preview</span>
        </h1>
        <p className="mt-1 text-xs text-ink-3">
          Edit the client / job / resume inputs on the left; the substituted prompt updates live on the right (snapshot mode).
          Switch to live mode to fetch the prompt fresh from the Ontology API. Token stays server-side.
        </p>
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ── Left: form ── */}
        <section className="flex flex-col gap-3">
          <ModeToggle mode={mode} setMode={setMode} />

          {mode === "live" ? (
            <LiveControls
              actionRef={actionRef}
              setActionRef={setActionRef}
              domain={domain}
              setDomain={setDomain}
              filterClient={filterClient}
              setFilterClient={setFilterClient}
              isPending={isPending}
              onRun={handleRunLive}
              canRun={!!input}
            />
          ) : null}

          <Panel title="Client">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Field label="name (required)">
                <input
                  value={clientName}
                  onChange={(e) => setClientName(e.target.value)}
                  className="w-full rounded border border-line bg-bg px-2 py-1 text-sm focus:border-accent focus:outline-none"
                  placeholder="腾讯"
                />
              </Field>
              <Field label="department (optional)">
                <input
                  value={clientDept}
                  onChange={(e) => setClientDept(e.target.value)}
                  className="w-full rounded border border-line bg-bg px-2 py-1 text-sm focus:border-accent focus:outline-none"
                  placeholder="互动娱乐事业群"
                />
              </Field>
            </div>
          </Panel>

          <Panel title="Job (Job_Requisition JSON)">
            <JsonTextarea value={jobJson} onChange={setJobJson} rows={14} />
          </Panel>

          <Panel title="Resume JSON">
            <JsonTextarea value={resumeJson} onChange={setResumeJson} rows={20} />
          </Panel>

          {parseError ? (
            <div className="rounded-lg border border-err bg-err-bg p-3 text-xs">
              <div className="font-semibold text-err">JSON parse error</div>
              <div className="mt-1 font-mono text-ink-1">{parseError}</div>
            </div>
          ) : null}
        </section>

        {/* ── Right: preview ── */}
        <section className="flex flex-col gap-3">
          <ResultMeta result={activeResult} mode={mode} />
          <Panel title="Filled prompt (markdown)">
            <PromptPre result={activeResult} parseError={parseError} mode={mode} />
          </Panel>
          {activeResult && !activeResult.ok ? (
            <div className="rounded-lg border border-err bg-err-bg p-3 text-xs">
              <div className="font-semibold text-err">Error</div>
              <div className="mt-1 font-mono text-ink-1">
                {"error" in activeResult ? activeResult.error : String(activeResult)}
              </div>
              {"details" in activeResult && activeResult.details ? (
                <pre className="mt-2 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-ink-2">
                  {JSON.stringify(activeResult.details, null, 2)}
                </pre>
              ) : null}
            </div>
          ) : null}
        </section>
      </div>
    </main>
  );
}

// ─── sub-components ───

function ModeToggle({ mode, setMode }: { mode: Mode; setMode: (m: Mode) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2 text-xs text-ink-3">
      <span className="font-semibold uppercase tracking-wide">Mode</span>
      <label className="flex items-center gap-1">
        <input
          type="radio"
          checked={mode === "snapshot"}
          onChange={() => setMode("snapshot")}
          className="h-3 w-3"
        />
        <span>Snapshot + fillRuntimeInput (instant, no fetch)</span>
      </label>
      <label className="flex items-center gap-1">
        <input
          type="radio"
          checked={mode === "live"}
          onChange={() => setMode("live")}
          className="h-3 w-3"
        />
        <span>Live generatePrompt (fetch ontology API)</span>
      </label>
    </div>
  );
}

function LiveControls({
  actionRef,
  setActionRef,
  domain,
  setDomain,
  filterClient,
  setFilterClient,
  isPending,
  onRun,
  canRun,
}: {
  actionRef: string;
  setActionRef: (v: string) => void;
  domain: string;
  setDomain: (v: string) => void;
  filterClient: string;
  setFilterClient: (v: string) => void;
  isPending: boolean;
  onRun: () => void;
  canRun: boolean;
}) {
  return (
    <Panel title="Live fetch params">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Field label="actionRef">
          <input
            value={actionRef}
            onChange={(e) => setActionRef(e.target.value)}
            className="w-full rounded border border-line bg-bg px-2 py-1 text-sm focus:border-accent focus:outline-none"
            placeholder="matchResume"
          />
        </Field>
        <Field label="domain">
          <input
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            className="w-full rounded border border-line bg-bg px-2 py-1 text-sm focus:border-accent focus:outline-none"
            placeholder="RAAS-v1"
          />
        </Field>
        <Field label="client (rule-filter, optional)">
          <input
            value={filterClient}
            onChange={(e) => setFilterClient(e.target.value)}
            className="w-full rounded border border-line bg-bg px-2 py-1 text-sm focus:border-accent focus:outline-none"
            placeholder="(any)"
          />
        </Field>
      </div>
      <div className="mt-3">
        <button
          type="button"
          onClick={onRun}
          disabled={isPending || !canRun}
          className="rounded bg-accent px-4 py-1.5 text-sm font-medium text-white hover:bg-accent-2 disabled:opacity-50"
        >
          {isPending ? "Fetching…" : "Run live"}
        </button>
      </div>
    </Panel>
  );
}

function JsonTextarea({
  value,
  onChange,
  rows,
}: {
  value: string;
  onChange: (v: string) => void;
  rows: number;
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={rows}
      spellCheck={false}
      className="w-full resize-y rounded border border-line bg-bg px-2 py-1 font-mono text-xs leading-relaxed text-ink-1 focus:border-accent focus:outline-none"
    />
  );
}

function ResultMeta({
  result,
  mode,
}: {
  result:
    | { ok: true; meta: { actionId: string; actionName: string; domain: string; client?: string; compiledAt: string; templateVersion: string; promptStrategy: string } }
    | { ok: false; error: string; details?: unknown }
    | null;
  mode: Mode;
}) {
  if (!result) {
    return (
      <div className="rounded-lg border border-line bg-surface px-3 py-2 text-xs text-ink-3">
        {mode === "live"
          ? "Click \"Run live\" to fetch the prompt from the Ontology API."
          : "Snapshot mode — preview updates as you edit."}
      </div>
    );
  }
  if (!result.ok) {
    return (
      <div className="rounded-lg border border-err bg-err-bg px-3 py-2 text-xs text-err">
        Result: error (see panel below)
      </div>
    );
  }
  const m = result.meta;
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 rounded-lg border border-line bg-surface px-3 py-2 text-xs text-ink-3">
      <Stat label="action" value={m.actionName} />
      <Stat label="id" value={m.actionId} />
      <Stat label="domain" value={m.domain} />
      <Stat label="client" value={m.client ?? "(none)"} />
      <Stat label="template" value={m.templateVersion} />
      <Stat label="strategy" value={m.promptStrategy} />
      <Stat label="compiledAt" value={m.compiledAt} />
    </div>
  );
}

function PromptPre({
  result,
  parseError,
  mode,
}: {
  result:
    | { ok: true; prompt: string }
    | { ok: false; error: string }
    | null;
  parseError: string | null;
  mode: Mode;
}) {
  if (parseError) {
    return (
      <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-ink-3">
        (fix JSON parse error to update preview)
      </pre>
    );
  }
  if (!result) {
    return (
      <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-ink-3">
        {mode === "live" ? "(no live result yet)" : "(awaiting input)"}
      </pre>
    );
  }
  if (!result.ok) {
    return (
      <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-ink-3">
        (no prompt — see error)
      </pre>
    );
  }
  return (
    <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-ink-1">
      {result.prompt}
    </pre>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0 overflow-hidden rounded-lg border border-line bg-surface shadow-sh-1">
      <header className="border-b border-line px-3 py-2 text-xs font-semibold uppercase tracking-wide text-ink-3">
        {title}
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-ink-3">{label}</span>
      {children}
    </label>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span>
      <span className="text-ink-4">{label}:</span>{" "}
      <span className="font-mono text-ink-2">{value}</span>
    </span>
  );
}
