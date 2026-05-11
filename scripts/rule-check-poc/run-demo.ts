// Demo entry — 跑 8 个 (candidate × jd) 组合,每个组合输出:
//   - <name>.input.json         候选人简历 + JR 原始 JSON (注入到 prompt 的 INPUT 段)
//   - <name>.rules.md           本场景激活的所有规则 (renderRulesSection 产出)
//   - <name>.output-schema.md   期待的 JSON 输出格式 (固定段)
//   - <name>.user-prompt.md     完整 user prompt = INPUT + RULES + OUTPUT
//   - <name>.expected.json      LLM 应当返回的 JSON 模板(每条 applicable rule 一个 flag)
//   - <name>.llm-response.json  LLM 实际返回 (含 --llm 时)
//
// 跨场景对比文件:
//   - _comparison.md            8 个场景 side-by-side 表格 + 维度过滤验证
//
// 用法:
//   npx tsx --env-file=.env.local scripts/rule-check-poc/run-demo.ts
//   npx tsx --env-file=.env.local scripts/rule-check-poc/run-demo.ts --llm

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENARIOS, CANDIDATES, JOB_REQUISITIONS } from './scenarios';
import { buildPipeline } from './pipeline';
import type { PipelineResult } from './types';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = resolve(__dirname, 'output');
const RUN_LLM = process.argv.includes('--llm');

async function main() {
  const pipeline = buildPipeline();

  console.log(`\nRunning ${SCENARIOS.length} (candidate × jd) scenarios${RUN_LLM ? ' (with --llm)' : ''}...\n`);
  const results: PipelineResult[] = [];
  for (const s of SCENARIOS) {
    process.stderr.write(`  ▸ ${s.name} ... `);
    const r = await pipeline.run(
      {
        scenarioName: s.name,
        input: s.input,
        candidateLabel: s.candidate_label,
        jdLabel: s.jd_label,
      },
      { runLLM: RUN_LLM },
    );
    process.stderr.write('done\n');
    results.push(r);
  }

  await mkdir(OUTPUT_DIR, { recursive: true });

  for (let i = 0; i < results.length; i++) {
    await writeScenarioFiles(results[i], SCENARIOS[i]);
  }

  await writeFile(
    resolve(OUTPUT_DIR, '_comparison.md'),
    buildComparison(results),
    'utf-8',
  );

  printConsoleSummary(results);
}

