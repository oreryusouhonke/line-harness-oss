import { getFriendById, getLineAccountById, jstNow } from '@line-crm/db';
import { LineClient } from '@line-crm/line-sdk';
import { extractFlexAltText } from '../utils/flex-alt-text.js';
import { canSendQueuedMessage, type ConversationControl } from './conversation-control.js';

type OutboundRow = {
  id: string;
  conversation_id: string;
  sender_type: 'BOT' | 'HUMAN' | 'SYSTEM';
  message_type: string;
  content: string;
  status: string;
  expected_control_mode: 'bot' | 'human';
  expected_version: number;
  expected_bot_generation: number;
  delivery_type: 'push' | 'reply';
  reply_token: string | null;
  quote_token: string | null;
  retry_count: number;
  created_by: string | null;
};

export type DispatchResult = { status: 'SENT' | 'CANCELLED' | 'FAILED' | 'SKIPPED'; reason?: string };

/**
 * Recovers only deliveries that are known not to have reached LINE (PENDING).
 * A stale SENDING row is ambiguous, so it is failed visibly and never retried.
 */
export async function recoverConversationOutbounds(
  db: D1Database,
  defaultAccessToken: string,
): Promise<{ recovered: number; failedAmbiguous: number }> {
  const stale = await db.prepare(
    `UPDATE conversation_outbound_messages
        SET status = 'FAILED', failed_at = ?, failure_reason = 'stale_sending_ambiguous'
      WHERE status = 'SENDING' AND created_at < datetime('now', '+9 hours', '-5 minutes')`,
  ).bind(jstNow()).run();
  const pending = await db.prepare(
    `SELECT id FROM conversation_outbound_messages
      WHERE status = 'PENDING' AND created_at < datetime('now', '+9 hours', '-1 minute')
      ORDER BY created_at ASC LIMIT 50`,
  ).all<{ id: string }>();
  let recovered = 0;
  for (const row of pending.results) {
    const result = await dispatchConversationOutbound(db, row.id, defaultAccessToken);
    if (result.status === 'SENT') recovered += 1;
  }
  return { recovered, failedAmbiguous: Number(stale.meta.changes ?? 0) };
}

