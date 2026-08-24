import { jstNow } from '@line-crm/db';
import type { WebhookEvent } from '@line-crm/line-sdk';

export async function reserveWebhookEvent(
  db: D1Database,
  event: WebhookEvent,
  lineAccountId: string | null,
): Promise<boolean> {
  const eventId = event.webhookEventId;
  if (!eventId) return true;
  const receivedAt = jstNow();
  const result = await db.prepare(
    `INSERT OR IGNORE INTO line_webhook_events
     (webhook_event_id, line_account_id, event_type, is_redelivery, line_timestamp, received_at, status)
     VALUES (?, ?, ?, ?, ?, ?, 'PROCESSING')`,
  ).bind(
    eventId,
    lineAccountId,
    event.type,
    event.deliveryContext?.isRedelivery ? 1 : 0,
    'timestamp' in event ? event.timestamp : null,
    receivedAt,
  ).run();
  if (Number(result.meta.changes ?? 0) === 1) return true;

  // LINE redelivery must be able to recover an event left FAILED or stuck in
  // PROCESSING by a Worker termination. A recently processing event remains
  // reserved so concurrent deliveries cannot execute twice.
  if (!event.deliveryContext?.isRedelivery) return false;
  const recovered = await db.prepare(
    `UPDATE line_webhook_events
        SET status = 'PROCESSING', received_at = ?, processed_at = NULL,
            failure_reason = NULL, is_redelivery = 1
      WHERE webhook_event_id = ?
        AND (status = 'FAILED'
          OR (status = 'PROCESSING' AND datetime(received_at) <= datetime(?, '-5 minutes')))`,
  ).bind(receivedAt, eventId, receivedAt).run();
  return Number(recovered.meta.changes ?? 0) === 1;
}

export async function completeWebhookEvent(db: D1Database, eventId: string | undefined): Promise<void> {
  if (!eventId) return;
  await db.prepare(
    `UPDATE line_webhook_events SET status = 'PROCESSED', processed_at = ?, failure_reason = NULL
      WHERE webhook_event_id = ?`,
  ).bind(jstNow(), eventId).run();
}

export async function failWebhookEvent(db: D1Database, eventId: string | undefined, reason: string): Promise<void> {
  if (!eventId) return;
  await db.prepare(
    `UPDATE line_webhook_events SET status = 'FAILED', processed_at = ?, failure_reason = ?
      WHERE webhook_event_id = ?`,
  ).bind(jstNow(), reason.slice(0, 500), eventId).run();
}
