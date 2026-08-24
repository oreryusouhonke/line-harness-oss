import { jstNow } from '@line-crm/db';
import {
  ConversationConflictError,
  planHumanHandoff,
  planReturnToBot,
  type ConversationControl,
} from './conversation-control.js';

export type ConversationOperationInput = {
  expectedVersion: number;
  idempotencyKey: string;
  reason: string;
  actorType: 'STAFF' | 'BOT' | 'SYSTEM';
  actorId: string | null;
  notifyCustomer?: boolean;
};

export type ConversationOperationOutput = {
  conversationId: string;
  mode: 'bot' | 'human';
  botState: string;
  attentionStatus: string;
  version: number;
  botGeneration: number;
  queuedMessageId: string | null;
  replayed: boolean;
};

export class ConversationNotFoundError extends Error {}
export class IdempotencyMismatchError extends Error {}

const HUMAN_NOTICE = '【家元・スタッフ対応】\nここからは家元またはスタッフが確認して返信します。\n家元Botは一時停止します。';
const BOT_NOTICE = '【家元Bot対応】\nここからは家元Botが相談をお聞きします。\n必要なときはいつでも人へ引き継げます。';

async function resolveConversation(db: D1Database, id: string): Promise<ConversationControl | null> {
  return db.prepare(
    `SELECT c.id, c.handling_mode, c.bot_state, c.previous_bot_state,
            c.attention_status, c.bot_generation, c.version, c.lock_owner_id,
            c.lock_expires_at, c.assigned_staff_id
       FROM chats c
      WHERE c.id = ? OR c.friend_id = ?
      ORDER BY CASE WHEN c.id = ? THEN 0 ELSE 1 END, c.created_at DESC
      LIMIT 1`,
  ).bind(id, id, id).first<ConversationControl>();
}

async function replayIfPresent(
  db: D1Database,
  conversationId: string,
  operationType: string,
  key: string,
): Promise<ConversationOperationOutput | null> {
  const found = await db.prepare(
    `SELECT operation_type, response_body FROM conversation_operation_keys
      WHERE idempotency_key = ? AND conversation_id = ?`,
  ).bind(key, conversationId).first<{ operation_type: string; response_body: string | null }>();
  if (!found) return null;
  if (found.operation_type !== operationType) throw new IdempotencyMismatchError('idempotency_key_reused');
  if (!found.response_body) throw new ConversationConflictError(-1);
  return { ...(JSON.parse(found.response_body) as ConversationOperationOutput), replayed: true };
}

function expiry24h(now: string): string {
  return new Date(new Date(now).getTime() + 24 * 60 * 60 * 1000).toISOString();
}

