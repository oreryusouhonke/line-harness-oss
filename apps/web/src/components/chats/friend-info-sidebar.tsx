'use client'

import { useState, useEffect, useRef } from 'react'
import { api, type MileageHistoryItem, type MileageSummary } from '@/lib/api'
import ManagementNicknameEditor from '@/components/friends/management-nickname-editor'
import {
  SAGAWA_ADDRESS_LINE_MAX,
  SAGAWA_PHONE_NUMBER_MAX,
  isSagawaAddressLine,
  isValidPhoneNumber,
  isValidPostalCode,
  normalizePhoneNumber,
  normalizePostalCode,
  splitLegacyAddress,
} from './customer-address'

interface FriendDetail {
  id: string
  displayName: string | null
  lineDisplayName: string | null
  managementNickname: string | null
  pictureUrl: string | null
  isFollowing: boolean
  metadata: Record<string, unknown>
  refCode: string | null
  createdAt: string
  tags: Array<{ id: string; name: string; color: string }>
  formSubmissions: Array<{
    id: string
    formId: string
    formName: string
    fields: Array<{ name: string; label: string }>
    data: Record<string, unknown>
    createdAt: string
  }>
}

interface ChatStatusInfo {
  status: 'unread' | 'in_progress' | 'resolved' | null
  notes: string | null
}

interface Props {
  friendId: string | null
  /** 親 (ChatDetail) が持っている chat 側の情報 — status / notes */
  chatStatus?: ChatStatusInfo
  /** 担当者名 (ChatDetail で operatorId → name 変換済を渡す想定) */
  operatorName?: string | null
}

function formatDate(iso: string | null): string {
  if (!iso) return '-'
  const d = new Date(iso)
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const statusLabels: Record<NonNullable<ChatStatusInfo['status']>, { label: string; className: string }> = {
  unread: { label: '未対応', className: 'bg-red-100 text-red-700' },
  in_progress: { label: '対応中', className: 'bg-yellow-100 text-yellow-700' },
  resolved: { label: '解決済', className: 'bg-green-100 text-green-700' },
}

const CUSTOMER_FILE_PATH_KEY = 'customer_file_path'
const CUSTOMER_ADDRESS_KEY = 'customer_address'
const CUSTOMER_POSTAL_CODE_KEY = 'customer_postal_code'
const CUSTOMER_PHONE_NUMBER_KEY = 'customer_phone_number'
const CUSTOMER_ADDRESS_LINE_KEYS = [
  'customer_address_line1',
  'customer_address_line2',
  'customer_address_line3',
] as const
const CUSTOMER_RECIPIENT_NAME_KEY = 'customer_recipient_name'
const CUSTOMER_RECIPIENT_NAME_LINE_KEYS = [
  'customer_recipient_name_line1',
  'customer_recipient_name_line2',
] as const
const EDITABLE_CUSTOMER_METADATA_KEYS = new Set([
  CUSTOMER_FILE_PATH_KEY,
  CUSTOMER_ADDRESS_KEY,
  CUSTOMER_POSTAL_CODE_KEY,
  CUSTOMER_PHONE_NUMBER_KEY,
  ...CUSTOMER_ADDRESS_LINE_KEYS,
  CUSTOMER_RECIPIENT_NAME_KEY,
  ...CUSTOMER_RECIPIENT_NAME_LINE_KEYS,
])

function metadataText(metadata: Record<string, unknown>, key: string): string {
  const value = metadata[key]
  return typeof value === 'string' ? value.trim() : ''
}

/** Render a metadata value safely as text. Objects/arrays → JSON, primitives → as-is. */
function renderValue(value: unknown): string {
  if (value === null || value === undefined) return '-'
  if (typeof value === 'string') return value || '-'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return '[unparseable]'
  }
}

