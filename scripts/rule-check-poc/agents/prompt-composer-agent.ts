// PromptComposerAgent — multi-agent pipeline 的第 3 个 sub-agent。
//
// 接收 (input, classified rules, dims),渲染成完整的 user prompt markdown 字符串,
// 直接喂给雨函的 RuleCheckAgent。
//
// 完整 user prompt 由三大块组成:
//   ┌─ INPUT 段       (动态 — 候选人简历 + 招聘需求 + HSM 反馈)
//   ├─ RULES 段       (动态 — 按 (client × department) 维度过滤后的规则集)
//   └─ OUTPUT 段      (固定 — 决策逻辑 + JSON schema + 自检)
//
// 输出严格遵守 docs/rule-check-prompt-pipeline.md §3.5 / §4 三段式。
//
// 提供两套 API:
//   - compose() 返回完整 prompt 字符串 (生产用)
//   - composeSections() 返回拆好的各段 (debug / 对比用)

import type {
  Rule,
  ClassifiedRules,
  OntologyQuery,
  RuleCheckPromptInput,
  PromptSections,
} from '../types';

const SEVERITY_TAG: Record<Rule['severity'], string> = {
  terminal: '终止级',
  needs_human: '需人工复核',
  flag_only: '仅记录',
};

// ─── 固定段(运行时不变) ──────────────────────────────────────────────

const HEADER = '# Resume Pre-Screen Rule Check';

const ROLE_SECTION = `## 1. 你的角色

你是一名简历预筛查员。系统会给你一份候选人的解析后简历,以及一个具体的客户原始需求(Job_Requisition)。你的任务是逐条检查下列所有规则,找出哪些规则在这份简历上命中,并把结果整理成结构化标签输出。

请特别注意:
- **不要给候选人打匹配分数。** 打分是下游 Robohire 的工作。
- 你的输出会驱动三种处理:DROP / PAUSE / KEEP。
- 简历缺少某个字段时,该字段相关的规则应标 \`result="NOT_APPLICABLE"\`,不要编造证据。`;

const DECISION_LOGIC_SECTION = `## 4. 决策结算逻辑

跑完全部 applicable 规则后:
1. 任一 \`rule_flags[i].result == "FAIL"\` → \`overall_decision = "DROP"\`
2. 否则任一 \`result == "REVIEW"\` → \`overall_decision = "PAUSE"\`
3. 否则 → \`overall_decision = "KEEP"\`

无论决策哪个,\`rule_flags\` 必须覆盖 §3 中**每一条**规则(不适用的写 NOT_APPLICABLE)。`;

const OUTPUT_SCHEMA_SECTION = `## 5. 输出格式

返回严格符合下列结构的 JSON,不允许多余字段,不允许遗漏字段:

\`\`\`json
{
  "candidate_id": "...",
  "job_requisition_id": "...",
  "client_id": "...",
  "overall_decision": "KEEP" | "DROP" | "PAUSE",
  "drop_reasons": ["<rule_id>:<short_code>"],
  "pause_reasons": ["<rule_id>:<short_code>"],
  "rule_flags": [
    {
      "rule_id": "...",
      "rule_name": "...",
      "applicable_client": "通用" | "<client>",
      "severity": "terminal" | "needs_human" | "flag_only",
      "applicable": true | false,
      "result": "PASS" | "FAIL" | "REVIEW" | "NOT_APPLICABLE",
      "evidence": "<引用简历原文>",
      "next_action": "continue" | "block" | "pause" | "notify_recruiter" | "notify_hsm"
    }
  ],
  "resume_augmentation": "<给 Robohire 的 markdown 标记段>",
  "notifications": [
    {
      "recipient": "招聘专员" | "HSM",
      "channel": "InApp" | "Email",
      "rule_id": "...",
      "message": "..."
    }
  ]
}
\`\`\``;

const SELF_CHECK_SECTION = `## 6. 提交前自检

- [ ] rule_flags 覆盖 §3 所有规则(不适用写 NOT_APPLICABLE)
- [ ] overall_decision 跟 drop_reasons / pause_reasons 一致
- [ ] 每条 evidence 引用了简历原文,简历未提供时写"简历未提供 <字段>,标 NOT_APPLICABLE"
- [ ] resume_augmentation 是给 Robohire 看的可读 markdown
- [ ] 不要给候选人打匹配分数`;

// ─── PromptComposerAgent 主体 ────────────────────────────────────────