async function changeMode(
  db: D1Database,
  publicId: string,
  operationType: 'HANDOFF' | 'RETURN_TO_BOT',
  input: ConversationOperationInput,
): Promise<ConversationOperationOutput> {
  const row = await resolveConversation(db, publicId);
  if (!row) throw new ConversationNotFoundError('conversation_not_found');
  const replay = await replayIfPresent(db, row.id, operationType, input.idempotencyKey);
  if (replay) return replay;

  if (operationType === 'RETURN_TO_BOT') {
    const lockActive = row.lock_owner_id && row.lock_expires_at &&
      new Date(row.lock_expires_at).getTime() > Date.now();
    if (lockActive && row.lock_owner_id !== input.actorId) {
      throw new ConversationConflictError(row.version);
    }
    const unsent = await db.prepare(
      `SELECT COUNT(*) AS count FROM conversation_outbound_messages
        WHERE conversation_id = ? AND sender_type = 'HUMAN' AND status IN ('PENDING','SENDING')`,
    ).bind(row.id).first<{ count: number }>();
    if (Number(unsent?.count ?? 0) > 0) throw new ConversationConflictError(row.version);
  }

  const next = operationType === 'HANDOFF'
    ? planHumanHandoff(row, input.expectedVersion, input.actorId)
    : planReturnToBot(row, input.expectedVersion);

  // Exact no-op is safe and idempotent, but still reserve the key for retries.
  const changed = next.version !== row.version;
  const now = jstNow();
  const requestId = crypto.randomUUID();
  const queuedMessageId = input.notifyCustomer === false || !changed ? null : crypto.randomUUID();
  const output: ConversationOperationOutput = {
    conversationId: row.id,
    mode: next.mode,
    botState: next.botState,
    attentionStatus: next.attentionStatus,
    version: next.version,
    botGeneration: next.botGeneration,
    queuedMessageId,
    replayed: false,
  };

  const statements: D1PreparedStatement[] = [];
  if (changed) {
    statements.push(db.prepare(
      `UPDATE chats
          SET handling_mode = ?, bot_state = ?, previous_bot_state = ?, attention_status = ?,
              bot_generation = ?, version = ?, lock_owner_id = ?, lock_expires_at = ?,
              assigned_staff_id = ?, updated_at = ?
        WHERE id = ? AND version = ?`,
    ).bind(
      next.mode, next.botState, next.previousBotState, next.attentionStatus,
      next.botGeneration, next.version, next.lockOwnerId, next.lockExpiresAt,
      next.assignedStaffId, now, row.id, row.version,
    ));
    statements.push(db.prepare(
      `INSERT INTO conversation_state_transitions
       (id, conversation_id, from_mode, to_mode, from_bot_state, to_bot_state, reason,
        performed_by_type, performed_by_id, request_id, from_version, to_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), row.id, row.handling_mode, next.mode, row.bot_state, next.botState,
      input.reason, input.actorType, input.actorId, requestId, row.version, next.version, now,
    ));
  }
  if (queuedMessageId) {
    statements.push(db.prepare(
      `INSERT INTO conversation_outbound_messages
       (id, conversation_id, sender_type, message_type, content, status, idempotency_key,
        expected_control_mode, expected_version, expected_bot_generation, delivery_type,
        created_by, created_at)
       VALUES (?, ?, 'SYSTEM', 'text', ?, 'PENDING', ?, ?, ?, ?, 'push', ?, ?)`,
    ).bind(
      queuedMessageId, row.id, operationType === 'HANDOFF' ? HUMAN_NOTICE : BOT_NOTICE,
      `${input.idempotencyKey}:notice`, next.mode, next.version, next.botGeneration, input.actorId, now,
    ));
  }
  statements.push(db.prepare(
    `INSERT INTO conversation_audit_logs
     (id, conversation_id, action, actor_type, actor_id, request_id, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(), row.id, operationType, input.actorType, input.actorId, requestId,
    JSON.stringify({ reason: input.reason, fromVersion: row.version, toVersion: next.version }), now,
  ));
  statements.push(db.prepare(
    `INSERT INTO conversation_operation_keys
     (idempotency_key, conversation_id, operation_type, response_status, response_body, created_at, expires_at)
     VALUES (?, ?, ?, 200, ?, ?, ?)`,
  ).bind(input.idempotencyKey, row.id, operationType, JSON.stringify(output), now, expiry24h(now)));

  try {
    const results = await db.batch(statements);
    if (changed && Number(results[0]?.meta?.changes ?? 0) !== 1) throw new ConversationConflictError(row.version);
  } catch (error) {
    const current = await resolveConversation(db, row.id);
    const retryReplay = await replayIfPresent(db, row.id, operationType, input.idempotencyKey);
    if (retryReplay) return retryReplay;
    if (current && current.version !== row.version) throw new ConversationConflictError(current.version);
    throw error;
  }
  return output;
}

export const handoffConversation = (db: D1Database, id: string, input: ConversationOperationInput) =>
  changeMode(db, id, 'HANDOFF', input);

export const returnConversationToBot = (db: D1Database, id: string, input: ConversationOperationInput) =>
  changeMode(db, id, 'RETURN_TO_BOT', input);

export type EnqueueHumanReplyInput = ConversationOperationInput & {
  staffId: string;
  messageType: 'text' | 'flex' | 'image';
  content: string;
  quoteToken?: string;
  lockSeconds?: number;
};

export async function enqueueHumanReply(
  db: D1Database,
  publicId: string,
  input: EnqueueHumanReplyInput,
): Promise<{ messageId: string; noticeMessageId: string | null; version: number; replayed: boolean }> {
  const row = await resolveConversation(db, publicId);
  if (!row) throw new ConversationNotFoundError('conversation_not_found');
  const replay = await replayIfPresent(db, row.id, 'HUMAN_MESSAGE', input.idempotencyKey);
  if (replay) {
    const saved = replay as ConversationOperationOutput & { messageId?: string; noticeMessageId?: string | null };
    return { messageId: saved.messageId!, noticeMessageId: saved.noticeMessageId ?? null, version: saved.version, replayed: true };
  }
  if (row.version !== input.expectedVersion) throw new ConversationConflictError(row.version);

  const now = jstNow();
  const nowMs = new Date(now).getTime();
  const lockActive = row.lock_owner_id && row.lock_expires_at && new Date(row.lock_expires_at).getTime() > nowMs;
  if (lockActive && row.lock_owner_id !== input.staffId) throw new ConversationConflictError(row.version);

  const fromBot = row.handling_mode === 'bot';
  const nextVersion = row.version + 1;
  const nextGeneration = row.bot_generation + (fromBot ? 1 : 0);
  const lockExpiresAt = new Date(nowMs + Math.max(30, input.lockSeconds ?? 180) * 1000).toISOString();
  const messageId = crypto.randomUUID();
  const noticeMessageId = fromBot && input.notifyCustomer !== false ? crypto.randomUUID() : null;
  const requestId = crypto.randomUUID();
  const output = { messageId, noticeMessageId, version: nextVersion, replayed: false };

  const statements: D1PreparedStatement[] = [
    db.prepare(
      `UPDATE chats
          SET status = 'in_progress', handling_mode = 'human', bot_state = 'PAUSED',
              previous_bot_state = CASE WHEN handling_mode = 'bot' THEN bot_state ELSE previous_bot_state END,
              attention_status = 'WAITING_CUSTOMER',
              bot_generation = ?, version = ?, assigned_staff_id = ?, lock_owner_id = ?,
              lock_expires_at = ?, last_reply_at = ?, updated_at = ?
        WHERE id = ? AND version = ?
          AND (lock_owner_id IS NULL OR lock_expires_at IS NULL OR lock_expires_at <= ? OR lock_owner_id = ?)`,
    ).bind(
      nextGeneration, nextVersion, input.staffId, input.staffId, lockExpiresAt, now, now,
      row.id, row.version, now, input.staffId,
    ),
    db.prepare(
      `INSERT INTO conversation_state_transitions
       (id, conversation_id, from_mode, to_mode, from_bot_state, to_bot_state, reason,
        performed_by_type, performed_by_id, request_id, from_version, to_version, created_at)
       VALUES (?, ?, ?, 'human', ?, 'PAUSED', ?, 'STAFF', ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), row.id, row.handling_mode, row.bot_state, input.reason,
      input.staffId, requestId, row.version, nextVersion, now,
    ),
  ];
  if (noticeMessageId) {
    statements.push(db.prepare(
      `INSERT INTO conversation_outbound_messages
       (id, conversation_id, sender_type, message_type, content, status, idempotency_key,
        expected_control_mode, expected_version, expected_bot_generation, delivery_type, created_by, created_at)
       VALUES (?, ?, 'SYSTEM', 'text', ?, 'PENDING', ?, 'human', ?, ?, 'push', ?, ?)`,
    ).bind(
      noticeMessageId, row.id, HUMAN_NOTICE, `${input.idempotencyKey}:notice`,
      nextVersion, nextGeneration, input.staffId, now,
    ));
  }
  statements.push(db.prepare(
    `INSERT INTO conversation_outbound_messages
     (id, conversation_id, sender_type, message_type, content, status, idempotency_key,
      expected_control_mode, expected_version, expected_bot_generation, delivery_type, quote_token, created_by, created_at)
     VALUES (?, ?, 'HUMAN', ?, ?, 'PENDING', ?, 'human', ?, ?, 'push', ?, ?, ?)`,
  ).bind(
    messageId, row.id, input.messageType, input.content, `${input.idempotencyKey}:message`,
    nextVersion, nextGeneration, input.quoteToken ?? null, input.staffId, now,
  ));
  statements.push(
    db.prepare(
      `INSERT INTO conversation_audit_logs
       (id, conversation_id, action, actor_type, actor_id, request_id, metadata, created_at)
       VALUES (?, ?, 'HUMAN_MESSAGE_QUEUED', 'STAFF', ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), row.id, input.staffId, requestId, JSON.stringify({ messageType: input.messageType }), now),
    db.prepare(
      `INSERT INTO conversation_operation_keys
       (idempotency_key, conversation_id, operation_type, response_status, response_body, created_at, expires_at)
       VALUES (?, ?, 'HUMAN_MESSAGE', 200, ?, ?, ?)`,
    ).bind(input.idempotencyKey, row.id, JSON.stringify(output), now, expiry24h(now)),
  );

  try {
    const results = await db.batch(statements);
    if (Number(results[0]?.meta?.changes ?? 0) !== 1) throw new ConversationConflictError(row.version);
  } catch (error) {
    const replayed = await replayIfPresent(db, row.id, 'HUMAN_MESSAGE', input.idempotencyKey);
    if (replayed) {
      const saved = replayed as ConversationOperationOutput & { messageId?: string; noticeMessageId?: string | null };
      return { messageId: saved.messageId!, noticeMessageId: saved.noticeMessageId ?? null, version: saved.version, replayed: true };
    }
    const current = await resolveConversation(db, row.id);
    if (current && current.version !== row.version) throw new ConversationConflictError(current.version);
    throw error;
  }
  return output;
}
