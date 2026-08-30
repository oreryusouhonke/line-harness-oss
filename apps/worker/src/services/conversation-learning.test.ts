import { describe, expect, it, vi } from 'vitest';
import {
  attachCustomerReactionForLearning,
  captureHumanReplyForLearning,
  getConversationLearningSummary,
} from './conversation-learning.js';

function mockDb(firstResult?: Record<string, number | null>) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const db = {
    prepare: vi.fn((sql: string) => ({
      bind: (...values: unknown[]) => {
        calls.push({ sql, values });
        return {
          run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
          first: vi.fn().mockResolvedValue(firstResult ?? null),
        };
      },
    })),
  } as unknown as D1Database;
  return { db, calls };
}

describe('conversation learning capture', () => {
  it('links a delivered human reply to the latest incoming text', async () => {
    const { db, calls } = mockDb();
    await captureHumanReplyForLearning(db, {
      conversationId: 'chat-1',
      friendId: 'friend-1',
      lineAccountId: 'account-1',
      staffMessageId: 'staff-message-1',
      staffId: 'staff-1',
      createdAt: '2026-08-30T10:00:00.000+09:00',
    });

    expect(calls[0]?.sql).toContain('INSERT OR IGNORE INTO conversation_learning_examples');
    expect(calls[0]?.sql).toContain("incoming.direction = 'incoming'");
    expect(calls[0]?.sql).toContain("incoming.message_type = 'text'");
    expect(calls[0]?.values).toContain('staff-message-1');
  });

  it('attaches only the first later customer reaction to the latest waiting example', async () => {
    const { db, calls } = mockDb();
    await attachCustomerReactionForLearning(db, {
      friendId: 'friend-1',
      reactionMessageId: 'incoming-2',
      reactedAt: '2026-08-30T10:05:00.000+09:00',
    });

    expect(calls[0]?.sql).toContain('customer_reaction_message_id IS NULL');
    expect(calls[0]?.sql).toContain('ORDER BY learning.created_at DESC');
    expect(calls[0]?.values[0]).toBe('incoming-2');
  });

  it('returns numeric summary values for the management screen', async () => {
    const { db } = mockDb({ captured: 4, with_reaction: 3, approved: 1, rejected: 1, excluded: 1 });
    await expect(getConversationLearningSummary(db, 'chat-1')).resolves.toEqual({
      captured: 4,
      withCustomerReaction: 3,
      approved: 1,
      rejected: 1,
      excluded: 1,
    });
  });
});
