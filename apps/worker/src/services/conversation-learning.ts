export type ConversationLearningSummary = {
  captured: number;
  withCustomerReaction: number;
  approved: number;
  rejected: number;
  excluded: number;
};

export async function captureHumanReplyForLearning(
  db: D1Database,
  input: {
    conversationId: string;
    friendId: string;
    lineAccountId: string | null;
    staffMessageId: string;
    staffId: string | null;
    createdAt: string;
  },
): Promise<void> {
  await db.prepare(
    `INSERT OR IGNORE INTO conversation_learning_examples
       (id, conversation_id, line_account_id, customer_message_id, staff_message_id,
        staff_id, status, created_at, updated_at)
     SELECT ?, ?, ?, incoming.id, ?, ?,
            CASE WHEN incoming.contains_sensitive_data = 1 THEN 'excluded' ELSE 'captured' END,
            ?, ?
       FROM messages_log incoming
      WHERE incoming.friend_id = ?
        AND incoming.direction = 'incoming'
        AND incoming.message_type = 'text'
        AND incoming.deleted_at IS NULL
        AND incoming.created_at <= ?
      ORDER BY incoming.created_at DESC
      LIMIT 1`,
  ).bind(
    crypto.randomUUID(), input.conversationId, input.lineAccountId, input.staffMessageId,
    input.staffId, input.createdAt, input.createdAt, input.friendId, input.createdAt,
  ).run();

  await db.prepare(
    `UPDATE conversation_learning_examples
        SET exclusion_reason = 'customer_message_contains_sensitive_data', updated_at = ?
      WHERE staff_message_id = ? AND status = 'excluded' AND exclusion_reason IS NULL`,
  ).bind(input.createdAt, input.staffMessageId).run();
}

export async function attachCustomerReactionForLearning(
  db: D1Database,
  input: { friendId: string; reactionMessageId: string; reactedAt: string },
): Promise<void> {
  await db.prepare(
    `UPDATE conversation_learning_examples
        SET customer_reaction_message_id = ?, customer_reacted_at = ?, updated_at = ?
      WHERE id = (
        SELECT learning.id
          FROM conversation_learning_examples learning
          JOIN chats chat ON chat.id = learning.conversation_id
         WHERE chat.friend_id = ?
           AND learning.customer_reaction_message_id IS NULL
           AND learning.created_at <= ?
         ORDER BY learning.created_at DESC
         LIMIT 1
      )`,
  ).bind(input.reactionMessageId, input.reactedAt, input.reactedAt, input.friendId, input.reactedAt).run();
}

export async function getConversationLearningSummary(
  db: D1Database,
  conversationId: string | null,
): Promise<ConversationLearningSummary> {
  if (!conversationId) return { captured: 0, withCustomerReaction: 0, approved: 0, rejected: 0, excluded: 0 };
  const row = await db.prepare(
    `SELECT COUNT(*) AS captured,
            SUM(CASE WHEN customer_reaction_message_id IS NOT NULL THEN 1 ELSE 0 END) AS with_reaction,
            SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
            SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
            SUM(CASE WHEN status = 'excluded' THEN 1 ELSE 0 END) AS excluded
       FROM conversation_learning_examples
      WHERE conversation_id = ?`,
  ).bind(conversationId).first<Record<string, number | null>>();
  return {
    captured: Number(row?.captured ?? 0),
    withCustomerReaction: Number(row?.with_reaction ?? 0),
    approved: Number(row?.approved ?? 0),
    rejected: Number(row?.rejected ?? 0),
    excluded: Number(row?.excluded ?? 0),
  };
}
