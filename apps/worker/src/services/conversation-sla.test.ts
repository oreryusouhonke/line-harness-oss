import { describe, expect, it } from 'vitest';
import { refreshConversationSla } from './conversation-sla.js';

describe('refreshConversationSla', () => {
  it('updates overdue and 24h-stale human queues without touching Bot queues', async () => {
    const sql: string[] = [];
    const db = {
      prepare(statement: string) {
        sql.push(statement);
        return { bind: () => ({ run: async () => ({ meta: { changes: 2 } }) }) };
      },
    } as unknown as D1Database;
    const result = await refreshConversationSla(db, new Date('2026-07-20T03:00:00.000Z'));
    expect(result).toEqual({ overdue: 2, staleHuman: 2 });
    expect(sql.every((statement) => statement.includes("handling_mode = 'human'"))).toBe(true);
  });
});

