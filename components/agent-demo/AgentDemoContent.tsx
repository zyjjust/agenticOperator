"use client";
import React from "react";
import { Badge, Btn, Card, CardHead } from "@/components/shared/atoms";
import { Ic } from "@/components/shared/Ic";
import { fetchJson } from "@/lib/api/client";

type ActivityRow = {
  id: string;
  type: string;
  narrative: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

type ActivityResponse = {
  agent: string;
  rows: ActivityRow[];
  count: number;
};

type TriggerResponse = {
  ok: boolean;
  sent: { name: string; data: Record<string, unknown> };
  inngest_ids: string[];
};

const AGENT_NAME = "processResume";
const POLL_MS = 2000;

const FILE_PRESETS = [
  { label: "Java 后端 · 王峰 (sample)",      path: "wang-feng-java.txt" },
  { label: "前端 · 李晓红 (sample)",         path: "li-xiaohong-frontend.txt" },
  { label: "数据科学 · 张伟 (sample)",       path: "zhang-wei-data.txt" },
];

const CHANNEL_PRESETS = ["BOSS直聘", "智联招聘", "前程无忧", "猎聘"];

export function AgentDemoContent() {
  const [filePath, setFilePath] = React.useState(FILE_PRESETS[0].path);
  const [jobReqId, setJobReqId] = React.useState("JR-ICBC-2024-0042");
  const [channel, setChannel] = React.useState(CHANNEL_PRESETS[0]);
  const [sending, setSending] = React.useState(false);
  const [lastSent, setLastSent] = React.useState<TriggerResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [activity, setActivity] = React.useState<ActivityRow[]>([]);
  const [highlightId, setHighlightId] = React.useState<string | null>(null);

  // Poll the activity feed every 2s
  React.useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetchJson<ActivityResponse>(
          `/api/agent-activity?agent=${AGENT_NAME}&limit=20`,
        );
        if (cancelled) return;
        setActivity((prev) => {
          // detect new rows since last poll → flash the most recent
          if (prev.length && r.rows.length && r.rows[0].id !== prev[0]?.id) {
            setHighlightId(r.rows[0].id);
            setTimeout(() => setHighlightId(null), 2000);
          }
          return r.rows;
        });
      } catch {
        /* keep last good state */
      }
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const fire = async () => {
    setSending(true);
    setError(null);
    try {
      const res = await fetchJson<TriggerResponse>(
        "/api/test/trigger-resume-uploaded",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            resume_file_paths: [filePath],
            job_requisition_id: jobReqId,
            channel,
          }),
        },
      );
      setLastSent(res);
    } catch (e) {
      setError(
        (e as { message?: string })?.message ?? String(e) ?? "Failed to send event",
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <SubHeader />
      <div
        className="flex-1 grid min-h-0 overflow-auto"
        style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.2fr)", padding: "18px 22px", gap: 18 }}
      >
        <TriggerPane
          filePath={filePath}
          setFilePath={setFilePath}
          jobReqId={jobReqId}
          setJobReqId={setJobReqId}
          channel={channel}
          setChannel={setChannel}
          sending={sending}
          fire={fire}
          lastSent={lastSent}
          error={error}
        />
        <ActivityPane activity={activity} highlightId={highlightId} />
      </div>
    </div>
  );
}

function SubHeader() {
  return (
    <div
      className="border-b border-line bg-surface flex items-center"
      style={{ padding: "14px 22px", gap: 18 }}
    >
      <div className="flex-1">
        <div className="text-[15px] font-semibold tracking-tight">Sample Agent Demo</div>
        <div className="text-ink-3 text-[12px] mt-px">
          resume.uploaded → "Received the resume" → resume.parse · in-process via Inngest serve adapter
        </div>
      </div>
      <Badge variant="ok" dot>
        agent · {AGENT_NAME}
      </Badge>
    </div>
  );
}

