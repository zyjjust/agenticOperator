// Ontology loader + classifier + severity inferer for rule-check.
//
// Production:JSON 文件 only(rules.json 与 ontology-lab/data/rules_20260330.json 1:1)。
// Neo4j 直读模式留给 POC,生产里若要切回 Neo4j,通过 Ontology API HTTP 拉
// (见 docs/neo4j-instance-storage-plan.md)— 那是另一个 PR。

import rulesData from './rules.json';
import type {
  ClassifiedRules,
  OntologyDims,
  Rule,
  Severity,
} from './types';

interface RawRule {
  id: string;
  specificScenarioStage?: string;
  businessLogicRuleName?: string;
  applicableClient?: string;
  applicableDepartment?: string;
  submissionCriteria?: string;
  standardizedLogicRule?: string;
  relatedEntities?: string[];
  businessBackgroundReason?: string;
  ruleSource?: string;
  executor: 'Agent' | 'Human';
}

let CACHED_ALL_RULES: Rule[] | null = null;

function inferSeverity(text: string): Severity {
  const TERMINAL = [
    '立即终止',
    '立即拦截',
    '直接终止',
    '终止匹配流程',
    '终止后续匹配',
    '禁止跨室推荐',
    '判定不予录用',
    '不予录用',
    '直接将该候选人标记为"不匹配"并终止',
    '直接判定为"年龄不匹配"',
    '直接拒绝',
    '不提供任何人工审核放行机制',
    '一票否决',
    '立即阻断',
  ];
  for (const kw of TERMINAL) if (text.includes(kw)) return 'terminal';

  const NEEDS_HUMAN = [
    '立即挂起',
    '暂停推荐',
    '挂起匹配',
    '挂起该候选人',
    '暂停该候选人',
    '暂停后续推荐',
    '锁定推荐流程',
    '锁定该候选人',
    '待HSM确认',
    '待 HSM 确认',
    '需HSM判定',
    '需 HSM 判定',
    '需 HSM 确认',
    '需HSM核实',
    '需 HSM 核实',
    '由 HSM 判定',
    '由HSM判定',
    '仅当HSM',
    '仅当 HSM',
    '生成一条',
    '生成并发送一条',
    '发送系统通知',
    '审核提醒',
    '待办任务',
    '人工核查',
    '待确认',
    '人工核查后决定',
    '人工核查并备注',
  ];
  for (const kw of NEEDS_HUMAN) if (text.includes(kw)) return 'needs_human';

  return 'flag_only';
}

function normalizeRaw(r: RawRule): Rule {
  const standardizedLogicRule = r.standardizedLogicRule ?? '';
  return {
    id: r.id,
    specificScenarioStage: r.specificScenarioStage ?? '',
    businessLogicRuleName: r.businessLogicRuleName ?? '',
    applicableClient: r.applicableClient ?? '通用',
    applicableDepartment: r.applicableDepartment ?? 'N/A',
    submissionCriteria: r.submissionCriteria ?? '',
    standardizedLogicRule,
    relatedEntities: r.relatedEntities ?? [],
    businessBackgroundReason: r.businessBackgroundReason ?? '',
    ruleSource: r.ruleSource ?? '',
    executor: r.executor,
    severity: inferSeverity(standardizedLogicRule),
  };
}

/** Load all matchResume rules (id starts with "10-") from bundled JSON. */
export function loadAllRules(): Rule[] {
  if (CACHED_ALL_RULES) return CACHED_ALL_RULES;
  const data = rulesData as { rules: RawRule[] };
  const matchResumeRaw = data.rules.filter((r) => r.id.startsWith('10-'));
  CACHED_ALL_RULES = matchResumeRaw.map(normalizeRaw);
  return CACHED_ALL_RULES;
}

function matchesDepartment(applicableDept: string, queryBg: string | null): boolean {
  if (!applicableDept) return true;
  const normalized = applicableDept.trim();
  if (normalized === 'N/A' || normalized === '通用' || normalized === '') return true;
  const allowed = normalized
    .split(/[、,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.length === 0) return true;
  if (!queryBg) return false;
  return allowed.includes(queryBg);
}

function matches(r: Rule, q: OntologyDims): boolean {
  if (r.executor !== 'Agent') return false;
  if (r.applicableClient !== '通用' && r.applicableClient !== q.client_id) return false;
  if (!matchesDepartment(r.applicableDepartment, q.business_group)) return false;
  return true;
}

/** Filter rules applicable to the given (client × business_group × studio) dimensions. */
export function filterRules(dims: OntologyDims): { rules: Rule[]; total: number } {
  const all = loadAllRules();
  const filtered = all.filter((r) => matches(r, dims));
  return { rules: filtered, total: all.length };
}

function hasDepartmentCondition(r: Rule): boolean {
  const d = r.applicableDepartment.trim();
  return d !== '' && d !== 'N/A' && d !== '通用';
}

/** Classify into general / client / department buckets + severity index. */
export function classifyRules(rules: Rule[]): ClassifiedRules {
  const general = rules.filter((r) => r.applicableClient === '通用');
  const client_level = rules.filter(
    (r) => r.applicableClient !== '通用' && !hasDepartmentCondition(r),
  );
  const department_level = rules.filter(
    (r) => r.applicableClient !== '通用' && hasDepartmentCondition(r),
  );
  return {
    general,
    client_level,
    department_level,
    by_severity: {
      terminal: rules.filter((r) => r.severity === 'terminal'),
      needs_human: rules.filter((r) => r.severity === 'needs_human'),
      flag_only: rules.filter((r) => r.severity === 'flag_only'),
    },
  };
}

// ─── client_id / business_group 归一化(来自 RaasRequirement 的扩展字段) ───

/** "CLI_TENCENT" → "腾讯", "CLI_BYTEDANCE" → "字节",其余原样。 */
export function normalizeClientId(id: string): string {
  if (!id) return '';
  const upper = id.toUpperCase();
  if (upper.includes('TENCENT')) return '腾讯';
  if (upper.includes('BYTEDANCE') || upper.includes('BYTE')) return '字节';
  return id;
}

/** "CLI_TENCENT_PCG" / "CLI_TENCENT_IEG_TIANMEI" → "PCG" / "IEG"。 */
export function deriveBgFromDepartmentId(deptId?: string | null): string | null {
  if (!deptId) return null;
  const upper = deptId.toUpperCase();
  for (const bg of ['IEG', 'PCG', 'WXG', 'CDG', 'CSIG', 'TEG', 'TIKTOK']) {
    if (upper.includes(`_${bg}_`) || upper.endsWith(`_${bg}`)) {
      return bg === 'TIKTOK' ? 'TikTok' : bg;
    }
  }
  return null;
}

/** Extract (client × business_group × studio) dims from a RaasRequirement-shaped object. */
export function extractDims(jr: Record<string, unknown>): OntologyDims {
  const clientId = typeof jr.client_id === 'string' ? jr.client_id : '';
  const explicitBg =
    typeof jr.client_business_group === 'string' && jr.client_business_group.trim()
      ? (jr.client_business_group as string)
      : null;
  const deptId = typeof jr.client_department_id === 'string' ? jr.client_department_id : null;
  const studio =
    typeof jr.client_studio === 'string' && jr.client_studio.trim() ? (jr.client_studio as string) : null;

  return {
    client_id: normalizeClientId(clientId),
    business_group: explicitBg ?? deriveBgFromDepartmentId(deptId),
    studio,
  };
}