export async function dispatchConversationOutbound(
  db: D1Database,
  messageId: string,
  defaultAccessToken: string,
): Promise<DispatchResult> {
  const outbound = await db.prepare(
    `SELECT * FROM conversation_outbound_messages WHERE id = ?`,
  ).bind(messageId).first<OutboundRow>();
  if (!outbound) return { status: 'FAILED', reason: 'message_missing' };
  if (outbound.status === 'SENT') return { status: 'SENT', reason: 'idempotent_replay' };
  if (outbound.status === 'FAILED') return { status: 'FAILED', reason: 'previous_delivery_failed' };
  if (outbound.status === 'CANCELLED') return { status: 'CANCELLED', reason: 'previous_delivery_cancelled' };
  if (outbound.status !== 'PENDING') return { status: 'SKIPPED', reason: 'delivery_in_progress' };

  const conversation = await db.prepare(
    `SELECT id, friend_id, handling_mode, bot_state, previous_bot_state, attention_status,
            bot_generation, version, lock_owner_id, lock_expires_at, assigned_staff_id
       FROM chats WHERE id = ?`,
  ).bind(outbound.conversation_id).first<ConversationControl & { friend_id: string }>();
  if (!conversation) return cancel(db, outbound.id, 'conversation_missing');

  const permission = canSendQueuedMessage(conversation, {
    senderType: outbound.sender_type,
    controlMode: outbound.expected_control_mode,
    version: outbound.expected_version,
    botGeneration: outbound.expected_bot_generation,
  });
  if (!permission.allowed) return cancel(db, outbound.id, permission.reason);
  if (outbound.sender_type === 'HUMAN' && conversation.lock_owner_id !== outbound.created_by) {
    return cancel(db, outbound.id, 'staff_lock_lost');
  }

  const claimed = await db.prepare(
    `UPDATE conversation_outbound_messages SET status = 'SENDING'
      WHERE id = ? AND status = 'PENDING'`,
  ).bind(outbound.id).run();
  if (Number(claimed.meta.changes ?? 0) !== 1) return { status: 'SKIPPED' };

  // Re-read after claiming. A handoff/return may have committed between the
  // first authorization check and our claim.
  const latest = await db.prepare(
    `SELECT id, friend_id, handling_mode, bot_state, previous_bot_state, attention_status,
            bot_generation, version, lock_owner_id, lock_expires_at, assigned_staff_id
       FROM chats WHERE id = ?`,
  ).bind(outbound.conversation_id).first<ConversationControl & { friend_id: string }>();
  if (!latest) return cancel(db, outbound.id, 'conversation_missing_after_claim');
  const finalPermission = canSendQueuedMessage(latest, {
    senderType: outbound.sender_type,
    controlMode: outbound.expected_control_mode,
    version: outbound.expected_version,
    botGeneration: outbound.expected_bot_generation,
  });
  if (!finalPermission.allowed) return cancel(db, outbound.id, finalPermission.reason);
  if (outbound.sender_type === 'HUMAN') {
    const lockValid = latest.lock_owner_id === outbound.created_by &&
      Boolean(latest.lock_expires_at) && new Date(latest.lock_expires_at!).getTime() > Date.now();
    if (!lockValid) return cancel(db, outbound.id, 'staff_lock_expired');
  }

  const friend = await getFriendById(db, conversation.friend_id);
  if (!friend) return fail(db, outbound.id, 'friend_missing');
  let accessToken = defaultAccessToken;
  if (friend.line_account_id) {
    const account = await getLineAccountById(db, friend.line_account_id);
    if (account) accessToken = account.channel_access_token;
  }

  try {
    const client = new LineClient(accessToken);
    if (outbound.delivery_type === 'reply' && outbound.reply_token) {
      await client.replyMessage(outbound.reply_token, toLineMessages(outbound));
    } else if (outbound.message_type === 'text') {
      await client.pushMessage(friend.line_user_id, [{
        type: 'text',
        text: outbound.content,
        ...(outbound.quote_token ? { quoteToken: outbound.quote_token } : {}),
      }]);
    } else if (outbound.message_type === 'flex') {
      const contents = JSON.parse(outbound.content);
      await client.pushFlexMessage(friend.line_user_id, extractFlexAltText(contents), contents);
    } else if (outbound.message_type === 'image') {
      const image = JSON.parse(outbound.content) as { originalContentUrl: string; previewImageUrl: string };
      await client.pushImageMessage(friend.line_user_id, image.originalContentUrl, image.previewImageUrl);
    } else {
      throw new Error('unsupported_message_type');
    }

    const now = jstNow();
    const source = outbound.sender_type === 'BOT'
      ? 'iemoto_bot'
      : outbound.sender_type === 'HUMAN' ? 'manual' : 'system_handoff';
    await db.batch([
      db.prepare(
        `UPDATE conversation_outbound_messages
            SET status = 'SENT', sent_at = ?, failure_reason = NULL
          WHERE id = ? AND status = 'SENDING'`,
      ).bind(now, outbound.id),
      db.prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, source, quote_token, created_at)
         VALUES (?, ?, 'outgoing', ?, ?, ?, ?, ?)`,
      ).bind(crypto.randomUUID(), friend.id, outbound.message_type, outbound.content, source, outbound.quote_token, now),
      db.prepare(
        `UPDATE chats SET last_reply_at = ?, last_message_at = ?, updated_at = ? WHERE id = ?`,
      ).bind(now, now, now, conversation.id),
      db.prepare(
        `INSERT INTO conversation_audit_logs
         (id, conversation_id, action, actor_type, actor_id, request_id, metadata, created_at)
         VALUES (?, ?, 'MESSAGE_SENT', ?, NULL, ?, ?, ?)`,
      ).bind(crypto.randomUUID(), conversation.id, outbound.sender_type, outbound.id, '{}', now),
    ]);
    return { status: 'SENT' };
  } catch (error) {
    // Never auto-retry an ambiguous LINE timeout: it may have been accepted remotely.
    return fail(db, outbound.id, error instanceof Error ? error.message : 'line_send_failed');
  }
}

function toLineMessage(row: OutboundRow): Parameters<LineClient['replyMessage']>[1][number] {
  if (row.message_type === 'text') return {
    type: 'text',
    text: row.content,
    ...(row.quote_token ? { quoteToken: row.quote_token } : {}),
  };
  if (row.message_type === 'flex') {
    const contents = JSON.parse(row.content);
    return { type: 'flex', altText: extractFlexAltText(contents), contents };
  }
  if (row.message_type === 'image') {
    const image = JSON.parse(row.content) as { originalContentUrl: string; previewImageUrl: string };
    return { type: 'image', ...image };
  }
  throw new Error('unsupported_message_type');
}

function toLineMessages(row: OutboundRow): Parameters<LineClient['replyMessage']>[1] {
  if (row.message_type !== 'image_text') return [toLineMessage(row)];
  const bundle = JSON.parse(row.content) as { text: string; imageUrl: string };
  if (!/^https:\/\//i.test(bundle.imageUrl) || !bundle.text) throw new Error('invalid_image_text_message');
  return [
    { type: 'image', originalContentUrl: bundle.imageUrl, previewImageUrl: bundle.imageUrl },
    { type: 'text', text: bundle.text },
  ];
}

async function cancel(db: D1Database, id: string, reason: string): Promise<DispatchResult> {
  await db.prepare(
    `UPDATE conversation_outbound_messages SET status = 'CANCELLED', failure_reason = ?
      WHERE id = ? AND status IN ('PENDING','SENDING')`,
  ).bind(reason, id).run();
  return { status: 'CANCELLED', reason };
}

async function fail(db: D1Database, id: string, reason: string): Promise<DispatchResult> {
  await db.prepare(
    `UPDATE conversation_outbound_messages
        SET status = 'FAILED', failed_at = ?, failure_reason = ?, retry_count = retry_count + 1
      WHERE id = ? AND status = 'SENDING'`,
  ).bind(jstNow(), reason.slice(0, 500), id).run();
  return { status: 'FAILED', reason };
}
