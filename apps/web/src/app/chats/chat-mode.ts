export type ChatModeState = {
  handlingMode: 'bot' | 'human'
  botState: string
  lastCustomerMessageAt?: string | null
}

const ACTIVE_IEMOTO_BOT_STATES = new Set(['CONSULTING', 'WAITING_CUSTOMER'])
const IEMOTO_IDLE_TIMEOUT_MS = 10 * 60 * 1000

export function isIemotoBotActive(chat: ChatModeState): boolean {
  if (chat.handlingMode !== 'bot' || !ACTIVE_IEMOTO_BOT_STATES.has(chat.botState)) return false
  const lastCustomerMessageAt = Date.parse(chat.lastCustomerMessageAt || '')
  return Number.isFinite(lastCustomerMessageAt) && Date.now() - lastCustomerMessageAt <= IEMOTO_IDLE_TIMEOUT_MS
}

export function isImportedLineHistory(source?: string): boolean {
  return source === 'line_history_import'
}
