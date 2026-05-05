# RAAS ↔ AO 事件流：upload_id 关联模型

> **来源**：与 RAAS 团队（partner）的对接说明，2026-04-29。
> **作用**：定义 AO 处理简历后回传的 MATCH_* 事件如何被 RAAS 正确关联到候选人。

## 1. 问题核心

RAAS 收到 `MATCH_PASSED_NEED_INTERVIEW` / `MATCH_PASSED_NO_INTERVIEW` 时，必须把
match 结果落到正确的 `Candidate` + `Application`。但 AO（外部 agent）只知道
`job_requisition_id`，不知道是哪个候选人的简历。

## 2. 关联锚点：`upload_id`

```
RAAS 发 RESUME_DOWNLOADED（payload 含 upload_id）
        ↓
AO 解析简历 + 跑 match
        ↓
AO 发 MATCH_PASSED_*（payload 含 job_requisition_id + upload_id）
        ↓
RAAS 收事件，用 upload_id → 查 resume_upload 表 → 拿到 candidate_id
        ↓
RAAS 写 candidate_match_result_runtime_state + 更新 Application.matching_score
```

`upload_id` 在 RAAS 侧 `resume_upload` 表里是主键。`processResumeUpload` 跑完后，
该行已经回填好 `candidate_id` / `resume_id` / `application_id`。所以 AO 在 MATCH_*
里**不需要**回传候选人信息 —— RAAS 自己就能反查到。

## 3. AO 侧需要做的 3 件事

### 3.1 RESUME_DOWNLOADED.payload 必须带 `upload_id`

RAAS 这边发事件时已经包含；AO 在 `processResume` 透传给 `RESUME_PROCESSED`，再
传给 `MATCH_*`。

### 3.2 AO 在 MATCH_PASSED_* 事件 payload 里**回传 upload_id**

我们当前实现：[`server/ws/agents/match-resume.ts`](../server/ws/agents/match-resume.ts) 中
`ECHO_ANCHORS = ["upload_id", "jd_id", "job_requisition_id"]` 已经把这三个字段
echo 进 outbound payload。

### 3.3 RAAS 侧 `match-result-ingest.function.ts` 用 upload_id 反查 candidate

```ts
// 现状（要改）：
const candidateId = payload?.candidate_id;  // ❌ 外部 agent 不知道这个

// 改成：
let candidateId = payload?.candidate_id;
if (!candidateId && payload?.upload_id) {
  const upload = await resumeUploadRepository.get(payload.upload_id);
  candidateId = upload?.candidate_id ?? null;
}
```

## 4. 关于 Candidate upsert 时机

RAAS `processResumeUpload` 在发 `RESUME_DOWNLOADED` **之前**就已经把
Candidate / Resume / Application 写入 Postgres（通过 `#syncCandidateToPostgres`）。
所以：

- AO 不负责创建 Candidate
- AO 的 MATCH_* 事件不需要带候选人信息
- RAAS 收到 MATCH_* 时 candidate 已经存在，反查必中

## 5. 完整时序

```
[RAAS]  上传简历 → processResumeUpload
        创建 Candidate + Resume + Application + upload_id
[RAAS]  发 RESUME_DOWNLOADED { upload_id, job_requisition_id, ... }
        ↓
[ AO]   processResume：MinIO 拉 PDF → RoboHire 解析 → 透传 upload_id
[ AO]   发 RESUME_PROCESSED { upload_id, ..., parsed.data }
        ↓
[ AO]   matchResume：fan-out 14 个 JD → RoboHire match
[ AO]   发 MATCH_PASSED_* { upload_id, job_requisition_id, matchScore, ... }
        ↓
[RAAS]  match-result-ingest：upload_id → resume_upload.candidate_id
[RAAS]  写 candidate_match_result_runtime_state
[RAAS]  更新 Application.status + Application.matching_score
```

## 6. AO 侧实现状态对照

| 要求 | AO 当前实现 | 状态 |
|---|---|---|
| processResume 把 RESUME_DOWNLOADED.upload_id 透传到 RESUME_PROCESSED | `TRANSPORT_FIELDS` 第 1 项 | ✅ |
| matchResume 把 upload_id 透传到 MATCH_* | `ECHO_ANCHORS` 含 `upload_id` | ✅ |
| matchResume payload 顶层带 job_requisition_id | `outboundPayload.job_requisition_id` | ✅ |
| matchResume 多 JD fan-out 时每个 MATCH_* 各带不同 job_requisition_id | for 循环每次单独 emit | ✅ |
| 不在 AO 里创建 Candidate / Resume DB 行 | AO 只读 MinIO + 调 LLM，不写 RAAS PG | ✅ |

**结论：AO 这边的 4 个 echo 锚点（upload_id / job_requisition_id / jd_id / candidate_ref）已经在事件里了，等 RAAS 改 match-result-ingest 加 upload_id 反查就能对接。**
