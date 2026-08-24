/** True when automated conversational messages must not be sent. */
export async function isConversationHumanControlled(db: D1Database, friendId: string): Promise<boolean> {
  const row = await db.prepare(
    `SELECT handling_mode FROM chats WHERE friend_id = ? ORDER BY created_at DESC LIMIT 1`,
  ).bind(friendId).first<{ handling_mode: string }>();
  return row?.handling_mode === 'human';
}