function TriggerPane({
  filePath,
  setFilePath,
  jobReqId,
  setJobReqId,
  channel,
  setChannel,
  sending,
  fire,
  lastSent,
  error,
}: {
  filePath: string;
  setFilePath: (s: string) => void;
  jobReqId: string;
  setJobReqId: (s: string) => void;
  channel: string;
  setChannel: (s: string) => void;
  sending: boolean;
  fire: () => void;
  lastSent: TriggerResponse | null;
  error: string | null;
}) {
  return (
    <Card>
      <CardHead>
        <div className="text-[13px] font-semibold tracking-tight">
          1 · 发送事件 / Send <span className="mono">RESUME_DOWNLOADED</span>
        </div>
      </CardHead>
      <div className="flex flex-col gap-3" style={{ padding: 16 }}>
        <SelectField
          label="resume_file_paths[0]"
          value={filePath}
          onChange={setFilePath}
          options={FILE_PRESETS.map((p) => ({ label: p.label, value: p.path }))}
        />
        <Field label="job_requisition_id" value={jobReqId} onChange={setJobReqId} />
        <SelectField
          label="channel"
          value={channel}
          onChange={setChannel}
          options={CHANNEL_PRESETS.map((c) => ({ label: c, value: c }))}
        />

        <div className="flex items-center gap-2 mt-2">
          <Btn variant="primary" size="md" onClick={fire} disabled={sending}>
            {sending ? "发送中…" : <><Ic.bolt /> 发送事件</>}
          </Btn>
          <span className="text-ink-3 text-[11.5px] flex-1">
            POST → <span className="mono">/api/test/trigger-resume-uploaded</span>
          </span>
        </div>

        {error && (
          <div
            className="text-[11.5px] mono p-2 rounded-md"
            style={{ background: "var(--c-err-bg)", color: "var(--c-err)" }}
          >
            ⚠ {error}
          </div>
        )}

        {lastSent && (
          <div className="text-[11.5px] mono p-2 rounded-md bg-panel border border-line">
            <div className="text-ink-3 mb-1">已发出 · sent</div>
            <div>
              event = <span className="text-ink-1">{lastSent.sent.name}</span>
            </div>
            <div>
              inngest id = <span className="text-ink-1">{lastSent.inngest_ids[0]}</span>
            </div>
          </div>
        )}

        <div className="text-[11.5px] text-ink-3 mt-2">
          对应真实工作流节点 <span className="mono">9-1 / processResume</span>
          （[workflow_20260330.json]）。点击后：
          <ol className="list-decimal pl-5 mt-1 space-y-0.5">
            <li>
              POST → <span className="mono">/api/test/trigger-resume-uploaded</span>
            </li>
            <li>
              <span className="mono">inngest.send(&quot;RESUME_DOWNLOADED&quot;, …)</span>
            </li>
            <li>
              Inngest dev → <span className="mono">{AGENT_NAME}</span> agent
            </li>
            <li>
              Agent 4 步：log received → 读 file 抽 text → LLM/stub 抽结构化字段 → emit{" "}
              <span className="mono">RESUME_PROCESSED</span>
            </li>
            <li>
              LLM mode：<span className="mono">OPENAI_API_KEY</span> 设了走 OpenAI；否则走确定性 stub
            </li>
            <li>右侧"日志"面板 2 秒轮询，新行会高亮</li>
          </ol>
        </div>
      </div>
    </Card>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (s: string) => void;
  options: { label: string; value: string }[];
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="hint mono">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-panel border border-line rounded-md mono text-[12px] px-2 py-1.5 text-ink-1 outline-none focus:border-accent-line"
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (s: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="hint mono">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-panel border border-line rounded-md mono text-[12px] px-2 py-1.5 text-ink-1 outline-none focus:border-accent-line"
      />
    </label>
  );
}

function ActivityPane({
  activity,
  highlightId,
}: {
  activity: ActivityRow[];
  highlightId: string | null;
}) {
  const counts = {
    received: activity.filter((r) => r.type === "event_received").length,
    extracted: activity.filter((r) => r.type === "tool").length,
    parsed: activity.filter((r) => r.type === "agent_complete").length,
    emitted: activity.filter((r) => r.type === "event_emitted").length,
  };
  return (
    <Card>
      <CardHead>
        <div className="text-[13px] font-semibold tracking-tight flex-1">
          2 · 日志 / Live log{" "}
          <span className="text-ink-3 mono text-[10.5px]">
            (poll 2s · {activity.length} rows)
          </span>
        </div>
        <Badge variant="info" dot>
          ao.db
        </Badge>
      </CardHead>
      <div className="grid border-b border-line" style={{ gridTemplateColumns: "1fr 1fr 1fr 1fr", padding: "10px 14px", gap: 14 }}>
        <PhaseCount label="1 · 收到 received" count={counts.received} color="var(--c-info)" />
        <PhaseCount label="2 · 提取 extracted" count={counts.extracted} color="var(--c-warn)" />
        <PhaseCount label="3 · 解析 parsed" count={counts.parsed} color="var(--c-warn)" />
        <PhaseCount label="4 · 发出 published" count={counts.emitted} color="var(--c-ok)" />
      </div>
      <div
        className="overflow-auto"
        style={{ padding: 0, maxHeight: "calc(100vh - 200px)" }}
      >
        {activity.length === 0 ? (
          <div className="text-ink-3 text-[12px] text-center" style={{ padding: 36 }}>
            暂无日志。点左侧"发送事件"试试。
            <br />
            <span className="hint mono mt-2 inline-block">
              SELECT * FROM AgentActivity WHERE agentName = &apos;{AGENT_NAME}&apos;
            </span>
          </div>
        ) : (
          activity.map((row) => (
            <ActivityRow key={row.id} row={row} highlight={row.id === highlightId} />
          ))
        )}
      </div>
    </Card>
  );
}

function PhaseCount({ label, count, color }: { label: string; count: number; color: string }) {
  return (
    <div>
      <div className="hint">{label}</div>
      <div className="text-[18px] font-semibold tabular-nums" style={{ color }}>
        {count}
      </div>
    </div>
  );
}

function ActivityRow({ row, highlight }: { row: ActivityRow; highlight: boolean }) {
  const [expanded, setExpanded] = React.useState(false);
  const meta = row.metadata as Record<string, unknown> | null;
  const phase = phaseFor(row.type);
  return (
    <div
      className="border-b border-line cursor-pointer transition-colors"
      style={{
        padding: "10px 14px",
        background: highlight ? "var(--c-ok-bg)" : undefined,
        borderLeft: `3px solid ${phase.color}`,
      }}
      onClick={() => setExpanded((v) => !v)}
    >
      <div className="flex items-center gap-2">
        <Badge variant={phase.badgeVariant}>{phase.label}</Badge>
        <span className="text-[12px] font-medium text-ink-1">{row.narrative}</span>
        <span className="ml-auto mono text-[10.5px] text-ink-3">
          {new Date(row.createdAt).toLocaleTimeString()}
        </span>
      </div>
      {meta && (
        <div className="mt-1.5 mono text-[10.5px] text-ink-3">
          {summaryFor(row.type, meta)}
        </div>
      )}
      {expanded && meta && (
        <pre className="mt-2 mono text-[10.5px] text-ink-2 bg-panel border border-line rounded-md overflow-auto" style={{ padding: 8 }}>
          {JSON.stringify(meta, null, 2)}
        </pre>
      )}
    </div>
  );
}

type PhaseInfo = {
  label: string;
  color: string;
  badgeVariant: "ok" | "info" | "warn" | "default";
};

function phaseFor(type: string): PhaseInfo {
  if (type === "event_received") return { label: "1 · subscribe", color: "var(--c-info)", badgeVariant: "info" };
  if (type === "tool")           return { label: "2 · extract",   color: "var(--c-warn)", badgeVariant: "warn" };
  if (type === "agent_complete") return { label: "3 · parse",     color: "var(--c-warn)", badgeVariant: "warn" };
  if (type === "event_emitted")  return { label: "4 · publish",   color: "var(--c-ok)",   badgeVariant: "ok" };
  if (type === "agent_error")    return { label: "✗ error",      color: "var(--c-err)",  badgeVariant: "default" };
  return { label: type, color: "var(--c-line)", badgeVariant: "default" };
}

function summaryFor(type: string, meta: Record<string, unknown>): string {
  if (type === "event_received") {
    const paths = (meta.resume_file_paths as string[] | undefined) ?? [];
    return `trigger=${String(meta.trigger ?? "—")} · jd=${String(meta.job_requisition_id ?? "—")} · channel=${String(meta.channel ?? "—")} · file=${paths[0] ?? "—"}`;
  }
  if (type === "tool") {
    return `chars=${String(meta.chars ?? "—")} · source=${String(meta.source ?? "—")}`;
  }
  if (type === "agent_complete") {
    const parsed = (meta.parsed ?? {}) as { candidate?: { name?: string; skills?: string[] }; resume?: { work_history?: unknown[] } };
    const cand = parsed.candidate ?? {};
    const skills = Array.isArray(cand.skills) ? cand.skills.join("、") : "—";
    return `mode=${String(meta.mode ?? "—")} · candidate=${cand.name ?? "—"} · skills=[${skills}] · jobs=${parsed.resume?.work_history?.length ?? 0}`;
  }
  if (type === "agent_error") {
    return `narrative='${String(meta).slice(0, 60)}'`;
  }
  if (type === "event_emitted") {
    return `event=${String(meta.event_name ?? "—")} · candidate=${String(meta.candidate_name ?? "—")} · parserVersion=${String(meta.parserVersion ?? "—")}`;
  }
  return JSON.stringify(meta).slice(0, 200);
}
