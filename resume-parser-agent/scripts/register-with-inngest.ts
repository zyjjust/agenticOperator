// 让远端 Inngest dev server 注册到本机 :3020/api/inngest

const INNGEST = process.env.INNGEST_BASE_URL ?? 'http://10.100.0.70:8288';
const AO_LAN_IP = process.env.AO_LAN_IP ?? '172.16.1.83';
const AO_PORT = process.env.AO_PORT ?? '3020';

const url = `http://${AO_LAN_IP}:${AO_PORT}/api/inngest`;

(async () => {
  console.log(`[register] inngest=${INNGEST}`);
  console.log(`[register] this app url=${url}`);

  const r = await fetch(`${INNGEST}/fn/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });

  const text = await r.text();
  console.log(`[register] HTTP ${r.status}`);
  console.log(text);

  if (!r.ok) process.exit(1);
})().catch((e) => {
  console.error('[register] FAIL:', e);
  process.exit(1);
});
