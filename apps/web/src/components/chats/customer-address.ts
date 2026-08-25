export const SAGAWA_ADDRESS_LINE_MAX = 16

export type SagawaAddressLines = [string, string, string]

/** Convert pasted full-width digits and common dash variants to 999-9999. */
export function normalizePostalCode(value: string): string {
  const halfWidth = value.replace(/[０-９]/g, (digit) =>
    String.fromCharCode(digit.charCodeAt(0) - 0xfee0),
  )
  const digits = halfWidth.replace(/\D/g, '').slice(0, 7)
  if (digits.length <= 3) return digits
  return `${digits.slice(0, 3)}-${digits.slice(3)}`
}

export function isValidPostalCode(value: string): boolean {
  return value === '' || /^\d{3}-\d{4}$/.test(value)
}

export function addressCharacterCount(value: string): number {
  return Array.from(value).length
}

export function isSagawaAddressLine(value: string): boolean {
  return addressCharacterCount(value) <= SAGAWA_ADDRESS_LINE_MAX
}

/** Split a previously saved single-line address without discarding overflow. */
export function splitLegacyAddress(value: string): SagawaAddressLines {
  const characters = Array.from(value.trim())
  return [
    characters.slice(0, SAGAWA_ADDRESS_LINE_MAX).join(''),
    characters.slice(SAGAWA_ADDRESS_LINE_MAX, SAGAWA_ADDRESS_LINE_MAX * 2).join(''),
    characters.slice(SAGAWA_ADDRESS_LINE_MAX * 2).join(''),
  ]
}
