import { describe, expect, test, vi } from 'vitest';
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

import { chats } from './chats.js';

describe('GET /api/chats/revision', () => {
  test('returns an account-scoped lightweight revision without cache storage', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
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
            return { revision: '2026-08-26T12:34:56.000+09:00' };
          },
        };
        return statement;
      },
    };
    const app = new Hono();
    app.route('/', chats);

    const response = await app.request(
      new Request('http://worker.test/api/chats/revision?lineAccountId=account-1'),
      {},
      { DB: db as unknown as D1Database } as never,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: { revision: '2026-08-26T12:34:56.000+09:00' },
    });
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain('ORDER BY c.updated_at DESC LIMIT 1');
    expect(queries[0].params).toEqual(['account-1', 'account-1', 'account-1']);
  });
});
