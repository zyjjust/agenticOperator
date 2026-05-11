# OUTPUT 段 — 06-bytedance-history-pause

这一段在所有场景下完全相同(除了 §2 / §3 的动态部分外固定的 §4-§6)。
LLM 必须严格遵守此 JSON schema 输出。

---

## 4. 决策结算逻辑

跑完全部 applicable 规则后:
1. 任一 `rule_flags[i].result == "FAIL"` → `overall_decision = "DROP"`
2. 否则任一 `result == "REVIEW"` → `overall_decision = "PAUSE"`
3. 否则 → `overall_decision = "KEEP"`

无论决策哪个,`rule_flags` 必须覆盖 §3 中**每一条**规则(不适用的写 NOT_APPLICABLE)。

## 5. 输出格式

返回严格符合下列结构的 JSON,不允许多余字段,不允许遗漏字段:

```json
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
```

## 6. 提交前自检

- [ ] rule_flags 覆盖 §3 所有规则(不适用写 NOT_APPLICABLE)
- [ ] overall_decision 跟 drop_reasons / pause_reasons 一致
- [ ] 每条 evidence 引用了简历原文,简历未提供时写"简历未提供 <字段>,标 NOT_APPLICABLE"
- [ ] resume_augmentation 是给 Robohire 看的可读 markdown
- [ ] 不要给候选人打匹配分数