async function writeScenarioFiles(r: PipelineResult, s: typeof SCENARIOS[0]) {
  const base = r.scenario_name;

  // 1. input.json — 注入到 prompt §2 的真实数据,5 块对齐生产 schema
  await writeFile(
    resolve(OUTPUT_DIR, `${base}.input.json`),
    JSON.stringify(
      {
        // 元数据(给读者看的,不是 prompt 内容)
        _scenario: {
          name: r.scenario_name,
          candidate_label: r.candidate_label,
          jd_label: r.jd_label,
          dims: r.dims,
          source: r.source,
        },
        // 这 5 个 key 跟 prompt §2 的 5 个 sub-section 一一对应
        runtime_context: s.input.runtime_context,
        resume: s.input.resume,
        job_requisition: s.input.job_requisition,
        job_requisition_specification: s.input.job_requisition_specification,
        hsm_feedback: s.input.hsm_feedback,
      },
      null,
      2,
    ),
    'utf-8',
  );

  // 2. rules.md — 本场景激活的所有规则(prompt §3 段)
  const rulesHeader = [
    `# RULES 段 — ${base}`,
    '',
    `**Candidate**: ${r.candidate_label}`,
    `**Job Requisition**: ${r.jd_label}`,
    `**Dimensions**: client=\`${r.dims.client_id}\`, business_group=\`${r.dims.business_group ?? '—'}\`, studio=\`${r.dims.studio ?? '—'}\``,
    '',
    `**Rules after filter**: ${r.rules_after_filter} / ${r.rules_total_in_db}`,
    `- 通用 (CSI): ${r.classified.general.length}`,
    `- 客户级 (${r.dims.client_id}): ${r.classified.client_level.length}`,
    `- 部门级 (${r.dims.business_group ?? '—'} / ${r.dims.studio ?? '—'}): ${r.classified.department_level.length}`,
    '',
    `**By severity**:`,
    `- terminal: ${r.classified.by_severity.terminal.length}`,
    `- needs_human: ${r.classified.by_severity.needs_human.length}`,
    `- flag_only: ${r.classified.by_severity.flag_only.length}`,
    '',
    '---',
    '',
    '_下面是叶洋的 PromptComposerAgent 渲染产出的 RULES 段 markdown,会被作为完整 prompt 的 §3 节嵌入:_',
    '',
  ].join('\n');
  await writeFile(resolve(OUTPUT_DIR, `${base}.rules.md`), rulesHeader + r.prompt_sections.rules, 'utf-8');

  // 3. output-schema.md — LLM 应当输出的 JSON 格式定义
  const outputSchemaContent = [
    `# OUTPUT 段 — ${base}`,
    '',
    `这一段在所有场景下完全相同(除了 §2 / §3 的动态部分外固定的 §4-§6)。`,
    `LLM 必须严格遵守此 JSON schema 输出。`,
    '',
    '---',
    '',
    r.prompt_sections.decision_logic,
    '',
    r.prompt_sections.output_schema,
    '',
    r.prompt_sections.self_check,
  ].join('\n');
  await writeFile(resolve(OUTPUT_DIR, `${base}.output-schema.md`), outputSchemaContent, 'utf-8');

  // 4. user-prompt.md — INPUT + RULES + OUTPUT 完整组合
  await writeFile(resolve(OUTPUT_DIR, `${base}.user-prompt.md`), r.prompt_sections.full, 'utf-8');

  // 5. expected.json — LLM 应该返回的 JSON 模板
  await writeFile(resolve(OUTPUT_DIR, `${base}.expected.json`), r.expected_llm_output, 'utf-8');

  // 6. (optional) llm-response.json — 实际 LLM 返回
  if (r.llm_output) {
    const dump = {
      model_used: r.llm_output.model_used,
      duration_ms: r.llm_output.duration_ms,
      prompt_tokens: r.llm_output.prompt_tokens,
      completion_tokens: r.llm_output.completion_tokens,
      parse_error: r.llm_output.parse_error,
      expected_decision: s.expected_decision,
      expected_reason: s.expected_reason,
      parsed_json: r.llm_output.parsed_json,
      raw_text: r.llm_output.raw_text,
    };
    await writeFile(
      resolve(OUTPUT_DIR, `${base}.llm-response.json`),
      JSON.stringify(dump, null, 2),
      'utf-8',
    );
  }
}

