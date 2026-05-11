// 6 个 strict 1:1 测试场景 — 反映 production 模式:
//   每份简历(候选人)对应 RAAS 已经关联的 1 个 JD,各自跑一次 rule check。
//
// 每个场景的 input 严格对齐生产 RESUME_PROCESSED + getRequirementDetail 的 schema:
//   runtime_context           ← RESUME_PROCESSED 透传
//   resume                    ← RESUME_PROCESSED.parsed.data
//   job_requisition           ← getRequirementDetail.requirement
//   job_requisition_spec      ← getRequirementDetail.specification
//   hsm_feedback              ← getHsmFeedback (可选)

import { CANDIDATES, getCandidate } from './fixtures/candidates';
import { JOB_REQUISITIONS, getJobRequisition } from './fixtures/job-requisitions';
import type { RuleCheckPromptInput, RuntimeContext } from './types';

export interface NamedScenario {
  name: string;
  candidate_id: string;
  jd_id: string;
  candidate_label: string;
  jd_label: string;
  expected_decision: 'KEEP' | 'DROP' | 'PAUSE';
  expected_reason: string;
  input: RuleCheckPromptInput;
}

interface ComboSpec {
  name: string;
  candidate_id: string;
  expected_decision: NamedScenario['expected_decision'];
  expected_reason: string;
}

const COMBOS: ComboSpec[] = [
  {
    name: '01-clean-baseline-keep',
    candidate_id: 'c01-zhangsan-clean',
    expected_decision: 'KEEP',
    expected_reason: '清白前端候选人投腾讯 PCG 前端,所有规则 PASS / NOT_APPLICABLE',
  },
  {
    name: '02-huawei-cooldown-pause',
    candidate_id: 'c02-lisi-huawei-recent',
    expected_decision: 'PAUSE',
    expected_reason: '前端候选人 1.5 月前从华为离职,通用 10-25 < 3 月冷冻期 → REVIEW',
  },
  {
    name: '03-csi-blacklist-drop',
    candidate_id: 'c03-wangwu-csi-blacklist',
    expected_decision: 'DROP',
    expected_reason: 'Java 候选人有华腾 B8 高风险离职编码,通用 10-17 → FAIL → DROP',
  },
  {
    name: '04-tencent-ieg-history-pause',
    candidate_id: 'c04-zhaoliu-tencent-ieg',
    expected_decision: 'PAUSE',
    expected_reason: '游戏后端候选人有腾讯 IEG 天美历史经历,腾讯 10-38 触发历史从业核实',
  },
  {
    name: '05-foreign-marital-pause',
    candidate_id: 'c05-zhouqi-foreign-data',
    expected_decision: 'PAUSE',
    expected_reason: '美籍 28F未婚 数据分析师投腾讯 CDG,10-35 + 10-47 → REVIEW',
  },
  {
    name: '06-bytedance-history-pause',
    candidate_id: 'c06-qianba-bytedance-history',
    expected_decision: 'PAUSE',
    expected_reason: '前字节正编员工投字节 TikTok,字节 10-49 (字节正编回流凭证校验) → REVIEW',
  },
];

/** 生成一份合成的 RuntimeContext — 模拟 RESUME_PROCESSED 事件透传给 matcher 的 anchor。 */
function makeRuntimeContext(args: {
  candidate_id: string;
  jd_id: string;
  scenario_idx: number;
}): RuntimeContext {
  // 给每个场景一个唯一 upload_id / resume_id 方便追溯
  const seq = String(args.scenario_idx + 1).padStart(3, '0');
  const uploadId = `upl_${seq}_${args.candidate_id.slice(0, 8)}`;
  return {
    upload_id: uploadId,
    candidate_id: args.candidate_id,
    resume_id: `res_${seq}`,
    employee_id: 'EMP_REC_007',                 // 默认招聘专员

    bucket: 'recruit-resume-raw',
    object_key: `2026/05/${uploadId}.pdf`,
    filename: `${args.candidate_id}.pdf`,
    hr_folder: '/HR/2026-05',
    etag: null,                                  // 手动上传链路常为 null
    size: 380000 + args.scenario_idx * 1000,
    source_event_name: 'ResumeUploaded',
    received_at: '2026-05-09T11:23:00Z',

    parsed_at: '2026-05-09T11:23:08Z',
    parser_version: 'v7-pull-model@2026-05-08',

    trace_id: `trace_${seq}_${Date.now().toString(36)}`,
    request_id: `req_${seq}`,
  };
}

export const SCENARIOS: NamedScenario[] = COMBOS.map((c, idx) => {
  const candidate = getCandidate(c.candidate_id);
  const jrSpec = getJobRequisition(candidate.target_jd_id);
  return {
    name: c.name,
    candidate_id: c.candidate_id,
    jd_id: candidate.target_jd_id,
    candidate_label: candidate.label,
    jd_label: jrSpec.label,
    expected_decision: c.expected_decision,
    expected_reason: c.expected_reason,
    input: {
      runtime_context: makeRuntimeContext({
        candidate_id: candidate.id,
        jd_id: candidate.target_jd_id,
        scenario_idx: idx,
      }),
      resume: candidate.resume,
      job_requisition: jrSpec.jr,
      job_requisition_specification: jrSpec.spec,
      hsm_feedback: null,
    },
  };
});

export { CANDIDATES, JOB_REQUISITIONS };
