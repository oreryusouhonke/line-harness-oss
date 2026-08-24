export type ControlMode = 'bot' | 'human';
export type BotState = 'IDLE' | 'CONSULTING' | 'WAITING_CUSTOMER' | 'HANDOFF_REQUESTED' | 'PAUSED' | 'CLOSED';
export type AttentionStatus = 'NONE' | 'NEEDS_REPLY' | 'WAITING_CUSTOMER' | 'WAITING_BUSINESS_HOURS' | 'OVERDUE' | 'URGENT' | 'RESOLVED';

export type ConversationControl = {
  id: string;
  handling_mode: ControlMode;
  bot_state: BotState;
  previous_bot_state: BotState | null;
  attention_status: AttentionStatus;
  bot_generation: number;
  version: number;
  lock_owner_id: string | null;
  lock_expires_at: string | null;
  assigned_staff_id: string | null;
};

export type TransitionResult = {
  mode: ControlMode;
  botState: BotState;
  previousBotState: BotState | null;
  attentionStatus: AttentionStatus;
  botGeneration: number;
  version: number;
  lockOwnerId: string | null;
  lockExpiresAt: string | null;
  assignedStaffId: string | null;
};

export class ConversationConflictError extends Error {
  constructor(public readonly currentVersion: number) {
    super('conversation_version_conflict');
  }
}

function requireVersion(row: ConversationControl, expectedVersion: number): void {
  if (row.version !== expectedVersion) throw new ConversationConflictError(row.version);
}

export function planHumanHandoff(
  row: ConversationControl,
  expectedVersion: number,
  staffId: string | null,
): TransitionResult {
  requireVersion(row, expectedVersion);
  if (row.handling_mode === 'human') {
    return {
      mode: 'human', botState: 'PAUSED', previousBotState: row.previous_bot_state,
      attentionStatus: row.attention_status, botGeneration: row.bot_generation,
      version: row.version, lockOwnerId: row.lock_owner_id,
      lockExpiresAt: row.lock_expires_at, assignedStaffId: row.assigned_staff_id,
    };
  }
  return {
    mode: 'human',
    botState: 'PAUSED',
    previousBotState: row.bot_state,
    attentionStatus: 'NEEDS_REPLY',
    botGeneration: row.bot_generation + 1,
    version: row.version + 1,
    lockOwnerId: staffId,
    lockExpiresAt: null,
    assignedStaffId: staffId,
  };
}

export function planReturnToBot(row: ConversationControl, expectedVersion: number): TransitionResult {
  requireVersion(row, expectedVersion);
  if (row.handling_mode === 'bot' && row.bot_state === 'IDLE') {
    return {
      mode: 'bot', botState: 'IDLE', previousBotState: null,
      attentionStatus: 'NONE', botGeneration: row.bot_generation,
      version: row.version, lockOwnerId: null, lockExpiresAt: null, assignedStaffId: null,
    };
  }
  return {
    mode: 'bot',
    botState: 'IDLE',
    previousBotState: null,
    attentionStatus: 'NONE',
    botGeneration: row.bot_generation + 1,
    version: row.version + 1,
    lockOwnerId: null,
    lockExpiresAt: null,
    assignedStaffId: null,
  };
}

export function canSendQueuedMessage(
  row: ConversationControl,
  expected: { senderType: 'BOT' | 'HUMAN' | 'SYSTEM'; controlMode: ControlMode; version: number; botGeneration: number },
): { allowed: true } | { allowed: false; reason: string } {
  if (row.handling_mode !== expected.controlMode) return { allowed: false, reason: 'control_mode_changed' };
  if (row.version !== expected.version) return { allowed: false, reason: 'version_changed' };
  if (expected.senderType === 'BOT' && row.bot_generation !== expected.botGeneration) {
    return { allowed: false, reason: 'bot_generation_changed' };
  }
  if (expected.senderType === 'BOT' && row.handling_mode !== 'bot') return { allowed: false, reason: 'bot_not_authorized' };
  if (expected.senderType === 'HUMAN' && row.handling_mode !== 'human') return { allowed: false, reason: 'human_not_authorized' };
  return { allowed: true };
}

