import { describe, expect, test } from 'vitest'
import {
  addressCharacterCount,
  isSagawaAddressLine,
  isValidPhoneNumber,
  isValidPostalCode,
  normalizePhoneNumber,
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

  test('normalizes phone numbers and limits them to 14 characters', () => {
    expect(normalizePhoneNumber('０９０ー１２３４ー５６７８')).toBe('090-1234-5678')
    expect(normalizePhoneNumber('03 (1234) 5678')).toBe('0312345678')
    expect(normalizePhoneNumber('1234567890123456')).toBe('12345678901234')
    expect(isValidPhoneNumber('090-1234-5678')).toBe(true)
    expect(isValidPhoneNumber('')).toBe(true)
    expect(isValidPhoneNumber('---')).toBe(false)
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
