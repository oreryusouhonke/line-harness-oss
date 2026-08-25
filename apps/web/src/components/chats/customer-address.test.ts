import { describe, expect, test } from 'vitest'
import {
  addressCharacterCount,
  isSagawaAddressLine,
  isValidPostalCode,
  normalizePostalCode,
  splitLegacyAddress,
} from './customer-address'

describe('Sagawa address formatting', () => {
  test('formats half-width and full-width postal codes as 999-9999', () => {
    expect(normalizePostalCode('1234567')).toBe('123-4567')
    expect(normalizePostalCode('１２３ー４５６７')).toBe('123-4567')
    expect(normalizePostalCode('123-45')).toBe('123-45')
  })

  test('accepts an empty or complete postal code only', () => {
    expect(isValidPostalCode('')).toBe(true)
    expect(isValidPostalCode('123-4567')).toBe(true)
    expect(isValidPostalCode('123-45')).toBe(false)
  })

  test('counts and limits each address line to 16 characters', () => {
    expect(addressCharacterCount('東京都千代田区丸の内一丁目')).toBe(13)
    expect(isSagawaAddressLine('１２３４５６７８９０１２３４５６')).toBe(true)
    expect(isSagawaAddressLine('１２３４５６７８９０１２３４５６７')).toBe(false)
  })

  test('splits a legacy address into 16-character lines without losing overflow', () => {
    const source = '１２３４５６７８９０１２３４５６７８９０１２３４５６７８９０１２３４５６７８９'
    const lines = splitLegacyAddress(source)

    expect(lines[0]).toBe('１２３４５６７８９０１２３４５６')
    expect(lines[1]).toBe('７８９０１２３４５６７８９０１２')
    expect(lines.join('')).toBe(source)
  })
})
