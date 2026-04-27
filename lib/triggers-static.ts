/**
 * Static catalog of known cron + webhook triggers.
 *
 * P2: served by /api/triggers as the source of cron/webhook entries.
 *     Upstream-emit entries are derived dynamically from AGENT_MAP.
 * P3: replaced by EM `ingestion_configs` + WS scheduler config when those
 *     services live in-process.
 */

import type { TriggerKind } from './api/types';

type Seed = {
  id: string;
  kind: TriggerKind;
  name: string;
  description: string;
  emits: string[];
  schedule?: string;
  endpoint?: string;
};

export const TRIGGER_CATALOG: Seed[] = [
  // Cron (5)
  { id: 'cron-rms-sync',     kind: 'cron', name: 'cron.rms-sync',     description: '定时同步客户 RMS 招聘需求', emits: ['SCHEDULED_SYNC'],          schedule: '*/5 * * * *' },
  { id: 'cron-resume-poll',  kind: 'cron', name: 'cron.resume-poll',  description: '渠道简历轮询',           emits: ['RESUME_DOWNLOADED'],       schedule: '*/2 * * * *' },
  { id: 'cron-sla-sweeper',  kind: 'cron', name: 'cron.sla-sweeper',  description: 'SLA 超时扫描器',         emits: ['SLA_BREACH_DETECTED'],     schedule: '*/1 * * * *' },
  { id: 'cron-cost-rollup',  kind: 'cron', name: 'cron.cost-rollup',  description: 'token 成本日聚合',       emits: ['COST_ROLLUP_READY'],       schedule: '0 */1 * * *' },
  { id: 'cron-blacklist-gc', kind: 'cron', name: 'cron.blacklist-gc', description: '过期 blacklist 清理',     emits: [],                          schedule: '0 3 * * *' },

  // Webhook (4)
  { id: 'wh-rms-byd',        kind: 'webhook', name: 'POST /webhook/rms/bytedance', description: '字节跳动 RMS 推送', emits: ['REQUIREMENT_LOGGED'],     endpoint: '/webhook/rms/bytedance' },
  { id: 'wh-zhilian',        kind: 'webhook', name: 'POST /webhook/zhilian',       description: '智联招聘投递回调', emits: ['RESUME_DOWNLOADED'],      endpoint: '/webhook/zhilian' },
  { id: 'wh-boss',           kind: 'webhook', name: 'POST /webhook/boss',          description: 'BOSS 直聘投递回调', emits: ['RESUME_DOWNLOADED'],      endpoint: '/webhook/boss' },
  { id: 'wh-portal-ack',     kind: 'webhook', name: 'POST /webhook/portal/ack',    description: '客户门户回执',     emits: ['SUBMISSION_ACKED'],       endpoint: '/webhook/portal/ack' },
];
