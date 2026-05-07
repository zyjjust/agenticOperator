import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock prisma — the route now reads EventDefinition directly (no more P1 HTTP
// sidecar to EM). Neo4j sync worker writes rows with source='neo4j'; the
// route filters to those, falls back to lib/events-catalog.ts only when
// the table is empty.
vi.mock('@/server/db', () => ({
  prisma: {
    eventDefinition: { findMany: vi.fn() },
    emSystemStatus: { findUnique: vi.fn() },
  },
}));

import { GET } from './route';
import { prisma } from '@/server/db';

describe('GET /api/events', () => {
  beforeEach(() => vi.clearAllMocks());

  it('serves Neo4j-synced events when DB cache has rows', async () => {
    (prisma.eventDefinition.findMany as any).mockResolvedValue([
      {
        name: 'JD_GENERATED',
        description: 'a JD has been generated',
        payload: '{"type":"object"}',
        version: '2.0',
        source: 'neo4j',
        syncedAt: new Date('2026-05-06T10:00:00Z'),
        activeVersionsJson: JSON.stringify(['2.0', '1.0']),
        publishersJson: JSON.stringify(['JDGenerator']),
        subscribersJson: JSON.stringify(['JDReviewer']),
        sortOrder: 0,
      },
    ]);
    (prisma.emSystemStatus.findUnique as any).mockResolvedValue({
      neo4jLastSyncAt: new Date('2026-05-06T10:00:00Z'),
      neo4jLastError: null,
    });

    const res = await GET(new Request('http://x/api/events'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.events).toHaveLength(1);
    expect(j.events[0].name).toBe('JD_GENERATED');
    expect(j.events[0].source).toBe('neo4j');
    expect(j.events[0].activeVersions).toEqual(['2.0', '1.0']);
    expect(j.meta.source).toBe('neo4j');
    expect(j.meta.totalNeo4jRows).toBe(1);
    expect(j.meta.totalHardcodedRows).toBe(0);
    expect(j.meta.partial).toBeUndefined();
  });

  it('falls back to hardcoded catalog when DB cache is empty (off-VPN)', async () => {
    (prisma.eventDefinition.findMany as any).mockResolvedValue([]);
    (prisma.emSystemStatus.findUnique as any).mockResolvedValue({
      neo4jLastSyncAt: null,
      neo4jLastError: 'connection refused',
    });

    const res = await GET(new Request('http://x/api/events'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.events.length).toBeGreaterThan(0);
    expect(j.events.every((e: any) => e.source === 'hardcoded')).toBe(true);
    expect(j.meta.source).toBe('hardcoded');
    expect(j.meta.partial).toEqual(['em']);
    expect(j.meta.lastNeo4jError).toBe('connection refused');
  });

  it('also falls back when DB itself is unreachable', async () => {
    (prisma.eventDefinition.findMany as any).mockRejectedValue(new Error('db down'));
    (prisma.emSystemStatus.findUnique as any).mockResolvedValue(null);

    const res = await GET(new Request('http://x/api/events'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.meta.source).toBe('hardcoded');
    expect(j.events.every((e: any) => e.source === 'hardcoded')).toBe(true);
  });
});
