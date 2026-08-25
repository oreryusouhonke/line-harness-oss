import { jstNow } from '@line-crm/db';
import type { WebhookEvent } from '@line-crm/line-sdk';

export interface RetryableWebhookEventRow {
  webhook_event_id: string;
  line_account_id: string | null;
  event_type: string;
  payload_json: string;
  attempt_count: number;
}

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
     (webhook_event_id, line_account_id, event_type, is_redelivery, line_timestamp,
      received_at, status, payload_json, attempt_count, next_retry_at)
     VALUES (?, ?, ?, ?, ?, ?, 'PROCESSING', ?, 1, NULL)`,
  ).bind(
    eventId,
    lineAccountId,
    event.type,
    event.deliveryContext?.isRedelivery ? 1 : 0,
    'timestamp' in event ? event.timestamp : null,
    receivedAt,
    JSON.stringify(event),
  ).run();
  if (Number(result.meta.changes ?? 0) === 1) return true;

  // LINE redelivery must be able to recover an event left FAILED or stuck in
  // PROCESSING by a Worker termination. A recently processing event remains
  // reserved so concurrent deliveries cannot execute twice.
  if (!event.deliveryContext?.isRedelivery) return false;
  const recovered = await db.prepare(
    `UPDATE line_webhook_events
        SET status = 'PROCESSING', received_at = ?, processed_at = NULL,
            failure_reason = NULL, is_redelivery = 1, payload_json = ?,
            attempt_count = attempt_count + 1, next_retry_at = NULL
      WHERE webhook_event_id = ?
        AND (status = 'FAILED'
          OR (status = 'PROCESSING' AND datetime(received_at) <= datetime(?, '-5 minutes')))`,
  ).bind(receivedAt, JSON.stringify(event), eventId, receivedAt).run();
  return Number(recovered.meta.changes ?? 0) === 1;
}

export async function completeWebhookEvent(db: D1Database, eventId: string | undefined): Promise<void> {
  if (!eventId) return;
  await db.prepare(
    `UPDATE line_webhook_events
        SET status = 'PROCESSED', processed_at = ?, failure_reason = NULL,
            payload_json = NULL, next_retry_at = NULL
      WHERE webhook_event_id = ?`,
  ).bind(jstNow(), eventId).run();
}

export async function failWebhookEvent(db: D1Database, eventId: string | undefined, reason: string): Promise<void> {
  if (!eventId) return;
  const retryAt = new Date(Date.now() + 60_000).toISOString();
  await db.prepare(
    `UPDATE line_webhook_events
        SET status = 'FAILED', processed_at = ?, failure_reason = ?, next_retry_at = ?
      WHERE webhook_event_id = ?`,
  ).bind(jstNow(), reason.slice(0, 500), retryAt, eventId).run();
}

export async function claimRetryableWebhookEvents(
  db: D1Database,
  limit = 20,
): Promise<RetryableWebhookEventRow[]> {
  const now = jstNow();
  const candidates = await db.prepare(
    `SELECT webhook_event_id, line_account_id, event_type, payload_json, attempt_count
       FROM line_webhook_events
      WHERE payload_json IS NOT NULL
        AND (
          (status = 'FAILED' AND (next_retry_at IS NULL OR datetime(next_retry_at) <= datetime(?)))
          OR (status = 'PROCESSING' AND datetime(received_at) <= datetime(?, '-5 minutes'))
        )
      ORDER BY received_at ASC
      LIMIT ?`,
  ).bind(now, now, limit).all<RetryableWebhookEventRow>();

  const claimed: RetryableWebhookEventRow[] = [];
  for (const row of candidates.results) {
    const result = await db.prepare(
      `UPDATE line_webhook_events
          SET status = 'PROCESSING', received_at = ?, processed_at = NULL,
              failure_reason = NULL, attempt_count = attempt_count + 1, next_retry_at = NULL
        WHERE webhook_event_id = ?
          AND payload_json IS NOT NULL
          AND (
            (status = 'FAILED' AND (next_retry_at IS NULL OR datetime(next_retry_at) <= datetime(?)))
            OR (status = 'PROCESSING' AND datetime(received_at) <= datetime(?, '-5 minutes'))
          )`,
    ).bind(now, row.webhook_event_id, now, now).run();
    if (Number(result.meta.changes ?? 0) === 1) {
      claimed.push({ ...row, attempt_count: row.attempt_count + 1 });
    }
  }
  return claimed;
}
