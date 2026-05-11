// OntologyQueryAgent — multi-agent pipeline 的第 1 个 sub-agent。
//
// 职责:
//   1. 从 ontology 来源(Neo4j 或 JSON 文件)拉所有 matchResume rules
//   2. 按维度过滤 — applicableClient + applicableDepartment + executor=Agent
//   3. 由 SeverityInferenceAgent 注入 severity 字段
//
// 支持两种 backend:
//   - Neo4j (神奇 RAAS_LINKS_NEO4J_* env 已配置 + 数据库可达 + 有 Rule 节点)
//   - JSON file fallback (ontology-lab/data/rules_20260330.json)
//
// 用哪种 backend 由 PipelineResult.source 字段告诉调用方。

import { readFileSync } from 'node:fs';
import neo4j, { Driver } from 'neo4j-driver';
import type { Rule, OntologyQuery } from '../types';
import { SeverityInferenceAgent } from './severity-inference-agent';

// ─── JSON file fallback path ────────────────────────────────────────
const ONTOLOGY_RULES_JSON = new URL(
  '../../../event_manager/Action_and_Event_Manager/ontology-lab/data/rules_20260330.json',
  import.meta.url,
).pathname;

interface RawRule {
  id: string;
  specificScenarioStage: string;
  businessLogicRuleName: string;
  applicableClient: string;
  applicableDepartment: string;
  submissionCriteria: string;
  standardizedLogicRule: string;
  relatedEntities?: string[];
  businessBackgroundReason?: string;
  ruleSource?: string;
  executor: 'Agent' | 'Human';
}

export interface QueryResult {
  rules: Rule[];
  source: 'neo4j' | 'json-file';
  total_in_source: number;
}

export class OntologyQueryAgent {
  private cachedAllRules: Rule[] | null = null;
  private cachedSource: 'neo4j' | 'json-file' | null = null;

  constructor(private readonly severityAgent: SeverityInferenceAgent) {}

  /** Lazy-load 所有 matchResume rules,优先 Neo4j,失败则回退 JSON。 */
  async loadAllRules(): Promise<{ rules: Rule[]; source: 'neo4j' | 'json-file' }> {
    if (this.cachedAllRules && this.cachedSource) {
      return { rules: this.cachedAllRules, source: this.cachedSource };
    }

    // 1. 试 Neo4j
    const neo4jResult = await this.tryLoadFromNeo4j();
    if (neo4jResult) {
      this.cachedAllRules = neo4jResult;
      this.cachedSource = 'neo4j';
      return { rules: neo4jResult, source: 'neo4j' };
    }

    // 2. 回退 JSON
    const jsonRules = this.loadFromJson();
    this.cachedAllRules = jsonRules;
    this.cachedSource = 'json-file';
    return { rules: jsonRules, source: 'json-file' };
  }

  /**
   * 按维度过滤 — Stage 2 of multi-agent pipeline。
   *
   * 过滤逻辑:
   *   1. id 以 "10-" 开头(matchResume action 的 rules)
   *   2. executor === 'Agent'(跳过 Human-only 规则)
   *   3. applicableClient 匹配:
   *        - '通用' 总是激活
   *        - 等于 query.client_id 时激活
   *   4. applicableDepartment 匹配:
   *        - 'N/A' 或 '通用' → 客户范围内不限部门,激活
   *        - 否则按"、"或","拆分,query.business_group 在列表里才激活
   */
  async query(q: OntologyQuery): Promise<QueryResult> {
    const { rules: all, source } = await this.loadAllRules();

    const filtered = all.filter((r) => this.matches(r, q));
    return { rules: filtered, source, total_in_source: all.length };
  }

  // ─── Filter logic ────────────────────────────────────────────────

  private matches(r: Rule, q: OntologyQuery): boolean {
    // matchResume action 的 rule_id 以 "10-" 开头
    if (!r.id.startsWith('10-')) return false;

    // 仅 Agent 执行的规则
    if (r.executor !== 'Agent') return false;

    // applicableClient 匹配
    if (r.applicableClient !== '通用' && r.applicableClient !== q.client_id) return false;

    // applicableDepartment 匹配
    if (!this.matchesDepartment(r.applicableDepartment, q.business_group)) return false;

    return true;
  }

