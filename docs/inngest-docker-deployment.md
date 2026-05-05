# Inngest Dockerized Deployment + Partner Connection Info

## TL;DR — partner 怎么连

```
Partner 发事件用：       http://172.16.1.83:8288/e/dev
Partner 看事件 / Runs：  http://172.16.1.83:8288  (浏览器打开)
事件名：                RESUME_DOWNLOADED
```

> 前提：partner 的机器要能 ping 通 `172.16.1.83`。如果他们在 `10.100.0.70` 网段（之前确认过单向不通），就**到不了我们这台**，需要走 RAAS 桥（参考最后一节"网络受限时的备选"）。

---

## 1. 部署状态

```
✓ 镜像   inngest/inngest:latest  (v1.18.0-04558d797)
✓ 容器   ao-inngest               Up 9 minutes
✓ 端口   8288 → 8288 (events API + dashboard UI)
         8289 → 8289 (connect-gateway)
✓ 持久化  --persist + 命名卷 inngest-data (sqlite, 容器重启不丢数据)
✓ 自动同步两个 SDK：
         - http://host.docker.internal:3002/api/inngest  ← AO 主仓库
         - http://host.docker.internal:3020/api/inngest  ← 旧 prototype 项目
✓ 健康   curl http://localhost:8288/health  →  {"status":200,"message":"OK"}
```

容器配置文件：[docker-compose.inngest.yml](../docker-compose.inngest.yml)

---

## 2. 启停命令

```bash
# 启动（后台）
docker compose -f docker-compose.inngest.yml up -d

# 看日志
docker compose -f docker-compose.inngest.yml logs -f

# 停掉
docker compose -f docker-compose.inngest.yml down

# 停掉并清空持久数据（事件历史也清掉）
docker compose -f docker-compose.inngest.yml down -v
```

---

## 3. Partner 的接入端点（外部可访问）

| 用途 | URL | 方法 |
|---|---|---|
| **发事件**（partner 主要用这个） | `http://172.16.1.83:8288/e/dev` | POST |
| **看事件流**（dashboard UI） | `http://172.16.1.83:8288` | 浏览器 |
| **拉事件列表**（程序读取） | `http://172.16.1.83:8288/v1/events?limit=50` | GET |
| **拉某条事件的详情** | `http://172.16.1.83:8288/v1/events/<event_id>` | GET |
| **拉某条事件触发的 fn runs** | `http://172.16.1.83:8288/v1/events/<event_id>/runs` | GET |

> `dev` 是 Inngest dev 模式的 event key，固定值。生产部署需要换成真实 signing key。

---

## 4. Partner 发 RESUME_DOWNLOADED 的 curl 模板

```bash
curl -X POST http://172.16.1.83:8288/e/dev \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "RESUME_DOWNLOADED",
    "data": {
      "entity_type": "Candidate",
      "entity_id": null,
      "event_id": "501463e2-b629-613b-ca20-ca1c4b4e2f89",
      "payload": {
        "upload_id": "501463e2-b629-613b-ca20-ca1c4b4e2f89",
        "bucket": "recruit-resume-raw",
        "object_key": "2026/04/501463e2-...-陈语泓.pdf",
        "filename": "陈语泓 24年毕业.pdf",
        "etag": null,
        "size": 1234567,
        "hr_folder": null,
        "employee_id": "EMP-002",
        "source_event_name": null,
        "received_at": "2026-04-28T01:00:00.000Z",
        "source_label": "RAAS Web Console",
        "summary_prefix": "手动上传简历",
        "operator_id": "EMP-002",
        "operator_name": "招聘小张",
        "operator_role": "recruiter",
        "ip_address": "127.0.0.1",
        "candidate_name": null,
        "candidate_id": null,
        "resume_file_path": "2026/04/501463e2-...-陈语泓.pdf"
      },
      "trace": {
        "trace_id": null,
        "request_id": null,
        "workflow_id": null,
        "parent_trace_id": null
      }
    }
  }'
```

成功返回：

