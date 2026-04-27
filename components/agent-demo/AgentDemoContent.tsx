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

const AGENT_NAME = "SampleResumeParser";
const POLL_MS = 2000;

export function AgentDemoContent() {
  const [resumeId, setResumeId] = React.useState("R-001");
  const [candidateName, setCandidateName] = React.useState("Yuhan");
  const [fileUrl, setFileUrl] = React.useState("https://example.com/yuhan.pdf");
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
            resume_id: resumeId,
            candidate_name: candidateName,
            file_url: fileUrl,
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
          resumeId={resumeId}
          setResumeId={setResumeId}
          candidateName={candidateName}
          setCandidateName={setCandidateName}
          fileUrl={fileUrl}
          setFileUrl={setFileUrl}
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
  resumeId,
  setResumeId,
  candidateName,
  setCandidateName,
  fileUrl,
  setFileUrl,
  sending,
  fire,
  lastSent,
  error,
}: {
  resumeId: string;
  setResumeId: (s: string) => void;
  candidateName: string;
  setCandidateName: (s: string) => void;
  fileUrl: string;
  setFileUrl: (s: string) => void;
  sending: boolean;
  fire: () => void;
  lastSent: TriggerResponse | null;
  error: string | null;
}) {
  return (
    <Card>
      <CardHead>
        <div className="text-[13px] font-semibold tracking-tight">
          1 · 发送事件 / Send <span className="mono">resume.uploaded</span>
        </div>
      </CardHead>
      <div className="flex flex-col gap-3" style={{ padding: 16 }}>
        <Field label="resume_id" value={resumeId} onChange={setResumeId} />
        <Field label="candidate_name" value={candidateName} onChange={setCandidateName} />
        <Field label="file_url" value={fileUrl} onChange={setFileUrl} />
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
          点击后会发生 / On click:
          <ol className="list-decimal pl-5 mt-1 space-y-0.5">
            <li>
              POST 到 <span className="mono">/api/test/trigger-resume-uploaded</span>
            </li>
            <li>
              该端点 <span className="mono">inngest.send(&quot;resume.uploaded&quot;, …)</span>
            </li>
            <li>
              Inngest dev (<span className="mono">:8288</span>) 把事件路由到{" "}
              <span className="mono">{AGENT_NAME}</span>
            </li>
            <li>
              Agent 写一行 <span className="mono">AgentActivity</span> 到 ao.db + emit{" "}
              <span className="mono">resume.parse</span>
            </li>
            <li>右侧"日志"面板每 2 秒拉一次，新行会高亮</li>
          </ol>
        </div>
      </div>
    </Card>
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

function ActivityRow({ row, highlight }: { row: ActivityRow; highlight: boolean }) {
  const [expanded, setExpanded] = React.useState(false);
  const meta = row.metadata as Record<string, unknown> | null;
  return (
    <div
      className="border-b border-line cursor-pointer transition-colors"
      style={{
        padding: "10px 14px",
        background: highlight ? "var(--c-ok-bg)" : undefined,
      }}
      onClick={() => setExpanded((v) => !v)}
    >
      <div className="flex items-center gap-2">
        <Badge variant="ok">{row.type}</Badge>
        <span className="text-[12px] font-medium text-ink-1">{row.narrative}</span>
        <span className="ml-auto mono text-[10.5px] text-ink-3">
          {new Date(row.createdAt).toLocaleTimeString()}
        </span>
      </div>
      {meta && (
        <div className="mt-1.5 mono text-[10.5px] text-ink-3">
          resume_id={String(meta.resume_id ?? "—")} · candidate_name=
          {String(meta.candidate_name ?? "—")} · file_url=
          {String(meta.file_url ?? "—")}
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
