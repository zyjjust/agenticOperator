// SeverityInferenceAgent — 从 standardizedLogicRule 文本推断 severity 等级。
//
// 现状:ontology 里所有 rule 都没有显式的 severity 字段。短期方案是从 rule
// 的自然语言描述里识别关键词来分类:
//
//   terminal     — 含"立即终止"/"立即拦截"/"立即终止匹配流程"/"判定不予录用"/"拦截"等
//   needs_human  — 含"挂起"/"暂停"/"待人工确认"/"通知 HSM"/"待办"/"需 HSM 判定"等
//   flag_only    — 兜底:其他情况(标记/记录但不阻断)
//
// 中期(陈洋的活):在 ontology Rule 节点加 gating_severity 字段,移除推断逻辑。

import type { Rule, Severity } from '../types';

export class SeverityInferenceAgent {
  /** 给定一条原始 rule(没 severity 字段),返回带 severity 的副本。 */
  inferOne(rawRule: Omit<Rule, 'severity'>): Rule {
    return { ...rawRule, severity: this.classifyText(rawRule.standardizedLogicRule) };
  }

  /** 批量推断 — pipeline 里 OntologyQueryAgent 调一次就把 severity 都填好。 */
  inferAll(rawRules: Array<Omit<Rule, 'severity'>>): Rule[] {
    return rawRules.map((r) => this.inferOne(r));
  }

  /** 核心分类逻辑。 */
  private classifyText(text: string): Severity {
    // 优先级 1: terminal 关键词(强终止信号)
    const TERMINAL_KEYWORDS = [
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
    for (const kw of TERMINAL_KEYWORDS) {
      if (text.includes(kw)) return 'terminal';
    }

    // 优先级 2: needs_human 关键词(暂停 + 等人工反馈)
    const NEEDS_HUMAN_KEYWORDS = [
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
    for (const kw of NEEDS_HUMAN_KEYWORDS) {
      if (text.includes(kw)) return 'needs_human';
    }

    // 优先级 3: 兜底为 flag_only(只标记不阻断)
    return 'flag_only';
  }
}
