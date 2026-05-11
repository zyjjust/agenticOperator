# Rule-Check Prompt Builder — Multi-Agent POC

> 独立的后端 POC，验证 [docs/rule-check-prompt-pipeline.md](../../docs/rule-check-prompt-pipeline.md)
> 中叶洋负责的 prompt 编译逻辑。**不接入 workflow agents，纯本地跑**。

## 跑起来

```bash
npx tsx scripts/rule-check-poc/run-demo.ts
```

输出会写到 [scripts/rule-check-poc/output/](output/)，并在控制台打印统计。

## 这个 POC 在演示什么

按 [docs/rule-check-prompt-pipeline.md §0.2](../../docs/rule-check-prompt-pipeline.md) 的"三层 agent
体系"，本 POC 实现了 L2 sub-agent 的 prompt 编译部分（叶洋的活），由 3 个 sub-agent 串行组成：

```
JobRequisition + ParsedResume
       │
       ▼
┌────────────────────────┐
│ OntologyQueryAgent      │  按 (client × business_group × studio × tags)
│                         │  从 mock Neo4j 过滤 Rule[]
└──────────┬──────────────┘
           ▼
┌────────────────────────┐
│ RuleClassifierAgent     │  按 applicable_client 三级分组
│                         │  + 按 severity 分桶
└──────────┬──────────────┘
           ▼
┌────────────────────────┐
│ PromptComposerAgent     │  渲染成完整 user prompt 字符串
│                         │  + 生成 expected output JSON 模板
└──────────┬──────────────┘
           ▼
PipelineResult { user_prompt, expected_llm_output, ... }
```

## 文件结构

```
scripts/rule-check-poc/
├── README.md
├── types.ts                            - 共享 TS types (Rule / JobRequisition / ParsedResume / ...)
├── mock-rules.ts                        - 20 条 mock 规则,代替 Neo4j (含 condition_business_groups
│                                         / condition_studios / condition_tags_required 维度字段)
├── agents/
│   ├── ontology-query-agent.ts          - L2 sub-agent #1: 按维度过滤 rules
│   ├── rule-classifier-agent.ts         - L2 sub-agent #2: 分组 (通用/客户/部门 + by severity)
│   └── prompt-composer-agent.ts         - L2 sub-agent #3: 渲染 6 段式 markdown
├── pipeline.ts                          - 三个 agent 的 orchestrator
├── scenarios.ts                         - 4 个测试场景 (覆盖维度过滤的 happy path)
├── run-demo.ts                          - main entry,跑 4 场景 + 写文件
└── output/                              - 生成的 prompt 和对比表
```

## 4 个测试场景

挑选了能激活不同 rule 子集的 (client, business_group, studio, tags) 组合：

| 场景 | client | business_group | studio | tags | 关键验证 |
|------|--------|----------------|--------|------|----------|
| `tencent-pcg`           | 腾讯 | PCG  | —    | []     | 应激活 10-40 (PCG ∈ 主动离职冷冻名单)，**不**激活 10-3/10-42/10-43 |
| `tencent-cdg`           | 腾讯 | CDG  | —    | []     | 应激活 10-42 (CDG 6 月绝对拦截)，**不**激活 10-40 (CDG 不在冷冻名单) |
| `tencent-ieg-tianmei`   | 腾讯 | IEG  | 天美 | []     | 应激活 10-3、10-40、10-43 (IEG + 天美 ∈ 四大工作室) |
| `bytedance-tiktok`      | 字节 | TikTok | —  | [外语] | 应激活字节 client 规则 + 通用 10-14 (tags 含"外语")，**不**激活任何腾讯规则 |

## 输出文件

跑完后 [output/](output/) 下会有：

- `<scenario>.user-prompt.md` — 完整 user prompt（直接喂给 LLM 的字符串）
- `<scenario>.expected-output.json` — 期待的 LLM 返回 JSON 模板（rule_flags 数组每条对应一条激活的 rule）
- `_summary.md` — 跨场景对比 + 维度过滤验证表（含 ✅/❌）

## 跟 docs/rule-check-prompt-pipeline.md 的对应关系

| 本 POC | 在文档里 |
|--------|----------|
| `OntologyQueryAgent.query()` | §3.4 陈洋的 `getRulesForMatchResume` API |
| `MOCK_RULES` 数据结构 | §3.4 Rule schema |
| `RuleClassifierAgent.classify()` | §3.5 Step 5 中的 `renderRulesSection` 三级分组 |
| `PromptComposerAgent.compose()` | §3.5 Step 4-6 整体（INPUT 段 + RULES 段 + OUTPUT 段）|
| `pipeline.run()` 输出的 `user_prompt` | §3.5 叶洋 `getRuleCheckPrompt` 的 return value |
| `pipeline.run()` 输出的 `expected_llm_output` | §3.6 Step 6 zod schema 校验时的目标形态 |

## 升级到生产路径

POC 跑通后，升级到接入 workflow agent 只需：

1. **OntologyQueryAgent** → 替换 `MOCK_RULES` in-memory 过滤为 Neo4j Cypher 查询（用项目里已有的 `neo4j-driver`）
2. **PromptComposerAgent** → 不动，直接复用
3. **Pipeline** → 包装成 `MatchResumeActionObject.getRuleCheckPrompt(args)` 类方法，注入到雨函的 `RuleCheckAgent`（[docs §3.5 / §3.6](../../docs/rule-check-prompt-pipeline.md)）
4. **mock-rules.ts** → 删掉，rules 改由 Neo4j 拉

## 已知 POC 简化

- 只 mock 了 20 条 rule（生产 50+），覆盖代表性维度过滤即可
- `severity` 字段是手工标的（生产应在 ontology Rule 节点存 `gating_severity`）
- 所有 `natural_language` 文本是从设计文档复制过来的；生产中应存在 Neo4j Rule 节点上
- 没有连真实 Neo4j；本 POC 不依赖任何外部服务，断网也能跑
