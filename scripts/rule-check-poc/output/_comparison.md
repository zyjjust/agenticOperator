# Rule-Check Prompt POC — 8 场景对比

Source: **neo4j** · Total matchResume rules: **51**

## 1. 场景一览

每行一个 (candidate × jd) 组合,展示维度过滤后的规则统计 + 预期 LLM 决策。

| # | Scenario | Candidate | JD | rules | gen | client | dept | term | nh | flag | expected | LLM result |
|---|----------|-----------|----|-------|-----|--------|------|------|----|----|----------|------------|
| 1 | **01-clean-baseline-keep** | 张三 — 5 年前端,阿里 + 字节背景,清白无红线 | 腾讯 PCG 高级前端 (jr_x99) | 27 | 17 | 8 | 2 | 13 | 9 | 5 | **KEEP** | PAUSE ⚠️ |
| 2 | **02-huawei-cooldown-pause** | 李四 — Frontend,1.5 个月前从华为离职 (3 月冷冻期… | 腾讯 PCG 高级前端 (jr_x99) | 27 | 17 | 8 | 2 | 13 | 9 | 5 | **PAUSE** | PAUSE ✅ |
| 3 | **03-csi-blacklist-drop** | 王五 — Java 后端,前华腾员工,离职编码 B8 (有犯罪记录-… | 腾讯 IEG 后台 Java 工程师 (jr_v55) | 30 | 17 | 8 | 5 | 14 | 9 | 7 | **DROP** | DROP ✅ |
| 4 | **04-tencent-ieg-history-pause** | 赵六 — 游戏后端,前腾讯 IEG 天美工作室员工,主动离职 14 月 | 腾讯 IEG 天美工作室 游戏服务端 (jr_z77) | 30 | 17 | 8 | 5 | 14 | 9 | 7 | **PAUSE** | DROP ⚠️ |
| 5 | **05-foreign-marital-pause** | 周七 — 数据分析师,美籍华人,28 岁未婚女性 | 腾讯 CDG 数据分析师 (jr_y88) | 27 | 17 | 8 | 2 | 14 | 8 | 5 | **PAUSE** | PAUSE ✅ |
| 6 | **06-bytedance-history-pause** | 钱八 — Frontend,前字节跳动正式员工,2 年前主动离职 | 字节 TikTok 海外 Web 前端 (jr_w66) | 28 | 17 | 11 | 0 | 13 | 6 | 9 | **PAUSE** | PAUSE ✅ |

## 2. 候选人 fixture 列表

### `c01-zhangsan-clean` — 张三 — 5 年前端,阿里 + 字节背景,清白无红线
- 期待触发: 所有规则 PASS / NOT_APPLICABLE → KEEP

### `c02-lisi-huawei-recent` — 李四 — Frontend,1.5 个月前从华为离职 (3 月冷冻期内)
- 期待触发: 通用 10-25 (华为竞对未满 3 月) → REVIEW → PAUSE

### `c03-wangwu-csi-blacklist` — 王五 — Java 后端,前华腾员工,离职编码 B8 (有犯罪记录-YCH)
- 期待触发: 通用 10-17 (高风险回流人员) → FAIL → DROP

### `c04-zhaoliu-tencent-ieg` — 赵六 — 游戏后端,前腾讯 IEG 天美工作室员工,主动离职 14 月
- 期待触发: 腾讯 10-38 (历史从业核实) + 部门级 10-3 (IEG 活跃流程)

### `c05-zhouqi-foreign-data` — 周七 — 数据分析师,美籍华人,28 岁未婚女性
- 期待触发: 腾讯 10-35 (外籍通道 flag) + 10-47 (婚育风险审视) → PAUSE

### `c06-qianba-bytedance-history` — 钱八 — Frontend,前字节跳动正式员工,2 年前主动离职
- 期待触发: 字节 10-49 (字节正编员工回流标记) → REVIEW → PAUSE

## 3. JD fixture 列表

### `jr-tencent-pcg-frontend` — 腾讯 PCG 高级前端 (jr_x99)
- client=CLI_TENCENT · business_group=PCG · studio=— · tags=[]

### `jr-tencent-cdg-data` — 腾讯 CDG 数据分析师 (jr_y88)
- client=CLI_TENCENT · business_group=CDG · studio=— · tags=[]

### `jr-tencent-ieg-tianmei` — 腾讯 IEG 天美工作室 游戏服务端 (jr_z77)
- client=CLI_TENCENT · business_group=IEG · studio=天美 · tags=[]

### `jr-bytedance-tiktok-fe` — 字节 TikTok 海外 Web 前端 (jr_w66)
- client=CLI_BYTEDANCE · business_group=TikTok · studio=— · tags=["外语"]

### `jr-tencent-java` — 腾讯 IEG 后台 Java 工程师 (jr_v55)
- client=CLI_TENCENT · business_group=IEG · studio=— · tags=[]

## 4. 各场景命中的 rule_id 列表

### 1. 01-clean-baseline-keep (27 rules)

- **通用 (CSI)** (17): `10-5` (terminal), `10-6` (flag_only), `10-7` (terminal), `10-8` (flag_only), `10-9` (terminal), `10-10` (terminal), `10-12` (needs_human), `10-14` (terminal), `10-15` (terminal), `10-16` (terminal), `10-17` (terminal), `10-18` (needs_human), `10-24` (flag_only), `10-25` (needs_human), `10-26` (needs_human), `10-29` (terminal), `10-54` (terminal)
- **客户级 (腾讯)** (8): `10-27` (needs_human), `10-28` (terminal), `10-35` (needs_human), `10-38` (terminal), `10-39` (terminal), `10-45` (flag_only), `10-46` (needs_human), `10-47` (needs_human)
- **部门级 (bg=PCG / studio=—)** (2): `10-40` (needs_human), `10-53` (flag_only)

### 2. 02-huawei-cooldown-pause (27 rules)

- **通用 (CSI)** (17): `10-5` (terminal), `10-6` (flag_only), `10-7` (terminal), `10-8` (flag_only), `10-9` (terminal), `10-10` (terminal), `10-12` (needs_human), `10-14` (terminal), `10-15` (terminal), `10-16` (terminal), `10-17` (terminal), `10-18` (needs_human), `10-24` (flag_only), `10-25` (needs_human), `10-26` (needs_human), `10-29` (terminal), `10-54` (terminal)
- **客户级 (腾讯)** (8): `10-27` (needs_human), `10-28` (terminal), `10-35` (needs_human), `10-38` (terminal), `10-39` (terminal), `10-45` (flag_only), `10-46` (needs_human), `10-47` (needs_human)
- **部门级 (bg=PCG / studio=—)** (2): `10-40` (needs_human), `10-53` (flag_only)

### 3. 03-csi-blacklist-drop (30 rules)

- **通用 (CSI)** (17): `10-5` (terminal), `10-6` (flag_only), `10-7` (terminal), `10-8` (flag_only), `10-9` (terminal), `10-10` (terminal), `10-12` (needs_human), `10-14` (terminal), `10-15` (terminal), `10-16` (terminal), `10-17` (terminal), `10-18` (needs_human), `10-24` (flag_only), `10-25` (needs_human), `10-26` (needs_human), `10-29` (terminal), `10-54` (terminal)
- **客户级 (腾讯)** (8): `10-27` (needs_human), `10-28` (terminal), `10-35` (needs_human), `10-38` (terminal), `10-39` (terminal), `10-45` (flag_only), `10-46` (needs_human), `10-47` (needs_human)
- **部门级 (bg=IEG / studio=—)** (5): `10-40` (needs_human), `10-3` (flag_only), `10-43` (terminal), `10-52` (flag_only), `10-56` (flag_only)

### 4. 04-tencent-ieg-history-pause (30 rules)

- **通用 (CSI)** (17): `10-5` (terminal), `10-6` (flag_only), `10-7` (terminal), `10-8` (flag_only), `10-9` (terminal), `10-10` (terminal), `10-12` (needs_human), `10-14` (terminal), `10-15` (terminal), `10-16` (terminal), `10-17` (terminal), `10-18` (needs_human), `10-24` (flag_only), `10-25` (needs_human), `10-26` (needs_human), `10-29` (terminal), `10-54` (terminal)
- **客户级 (腾讯)** (8): `10-27` (needs_human), `10-28` (terminal), `10-35` (needs_human), `10-38` (terminal), `10-39` (terminal), `10-45` (flag_only), `10-46` (needs_human), `10-47` (needs_human)
- **部门级 (bg=IEG / studio=天美)** (5): `10-40` (needs_human), `10-3` (flag_only), `10-43` (terminal), `10-52` (flag_only), `10-56` (flag_only)

### 5. 05-foreign-marital-pause (27 rules)

- **通用 (CSI)** (17): `10-5` (terminal), `10-6` (flag_only), `10-7` (terminal), `10-8` (flag_only), `10-9` (terminal), `10-10` (terminal), `10-12` (needs_human), `10-14` (terminal), `10-15` (terminal), `10-16` (terminal), `10-17` (terminal), `10-18` (needs_human), `10-24` (flag_only), `10-25` (needs_human), `10-26` (needs_human), `10-29` (terminal), `10-54` (terminal)
- **客户级 (腾讯)** (8): `10-27` (needs_human), `10-28` (terminal), `10-35` (needs_human), `10-38` (terminal), `10-39` (terminal), `10-45` (flag_only), `10-46` (needs_human), `10-47` (needs_human)
- **部门级 (bg=CDG / studio=—)** (2): `10-42` (terminal), `10-53` (flag_only)

### 6. 06-bytedance-history-pause (28 rules)

- **通用 (CSI)** (17): `10-5` (terminal), `10-6` (flag_only), `10-7` (terminal), `10-8` (flag_only), `10-9` (terminal), `10-10` (terminal), `10-12` (needs_human), `10-14` (terminal), `10-15` (terminal), `10-16` (terminal), `10-17` (terminal), `10-18` (needs_human), `10-24` (flag_only), `10-25` (needs_human), `10-26` (needs_human), `10-29` (terminal), `10-54` (terminal)
- **客户级 (字节)** (11): `10-32` (flag_only), `10-33` (flag_only), `10-34` (terminal), `10-1` (flag_only), `10-2` (flag_only), `10-11` (flag_only), `10-21` (terminal), `10-22` (terminal), `10-36` (needs_human), `10-49` (needs_human), `10-51` (flag_only)
- **部门级 (bg=TikTok / studio=—)**: 无

## 5. 维度过滤效果验证

下面这些 rule_id 应当**只在某些场景中出现**,可以快速人工核对过滤逻辑是否正确:

| rule_id | 应只在以下场景激活 | 实际激活的场景 | |
|---------|-------------------|----------------|--|
| `10-3` | 03-csi-blacklist-drop, 04-tencent-ieg-history-pause | 03-csi-blacklist-drop, 04-tencent-ieg-history-pause | ✅ |
| `10-42` | 05-foreign-marital-pause | 05-foreign-marital-pause | ✅ |
| `10-43` | 04-tencent-ieg-history-pause | 03-csi-blacklist-drop, 04-tencent-ieg-history-pause | ❌ |
| `10-21` | 06-bytedance-history-pause | 06-bytedance-history-pause | ✅ |
| `10-32` | 06-bytedance-history-pause | 06-bytedance-history-pause | ✅ |
| `10-38` | 01-clean-baseline-keep, 02-huawei-cooldown-pause, 03-csi-blacklist-drop, 04-tencent-ieg-history-pause, 05-foreign-marital-pause | 01-clean-baseline-keep, 02-huawei-cooldown-pause, 03-csi-blacklist-drop, 04-tencent-ieg-history-pause, 05-foreign-marital-pause | ✅ |
| `10-40` | 01-clean-baseline-keep, 02-huawei-cooldown-pause, 03-csi-blacklist-drop, 04-tencent-ieg-history-pause | 01-clean-baseline-keep, 02-huawei-cooldown-pause, 03-csi-blacklist-drop, 04-tencent-ieg-history-pause | ✅ |

## 6. LLM 实际输出预览

### 1. 01-clean-baseline-keep

- **预期**: KEEP — 清白前端候选人投腾讯 PCG 前端,所有规则 PASS / NOT_APPLICABLE
- model: google/gemini-3-flash-preview · duration: 55982ms · tokens: 9479 in / 3083 out
- **LLM 决策**: `PAUSE` ⚠️ MISMATCH
- drop_reasons: []
- pause_reasons: ["10-12:AGE_LOGIC_ERROR"]

### 2. 02-huawei-cooldown-pause

- **预期**: PAUSE — 前端候选人 1.5 月前从华为离职,通用 10-25 < 3 月冷冻期 → REVIEW
- model: google/gemini-3-flash-preview · duration: 16907ms · tokens: 9445 in / 3213 out
- **LLM 决策**: `PAUSE` ✅
- drop_reasons: []
- pause_reasons: ["10-25:competitor_cooling_off"]

### 3. 03-csi-blacklist-drop

- **预期**: DROP — Java 候选人有华腾 B8 高风险离职编码,通用 10-17 → FAIL → DROP
- model: google/gemini-3-flash-preview · duration: 18467ms · tokens: 10185 in / 3460 out
- **LLM 决策**: `DROP` ✅
- drop_reasons: ["10-17:high_risk_csi_returnee"]
- pause_reasons: []

### 4. 04-tencent-ieg-history-pause

- **预期**: PAUSE — 游戏后端候选人有腾讯 IEG 天美历史经历,腾讯 10-38 触发历史从业核实
- model: google/gemini-3-flash-preview · duration: 19005ms · tokens: 10227 in / 3731 out
- **LLM 决策**: `DROP` ⚠️ MISMATCH
- drop_reasons: ["10-38:TENCENT_HISTORY_VERIFY","10-43:IEG_STUDIO_MUTEX"]
- pause_reasons: ["10-40:IEG_QUICK_RETURN_REVIEW","10-46:TENCENT_RETURN_CERT_NEEDED","10-47:TENCENT_MARRIAGE_RISK"]

### 5. 05-foreign-marital-pause

- **预期**: PAUSE — 美籍 28F未婚 数据分析师投腾讯 CDG,10-35 + 10-47 → REVIEW
- model: google/gemini-3-flash-preview · duration: 203173ms · tokens: 9359 in / 3147 out
- **LLM 决策**: `PAUSE` ✅
- drop_reasons: []
- pause_reasons: ["10-35:foreign_nationality","10-47:female_age_marriage_risk"]

### 6. 06-bytedance-history-pause

- **预期**: PAUSE — 前字节正编员工投字节 TikTok,字节 10-49 (字节正编回流凭证校验) → REVIEW
- model: google/gemini-3-flash-preview · duration: 17110ms · tokens: 9362 in / 3430 out
- **LLM 决策**: `PAUSE` ✅
- drop_reasons: []
- pause_reasons: ["10-49:former_bytedance_employee"]

---

_生成时间: 2026-05-09T12:58:34.731Z_