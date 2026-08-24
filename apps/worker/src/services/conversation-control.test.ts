import { describe, expect, it } from 'vitest';
import {
  canSendQueuedMessage,
  ConversationConflictError,
  planHumanHandoff,
  planReturnToBot,
  type ConversationControl,
} from './conversation-control.js';

const base = (overrides: Partial<ConversationControl> = {}): ConversationControl => ({
  id: 'chat-1', handling_mode: 'bot', bot_state: 'CONSULTING', previous_bot_state: null,
  attention_status: 'NONE', bot_generation: 4, version: 7, lock_owner_id: null,
  lock_expires_at: null, assigned_staff_id: null, ...overrides,
});

describe('conversation control state machine', () => {
  it('pauses Bot and invalidates an in-flight generation before human handoff', () => {
    const next = planHumanHandoff(base(), 7, 'staff-1');
    expect(next).toMatchObject({
      mode: 'human', botState: 'PAUSED', previousBotState: 'CONSULTING',
      attentionStatus: 'NEEDS_REPLY', botGeneration: 5, version: 8,
      assignedStaffId: 'staff-1', lockOwnerId: 'staff-1',
    });
  });

  it('returns to a fresh IDLE Bot and clears handoff/lock state', () => {
    const next = planReturnToBot(base({
      handling_mode: 'human', bot_state: 'HANDOFF_REQUESTED', previous_bot_state: 'CONSULTING',
      attention_status: 'NEEDS_REPLY', lock_owner_id: 'staff-1', assigned_staff_id: 'staff-1',
    }), 7);
    expect(next).toMatchObject({
      mode: 'bot', botState: 'IDLE', previousBotState: null, attentionStatus: 'NONE',
      botGeneration: 5, version: 8, lockOwnerId: null, assignedStaffId: null,
    });
  });

  it('rejects stale state transitions with the current version', () => {
    expect(() => planHumanHandoff(base(), 6, 'staff-1')).toThrow(ConversationConflictError);
  });

  it('cancels a Bot answer generated before human takeover', () => {
    const afterHandoff = base({ handling_mode: 'human', bot_state: 'PAUSED', bot_generation: 5, version: 8 });
    expect(canSendQueuedMessage(afterHandoff, {
      senderType: 'BOT', controlMode: 'bot', version: 7, botGeneration: 4,
    })).toEqual({ allowed: false, reason: 'control_mode_changed' });
  });

  it('allows only a message matching the current authoritative state', () => {
    expect(canSendQueuedMessage(base(), {
      senderType: 'BOT', controlMode: 'bot', version: 7, botGeneration: 4,
    })).toEqual({ allowed: true });
  });
});

