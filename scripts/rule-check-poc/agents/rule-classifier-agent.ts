// RuleClassifierAgent — multi-agent pipeline 的第 2 个 sub-agent。
//
// 把 OntologyQueryAgent 过滤后的扁平 Rule[] 重新组织成多视图,
// 服务于 PromptComposerAgent 的渲染:
//   - 按 applicableClient 三级分组 (通用 / 客户 / 部门)
//   - 按 severity 分桶 (terminal / needs_human / flag_only)

import type { Rule, ClassifiedRules } from '../types';

export class RuleClassifierAgent {
  classify(rules: Rule[]): ClassifiedRules {
    const general = rules.filter((r) => r.applicableClient === '通用');

    const clientLevel = rules.filter(
      (r) => r.applicableClient !== '通用' && !this.hasDepartmentCondition(r),
    );

    const departmentLevel = rules.filter(
      (r) => r.applicableClient !== '通用' && this.hasDepartmentCondition(r),
    );

    const bySeverity = {
      terminal: rules.filter((r) => r.severity === 'terminal'),
      needs_human: rules.filter((r) => r.severity === 'needs_human'),
      flag_only: rules.filter((r) => r.severity === 'flag_only'),
    };

    return {
      general,
      client_level: clientLevel,
      department_level: departmentLevel,
      by_severity: bySeverity,
    };
  }

  /**
   * 一条 rule 是否带"具体部门"维度限制。
   * applicableDepartment 是 'N/A' 或 '通用' 时表示不限,否则是具体 BG 限制。
   */
  private hasDepartmentCondition(r: Rule): boolean {
    const dept = r.applicableDepartment.trim();
    return dept !== '' && dept !== 'N/A' && dept !== '通用';
  }
}
