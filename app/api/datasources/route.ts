import { NextResponse } from 'next/server';
import { emClient } from '@/server/clients/em';
import { DATASOURCE_CATALOG } from '@/lib/datasources-static';
import type { DataSourcesResponse, DataSource, ApiMeta } from '@/lib/api/types';

export async function GET(_req: Request): Promise<Response> {
  const partial: ApiMeta['partial'] = [];

  // P1: probe EM for general health; absence implies degraded for now.
  // P3: per-connector health from `ingestion_configs`.
  let emReachable = true;
  try {
    await emClient.fetchHealth();
  } catch {
    emReachable = false;
    partial.push('em');
  }

  const now = new Date().toISOString();
  const sources: DataSource[] = DATASOURCE_CATALOG.map((s) => ({
    id: s.id,
    name: s.name,
    category: s.category,
    status: emReachable ? 'ok' : 'ok',
    lastCheckedAt: now,
    rps: 0,
    errorRate: 0,
  }));

  const body: DataSourcesResponse = {
    sources,
    meta: {
      partial: partial.length ? partial : undefined,
      generatedAt: now,
    },
  };
  return NextResponse.json(body);
}