function buildComparison(results: PipelineResult[]): string {
  const lines: string[] = [
    '# Rule-Check Prompt POC — 8 场景对比',
    '',
    `Source: **${results[0]?.source}** · Total matchResume rules: **${results[0]?.rules_total_in_db ?? 0}**`,
    '',
    '## 1. 场景一览',
    '',
    '每行一个 (candidate × jd) 组合,展示维度过滤后的规则统计 + 预期 LLM 决策。',
    '',
    '| # | Scenario | Candidate | JD | rules | gen | client | dept | term | nh | flag | expected | LLM result |',
    '|---|----------|-----------|----|-------|-----|--------|------|------|----|----|----------|------------|',
    ...results.map((r, i) => {
      const s = SCENARIOS[i];
      const llmDecision = r.llm_output
        ? (r.llm_output.parse_error
            ? '❌'
            : `${(r.llm_output.parsed_json as any)?.overall_decision ?? '?'}`)
        : '—';
      const matches =
        r.llm_output && !r.llm_output.parse_error
          ? (r.llm_output.parsed_json as any)?.overall_decision === s.expected_decision
            ? ' ✅'
            : ' ⚠️'
          : '';
      return `| ${i + 1} | **${r.scenario_name}** | ${truncate(r.candidate_label, 35)} | ${truncate(r.jd_label, 30)} | ${r.rules_after_filter} | ${r.classified.general.length} | ${r.classified.client_level.length} | ${r.classified.department_level.length} | ${r.classified.by_severity.terminal.length} | ${r.classified.by_severity.needs_human.length} | ${r.classified.by_severity.flag_only.length} | **${s.expected_decision}** | ${llmDecision}${matches} |`;
    }),
    '',
    '## 2. 候选人 fixture 列表',
    '',
    ...CANDIDATES.flatMap((c) => [
      `### \`${c.id}\` — ${c.label}`,
      `- 期待触发: ${c.expected_trigger}`,
      '',
    ]),
    '## 3. JD fixture 列表',
    '',
    ...JOB_REQUISITIONS.flatMap((j) => [
      `### \`${j.id}\` — ${j.label}`,
      `- client=${j.jr.client_id} · business_group=${j.jr.client_business_group ?? '—'} · studio=${j.jr.client_studio ?? '—'} · tags=${JSON.stringify(j.jr.tags ?? [])}`,
      '',
    ]),
    '## 4. 各场景命中的 rule_id 列表',
    '',
    ...results.flatMap((r, i) => [
      `### ${i + 1}. ${r.scenario_name} (${r.rules_after_filter} rules)`,
      '',
      ruleIdsTable(r),
      '',
    ]),
    '## 5. 维度过滤效果验证',
    '',
    '下面这些 rule_id 应当**只在某些场景中出现**,可以快速人工核对过滤逻辑是否正确:',
    '',
    '| rule_id | 应只在以下场景激活 | 实际激活的场景 | |',
    '|---------|-------------------|----------------|--|',
    ...buildVerificationRows(results),
    '',
  ];

  if (results.some((r) => r.llm_output)) {
    lines.push('## 6. LLM 实际输出预览');
    lines.push('');
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const s = SCENARIOS[i];
      if (r.llm_output) {
        lines.push(`### ${i + 1}. ${r.scenario_name}`);
        lines.push('');
        lines.push(`- **预期**: ${s.expected_decision} — ${s.expected_reason}`);
        lines.push(
          `- model: ${r.llm_output.model_used} · duration: ${r.llm_output.duration_ms}ms · tokens: ${r.llm_output.prompt_tokens ?? '?'} in / ${r.llm_output.completion_tokens ?? '?'} out`,
        );
        if (r.llm_output.parse_error) {
          lines.push(`- ❌ parse_error: ${r.llm_output.parse_error}`);
        } else {
          const j = r.llm_output.parsed_json as Record<string, unknown> | null;
          const matches = j?.overall_decision === s.expected_decision ? '✅' : '⚠️ MISMATCH';
          lines.push(`- **LLM 决策**: \`${j?.overall_decision ?? '(none)'}\` ${matches}`);
          lines.push(`- drop_reasons: ${JSON.stringify(j?.drop_reasons ?? [])}`);
          lines.push(`- pause_reasons: ${JSON.stringify(j?.pause_reasons ?? [])}`);
        }
        lines.push('');
      }
    }
  }

  lines.push('---');
  lines.push('');
  lines.push(`_生成时间: ${new Date().toISOString()}_`);
  return lines.join('\n');
}