export class PromptComposerAgent {
  /**
   * 返回拆好的各段 + 完整 prompt。
   *
   * 完整 user prompt 的组成:
   *   sections.header
   *   + sections.role
   *   + sections.inputs       ← INPUT 段
   *   + sections.rules        ← RULES 段
   *   + sections.decision_logic
   *   + sections.output_schema ← OUTPUT 段(JSON schema)
   *   + sections.self_check
   *
   * 即 sections.full = 上面 7 段用 \n\n 拼起来。
   */
  composeSections(args: {
    inputs: RuleCheckPromptInput;
    classified: ClassifiedRules;
    dims: OntologyQuery;
  }): PromptSections {
    const inputsSection = this.renderInputsSection(args.inputs, args.dims);
    const rulesSection = this.renderRulesSection(args.classified, args.dims);

    const sections: Omit<PromptSections, 'full'> = {
      header: HEADER,
      role: ROLE_SECTION,
      inputs: inputsSection,
      rules: rulesSection,
      decision_logic: DECISION_LOGIC_SECTION,
      output_schema: OUTPUT_SCHEMA_SECTION,
      self_check: SELF_CHECK_SECTION,
    };

    const full = [
      sections.header,
      sections.role,
      sections.inputs,
      sections.rules,
      sections.decision_logic,
      sections.output_schema,
      sections.self_check,
    ].join('\n\n');

    return { ...sections, full };
  }

  /** 简便方法:只要完整 prompt 字符串。 */
  compose(args: {
    inputs: RuleCheckPromptInput;
    classified: ClassifiedRules;
    dims: OntologyQuery;
  }): string {
    return this.composeSections(args).full;
  }

  /** 期待的 LLM 输出 JSON 模板 — 给雨函 schema 校验用。 */
  expectedOutputSkeleton(args: {
    inputs: RuleCheckPromptInput;
    classified: ClassifiedRules;
  }): string {
    const allRules = [
      ...args.classified.general,
      ...args.classified.client_level,
      ...args.classified.department_level,
    ];
    const skeleton = {
      candidate_id: args.inputs.runtime_context.candidate_id,
      job_requisition_id: args.inputs.job_requisition.job_requisition_id,
      client_id: args.inputs.job_requisition.client_id ?? '',
      overall_decision: '<KEEP|DROP|PAUSE>',
      drop_reasons: ['<rule_id>:<short_code>'],
      pause_reasons: ['<rule_id>:<short_code>'],
      rule_flags: allRules.map((r) => ({
        rule_id: r.id,
        rule_name: r.businessLogicRuleName,
        applicable_client: r.applicableClient,
        severity: r.severity,
        applicable: '<true|false>',
        result: '<PASS|FAIL|REVIEW|NOT_APPLICABLE>',
        evidence: '<引用简历原文>',
        next_action: '<continue|block|pause|notify_recruiter|notify_hsm>',
      })),
      resume_augmentation: '<给 Robohire 的 markdown 标记段>',
      notifications: [
        {
          recipient: '<招聘专员|HSM>',
          channel: '<InApp|Email>',
          rule_id: '<rule_id>',
          message: '<...>',
        },
      ],
    };
    return JSON.stringify(skeleton, null, 2);
  }

  // ─── 内部渲染方法 ────────────────────────────────────────────────

  /**
   * 渲染 §2 INPUTS 段。
   *
   * 输出 5 个清晰分块,每块对应生产 schema 中的一个数据来源:
   *
   *   2.1 runtime_context              ← RESUME_PROCESSED 事件透传
   *   2.2 resume                        ← RESUME_PROCESSED.parsed.data (RaasParseResumeData)
   *   2.3 job_requisition              ← RAAS getRequirementDetail.requirement (RaasRequirement)
   *   2.4 job_requisition_specification ← RAAS getRequirementDetail.specification
   *   2.5 hsm_feedback                  ← RAAS getHsmFeedback (可能 null)
   *
   * 这样 LLM 可以清楚知道"哪个字段从哪来",而不是看一坨混合的 JSON。
   */
  private renderInputsSection(input: RuleCheckPromptInput, dims: OntologyQuery): string {
    const ctx = input.runtime_context;
    const jr = input.job_requisition;
    const spec = input.job_requisition_specification ?? null;

    return [
      '## 2. Inputs',
      '',
      '本节展示这次 rule check 涉及的全部 runtime input,分 5 个数据块,各自对应 production 系统中的一个数据来源。LLM 应当按需引用这些字段(例如检查 \`resume.experience\` 时引用具体公司名 + 起止时间作为 evidence)。',
      '',
      '### 2.1 runtime_context — 来自 `RESUME_PROCESSED` 事件',
      '',
      '匹配请求的事件 anchor / metadata。这些字段不是简历内容,而是这次匹配请求的上下文(谁上传的、什么时候、对应哪个 upload_id)。',
      '',
      '```json',
      JSON.stringify(
        {
          ...ctx,
          // 派生维度,LLM 直接拿来按 client × business_group × studio 校验规则适用性
          _derived_dimensions: {
            client_id: dims.client_id,
            business_group: dims.business_group,
            studio: dims.studio,
          },
        },
        null,
        2,
      ),
      '```',
      '',
      '### 2.2 resume — 来自 `RESUME_PROCESSED.parsed.data` (RaasParseResumeData)',
      '',
      '候选人解析后的简历数据。生产中由 RoboHire `/parse-resume` 输出,字段定义见 [resume-parser-agent/lib/raas-api-client.ts:114] `RaasParseResumeData`。',
      '',
      '```json',
      JSON.stringify(input.resume, null, 2),
      '```',
      '',
      '### 2.3 job_requisition — 来自 RAAS `getRequirementDetail.requirement` (RaasRequirement)',
      '',
      '客户原始招聘需求(Job_Requisition canonical 字段)。所有规则匹配以此为准,**不**使用 createJdAgent 生成的 JD。字段定义见 [resume-parser-agent/lib/raas-api-client.ts:623] `RaasRequirement`。',
      '',
      '```json',
      JSON.stringify(jr, null, 2),
      '```',
      '',
      '### 2.4 job_requisition_specification — 来自 RAAS `getRequirementDetail.specification`',
      '',
      spec
        ? '招聘需求规约(优先级 / 截止 / 是否独家 / HSM/招聘专员 ID)。规则的通知路由(到 HSM Email vs 招聘专员 InApp)依赖此处的 employee_id。'
        : '本场景 `specification = null`(RAAS 没有为该需求登记 spec)。`hsm_employee_id` / `recruiter_employee_id` 不可用,通知路由按 fallback 处理。',
      '',
      '```json',
      JSON.stringify(spec, null, 2),
      '```',
      '',
      '### 2.5 hsm_feedback — 来自 RAAS `getHsmFeedback(candidate_id, job_requisition_id)`',
      '',
      input.hsm_feedback
        ? 'HSM 历史反馈数据。规则 10-28 / 10-39 / 10-46 等需要 HSM 二次输入的规则会从这里读取。'
        : '本场景 `hsm_feedback = null`(首次匹配,无 HSM 反馈)。需要 HSM 反馈才能判定的规则(10-28 / 10-39 等)应当标 `result="NOT_APPLICABLE"`。',
      '',
      '```json',
      JSON.stringify(input.hsm_feedback ?? null, null, 2),
      '```',
    ].join('\n');
  }

