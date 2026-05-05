// 一次性脚本：重放截图里那条 RAAS 测试事件 + 收集所有 JSON
// 不改 production 代码，只是发事件 + 用 Inngest API 拉运行详情

import { Inngest } from 'inngest';

const SCREENSHOT_EVENT = {
  name: 'RESUME_DOWNLOADED',
  data: {
    bucket: 'recruit-resume-raw',
    employeeId: '0000206419',
    etag: 'real-2026-04-28-shen-zhi-zhong',
    filename: '【游戏测试（全国招聘）_深圳 7-11K】谌治中 3年.pdf',
    hrFolder: 'xiaqi-0000206419',
    objectKey:
      '2026/04/e7b3dde7-b4fc-96dc-6a9b-d2e2facd57db-【游戏测试（全国招聘）_深圳 7-11K】谌治中 3年.pdf',
    receivedAt: '2026-04-28T03:00:00Z',
    size: null,
    sourceEventName: 'raas-real-pdf-test',
  },
};

const INNGEST = process.env.INNGEST_BASE_URL ?? 'http://10.100.0.70:8288';

const client = new Inngest({
  id: 'replay-tester',
  eventKey: process.env.INNGEST_EVENT_KEY ?? 'dev',
  baseUrl: INNGEST,
  isDev: true,
});

async function fetchJson(url: string): Promise<unknown> {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) return { _error: `HTTP ${r.status}`, _url: url };
  return r.json();
}

(async () => {
  console.log('=== STEP 0 — 发送的 RESUME_DOWNLOADED 事件 ===');
  console.log(JSON.stringify(SCREENSHOT_EVENT, null, 2));

  const sent = await client.send(SCREENSHOT_EVENT);
  const eventId = sent.ids[0];
  console.log(`\n=== STEP 1 — Inngest 接受 ===\nevent_id: ${eventId}`);

  // 等 30s 让两个 function 跑完
  console.log('\n等 35s 让两个 LLM step 跑完...');
  await new Promise((r) => setTimeout(r, 35_000));

  console.log('\n=== STEP 2 — 探测 Inngest 可用 API endpoint ===');
  for (const path of [
    `/v1/events/${eventId}/runs`,
    `/v1/events/${eventId}`,
    `/v1/runs?event_id=${eventId}`,
    `/v0/runs?event_id=${eventId}`,
    `/v0/events/${eventId}`,
  ]) {
    const url = `${INNGEST}${path}`;
    const r = await fetch(url).catch(() => null);
    console.log(`  ${path} → ${r ? `HTTP ${r.status}` : 'failed'}`);
  }

  // 拉这条事件触发的所有 run
  console.log('\n=== STEP 3 — 这条事件触发的 runs ===');
  const runsResp = (await fetchJson(`${INNGEST}/v1/events/${eventId}/runs`)) as {
    data?: Array<{ run_id: string; function_id: string; status: string }>;
  };
  console.log(JSON.stringify(runsResp, null, 2));

  if (!runsResp.data || !Array.isArray(runsResp.data)) {
    console.log('\n(没拿到 runs，下面直接结束 — 看 Inngest UI 取详情)');
    return;
  }

  for (const run of runsResp.data) {
    console.log(`\n=== STEP 4 — Run ${run.run_id} (${run.function_id}) status=${run.status} ===`);
    const detail = await fetchJson(`${INNGEST}/v1/runs/${run.run_id}`);
    console.log(JSON.stringify(detail, null, 2));

    const jobs = await fetchJson(`${INNGEST}/v1/runs/${run.run_id}/jobs`);
    console.log(`\n--- jobs of ${run.run_id} ---`);
    console.log(JSON.stringify(jobs, null, 2));
  }

  // 也把它派生出来的 RESUME_PROCESSED / MATCH_* 找出来
  console.log('\n=== STEP 5 — 看派生事件 (RESUME_PROCESSED / MATCH_*) ===');
  for (const evt of ['RESUME_PROCESSED', 'MATCH_PASSED_NEED_INTERVIEW', 'MATCH_PASSED_NO_INTERVIEW', 'MATCH_FAILED']) {
    const url = `${INNGEST}/v1/events?name=${encodeURIComponent(evt)}&limit=3`;
    const data = await fetchJson(url);
    console.log(`\n--- 最近 3 条 ${evt} ---`);
    console.log(JSON.stringify(data, null, 2));
  }
})().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});
