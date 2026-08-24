import { describe, expect, it } from 'vitest'
import { resolveChatDisplayName } from './chat-display-name'

describe('resolveChatDisplayName', () => {
  it('shows only the management name when one is set', () => {
    expect(resolveChatDisplayName({
      managementNickname: '松澤信一【卸】',
      lineDisplayName: '松澤信一',
      fallback: '松澤信一',
    })).toBe('松澤信一【卸】')
  })

  it('falls back to the LINE display name when there is no management name', () => {
    expect(resolveChatDisplayName({
      managementNickname: null,
      lineDisplayName: '松澤信一',
      fallback: '名前なし',
    })).toBe('松澤信一')
  })

  it('ignores a blank management name', () => {
    expect(resolveChatDisplayName({
      managementNickname: '   ',
      lineDisplayName: '松澤信一',
      fallback: '名前なし',
    })).toBe('松澤信一')
  })

  it('uses the fallback when both stored names are absent', () => {
    expect(resolveChatDisplayName({
      managementNickname: null,
      lineDisplayName: null,
      fallback: '名前なし',
    })).toBe('名前なし')
  })
})