export default function FriendInfoSidebar({ friendId, chatStatus, operatorName }: Props) {
  const currentFriendIdRef = useRef(friendId)
  currentFriendIdRef.current = friendId
  const [friend, setFriend] = useState<FriendDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [customerFilePath, setCustomerFilePath] = useState('')
  const [customerPhoneNumber, setCustomerPhoneNumber] = useState('')
  const [customerPostalCode, setCustomerPostalCode] = useState('')
  const [customerAddressLine1, setCustomerAddressLine1] = useState('')
  const [customerAddressLine2, setCustomerAddressLine2] = useState('')
  const [customerAddressLine3, setCustomerAddressLine3] = useState('')
  const [customerRecipientNameLine1, setCustomerRecipientNameLine1] = useState('')
  const [customerRecipientNameLine2, setCustomerRecipientNameLine2] = useState('')
  const [savedCustomerFilePath, setSavedCustomerFilePath] = useState('')
  const [savedCustomerPhoneNumber, setSavedCustomerPhoneNumber] = useState('')
  const [savedCustomerPostalCode, setSavedCustomerPostalCode] = useState('')
  const [savedCustomerAddressLines, setSavedCustomerAddressLines] = useState<[string, string, string]>(['', '', ''])
  const [savedCustomerRecipientNameLines, setSavedCustomerRecipientNameLines] = useState<[string, string]>(['', ''])
  const [savingCustomerDetails, setSavingCustomerDetails] = useState(false)
  const [customerDetailsMessage, setCustomerDetailsMessage] = useState<{
    kind: 'success' | 'error'
    text: string
  } | null>(null)
  type MileageState =
    | { kind: 'loading' }
    | { kind: 'error' }
    | { kind: 'data'; summary: MileageSummary; history: MileageHistoryItem[] }
  const [mileage, setMileage] = useState<MileageState>({ kind: 'loading' })

  useEffect(() => {
    if (!friendId) {
      setFriend(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    api.friends.get(friendId).then((res) => {
      if (cancelled) return
      if (res.success && res.data) {
        const loadedFriend = res.data as unknown as FriendDetail
        const loadedFilePath = metadataText(loadedFriend.metadata, CUSTOMER_FILE_PATH_KEY)
        const loadedPhoneNumber = normalizePhoneNumber(metadataText(loadedFriend.metadata, CUSTOMER_PHONE_NUMBER_KEY))
        const loadedPostalCode = normalizePostalCode(metadataText(loadedFriend.metadata, CUSTOMER_POSTAL_CODE_KEY))
        const legacyAddressLines = splitLegacyAddress(metadataText(loadedFriend.metadata, CUSTOMER_ADDRESS_KEY))
        const hasStructuredAddress = CUSTOMER_ADDRESS_LINE_KEYS.some(
          (key) => typeof loadedFriend.metadata[key] === 'string',
        )
        const loadedAddressLines: [string, string, string] = hasStructuredAddress
          ? CUSTOMER_ADDRESS_LINE_KEYS.map(
            (key) => metadataText(loadedFriend.metadata, key),
          ) as [string, string, string]
          : legacyAddressLines
        const legacyRecipientNameLines = splitLegacyAddress(
          metadataText(loadedFriend.metadata, CUSTOMER_RECIPIENT_NAME_KEY),
        )
        const hasStructuredRecipientName = CUSTOMER_RECIPIENT_NAME_LINE_KEYS.some(
          (key) => typeof loadedFriend.metadata[key] === 'string',
        )
        const loadedRecipientNameLines: [string, string] = hasStructuredRecipientName
          ? CUSTOMER_RECIPIENT_NAME_LINE_KEYS.map(
            (key) => metadataText(loadedFriend.metadata, key),
          ) as [string, string]
          : [legacyRecipientNameLines[0], legacyRecipientNameLines[1] + legacyRecipientNameLines[2]]
        setFriend(loadedFriend)
        setCustomerFilePath(loadedFilePath)
        setCustomerPhoneNumber(loadedPhoneNumber)
        setCustomerPostalCode(loadedPostalCode)
        setCustomerAddressLine1(loadedAddressLines[0])
        setCustomerAddressLine2(loadedAddressLines[1])
        setCustomerAddressLine3(loadedAddressLines[2])
        setCustomerRecipientNameLine1(loadedRecipientNameLines[0])
        setCustomerRecipientNameLine2(loadedRecipientNameLines[1])
        setSavedCustomerFilePath(loadedFilePath)
        setSavedCustomerPhoneNumber(loadedPhoneNumber)
        setSavedCustomerPostalCode(loadedPostalCode)
        setSavedCustomerAddressLines(loadedAddressLines)
        setSavedCustomerRecipientNameLines(loadedRecipientNameLines)
        setSavingCustomerDetails(false)
        setCustomerDetailsMessage(null)
      } else {
        setError((res as { error?: string }).error ?? '友だち情報を取得できませんでした')
      }
    }).catch((err) => {
      if (cancelled) return
      setError(err instanceof Error ? err.message : String(err))
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [friendId])

  async function saveCustomerDetails() {
    if (!friend || savingCustomerDetails) return

    const targetFriendId = friend.id
    const nextFilePath = customerFilePath.trim()
    const nextPhoneNumber = normalizePhoneNumber(customerPhoneNumber)
    const nextPostalCode = normalizePostalCode(customerPostalCode)
    const nextAddressLines: [string, string, string] = [
      customerAddressLine1.trim(),
      customerAddressLine2.trim(),
      customerAddressLine3.trim(),
    ]
    const nextRecipientNameLines: [string, string] = [
      customerRecipientNameLine1.trim(),
      customerRecipientNameLine2.trim(),
    ]

    if (!isValidPhoneNumber(nextPhoneNumber)) {
      setCustomerDetailsMessage({ kind: 'error', text: '電話番号は半角数字・ハイフン込み14文字以内で入力してください' })
      return
    }
    if (!isValidPostalCode(nextPostalCode)) {
      setCustomerDetailsMessage({ kind: 'error', text: '郵便番号は999-9999形式で入力してください' })
      return
    }
    if (nextAddressLines.some((line) => !isSagawaAddressLine(line))) {
      setCustomerDetailsMessage({ kind: 'error', text: '住所は各行16文字以内で入力してください' })
      return
    }
    if (!nextAddressLines[0] && (nextPostalCode || nextAddressLines[1] || nextAddressLines[2])) {
      setCustomerDetailsMessage({ kind: 'error', text: '住所1を入力してください' })
      return
    }
    if (nextRecipientNameLines.some((line) => !isSagawaAddressLine(line))) {
      setCustomerDetailsMessage({ kind: 'error', text: '宛名は各行16文字以内で入力してください' })
      return
    }
    if (!nextRecipientNameLines[0] && nextRecipientNameLines[1]) {
      setCustomerDetailsMessage({ kind: 'error', text: '宛名1を入力してください' })
      return
    }

    const combinedAddress = nextAddressLines.join('')
    const combinedRecipientName = nextRecipientNameLines.filter(Boolean).join(' ')
    setSavingCustomerDetails(true)
    setCustomerDetailsMessage(null)

    try {
      const res = await api.friends.updateMetadata(targetFriendId, {
        [CUSTOMER_FILE_PATH_KEY]: nextFilePath || null,
        [CUSTOMER_PHONE_NUMBER_KEY]: nextPhoneNumber || null,
        [CUSTOMER_POSTAL_CODE_KEY]: nextPostalCode || null,
        [CUSTOMER_ADDRESS_LINE_KEYS[0]]: nextAddressLines[0] || null,
        [CUSTOMER_ADDRESS_LINE_KEYS[1]]: nextAddressLines[1] || null,
        [CUSTOMER_ADDRESS_LINE_KEYS[2]]: nextAddressLines[2] || null,
        [CUSTOMER_ADDRESS_KEY]: combinedAddress || null,
        [CUSTOMER_RECIPIENT_NAME_LINE_KEYS[0]]: nextRecipientNameLines[0] || null,
        [CUSTOMER_RECIPIENT_NAME_LINE_KEYS[1]]: nextRecipientNameLines[1] || null,
        [CUSTOMER_RECIPIENT_NAME_KEY]: combinedRecipientName || null,
      })
      if (!res.success || !res.data) {
        throw new Error((res as { error?: string }).error ?? '保存できませんでした')
      }

      setFriend((current) => current?.id === targetFriendId
        ? {
          ...current,
          ...(res.data as unknown as Partial<FriendDetail>),
          formSubmissions: current.formSubmissions,
        }
        : current)
      if (currentFriendIdRef.current === targetFriendId) {
        setCustomerFilePath(nextFilePath)
        setCustomerPhoneNumber(nextPhoneNumber)
        setCustomerPostalCode(nextPostalCode)
        setCustomerAddressLine1(nextAddressLines[0])
        setCustomerAddressLine2(nextAddressLines[1])
        setCustomerAddressLine3(nextAddressLines[2])
        setCustomerRecipientNameLine1(nextRecipientNameLines[0])
        setCustomerRecipientNameLine2(nextRecipientNameLines[1])
        setSavedCustomerFilePath(nextFilePath)
        setSavedCustomerPhoneNumber(nextPhoneNumber)
        setSavedCustomerPostalCode(nextPostalCode)
        setSavedCustomerAddressLines(nextAddressLines)
        setSavedCustomerRecipientNameLines(nextRecipientNameLines)
        setCustomerDetailsMessage({ kind: 'success', text: '保存しました' })
      }
    } catch (err) {
      if (currentFriendIdRef.current === targetFriendId) {
        setCustomerDetailsMessage({
          kind: 'error',
          text: err instanceof Error ? err.message : '保存に失敗しました',
        })
      }
    } finally {
      if (currentFriendIdRef.current === targetFriendId) setSavingCustomerDetails(false)
    }
  }

  useEffect(() => {
    if (!friendId) {
      setMileage({ kind: 'loading' })
      return
    }
    let cancelled = false
    setMileage({ kind: 'loading' })
    api.friends.mileage(friendId, 10).then((res) => {
      if (cancelled) return
      if (res.success && res.data) {
        setMileage({ kind: 'data', ...res.data })
      } else {
        setMileage({ kind: 'error' })
      }
    }).catch(() => {
      if (!cancelled) setMileage({ kind: 'error' })
    })
    return () => { cancelled = true }
  }, [friendId])

  // リッチメニュー — loading / error / data を区別して、null=未設定 を取得失敗と
  // 混同しないようにする。Codex review (P3) の指摘で導入。
  type RichMenuState =
    | { kind: 'loading' }
    | { kind: 'error' }
    | { kind: 'data'; id: string | null; name: string | null; isDefault: boolean }
  const [richMenu, setRichMenu] = useState<RichMenuState>({ kind: 'loading' })

  useEffect(() => {
    if (!friendId) {
      setRichMenu({ kind: 'loading' })
      return
    }
    let cancelled = false
    setRichMenu({ kind: 'loading' })
    api.friends.richMenu(friendId).then((res) => {
      if (cancelled) return
      if (res.success && res.data) {
        setRichMenu({ kind: 'data', ...res.data })
      } else {
        setRichMenu({ kind: 'error' })
      }
    }).catch(() => {
      if (cancelled) return
      setRichMenu({ kind: 'error' })
    })
    return () => { cancelled = true }
  }, [friendId])

  if (!friendId) return null

  const hasCustomerDeliveryInfo = [
    customerPhoneNumber,
    customerPostalCode,
    customerAddressLine1,
    customerAddressLine2,
    customerAddressLine3,
    customerRecipientNameLine1,
    customerRecipientNameLine2,
  ].some((value) => value.trim().length > 0)

  return (
    <div className="min-h-0 w-full lg:w-80 lg:flex-shrink bg-white rounded-lg shadow-sm border border-gray-200 flex flex-col overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
        <h3 className="text-sm font-semibold text-gray-700">友だち詳細</h3>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-4 space-y-3 animate-pulse">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-full bg-gray-200" />
              <div className="flex-1 space-y-2">
                <div className="h-3 bg-gray-200 rounded w-32" />
                <div className="h-2 bg-gray-100 rounded w-20" />
              </div>
            </div>
          </div>
        ) : error ? (
          <div className="p-4 text-xs text-red-600">{error}</div>
        ) : friend ? (
          <div className="divide-y divide-gray-100">
            {/* Profile Header */}
            <div className="p-4 flex items-start gap-3">
              {friend.pictureUrl ? (
                <img src={friend.pictureUrl} alt="" className="w-12 h-12 rounded-full flex-shrink-0" />
              ) : (
                <div className="w-12 h-12 rounded-full bg-gray-200 flex items-center justify-center flex-shrink-0">
                  <span className="text-gray-500 text-base">{(friend.displayName || '?').charAt(0)}</span>
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-gray-900 truncate">{friend.displayName || '名前なし'}</p>
                <p className="text-[11px] text-gray-400 mt-0.5">
                  登録日: {formatDate(friend.createdAt)}
                </p>
                {!friend.isFollowing && (
                  <span className="inline-block mt-1 px-1.5 py-0 rounded text-[10px] font-medium bg-gray-100 text-gray-500">
                    ブロック済
                  </span>
                )}
              </div>
            </div>

            {/* Management-only nickname. Never changes the LINE profile name. */}
            <div className="p-4">
              <ManagementNicknameEditor
                friendId={friend.id}
                lineDisplayName={friend.lineDisplayName}
                managementNickname={friend.managementNickname}
                onSaved={(nickname) => setFriend((current) => current ? {
                  ...current,
                  managementNickname: nickname,
                  displayName: nickname || current.lineDisplayName,
                } : current)}
              />
            </div>

            {/* Customer details stored separately from the LINE profile. */}
            <div className="p-4 space-y-3">
              <h4 className="text-[11px] font-medium text-gray-500">お客様情報</h4>
              <details key={friend.id} className="group overflow-hidden rounded-lg border border-gray-200 bg-gray-50/60">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2.5 text-xs font-medium text-gray-700 hover:bg-gray-100 [&::-webkit-details-marker]:hidden">
                  <span>電話番号・住所・宛名</span>
                  <span className="flex items-center gap-2">
                    {hasCustomerDeliveryInfo && (
                      <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-medium text-green-700">
                        登録済み
                      </span>
                    )}
                    <svg
                      aria-hidden="true"
                      className="h-4 w-4 text-gray-400 transition-transform group-open:rotate-180"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m19 9-7 7-7-7" />
                    </svg>
                  </span>
                </summary>
                <div className="space-y-3 border-t border-gray-200 bg-white p-3">
                  <div>
                <label htmlFor={`customer-phone-number-${friend.id}`} className="block text-[11px] font-medium text-gray-500 mb-1">
                  電話番号
                </label>
                <input
                  id={`customer-phone-number-${friend.id}`}
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  value={customerPhoneNumber}
                  onChange={(event) => {
                    setCustomerPhoneNumber(normalizePhoneNumber(event.target.value))
                    setCustomerDetailsMessage(null)
                  }}
                  maxLength={SAGAWA_PHONE_NUMBER_MAX}
                  placeholder="半角数字14桁（ハイフンあり）以内"
                  className="w-full border border-gray-300 rounded px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-green-500"
                />
                  </div>
                  <div>
                <label htmlFor={`customer-postal-code-${friend.id}`} className="block text-[11px] font-medium text-gray-500 mb-1">
                  郵便番号
                </label>
                <input
                  id={`customer-postal-code-${friend.id}`}
                  type="text"
                  inputMode="numeric"
                  autoComplete="postal-code"
                  value={customerPostalCode}
                  onChange={(event) => {
                    setCustomerPostalCode(normalizePostalCode(event.target.value))
                    setCustomerDetailsMessage(null)
                  }}
                  maxLength={8}
                  placeholder="999-9999"
                  aria-describedby={`customer-postal-code-help-${friend.id}`}
                  className="w-full border border-gray-300 rounded px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-green-500"
                />
                <p id={`customer-postal-code-help-${friend.id}`} className="mt-1 text-[10px] text-gray-400">
                  半角数字・ハイフンあり
                </p>
                  </div>
              {[
                { id: '1', label: '住所1', value: customerAddressLine1, setValue: setCustomerAddressLine1, required: true },
                { id: '2', label: '住所2', value: customerAddressLine2, setValue: setCustomerAddressLine2, required: false },
                { id: '3', label: '住所3', value: customerAddressLine3, setValue: setCustomerAddressLine3, required: false },
              ].map((addressLine) => (
                    <div key={addressLine.id}>
                  <label htmlFor={`customer-address-${addressLine.id}-${friend.id}`} className="block text-[11px] font-medium text-gray-500 mb-1">
                    {addressLine.required && <span className="text-red-500 mr-0.5">*</span>}
                    {addressLine.label}
                  </label>
                  <input
                    id={`customer-address-${addressLine.id}-${friend.id}`}
                    type="text"
                    value={addressLine.value}
                    onChange={(event) => {
                      addressLine.setValue(event.target.value)
                      setCustomerDetailsMessage(null)
                    }}
                    maxLength={SAGAWA_ADDRESS_LINE_MAX}
                    placeholder={`全角${SAGAWA_ADDRESS_LINE_MAX}文字以内`}
                    className="w-full border border-gray-300 rounded px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-green-500"
                  />
                    </div>
              ))}
              {[
                { id: '1', label: '宛名1', value: customerRecipientNameLine1, setValue: setCustomerRecipientNameLine1, required: true },
                { id: '2', label: '宛名2', value: customerRecipientNameLine2, setValue: setCustomerRecipientNameLine2, required: false },
              ].map((recipientNameLine) => (
                    <div key={recipientNameLine.id}>
                  <label htmlFor={`customer-recipient-name-${recipientNameLine.id}-${friend.id}`} className="block text-[11px] font-medium text-gray-500 mb-1">
                    {recipientNameLine.required && <span className="text-red-500 mr-0.5">*</span>}
                    {recipientNameLine.label}
                  </label>
                  <input
                    id={`customer-recipient-name-${recipientNameLine.id}-${friend.id}`}
                    type="text"
                    value={recipientNameLine.value}
                    onChange={(event) => {
                      recipientNameLine.setValue(event.target.value)
                      setCustomerDetailsMessage(null)
                    }}
                    maxLength={SAGAWA_ADDRESS_LINE_MAX}
                    placeholder={`全角${SAGAWA_ADDRESS_LINE_MAX}文字以内`}
                    className="w-full border border-gray-300 rounded px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-green-500"
                  />
                    </div>
              ))}
                </div>
              </details>
              <div>
                <label htmlFor={`customer-file-path-${friend.id}`} className="block text-[11px] font-medium text-gray-500 mb-1">
                  顧客ファイル／フォルダのパス
                </label>
                <input
                  id={`customer-file-path-${friend.id}`}
                  type="text"
                  value={customerFilePath}
                  onChange={(event) => {
                    setCustomerFilePath(event.target.value)
                    setCustomerDetailsMessage(null)
                  }}
                  maxLength={1000}
                  placeholder={'例：C:\\顧客管理\\横田和典'}
                  className="w-full border border-gray-300 rounded px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-green-500"
                />
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={saveCustomerDetails}
                  disabled={
                    savingCustomerDetails
                    || (
                      customerFilePath.trim() === savedCustomerFilePath
                      && customerPhoneNumber === savedCustomerPhoneNumber
                      && customerPostalCode === savedCustomerPostalCode
                      && customerAddressLine1.trim() === savedCustomerAddressLines[0]
                      && customerAddressLine2.trim() === savedCustomerAddressLines[1]
                      && customerAddressLine3.trim() === savedCustomerAddressLines[2]
                      && customerRecipientNameLine1.trim() === savedCustomerRecipientNameLines[0]
                      && customerRecipientNameLine2.trim() === savedCustomerRecipientNameLines[1]
                    )
                  }
                  className="px-2.5 py-1 rounded text-xs font-medium text-white disabled:opacity-40"
                  style={{ backgroundColor: '#06C755' }}
                >
                  {savingCustomerDetails ? '保存中...' : '保存'}
                </button>
                {customerDetailsMessage && (
                  <p role="status" aria-live="polite" className={`text-[11px] ${customerDetailsMessage.kind === 'success' ? 'text-green-600' : 'text-red-600'}`}>
                    {customerDetailsMessage.text}
                  </p>
                )}
              </div>
            </div>

            {/* Status / Operator */}
            {(chatStatus?.status || operatorName) && (
              <div className="p-4 space-y-2">
                {chatStatus?.status && statusLabels[chatStatus.status] && (
                  <div className="flex justify-between items-center">
                    <span className="text-[11px] text-gray-500">対応状況</span>
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${statusLabels[chatStatus.status].className}`}>
                      {statusLabels[chatStatus.status].label}
                    </span>
                  </div>
                )}
                {operatorName && (
                  <div className="flex justify-between items-center">
                    <span className="text-[11px] text-gray-500">担当者</span>
                    <span className="text-xs text-gray-700">{operatorName}</span>
                  </div>
                )}
              </div>
            )}

            {/* Notes */}
            {chatStatus?.notes && (
              <div className="p-4">
                <h4 className="text-[11px] font-medium text-gray-500 mb-1.5">個別メモ</h4>
                <p className="text-xs text-gray-700 whitespace-pre-wrap break-words">{chatStatus.notes}</p>
              </div>
            )}

            {/* Tags */}
            <div className="p-4">
              <h4 className="text-[11px] font-medium text-gray-500 mb-1.5">タグ</h4>
              {friend.tags.length === 0 ? (
                <p className="text-[11px] text-gray-400 italic">タグなし</p>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {friend.tags.map((tag) => (
                    <span
                      key={tag.id}
                      className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium"
                      style={{
                        backgroundColor: `${tag.color}20`,
                        color: tag.color,
                      }}
                    >
                      {tag.name}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* Rich Menu */}
            <div className="p-4">
              <h4 className="text-[11px] font-medium text-gray-500 mb-1.5">リッチメニュー</h4>
              {richMenu.kind === 'loading' ? (
                <p className="text-[11px] text-gray-400 italic">読み込み中...</p>
              ) : richMenu.kind === 'error' ? (
                <p className="text-[11px] text-red-500 italic">取得に失敗しました</p>
              ) : richMenu.id === null ? (
                <p className="text-[11px] text-gray-400 italic">未設定</p>
              ) : (
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs text-gray-700">{richMenu.name ?? '(名前なし)'}</span>
                  {richMenu.isDefault && (
                    <span className="px-1.5 py-0 rounded text-[10px] font-medium bg-gray-100 text-gray-500">
                      デフォルト
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* Metadata custom fields */}
            {friend.metadata && Object.entries(friend.metadata).some(([key]) => !EDITABLE_CUSTOMER_METADATA_KEYS.has(key)) && (
              <div className="p-4">
                <h4 className="text-[11px] font-medium text-gray-500 mb-2">友だち情報</h4>
                <dl className="space-y-2 text-xs">
                  {Object.entries(friend.metadata)
                    .filter(([key]) => !EDITABLE_CUSTOMER_METADATA_KEYS.has(key))
                    .map(([key, value]) => (
                    <div key={key}>
                      <dt className="text-[10px] text-gray-400 uppercase tracking-wide">{key}</dt>
                      <dd className="text-gray-700 mt-0.5 whitespace-pre-wrap break-words">{renderValue(value)}</dd>
                    </div>
                    ))}
                </dl>
              </div>
            )}

            {/* Form answers — save_to_metadata の設定に関係なく回答履歴を表示 */}
            {friend.formSubmissions?.length > 0 && (
              <div className="p-4">
                <h4 className="text-[11px] font-medium text-gray-500 mb-2">フォーム回答</h4>
                <div className="space-y-3">
                  {friend.formSubmissions.map((submission) => {
                    const labels = new Map(submission.fields.map((field) => [field.name, field.label]))
                    const answers = Object.entries(submission.data).filter(([key]) => !key.startsWith('_'))
                    return (
                      <div key={submission.id} className="rounded-lg border border-gray-100 bg-gray-50 p-3">
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-xs font-medium text-gray-700 break-words">{submission.formName}</p>
                          <time className="shrink-0 text-[10px] text-gray-400">
                            {formatDate(submission.createdAt)}
                          </time>
                        </div>
                        <dl className="mt-2 space-y-2">
                          {answers.map(([key, value]) => (
                            <div key={key}>
                              <dt className="text-[10px] text-gray-400">{labels.get(key) ?? key}</dt>
                              <dd className="mt-0.5 whitespace-pre-wrap break-words text-xs text-gray-700">
                                {renderValue(value)}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/*
              編集導線は将来追加予定 (現在の /friends は ?id= をハンドルしないため、
              リンク先が機能しない → Codex review で指摘済 → 代わりに削除。
              編集 UI が出来たら復活させる)。
            */}
          </div>
        ) : (
          <div className="p-4 text-xs text-gray-400">友だち情報がありません</div>
        )}
      </div>
    </div>
  )
}


