import { describe, expect, it } from 'vitest'
import { isIemotoBotActive, isImportedLineHistory } from './chat-mode'

describe('isIemotoBotActive', () => {
  it('does not mark untouched chats whose bot state is IDLE', () => {
    expect(isIemotoBotActive({ handlingMode: 'bot', botState: 'IDLE' })).toBe(false)
  })

  it.each(['CONSULTING', 'WAITING_CUSTOMER'])('marks an actually active bot state: %s', (botState) => {
    expect(isIemotoBotActive({
      handlingMode: 'bot',
      botState,
      lastCustomerMessageAt: new Date().toISOString(),
    })).toBe(true)
  })

  it('does not mark a bot session after ten minutes without a customer message', () => {
    expect(isIemotoBotActive({
      handlingMode: 'bot',
      botState: 'CONSULTING',
      lastCustomerMessageAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
    })).toBe(false)
  })

  it('does not show the bot mark while a human is handling the chat', () => {
    expect(isIemotoBotActive({ handlingMode: 'human', botState: 'CONSULTING' })).toBe(false)
  })

  it.each(['PAUSED', 'CLOSED'])('does not mark an inactive bot state: %s', (botState) => {
    expect(isIemotoBotActive({ handlingMode: 'bot', botState })).toBe(false)
  })
})

describe('isImportedLineHistory', () => {
  it('identifies only archived LINE history', () => {
    expect(isImportedLineHistory('line_history_import')).toBe(true)
    expect(isImportedLineHistory('line_history_direct')).toBe(false)
    expect(isImportedLineHistory('user')).toBe(false)
    expect(isImportedLineHistory(undefined)).toBe(false)
  })
})
