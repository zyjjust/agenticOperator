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
  sent?: { name: string; data: Record<string, unknown> };
  inngest_ids?: string[];
  requisition_id?: string;
  error?: string;
  message?: string;
};

const POLL_MS = 2000;

type AgentTab = {
  id: string;
  agentName: string;          // matches AgentActivity.agentName
  label: string;
  workflowNode: string;
  desc: string;
};

const AGENT_TABS: AgentTab[] = [
  {
    id: "createJD",
    agentName: "createJD",
    label: "createJD",
    workflowNode: "node 4",
    desc: "REQUIREMENT_LOGGED → 用 LLM 生成结构化 JD → JD_GENERATED",
  },
  {
    id: "processResume",
    agentName: "processResume",
    label: "processResume",
    workflowNode: "node 9-1",
    desc: "RESUME_DOWNLOADED → MinIO 拉文件 → RoboHire 解析 → RESUME_PROCESSED + AO_MATCH_REQUESTED",
  },
  {
    id: "matchResume",
    agentName: "matchResume",
    label: "matchResume",
    workflowNode: "node 10",
    desc: "AO_MATCH_REQUESTED → 从 DB 取真实 JD → RoboHire 匹配 → MATCH_PASSED_*/MATCH_FAILED",
  },
];

export function AgentDemoContent() {
  const [activeTab, setActiveTab] = React.useState<string>(AGENT_TABS[0].id);
  const [activity, setActivity] = React.useState<ActivityRow[]>([]);
  const [highlightId, setHighlightId] = React.useState<string | null>(null);

  const tab = AGENT_TABS.find((t) => t.id === activeTab) ?? AGENT_TABS[0];

  React.useEffect(() => {
    let cancelled = false;
    setActivity([]); // clear when switching agents
    const tick = async () => {
      try {
        const r = await fetchJson<ActivityResponse>(
          `/api/agent-activity?agent=${tab.agentName}&limit=40`,
        );
        if (cancelled) return;
        setActivity((prev) => {
          if (prev.length && r.rows.length && r.rows[0].id !== prev[0]?.id) {
            setHighlightId(r.rows[0].id);
            setTimeout(() => setHighlightId(null), 2000);
          }
          return r.rows;
        });
      } catch {
        /* keep last */
      }
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [tab.agentName]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <SubHeader />
      <TabBar tabs={AGENT_TABS} activeId={activeTab} onChange={setActiveTab} />
      <div
        className="flex-1 grid min-h-0 overflow-auto"
        style={{
          gridTemplateColumns: "minmax(0, 0.9fr) minmax(0, 1.5fr)",
          padding: "18px 22px",
          gap: 18,
        }}
      >
        <TriggerPane tab={tab} />
        <ActivityPane
          activity={activity}
          highlightId={highlightId}
          tab={tab}
        />
      </div>
    </div>
  );
}

// ─── Sub-header + tabs ──────────────────────────────────────────────

function SubHeader() {
  return (
    <div
      className="border-b border-line bg-surface flex items-center"
      style={{ padding: "14px 22px", gap: 18 }}
    >
      <div className="flex-1">
        <div className="text-[15px] font-semibold tracking-tight">
          Sample Agent Demo
        </div>
        <div className="text-ink-3 text-[12px] mt-px">
          每个 agent 的实时 input / output / step 完整可见 · 2s 轮询 ·{" "}
          <span className="mono">SELECT * FROM AgentActivity WHERE agentName = ?</span>
        </div>
      </div>
      <Badge variant="ok" dot>
        live
      </Badge>
    </div>
  );
}

function TabBar({
  tabs,
  activeId,
  onChange,
}: {
  tabs: AgentTab[];
  activeId: string;
  onChange: (id: string) => void;
}) {
  return (
    <div
      className="border-b border-line bg-surface flex items-stretch"
      style={{ padding: "0 22px" }}
    >
      {tabs.map((t) => {
        const on = t.id === activeId;
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            className="flex flex-col items-start text-left transition-colors"
            style={{
              padding: "10px 18px",
              borderBottom: on
                ? "2px solid var(--c-accent)"
                : "2px solid transparent",
              color: on ? "var(--c-ink-1)" : "var(--c-ink-3)",
              opacity: on ? 1 : 0.85,
            }}
          >
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-semibold mono">{t.label}</span>
              <span className="text-[10.5px] mono text-ink-3">
                · {t.workflowNode}
              </span>
            </div>
            <div
              className="text-[10.5px] text-ink-3 mt-0.5 max-w-[460px] truncate"
              title={t.desc}
            >
              {t.desc}
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ─── Trigger pane (form per agent) ──────────────────────────────────

function TriggerPane({ tab }: { tab: AgentTab }) {
  return (
    <Card>
      <CardHead>
        <div className="text-[13px] font-semibold tracking-tight">
          1 · 触发事件 / Trigger
        </div>
      </CardHead>
      {tab.id === "createJD" && <CreateJdForm />}
      {tab.id === "processResume" && <ProcessResumeForm />}
      {tab.id === "matchResume" && <MatchResumeNote />}
    </Card>
  );
}

function CreateJdForm() {
  const [title, setTitle] = React.useState("游戏测试工程师");
  const [city, setCity] = React.useState("深圳");
  const [headcount, setHeadcount] = React.useState(1);
  const [salary, setSalary] = React.useState("7k-11k");
  const [responsibility, setResponsibility] = React.useState(
    "1.负责游戏功能/性能/回归测试；2.编写测试用例和报告；3.跟踪缺陷生命周期；4.参与版本验收。",
  );
  const [requirement, setRequirement] = React.useState(
    "1.计算机相关本科及以上；2.1-3年游戏测试经验；3.熟悉Jira/TAPD缺陷管理；4.熟悉PerfDog性能测试。",
  );
  const [sending, setSending] = React.useState(false);
  const [resp, setResp] = React.useState<TriggerResponse | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  const fire = async () => {
    setSending(true);
    setErr(null);
    try {
      const r = await fetchJson<TriggerResponse>("/api/test/trigger-requirement", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_job_title: title,
          city,
          headcount,
          salary_range: salary,
          job_responsibility: responsibility,
          job_requirement: requirement,
        }),
      });
      setResp(r);
    } catch (e) {
      setErr((e as { message?: string })?.message ?? String(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex flex-col gap-3" style={{ padding: 16 }}>
      <Field label="client_job_title (岗位名称)" value={title} onChange={setTitle} />
      <Field label="city" value={city} onChange={setCity} />
      <Field
        label="headcount"
        value={String(headcount)}
        onChange={(s) => setHeadcount(Number(s) || 1)}
      />
      <Field label="salary_range (e.g. 7k-11k)" value={salary} onChange={setSalary} />
      <TextArea
        label="job_responsibility (岗位职责 — 原始)"
        value={responsibility}
        onChange={setResponsibility}
      />
      <TextArea
        label="job_requirement (任职要求 — 原始)"
        value={requirement}
        onChange={setRequirement}
      />
      <div className="flex items-center gap-2 mt-2">
        <Btn variant="primary" size="md" onClick={fire} disabled={sending}>
          {sending ? "发送中…" : <><Ic.bolt /> 发 REQUIREMENT_LOGGED</>}
        </Btn>
        <span className="text-ink-3 text-[11.5px] flex-1">
          POST <span className="mono">/api/test/trigger-requirement</span>
        </span>
      </div>
      {err && <ErrorBox msg={err} />}
      {resp && <SentBox resp={resp} />}
      <div className="text-[11.5px] text-ink-3 mt-2">
        信封是 RAAS 真实 shape：<span className="mono">data.payload.raw_input_data.{"{...28 fields...}"}</span>，
        agent 内部用 LLM 把粗糙的原始职责 / 要求扩写成结构化 JD（含搜索关键词、薪资福利、面试形式）。
        生成后 jd_id 会出现在 RESUME_DOWNLOADED 的 trigger 表单里供选用。
      </div>
    </div>
  );
}

function ProcessResumeForm() {
  const [jdId, setJdId] = React.useState("");
  const [objectKey, setObjectKey] = React.useState(
    "2026/04/e7b3dde7-b4fc-96dc-6a9b-d2e2facd57db-【游戏测试（全国招聘）_深圳 7-11K】谌治中 3年.pdf",
  );
  const [filename, setFilename] = React.useState(
    "【游戏测试（全国招聘）_深圳 7-11K】谌治中 3年.pdf",
  );
  const [resumeText, setResumeText] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const [resp, setResp] = React.useState<TriggerResponse | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  const fire = async () => {
    setSending(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = {
        object_key: objectKey,
        filename,
      };
      if (jdId.trim()) body.jd_id = jdId.trim();
      if (resumeText.trim()) body.resume_text = resumeText.trim();
      const r = await fetchJson<TriggerResponse>(
        "/api/test/trigger-resume-uploaded",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      setResp(r);
    } catch (e) {
      setErr((e as { message?: string })?.message ?? String(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex flex-col gap-3" style={{ padding: 16 }}>
      <Field
        label="jd_id (来自 createJD · 留空则触发 MATCH_FAILED)"
        value={jdId}
        onChange={setJdId}
      />
      <Field label="object_key (MinIO 路径)" value={objectKey} onChange={setObjectKey} />
      <Field label="filename" value={filename} onChange={setFilename} />
      <TextArea
        label="resume_text (留空走 MinIO 真实 PDF + RoboHire；填了走 LLM 解析跳过 MinIO)"
        value={resumeText}
        onChange={setResumeText}
        rows={4}
      />
      <div className="flex items-center gap-2 mt-2">
        <Btn variant="primary" size="md" onClick={fire} disabled={sending}>
          {sending ? "发送中…" : <><Ic.bolt /> 发 RESUME_DOWNLOADED</>}
        </Btn>
        <span className="text-ink-3 text-[11.5px] flex-1">
          POST <span className="mono">/api/test/trigger-resume-uploaded</span>
        </span>
      </div>
      {err && <ErrorBox msg={err} />}
      {resp && <SentBox resp={resp} />}
      <div className="text-[11.5px] text-ink-3 mt-2">
        agent 4 步：fetch (MinIO) → parse (RoboHire) → emit RESUME_PROCESSED → emit AO_MATCH_REQUESTED。
        每一步的完整 input + output 在右边日志里逐行展开。
      </div>
    </div>
  );
}

function MatchResumeNote() {
  const [jdId, setJdId] = React.useState("");
  const [requisitionId, setRequisitionId] = React.useState("");
  const [claimer, setClaimer] = React.useState("0000199059");
  const [candidateName, setCandidateName] = React.useState("测试候选人");
  const [candidatePhone, setCandidatePhone] = React.useState("13800000000");
  const [candidateEmail, setCandidateEmail] = React.useState("test@example.com");
  const [sending, setSending] = React.useState(false);
  const [resp, setResp] = React.useState<TriggerResponse | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  const fire = async () => {
    setSending(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = {};
      if (jdId.trim()) body.jd_id = jdId.trim();
      if (requisitionId.trim()) body.job_requisition_id = requisitionId.trim();
      if (claimer.trim()) body.claimer_employee_id = claimer.trim();
      body.candidate = {
        name: candidateName,
        phone: candidatePhone,
        email: candidateEmail,
      };
      const r = await fetchJson<TriggerResponse>(
        "/api/test/trigger-match-requested",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      setResp(r);
    } catch (e) {
      setErr((e as { message?: string })?.message ?? String(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 text-[12px] text-ink-2" style={{ padding: 16 }}>
      <div>
        正常情况下 matchResume 是<strong>下游级联</strong>：由 processResume 完成时通过{" "}
        <span className="mono">AO_MATCH_REQUESTED</span> 自动触发。
      </div>
      <div
        className="mono text-[11.5px] p-3 rounded-md"
        style={{ background: "var(--c-panel)", border: "1px solid var(--c-line)" }}
      >
        触发链：
        <br />
        <span className="text-ink-3">  REQUIREMENT_LOGGED →</span> createJD →{" "}
        <span className="text-ink-3">JD_GENERATED + JD_APPROVED (auto)</span>
        <br />
        <span className="text-ink-3">  RESUME_DOWNLOADED →</span> processResume →{" "}
        <span className="text-ink-3">RESUME_PROCESSED + AO_MATCH_REQUESTED</span>
        <br />
        <span className="text-ink-3">  AO_MATCH_REQUESTED →</span>{" "}
        <strong>matchResume</strong> →{" "}
        <span className="text-ink-3">MATCH_PASSED_*/MATCH_FAILED</span>
      </div>

      <div
        className="mt-3 p-3 rounded-md"
        style={{ background: "var(--c-surface)", border: "1px dashed var(--c-line)" }}
      >
        <div className="text-[12px] font-semibold mb-2 text-ink-1">
          ⚡ 隔离测试 · 手动触发 AO_MATCH_REQUESTED
        </div>
        <div className="text-[11px] text-ink-3 mb-3">
          跳过 processResume + RoboHire /parse-resume，直接用 stub candidate 触发 matchResume。
          用来单独验证 RAAS Internal API 拉 JD + RoboHire /match-resume 这条路径。
        </div>
        <div className="flex flex-col gap-3">
          <Field label="jd_id (优先)" value={jdId} onChange={setJdId} />
          <Field
            label="job_requisition_id (jd_id 没填时用)"
            value={requisitionId}
            onChange={setRequisitionId}
          />
          <Field
            label="claimer_employee_id (RAAS API 必需)"
            value={claimer}
            onChange={setClaimer}
          />
          <div className="grid grid-cols-3 gap-2">
            <Field label="cand name" value={candidateName} onChange={setCandidateName} />
            <Field label="cand phone" value={candidatePhone} onChange={setCandidatePhone} />
            <Field label="cand email" value={candidateEmail} onChange={setCandidateEmail} />
          </div>
          <div className="flex items-center gap-2 mt-1">
            <Btn variant="primary" size="md" onClick={fire} disabled={sending}>
              {sending ? "发送中…" : <><Ic.bolt /> 发 AO_MATCH_REQUESTED</>}
            </Btn>
            <span className="text-ink-3 text-[11.5px] flex-1">
              POST <span className="mono">/api/test/trigger-match-requested</span>
            </span>
          </div>
          {err && <ErrorBox msg={err} />}
          {resp && <SentBox resp={resp} />}
        </div>
      </div>
    </div>
  );
}

// ─── shared form atoms ──────────────────────────────────────────────

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

function TextArea({
  label,
  value,
  onChange,
  rows = 3,
}: {
  label: string;
  value: string;
  onChange: (s: string) => void;
  rows?: number;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="hint mono">{label}</span>
      <textarea
        value={value}
        rows={rows}
        onChange={(e) => onChange(e.target.value)}
        className="bg-panel border border-line rounded-md mono text-[11.5px] px-2 py-1.5 text-ink-1 outline-none focus:border-accent-line resize-y"
      />
    </label>
  );
}

function ErrorBox({ msg }: { msg: string }) {
  return (
    <div
      className="text-[11.5px] mono p-2 rounded-md"
      style={{ background: "var(--c-err-bg)", color: "var(--c-err)" }}
    >
      ⚠ {msg}
    </div>
  );
}

function SentBox({ resp }: { resp: TriggerResponse }) {
  return (
    <div className="text-[11.5px] mono p-2 rounded-md bg-panel border border-line">
      <div className="text-ink-3 mb-1">已发出 · sent</div>
      {resp.sent && (
        <div>
          event = <span className="text-ink-1">{resp.sent.name}</span>
        </div>
      )}
      {resp.inngest_ids?.[0] && (
        <div>
          inngest id = <span className="text-ink-1">{resp.inngest_ids[0]}</span>
        </div>
      )}
      {resp.requisition_id && (
        <div>
          requisition_id = <span className="text-ink-1">{resp.requisition_id}</span>
        </div>
      )}
    </div>
  );
}

// ─── Activity / live log ────────────────────────────────────────────

function ActivityPane({
  activity,
  highlightId,
  tab,
}: {
  activity: ActivityRow[];
  highlightId: string | null;
  tab: AgentTab;
}) {
  const counts = countByPhase(activity);
  return (
    <Card>
      <CardHead>
        <div className="text-[13px] font-semibold tracking-tight flex-1">
          2 · Live log{" "}
          <span className="text-ink-3 mono text-[10.5px]">
            (poll 2s · {activity.length} rows · {tab.agentName})
          </span>
        </div>
        <Badge variant="info" dot>
          ao.db
        </Badge>
      </CardHead>
      <div
        className="grid border-b border-line"
        style={{
          gridTemplateColumns: "1fr 1fr 1fr 1fr 1fr",
          padding: "10px 14px",
          gap: 10,
        }}
      >
        <PhaseCount label="received" count={counts.received} color="var(--c-info)" />
        <PhaseCount label="tool" count={counts.tool} color="var(--c-warn)" />
        <PhaseCount label="complete" count={counts.complete} color="var(--c-warn)" />
        <PhaseCount label="emitted" count={counts.emitted} color="var(--c-ok)" />
        <PhaseCount label="error" count={counts.error} color="var(--c-err)" />
      </div>
      <div
        className="overflow-auto"
        style={{ padding: 0, maxHeight: "calc(100vh - 280px)" }}
      >
        {activity.length === 0 ? (
          <div className="text-ink-3 text-[12px] text-center" style={{ padding: 36 }}>
            暂无日志。点左侧&ldquo;触发&rdquo;试试。
            <br />
            <span className="hint mono mt-2 inline-block">
              SELECT * FROM AgentActivity WHERE agentName = &apos;{tab.agentName}&apos;
            </span>
          </div>
        ) : (
          activity.map((row) => (
            <ActivityRowView
              key={row.id}
              row={row}
              highlight={row.id === highlightId}
            />
          ))
        )}
      </div>
    </Card>
  );
}

function PhaseCount({
  label,
  count,
  color,
}: {
  label: string;
  count: number;
  color: string;
}) {
  return (
    <div>
      <div className="hint mono">{label}</div>
      <div className="text-[18px] font-semibold tabular-nums" style={{ color }}>
        {count}
      </div>
    </div>
  );
}

function countByPhase(rows: ActivityRow[]) {
  return {
    received: rows.filter((r) => r.type === "event_received").length,
    tool: rows.filter((r) => r.type === "tool").length,
    complete: rows.filter((r) => r.type === "agent_complete").length,
    emitted: rows.filter((r) => r.type === "event_emitted").length,
    error: rows.filter((r) => r.type === "agent_error").length,
  };
}

function ActivityRowView({
  row,
  highlight,
}: {
  row: ActivityRow;
  highlight: boolean;
}) {
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const phase = phaseFor(row.type);
  const sections = sectionsFor(row.type, meta);
  return (
    <div
      className="border-b border-line transition-colors"
      style={{
        padding: "12px 14px",
        background: highlight ? "var(--c-ok-bg)" : undefined,
        borderLeft: `3px solid ${phase.color}`,
      }}
    >
      <div className="flex items-center gap-2">
        <Badge variant={phase.badgeVariant}>{phase.label}</Badge>
        <span className="text-[12.5px] font-medium text-ink-1">{row.narrative}</span>
        <span className="ml-auto mono text-[10.5px] text-ink-3">
          {new Date(row.createdAt).toLocaleTimeString()}
        </span>
      </div>

      {sections.length > 0 && (
        <div className="mt-2.5 flex flex-col gap-2">
          {sections.map((s, i) => (
            <JsonSection key={i} title={s.title} value={s.value} accent={s.accent} />
          ))}
        </div>
      )}
    </div>
  );
}

type SectionAccent = "input" | "output" | "diag" | "error";
type Section = { title: string; value: unknown; accent: SectionAccent };

/** Pull structured input/output/diagnostic sections out of metadata
 *  for each phase. Always renders both an INPUT and OUTPUT section
 *  where applicable so the user sees what the step received and what
 *  it produced — no clicking required. */
function sectionsFor(type: string, meta: Record<string, unknown>): Section[] {
  const out: Section[] = [];
  if (type === "event_received") {
    out.push({
      title: "INPUT · event payload (received from Inngest)",
      value: meta.payload ?? meta,
      accent: "input",
    });
    const diag = pickKeys(meta, ["event_name", "event_id", "upload_id", "entity_id", "filename"]);
    if (Object.keys(diag).length) {
      out.push({ title: "META", value: diag, accent: "diag" });
    }
    return out;
  }
  if (type === "tool") {
    // INPUT signals — what the tool was given (source, bytes, chars).
    out.push({
      title: "INPUT / source",
      value: pickKeys(meta, ["source", "input_bytes", "text_chars", "llm_prompt_chars", "mode"]),
      accent: "input",
    });
    // OUTPUT — diagnostic / counts. Tool step doesn't produce a JSON
    // output directly (it's an intermediate fetch), so we collapse
    // any cache / request_id signals into a META block.
    const out2 = pickKeys(meta, ["cached", "request_id", "fallback_reason"]);
    if (Object.keys(out2).length) {
      out.push({ title: "META", value: out2, accent: "diag" });
    }
    return out;
  }
  if (type === "agent_complete") {
    // The agent's actual output (parse / match / JD content)
    if (meta.parsed) {
      out.push({ title: "OUTPUT · parsed", value: meta.parsed, accent: "output" });
    }
    if (meta.match) {
      out.push({ title: "OUTPUT · match", value: meta.match, accent: "output" });
    }
    if (meta.content) {
      out.push({ title: "OUTPUT · jd content", value: meta.content, accent: "output" });
    }
    if (meta.jd) {
      out.push({ title: "META · jd resolution", value: meta.jd, accent: "diag" });
    }
    out.push({
      title: "META · perf",
      value: pickKeys(meta, [
        "model_used",
        "duration_ms",
        "llm_duration_ms",
        "parse_duration_ms",
        "request_id",
        "document_id",
        "saved_as",
        "cached",
        "score",
        "recommendation",
        "quality_score",
        "market_competitiveness",
        "fallback_reason",
      ]),
      accent: "diag",
    });
    return out;
  }
  if (type === "event_emitted") {
    out.push({
      title: "OUTPUT · emitted event metadata",
      value: meta,
      accent: "output",
    });
    return out;
  }
  if (type === "agent_error") {
    out.push({ title: "ERROR · context", value: meta, accent: "error" });
    return out;
  }
  if (Object.keys(meta).length > 0) {
    out.push({ title: "META", value: meta, accent: "diag" });
  }
  return out;
}

function pickKeys(o: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const r: Record<string, unknown> = {};
  for (const k of keys) {
    if (o[k] !== undefined && o[k] !== null) r[k] = o[k];
  }
  return r;
}

function JsonSection({
  title,
  value,
  accent,
}: {
  title: string;
  value: unknown;
  accent: SectionAccent;
}) {
  const [open, setOpen] = React.useState(true);
  const cfg = accentConfig(accent);
  const isEmpty =
    value == null ||
    (typeof value === "object" && Object.keys(value as Record<string, unknown>).length === 0);
  return (
    <div
      className="rounded-md overflow-hidden"
      style={{
        background: cfg.bg,
        border: `1px solid ${cfg.border}`,
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center text-left"
        style={{ padding: "5px 8px", color: cfg.fg }}
      >
        <span className="mono text-[10.5px] font-semibold tracking-wide flex-1">
          {open ? "▼" : "▶"} {title}
        </span>
        {isEmpty && (
          <span className="text-[10px] mono text-ink-3 ml-2">(empty)</span>
        )}
      </button>
      {open && !isEmpty && (
        <pre
          className="mono text-[10.5px] text-ink-2 overflow-auto"
          style={{
            padding: "6px 10px 8px",
            margin: 0,
            background: "var(--c-panel)",
            borderTop: `1px solid ${cfg.border}`,
            maxHeight: 360,
          }}
        >
          {JSON.stringify(value, null, 2)}
        </pre>
      )}
    </div>
  );
}

function accentConfig(a: SectionAccent) {
  if (a === "input") {
    return {
      fg: "var(--c-info)",
      bg: "rgba(59,130,246,0.06)",
      border: "rgba(59,130,246,0.25)",
    };
  }
  if (a === "output") {
    return {
      fg: "var(--c-ok)",
      bg: "rgba(34,197,94,0.06)",
      border: "rgba(34,197,94,0.25)",
    };
  }
  if (a === "error") {
    return {
      fg: "var(--c-err)",
      bg: "var(--c-err-bg)",
      border: "rgba(239,68,68,0.35)",
    };
  }
  // diag
  return {
    fg: "var(--c-ink-3)",
    bg: "var(--c-surface)",
    border: "var(--c-line)",
  };
}

// ─── phase styling ──────────────────────────────────────────────────

type PhaseInfo = {
  label: string;
  color: string;
  badgeVariant: "ok" | "info" | "warn" | "default";
};

function phaseFor(type: string): PhaseInfo {
  if (type === "event_received")
    return { label: "received", color: "var(--c-info)", badgeVariant: "info" };
  if (type === "tool")
    return { label: "tool", color: "var(--c-warn)", badgeVariant: "warn" };
  if (type === "agent_complete")
    return { label: "complete", color: "var(--c-warn)", badgeVariant: "warn" };
  if (type === "event_emitted")
    return { label: "emitted", color: "var(--c-ok)", badgeVariant: "ok" };
  if (type === "agent_error")
    return { label: "error", color: "var(--c-err)", badgeVariant: "default" };
  return { label: type, color: "var(--c-line)", badgeVariant: "default" };
}
