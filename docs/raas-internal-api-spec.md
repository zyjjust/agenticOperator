# RAAS Dashboard 内部 API 接入说明

> **来源**：与 RAAS 团队（partner）的对接说明，2026-04-29。
> **作用**：AO 调 RAAS Internal API 拉 recruiter 已认领的 requirements，
> 用作 matchResume 的 JD 上下文。

## 1. 环境配置

**RAAS 侧 `backend/.env`**（partner 配）:

```bash
AGENT_API_KEY=your-shared-secret-here
```

**AO 侧 `.env.local`**（同一个值）:

```bash
RAAS_INTERNAL_API_URL=http://10.100.0.70:3001    # 生产内网地址
RAAS_AGENT_API_KEY=your-shared-secret-here
```

两侧的 `AGENT_API_KEY` 必须**完全一致**，否则返回 401。

## 2. 接口规格

```
GET {RAAS_INTERNAL_API_URL}/api/v1/internal/requirements
Authorization: Bearer {RAAS_AGENT_API_KEY}
```

### Query 参数

| 参数 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `claimer_employee_id` | 必填 | string | 招聘人员的 employee_id |
| `scope` | 选填 | string | `claimed`（默认）/ `watched` / `mine` |
| `page` | 选填 | int | 页码，默认 1 |
| `page_size` | 选填 | int | 每页条数，默认 20，最大 100 |
| `status` | 选填 | string | 需求状态，如 `recruiting` |
| `client_id` | 选填 | string | 按客户过滤 |

## 3. 响应结构

```json
{
  "items": [
    {
      "job_requisition_id": "jr-uuid",
      "client_id": "client-uuid",
      "client_job_id": "WXG-2026-001",
      "client_job_title": "高级后端工程师",
      "client_department_id": "dept-uuid",
      "first_level_department": "WXG",
      "work_city": "深圳",
      "headcount": 3,
      "status": "recruiting",
      "priority": "high",
      "salary_range": "30-50k",
      "publish_date": "2026-04-01T00:00:00.000Z",
      "expected_arrival_date": "2026-06-01T00:00:00.000Z",

      // 简历匹配核心字段
      "job_responsibility": "负责核心系统架构设计...",
      "job_requirement": "5年以上后端开发经验...",
      "degree_requirement": "本科及以上",
      "education_requirement": "计算机相关专业",
      "must_have_skills": ["Go", "分布式系统", "MySQL"],
      "nice_to_have_skills": ["Kubernetes", "Rust"],
      "language_requirements": "英语读写流利",
      "negative_requirement": "无",
      "work_years": 5,
      "expected_level": "T4-T5",
      "interview_mode": "现场面试",
      "required_arrival_date": "2026-06-01T00:00:00.000Z",
      "gender": null,
      "age_range": null,
      "recruitment_type": "社招",

      // 进度信息
      "our_application_count": 12,
      "headcount_filled": 1,
      "hsm_employee_id": "0000199059",
      "assigned_hsm_name": "张三"
    }
  ],
  "page": 1,
  "page_size": 20,
  "total": 5,
  "total_pages": 1
}
```

## 4. AO 调用代码（已实现）

实现位置：[`server/raas/internal-client.ts`](../server/raas/internal-client.ts)

- `listAllRequirements({ claimerEmployeeId, scope, status, pageSize })` — 拉单个 recruiter 全部 requirements
- `findRequirementById({ jobRequisitionId, claimerEmployeeId })` — 单个 requirement 精确查
- `flattenRequirementForMatch(req)` — 把响应 flatten 成给 RoboHire `/match-resume` 喂的 `jd` 文本
- `isRaasInternalApiConfigured()` — env guard

被 [`server/ws/agents/match-resume.ts`](../server/ws/agents/match-resume.ts) `resolveJds()` 用，模式 A（指定 job_requisition_id）走 `findRequirementById`，模式 B（fan-out）走 `listAllRequirements`。

## 5. 错误码

| HTTP | 含义 | 处理 |
|---|---|---|
| 401 | `AGENT_API_KEY` 不匹配或缺 header | 检查两侧 key 一致 |
| 400 | 缺 `claimer_employee_id` | 补传参数 |
| 503 | RAAS 服务未就绪 | 稍后重试 |

## 6. 分页（拉全量）

```ts
async function getAllClaimed(employeeId: string) {
  const all = [];
  let page = 1;
  while (true) {
    const data = await listAllRequirements({
      claimerEmployeeId: employeeId, scope: 'claimed', page, pageSize: 100,
    });
    all.push(...data.items);
    if (page >= data.total_pages) break;
    page++;
  }
  return all;
}
```

## 7. 当前 AO 接入状态

| 项 | 状态 |
|---|---|
| `RAAS_INTERNAL_API_URL` 在 `.env.local` | 🟡 检查 |
| `RAAS_AGENT_API_KEY` 在 `.env.local` | 🟡 检查（之前 .env.local 里好像没看到这两条） |
| `server/raas/internal-client.ts` 实现 | ✅ |
| `matchResume` resolveJds() 调用它 | ✅ |
| 跑通过的证据 | ✅ 之前看到 `Resolved 14 JDs (fan-out across recruiter roster) · source=raas-internal-api` |
