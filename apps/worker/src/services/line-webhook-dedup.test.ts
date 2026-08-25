import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { WebhookEvent } from '@line-crm/line-sdk';
import {
  claimRetryableWebhookEvents,
  completeWebhookEvent,
  failWebhookEvent,
  reserveWebhookEvent,
} from './line-webhook-dedup.js';

function d1Adapter(sqlite: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = sqlite.prepare(sql);
      const prepared = {
        bind(...args: unknown[]) {
          values = args;
          return prepared;
        },
        async run() {
          const result = statement.run(...values);
          return { success: true, meta: { changes: result.changes } };
        },
        async first<T>() {
          return (statement.get(...values) as T | undefined) ?? null;
        },
        async all<T>() {
          return { success: true, results: statement.all(...values) as T[] };
        },
      };
      return prepared;
    },
  } as unknown as D1Database;
}

function createDb(): Database.Database {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE line_webhook_events (
      webhook_event_id TEXT PRIMARY KEY,
      line_account_id TEXT,
      event_type TEXT NOT NULL,
      is_redelivery INTEGER NOT NULL DEFAULT 0,
      line_timestamp INTEGER,
      received_at TEXT NOT NULL,
      processed_at TEXT,
      status TEXT NOT NULL DEFAULT 'PROCESSING',
      failure_reason TEXT,
      payload_json TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT
    );
  `);
  return sqlite;
}

const messageEvent = {
  type: 'message',
  replyToken: 'reply-token',
  message: { type: 'text', id: 'message-1', text: 'hello' },
  timestamp: Date.now(),
  source: { type: 'user', userId: 'U-test' },
  webhookEventId: 'event-1',
  deliveryContext: { isRedelivery: false },
  mode: 'active',
} as WebhookEvent;

describe('durable LINE webhook events', () => {
  it('persists the payload before processing and rejects a duplicate delivery', async () => {
    const sqlite = createDb();
    const db = d1Adapter(sqlite);

    await expect(reserveWebhookEvent(db, messageEvent, 'account-1')).resolves.toBe(true);
    await expect(reserveWebhookEvent(db, messageEvent, 'account-1')).resolves.toBe(false);

    const row = sqlite.prepare(
      'SELECT status, payload_json, attempt_count FROM line_webhook_events WHERE webhook_event_id = ?',
    ).get('event-1') as { status: string; payload_json: string; attempt_count: number };
    expect(row.status).toBe('PROCESSING');
    expect(JSON.parse(row.payload_json)).toMatchObject({ webhookEventId: 'event-1' });
    expect(row.attempt_count).toBe(1);
  });

  it('claims a failed payload for cron retry and clears it after success', async () => {
    const sqlite = createDb();
    const db = d1Adapter(sqlite);
    await reserveWebhookEvent(db, messageEvent, 'account-1');
    await failWebhookEvent(db, 'event-1', 'temporary D1 error');
    sqlite.prepare("UPDATE line_webhook_events SET next_retry_at = datetime('now', '-1 minute')").run();

    const claimed = await claimRetryableWebhookEvents(db);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ webhook_event_id: 'event-1', attempt_count: 2 });

    await completeWebhookEvent(db, 'event-1');
    const row = sqlite.prepare(
      'SELECT status, payload_json, next_retry_at FROM line_webhook_events WHERE webhook_event_id = ?',
    ).get('event-1') as { status: string; payload_json: string | null; next_retry_at: string | null };
    expect(row).toEqual({ status: 'PROCESSED', payload_json: null, next_retry_at: null });
  });
});
