import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('@line-crm/db', () => ({
  getOperators: vi.fn(),
  getOperatorById: vi.fn(),
  createOperator: vi.fn(),
  updateOperator: vi.fn(),
  deleteOperator: vi.fn(),
  getChats: vi.fn(),
  getChatById: vi.fn(),
  createChat: vi.fn(),
  getFriendById: vi.fn(),
  getLineAccountById: vi.fn(),
  updateChat: vi.fn(),
  jstNow: vi.fn(() => '2026-08-26T12:00:00.000+09:00'),
}));

import { getChatById } from '@line-crm/db';
import { chats } from './chats.js';

type Query = { sql: string; params: unknown[] };

function fakeDb() {
  const queries: Query[] = [];
  const messageRows = Array.from({ length: 26 }, (_, index) => ({
    id: `message-${String(index).padStart(2, '0')}`,
    friend_id: 'friend-1',
    direction: index % 2 === 0 ? 'incoming' : 'outgoing',
    message_type: 'text',
    content: `message ${index}`,
    source: 'user',
    quote_token: null,
    created_at: `2026-08-26T11:${String(59 - index).padStart(2, '0')}:00.000+09:00`,
  }));

  const db = {
    prepare(sql: string) {
      const statement = {
        params: [] as unknown[],
        bind(...params: unknown[]) {
          statement.params = params;
          return statement;
        },
        async first() {
          queries.push({ sql, params: statement.params });
          if (sql.includes('SELECT display_name')) {
            return {
              display_name: 'LINE name',
              management_nickname: 'Customer name',
              picture_url: null,
              line_account_id: 'account-1',
              line_user_id: 'U-user-1',
            };
          }
          return null;
        },
        async all() {
          queries.push({ sql, params: statement.params });
          if (sql.includes('SELECT id FROM friends')) return { results: [{ id: 'friend-1' }] };
          if (sql.includes('FROM messages_log')) return { results: messageRows };
          return { results: [] };
        },
      };
      return statement;
    },
  };

  return { db: db as unknown as D1Database, queries };
}

describe('GET /api/chats/:id message pagination', () => {
  beforeEach(() => {
    vi.mocked(getChatById).mockResolvedValue({
      id: 'chat-1',
      friend_id: 'friend-1',
      operator_id: null,
      status: 'in_progress',
      notes: null,
      last_message_at: '2026-08-26T11:59:00.000+09:00',
      created_at: '2026-08-01T00:00:00.000+09:00',
      updated_at: '2026-08-26T11:59:00.000+09:00',
    } as never);
  });

  test('returns only the newest 25 messages and exposes a stable older-message cursor query', async () => {
    const { db, queries } = fakeDb();
    const app = new Hono();
    app.route('/', chats);

    const response = await app.request(
      new Request(
        'http://worker.test/api/chats/friend-1?messageLimit=25&beforeAt=2026-08-26T11%3A35%3A00.000%2B09%3A00&beforeId=message-24',
      ),
      {},
      { DB: db } as never,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      data: { hasMoreMessages: boolean; messages: Array<{ id: string }> };
    };
    expect(body.data.hasMoreMessages).toBe(true);
    expect(body.data.messages).toHaveLength(25);
    expect(body.data.messages[0].id).toBe('message-24');
    expect(body.data.messages[24].id).toBe('message-00');

    const messageQuery = queries.find((query) => query.sql.includes('FROM messages_log'))!;
    expect(messageQuery.sql).toContain('ORDER BY created_at DESC, id DESC LIMIT ?');
    expect(messageQuery.sql).toContain('(created_at < ? OR (created_at = ? AND id < ?))');
    expect(messageQuery.params).toEqual([
      'friend-1',
      '2026-08-26T11:35:00.000+09:00',
      '2026-08-26T11:35:00.000+09:00',
      'message-24',
      26,
    ]);
  });
});
