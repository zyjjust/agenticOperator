/**
 * Static catalog of the 24 data source connectors AO talks to.
 *
 * P1: served as-is from /api/datasources, with EM /health probe layered on
 *     top to determine status when reachable.
 * P3: replaced by EM `ingestion_configs` + `health_incidents` join.
 */

import type { DataSource } from './api/types';

type Seed = Pick<DataSource, 'id' | 'name' | 'category'>;

export const DATASOURCE_CATALOG: Seed[] = [
  // ATS / Customer RMS (6)
  { id: 'ats-workday',  name: 'Workday',         category: 'ats' },
  { id: 'ats-bytedance', name: '字节跳动 RMS',    category: 'ats' },
  { id: 'ats-greenhouse', name: 'Greenhouse',    category: 'ats' },
  { id: 'ats-lever',    name: 'Lever',           category: 'ats' },
  { id: 'ats-moka',     name: 'Moka',            category: 'ats' },
  { id: 'ats-beisen',   name: '北森',            category: 'ats' },

  // Channels (5)
  { id: 'ch-zhilian',   name: '智联招聘',         category: 'channel' },
  { id: 'ch-51job',     name: '前程无忧',         category: 'channel' },
  { id: 'ch-boss',      name: 'BOSS 直聘',       category: 'channel' },
  { id: 'ch-liepin',    name: '猎聘',             category: 'channel' },
  { id: 'ch-linkedin',  name: 'LinkedIn',        category: 'channel' },

  // LLM (4)
  { id: 'llm-anthropic', name: 'Anthropic Claude', category: 'llm' },
  { id: 'llm-gemini',    name: 'Google Gemini',    category: 'llm' },
  { id: 'llm-openai',    name: 'OpenAI',           category: 'llm' },
  { id: 'llm-tongyi',    name: '通义千问',          category: 'llm' },

  // Vector (2)
  { id: 'vec-pinecone',  name: 'Pinecone',         category: 'vector' },
  { id: 'vec-pgvector',  name: 'pgvector',         category: 'vector' },

  // Messaging (3)
  { id: 'msg-feishu',    name: '飞书',             category: 'msg' },
  { id: 'msg-wecom',     name: '企业微信',          category: 'msg' },
  { id: 'msg-email',     name: 'SMTP / SES',       category: 'msg' },

  // Storage (2)
  { id: 'sto-s3',        name: 'S3 / OSS',         category: 'storage' },
  { id: 'sto-cos',       name: '腾讯 COS',          category: 'storage' },

  // Identity (2)
  { id: 'id-okta',       name: 'Okta',             category: 'identity' },
  { id: 'id-feishu-id',  name: '飞书身份',          category: 'identity' },
];
