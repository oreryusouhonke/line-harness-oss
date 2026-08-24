import { jstNow } from '@line-crm/db';

export async function recordAiFailure(
  db: D1Database,
  lineAccountId: string | null,
): Promise<'DEGRADED' | 'OUTAGE'> {
  const key = lineAccountId || 'default';
  const now = jstNow();
  const windowStart = new Date(Date.now() - 5 * 60_000).toISOString();
  await db.prepare(
    `INSERT INTO ai_service_health
     (service_key, status, failure_count, window_started_at, last_failure_at, updated_at)
     VALUES (?, 'DEGRADED', 1, ?, ?, ?)
     ON CONFLICT(service_key) DO UPDATE SET
       failure_count = CASE WHEN window_started_at < ? THEN 1 ELSE failure_count + 1 END,
       window_started_at = CASE WHEN window_started_at < ? THEN excluded.window_started_at ELSE window_started_at END,
       last_failure_at = excluded.last_failure_at,
       status = CASE
         WHEN (CASE WHEN window_started_at < ? THEN 1 ELSE failure_count + 1 END) >= 5 THEN 'OUTAGE'
         ELSE 'DEGRADED' END,
       updated_at = excluded.updated_at`,
  ).bind(key, now, now, now, windowStart, windowStart, windowStart).run();
  const row = await db.prepare(`SELECT status FROM ai_service_health WHERE service_key = ?`)
    .bind(key).first<{ status: 'DEGRADED' | 'OUTAGE' }>();
  return row?.status ?? 'DEGRADED';
}

export async function recordAiSuccess(db: D1Database, lineAccountId: string | null): Promise<void> {
  const now = jstNow();
  await db.prepare(
    `INSERT INTO ai_service_health
     (service_key, status, failure_count, window_started_at, last_success_at, updated_at)
     VALUES (?, 'NORMAL', 0, ?, ?, ?)
     ON CONFLICT(service_key) DO UPDATE SET
       status = 'NORMAL', failure_count = 0, last_success_at = excluded.last_success_at, updated_at = excluded.updated_at`,
  ).bind(lineAccountId || 'default', now, now, now).run();
}

