import { jstNow } from '@line-crm/db';

export async function refreshConversationSla(db: D1Database, now = new Date()): Promise<{ overdue: number; staleHuman: number }> {
  const nowIso = now.toISOString();
  const staleIso = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
  const overdue = await db.prepare(
    `UPDATE chats
        SET attention_status = 'OVERDUE', priority = CASE WHEN priority = 'URGENT' THEN priority ELSE 'HIGH' END,
            updated_at = ?
      WHERE handling_mode = 'human'
        AND attention_status IN ('NEEDS_REPLY','WAITING_BUSINESS_HOURS')
        AND next_action_at IS NOT NULL AND next_action_at <= ?`,
  ).bind(jstNow(), nowIso).run();
  const stale = await db.prepare(
    `UPDATE chats
        SET attention_status = CASE WHEN attention_status = 'RESOLVED' THEN attention_status ELSE 'OVERDUE' END,
            priority = CASE WHEN priority = 'URGENT' THEN priority ELSE 'HIGH' END,
            updated_at = ?
      WHERE handling_mode = 'human' AND updated_at <= ?`,
  ).bind(jstNow(), staleIso).run();
  return {
    overdue: Number(overdue.meta.changes ?? 0),
    staleHuman: Number(stale.meta.changes ?? 0),
  };
}