  private renderRulesSection(c: ClassifiedRules, dims: OntologyQuery): string {
    const sections: string[] = ['## 3. Rules to check'];

    sections.push(
      `### 3.1 通用规则 (CSI 级,所有客户必查 — ${c.general.length} 条)\n\n${this.renderRuleGroup(c.general)}`,
    );

    sections.push(
      `### 3.2 客户级规则 (本次 client_id="${dims.client_id}" — ${c.client_level.length} 条)\n\n${
        c.client_level.length > 0
          ? this.renderRuleGroup(c.client_level)
          : '> 本次激活的客户级规则:无'
      }`,
    );

    const deptHeader = `### 3.3 部门级规则 (本次 business_group="${dims.business_group ?? '无'}", studio="${dims.studio ?? '无'}" — ${c.department_level.length} 条)`;
    if (c.department_level.length > 0) {
      sections.push(`${deptHeader}\n\n${this.renderRuleGroup(c.department_level)}`);
    } else {
      sections.push(
        `${deptHeader}\n\n> 本次激活的部门级规则:无(被维度过滤排除的规则未出现在 prompt 中)`,
      );
    }

    return sections.join('\n\n');
  }

  private renderRuleGroup(rules: Rule[]): string {
    if (rules.length === 0) return '(无)';
    return rules.map((r) => this.renderSingleRule(r)).join('\n\n');
  }

  private renderSingleRule(r: Rule): string {
    return `#### 规则 ${r.id}:${r.businessLogicRuleName} [${SEVERITY_TAG[r.severity]}]

**触发条件**:${r.submissionCriteria || '(始终激活)'}

**判定逻辑**:${r.standardizedLogicRule}

**命中时的输出动作**:
- 在 \`rule_flags\` 中加一条 \`{rule_id: "${r.id}", severity: "${r.severity}", applicable: true, result: "${this.severityToResult(r.severity)}", evidence: "<引用简历原文>"}\`
- ${this.severityToActionHint(r)}`;
  }

  private severityToResult(s: Rule['severity']): string {
    switch (s) {
      case 'terminal':    return 'FAIL';
      case 'needs_human': return 'REVIEW';
      case 'flag_only':   return 'PASS';
    }
  }

  private severityToActionHint(r: Rule): string {
    switch (r.severity) {
      case 'terminal':
        return `\`drop_reasons\` 加 \`"${r.id}:<short_code>"\`,\`next_action\`="block"`;
      case 'needs_human':
        return `\`pause_reasons\` 加 \`"${r.id}:<short_code>"\`,\`notifications\` 加对应招聘专员/HSM 的通知,\`next_action\`="pause"`;
      case 'flag_only':
        return `仅在 \`resume_augmentation\` 文本里追加一行 flag,不写 drop/pause reasons,\`next_action\`="continue"`;
    }
  }
}