```json
{ "ids": ["01KQ9AMXF4XMD94YQDEM6G689T"], "status": 200 }
```

返回的 `ids[0]` 就是事件在 Inngest 总线上的 ID。partner 可以用它去 `/v1/events/<id>/runs` 看 AO 这边消费的进度。

---

## 5. 这次跑通的端到端验证（10 分钟前）

我用上面的 URL 自己 POST 了一条 `RESUME_DOWNLOADED`（用内联 `resume_text` 因为 MinIO 现在是断开的），9 秒走完整条链：

| 时刻 | 事件 | event_id |
|---|---|---|
| 05:58:00.161 | `RESUME_DOWNLOADED` | `01KQ9AMXF4XMD94YQDEM6G689T` |
| 05:58:04.444 | `RESUME_PROCESSED` | `01KQ9AN1Q5XHS1P3ZS31Q7T3YG` |
| 05:58:09.235 | `MATCH_PASSED_NO_INTERVIEW` | `01KQ9AN6GEAGWHT0CBQ05ZC4XD` |

| Run | function | status |
|---|---|---|
| `01KQ9AMXQ9B79DTMA12DEGQJV8` | `processResume (workflow node 9-1)` | **Completed** |
| (cascade) | `matchResume (workflow node 10)` | **Completed** |

输出 score = **85**, recommendation = **STRONG_MATCH**, outcome = **MATCH_PASSED_NO_INTERVIEW**。

完整 3 条事件 JSON 在 [data/e2e-out/docker-inngest-20260428T135839/](../data/e2e-out/docker-inngest-20260428T135839/)。

---

## 6. 关键改动（让 Docker Inngest 能 callback 到 host 上的 AO）

### `.env.local`

```
INNGEST_DEV=http://localhost:8288
INNGEST_BASE_URL=http://localhost:8288

# 关键：从 Docker 容器内部，"localhost" 指容器自己，不是 host。
# AO 必须告诉 Inngest "请回调 host.docker.internal:3002 来跑我"，
# 否则 Inngest dispatch 会发到容器自己的 3002，端口空，EOF。
INNGEST_SERVE_HOST=http://host.docker.internal:3002
INNGEST_SERVE_PATH=/api/inngest
```

如果未来 Inngest 切回原生（不在 Docker），把这两行删掉就行。

### docker-compose.inngest.yml

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"   # Linux Docker 也能用 host.docker.internal
```

Docker Desktop（Mac/Win）原生支持 `host.docker.internal`，加这一行是为了 Linux 兼容。

---

## 7. 网络受限时的备选方案 — RAAS 桥

如果 partner 在 `10.100.0.70` 网段、单向打不通我们 `172.16.1.83`：

1. Partner 把事件发到他自己的 Inngest（`10.100.0.70:8288`）
2. AO 这边 enable bridge，**主动拉**他那边的事件，重新发到我们的本地 Inngest

```bash
# .env.local 改两行：
RAAS_BRIDGE_ENABLED=1
RAAS_INNGEST_URL=http://10.100.0.70:8288
```

代码 [server/inngest/raas-bridge.ts](../server/inngest/raas-bridge.ts) 已经实现：每 5 秒 GET 一次他那边的 `/v1/events?limit=20`，过滤 `RESUME_DOWNLOADED` 重新 publish 到本地。流量只走 我们 → partner 一个方向，绕过反向不通的问题。

---

## 8. 给 partner 的精简 README

```markdown
# AO 接入 — partner 速查

## 总线地址
- Events API: http://172.16.1.83:8288
- 浏览器看事件: http://172.16.1.83:8288

## 发事件
POST http://172.16.1.83:8288/e/dev
Body: 见 spec §3 RESUME_DOWNLOADED 信封示例

## 收事件回执
我们解析完会发 RESUME_PROCESSED（同一总线），按 spec §4 入库。

## 排错
- 拿到 ids 但 AO 没反应？查 http://172.16.1.83:8288/v1/events/<id>/runs
- 总线 unreachable？检查能否 ping 172.16.1.83；不通的话改用 RAAS 桥模式。
```