function ruleIdsTable(r: PipelineResult): string {
  const groups: Array<{ label: string; rules: typeof r.classified.general }> = [
    { label: '通用 (CSI)', rules: r.classified.general },
    { label: `客户级 (${r.dims.client_id})`, rules: r.classified.client_level },
    {
      label: `部门级 (bg=${r.dims.business_group ?? '—'} / studio=${r.dims.studio ?? '—'})`,
      rules: r.classified.department_level,
    },
  ];
  const out: string[] = [];
  for (const g of groups) {
    if (g.rules.length === 0) {
      out.push(`- **${g.label}**: 无`);
    } else {
      out.push(
        `- **${g.label}** (${g.rules.length}): ${g.rules.map((x) => `\`${x.id}\` (${x.severity})`).join(', ')}`,
      );
    }
  }
  return out.join('\n');
}

function buildVerificationRows(results: PipelineResult[]): string[] {
  const expectations: Array<{ ruleId: string; shouldBeIn: string[] }> = [
    { ruleId: '10-3',  shouldBeIn: results.filter(r => r.dims.business_group === 'IEG').map(r => r.scenario_name) },
    { ruleId: '10-42', shouldBeIn: results.filter(r => r.dims.business_group === 'CDG').map(r => r.scenario_name) },
    { ruleId: '10-43', shouldBeIn: results.filter(r => r.dims.business_group === 'IEG' && r.dims.studio).map(r => r.scenario_name) },
    { ruleId: '10-21', shouldBeIn: results.filter(r => r.dims.client_id === '字节').map(r => r.scenario_name) },
    { ruleId: '10-32', shouldBeIn: results.filter(r => r.dims.client_id === '字节').map(r => r.scenario_name) },
    { ruleId: '10-38', shouldBeIn: results.filter(r => r.dims.client_id === '腾讯').map(r => r.scenario_name) },
    { ruleId: '10-40', shouldBeIn: results.filter(r => r.dims.client_id === '腾讯' && ['IEG','PCG','WXG','CSIG','TEG','S线'].includes(r.dims.business_group ?? '')).map(r => r.scenario_name) },
  ];
  return expectations.map(({ ruleId, shouldBeIn }) => {
    const actuallyIn = results
      .filter((r) =>
        [
          ...r.classified.general,
          ...r.classified.client_level,
          ...r.classified.department_level,
        ].some((rule) => rule.id === ruleId),
      )
      .map((r) => r.scenario_name);
    const expected = new Set(shouldBeIn);
    const actual = new Set(actuallyIn);
    const ok =
      expected.size === actual.size && [...expected].every((s) => actual.has(s));
    const status = ok ? '✅' : '❌';
    return `| \`${ruleId}\` | ${shouldBeIn.length ? shouldBeIn.join(', ') : '(无)'} | ${actuallyIn.length ? actuallyIn.join(', ') : '(无)'} | ${status} |`;
  });
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function printConsoleSummary(results: PipelineResult[]): void {
  console.log('\n' + '═'.repeat(96));
  console.log(' Rule-Check Prompt POC — Demo Result');
  console.log('═'.repeat(96) + '\n');

  console.log(`Source: ${results[0]?.source}`);
  console.log(`Total matchResume rules: ${results[0]?.rules_total_in_db ?? 0}\n`);

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const s = SCENARIOS[i];
    console.log('─'.repeat(96));
    console.log(`#${i + 1} ${r.scenario_name}`);
    console.log('─'.repeat(96));
    console.log(`  Candidate:  ${r.candidate_label}`);
    console.log(`  JD:         ${r.jd_label}`);
    console.log(`  Dimensions: client=${r.dims.client_id} bg=${r.dims.business_group ?? '—'} studio=${r.dims.studio ?? '—'}`);
    console.log(`  Rules:      ${r.rules_after_filter}/${r.rules_total_in_db}  (gen=${r.classified.general.length} client=${r.classified.client_level.length} dept=${r.classified.department_level.length})`);
    console.log(`              terminal=${r.classified.by_severity.terminal.length} needs_human=${r.classified.by_severity.needs_human.length} flag_only=${r.classified.by_severity.flag_only.length}`);
    console.log(`  Prompt size: ${r.prompt_sections.full.length} chars`);
    console.log(`  Expected: ${s.expected_decision} — ${s.expected_reason}`);
    if (r.llm_output) {
      const j = r.llm_output.parsed_json as Record<string, unknown> | null;
      const llmDecision = r.llm_output.parse_error ? `❌ parse_error` : (j?.overall_decision ?? '?');
      const matches =
        !r.llm_output.parse_error && j?.overall_decision === s.expected_decision ? '✅' : '⚠️';
      console.log(`  LLM:      ${llmDecision} ${matches}  (model=${r.llm_output.model_used}, ${r.llm_output.duration_ms}ms, ${r.llm_output.prompt_tokens ?? '?'}/${r.llm_output.completion_tokens ?? '?'} tokens)`);
    }
    console.log();
  }

  console.log('═'.repeat(96));
  console.log(` Output dir: scripts/rule-check-poc/output/`);
  console.log(` Per-scenario files: <name>.input.json / .rules.md / .output-schema.md / .user-prompt.md / .expected.json`);
  if (results[0]?.llm_output) console.log(`                    + .llm-response.json`);
  console.log(` Cross-scenario:     _comparison.md`);
  console.log('═'.repeat(96) + '\n');
}

main().catch((err) => {
  console.error('Demo failed:', err);
  process.exit(1);
});