  /**
   * applicableDepartment 字段的取值情况(从真实 ontology 探查得到):
   *   'N/A'                                   — 不限部门,激活
   *   '通用'                                   — 不限部门,激活(跟 N/A 等价)
   *   'IEG'                                    — 仅当 jr.business_group === 'IEG'
   *   'CDG'                                    — 仅当 jr.business_group === 'CDG'
   *   'IEG、PCG、WXG、CSIG、TEG、S线'         — jr.business_group ∈ 列表
   *   'PCG，WXG，CDG，CSIG，TEG，S线'         — 同上(注意是中文逗号)
   */
  private matchesDepartment(applicableDepartment: string, queryBg: string | null): boolean {
    if (!applicableDepartment) return true;
    const normalized = applicableDepartment.trim();
    if (normalized === 'N/A' || normalized === '通用' || normalized === '') return true;

    // 拆分:支持 "、" 和 "," 和 "，"
    const allowed = normalized
      .split(/[、,，]/)
      .map((s) => s.trim())
      .filter(Boolean);

    if (allowed.length === 0) return true; // 兜底
    if (!queryBg) return false;
    return allowed.includes(queryBg);
  }

  // ─── Neo4j backend ───────────────────────────────────────────────

  private async tryLoadFromNeo4j(): Promise<Rule[] | null> {
    const uri = process.env.RAAS_LINKS_NEO4J_URI;
    const user = process.env.RAAS_LINKS_NEO4J_USER;
    const password = process.env.RAAS_LINKS_NEO4J_PASSWORD;
    const database = process.env.RAAS_LINKS_NEO4J_DATABASE ?? 'neo4j';

    if (!uri || !user || !password) {
      console.error('  [ontology-query] Neo4j env not configured, will fallback to JSON');
      return null;
    }

    let driver: Driver | null = null;
    try {
      driver = neo4j.driver(uri, neo4j.auth.basic(user, password), {
        connectionTimeout: 10_000,
        disableLosslessIntegers: true,
      });

      const session = driver.session({ database });
      try {
        // 尝试常见的 Rule 节点 label;按真实 ontology 可能的命名规则
        const labelsToTry = ['Rule', 'BusinessLogicRule', 'BusinessRule'];
        for (const label of labelsToTry) {
          const cypher = `
            MATCH (r:\`${label}\`)
            WHERE r.id STARTS WITH '10-'
            RETURN r {
              .id,
              .specificScenarioStage,
              .businessLogicRuleName,
              .applicableClient,
              .applicableDepartment,
              .submissionCriteria,
              .standardizedLogicRule,
              .relatedEntities,
              .businessBackgroundReason,
              .ruleSource,
              .executor
            } AS r
          `;
          const result = await session.run(cypher);
          if (result.records.length > 0) {
            console.error(
              `  [ontology-query] Neo4j success: label=${label}, ${result.records.length} matchResume rules`,
            );
            const raw = result.records.map((rec) => rec.get('r') as RawRule);
            return this.severityAgent.inferAll(raw.map((r) => this.normalizeRaw(r)));
          }
        }
        console.error(
          '  [ontology-query] Neo4j connected but no Rule nodes with id starting "10-" found; will fallback to JSON',
        );
        return null;
      } finally {
        await session.close();
      }
    } catch (err) {
      console.error(
        `  [ontology-query] Neo4j unreachable: ${(err as Error).message.slice(0, 200)}; will fallback to JSON`,
      );
      return null;
    } finally {
      if (driver) await driver.close();
    }
  }

  // ─── JSON file backend ───────────────────────────────────────────

  private loadFromJson(): Rule[] {
    const raw = readFileSync(ONTOLOGY_RULES_JSON, 'utf-8');
    const data = JSON.parse(raw) as { rules: RawRule[] };
    const matchResumeRaw = data.rules.filter((r) => r.id.startsWith('10-'));
    console.error(
      `  [ontology-query] loaded ${matchResumeRaw.length} matchResume rules from JSON file`,
    );
    return this.severityAgent.inferAll(matchResumeRaw.map((r) => this.normalizeRaw(r)));
  }

  /** 把 RawRule(可能字段缺失)归一化成 Omit<Rule, 'severity'>。 */
  private normalizeRaw(r: RawRule): Omit<Rule, 'severity'> {
    return {
      id: r.id,
      specificScenarioStage: r.specificScenarioStage ?? '',
      businessLogicRuleName: r.businessLogicRuleName ?? '',
      applicableClient: r.applicableClient ?? '通用',
      applicableDepartment: r.applicableDepartment ?? 'N/A',
      submissionCriteria: r.submissionCriteria ?? '',
      standardizedLogicRule: r.standardizedLogicRule ?? '',
      relatedEntities: r.relatedEntities ?? [],
      businessBackgroundReason: r.businessBackgroundReason ?? '',
      ruleSource: r.ruleSource ?? '',
      executor: r.executor,
    };
  }
}
