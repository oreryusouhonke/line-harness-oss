'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { parseStickerMessageContent, stickerFallback } from '@line-crm/shared'
import { api, fetchApi } from '@/lib/api'
import { UNANSWERED_REFRESH_EVENT } from '@/lib/events'
import { useAccount } from '@/contexts/account-context'
import CcPromptButton from '@/components/cc-prompt-button'
import FlexPreviewComponent from '@/components/flex-preview'
import FriendInfoSidebar from '@/components/chats/friend-info-sidebar'
import ImageUploader, { type ImageUploaderValue } from '@/components/shared/image-uploader'
import { isIemotoBotActive, isImportedLineHistory } from './chat-mode'
import { resolveChatDisplayName } from './chat-display-name'
import { readClientCache, writeClientCache } from '@/lib/client-cache'

interface Chat {
  id: string
  friendId: string
  friendName: string
  lineDisplayName: string | null
  managementNickname: string | null
  friendPictureUrl: string | null
  operatorId: string | null
  status: 'unread' | 'in_progress' | 'resolved'
  handlingMode: 'bot' | 'human'
  botState: string
  attentionStatus: string
  priority: string
  assignedStaffId: string | null
  lockOwnerId: string | null
  lockExpiresAt: string | null
  nextActionAt: string | null
  lastCustomerMessageAt: string | null
  version: number
  notes: string | null
  lastMessageAt: string | null
  lastMessageContent: string | null
  lastMessageDirection: 'incoming' | 'outgoing' | null
  lastMessageType: string | null
  createdAt: string
  updatedAt: string
}

interface ChatMessage {
  id: string
  direction: 'incoming' | 'outgoing'
  messageType: string
  content: string
  source?: string
  canQuote?: boolean
  createdAt: string
}

interface ChatDetail extends Chat {
  friendName: string
  friendPictureUrl: string | null
  messages?: ChatMessage[]
  handlingMode: 'bot' | 'human'
  version: number
  botGeneration: number
  botState: string
  attentionStatus: string
  hasMoreMessages?: boolean
}

type StatusFilter = 'all' | 'unread' | 'in_progress' | 'resolved'
type QueueFilter = 'all' | 'in_progress' | 'needs_action'

const CHAT_QUEUE_FILTER_PREF_KEY = 'lh_chat_queue_filter'
const CHAT_PAGE_SIZE = 100
const CHAT_MESSAGE_PAGE_SIZE = 25
const CHAT_DETAIL_CACHE_SIZE = 30
const CHAT_VIEW_CACHE_MAX_AGE = 12 * 60 * 60_000

type ChatListCacheParams = {
  status?: string
  accountId?: string
  search?: string
  unansweredOnly?: boolean
  limit?: number
}

function chatListCacheKey(params: ChatListCacheParams): string {
  const query = new URLSearchParams()
  if (params.status) query.set('status', params.status)
  if (params.accountId) query.set('accountId', params.accountId)
  if (params.search) query.set('search', params.search)
  if (params.unansweredOnly) query.set('unansweredOnly', '1')
  if (params.limit !== undefined) query.set('limit', String(params.limit))
  return `view:chats:list:${query.toString()}`
}

function chatDetailCacheKey(chatId: string): string {
  return `view:chats:detail:${chatId}`
}

const statusConfig: Record<Chat['status'], { label: string; className: string }> = {
  unread: { label: '未読', className: 'bg-red-100 text-red-700' },
  in_progress: { label: '対応中', className: 'bg-yellow-100 text-yellow-700' },
  resolved: { label: '解決済', className: 'bg-green-100 text-green-700' },
}

const statusFilters: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: '全て' },
  { key: 'unread', label: '未読' },
  { key: 'in_progress', label: '対応中' },
  { key: 'resolved', label: '解決済' },
]

function StickerMessageImage({ content }: { content: string }) {
  const [failed, setFailed] = useState(false)
  const sticker = parseStickerMessageContent(content)
  const fallback = stickerFallback(content)

  if (!sticker || failed) return <span>{fallback}</span>

  return (
    <img
      src={sticker.stickerUrl}
      alt={fallback}
      className="max-h-[140px] max-w-[140px] object-contain"
      loading="lazy"
      onError={() => setFailed(true)}
    />
  )
}

function FriendNamePair({ lineDisplayName, managementNickname, fallback }: {
  lineDisplayName?: string | null
  managementNickname?: string | null
  fallback: string
}) {
  const displayName = resolveChatDisplayName({ lineDisplayName, managementNickname, fallback })

  return (
    <span className="block min-w-0 truncate">{displayName}</span>
  )
}

function ImportedHistoryCard({ message }: { message: ChatMessage }) {
  return (
    <details className="mx-auto max-w-[360px] rounded-xl border border-white/40 bg-white/95 text-gray-800 shadow-sm">
      <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold hover:bg-gray-50 rounded-xl">
        過去履歴を見る
        <span className="ml-2 text-xs font-normal text-gray-500">
          {formatYmdSlash(message.createdAt)}まで
        </span>
      </summary>
      <div className="max-h-[420px] overflow-y-auto border-t border-gray-200 px-4 py-3 text-sm whitespace-pre-wrap break-words">
        {message.content}
      </div>
    </details>
  )
}

function formatDatetime(iso: string | null): string {
  if (!iso) return '-'
  return new Date(iso).toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function sameYmd(aIso: string, bIso: string): boolean {
  const a = new Date(aIso)
  const b = new Date(bIso)
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

function formatYmdSlash(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

const ccPrompts = [
  {
    title: 'チャット対応テンプレート',
    prompt: `チャット対応で使えるテンプレートメッセージを作成してください。
1. よくある質問への回答テンプレート（挨拶、FAQ、サポート）
2. クレーム対応用の丁寧な返信テンプレート
3. フォローアップメッセージのテンプレート
手順を示してください。`,
  },
  {
    title: '未対応チャット確認',
    prompt: `未対応のチャットを確認し、対応優先度を整理してください。
1. 未読・対応中のチャット数を集計
2. 最終メッセージからの経過時間で優先度を判定
3. 長時間未対応のチャットへの対応アクションを提案
結果をレポートしてください。`,
  },
]

interface FriendItem {
  id: string
  displayName: string
  pictureUrl: string | null
  isFollowing: boolean
}

interface MessageLog {
  id: string
  direction: 'incoming' | 'outgoing'
  messageType: string
  content: string
  createdAt: string
}

function DirectMessagePanel({ friendId, friend, onBack, onSent }: {
  friendId: string
  friend: FriendItem | null
  onBack: () => void
  onSent: () => void
}) {
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [messages, setMessages] = useState<MessageLog[]>([])
  const [loadingMessages, setLoadingMessages] = useState(true)
  const isComposingRef = useRef(false)
  const sendLockRef = useRef(false)

  useEffect(() => {
    const loadMessages = async () => {
      setLoadingMessages(true)
      try {
        const res = await fetchApi<{ success: boolean; data: MessageLog[] }>(
          `/api/friends/${friendId}/messages`
        )
        if (res.success) setMessages(res.data)
      } catch { /* silent */ }
      setLoadingMessages(false)
    }
    loadMessages()
  }, [friendId])

  const handleSend = async () => {
    if (!message.trim() || sending || sendLockRef.current) return
    sendLockRef.current = true
    setSending(true)
    try {
      await fetchApi(`/api/friends/${friendId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: message, messageType: 'text' }),
      })
      setMessages((prev) => [...prev, {
        id: crypto.randomUUID(),
        direction: 'outgoing',
        messageType: 'text',
        content: message,
        createdAt: new Date().toISOString(),
      }])
      setMessage('')
    } catch { /* silent */ }
    setSending(false)
    sendLockRef.current = false
  }

  function renderContent(msg: MessageLog) {
    if (msg.messageType === 'text') return msg.content
    if (msg.messageType === 'flex') {
      try {
        const parsed = JSON.parse(msg.content)
        // Extract ALL text from flex (up to 200 chars)
        const texts: string[] = []
        const collectText = (obj: Record<string, unknown>) => {
          if (texts.join(' ').length > 200) return
          if (obj.type === 'text' && typeof obj.text === 'string') {
            const t = (obj.text as string).trim()
            if (t && !t.startsWith('{{')) texts.push(t)
          }
          for (const key of ['header', 'body', 'footer']) {
            if (obj[key]) collectText(obj[key] as Record<string, unknown>)
          }
          if (Array.isArray(obj.contents)) {
            for (const c of obj.contents) collectText(c as Record<string, unknown>)
          }
        }
        collectText(parsed)
        return texts.slice(0, 4).join('\n') || '[Flex Message]'
      } catch { return '[Flex Message]' }
    }
    if (msg.messageType === 'sticker') {
      return <StickerMessageImage content={msg.content} />
    }
    return `[${msg.messageType}]`
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-4 border-b border-gray-200 flex items-center gap-3">
        <button onClick={onBack} className="lg:hidden text-gray-400 hover:text-gray-600">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        {friend?.pictureUrl ? (
          <img src={friend.pictureUrl} alt="" className="w-8 h-8 rounded-full" />
        ) : (
          <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center">
            <span className="text-gray-500 text-xs">{(friend?.displayName || '?').charAt(0)}</span>
          </div>
        )}
        <div>
          <p className="text-sm font-bold text-gray-900">{friend?.displayName || '不明'}</p>
          <p className="text-xs text-gray-400">メッセージ履歴</p>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {loadingMessages ? (
          <p className="text-center text-gray-400 text-sm">読み込み中...</p>
        ) : messages.length === 0 ? (
          <p className="text-center text-gray-400 text-sm">メッセージ履歴がありません</p>
        ) : (
          messages.map((msg) => (
            <div key={msg.id} className={`flex ${msg.direction === 'outgoing' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[75%] rounded-2xl px-4 py-2 ${
                msg.direction === 'outgoing'
                  ? 'bg-green-500 text-white'
                  : 'bg-gray-100 text-gray-900'
              }`}>
                <div className="text-sm whitespace-pre-wrap break-words">{renderContent(msg)}</div>
                <p className={`text-xs mt-1 ${msg.direction === 'outgoing' ? 'text-green-200' : 'text-gray-400'}`}>
                  {new Date(msg.createdAt).toLocaleString('ja-JP', { hour: '2-digit', minute: '2-digit' })}
                </p>
              </div>
            </div>
          ))
        )}
      </div>
      <div className="px-4 py-3 border-t border-gray-200">
        <div className="flex gap-2">
          <input
            type="text"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onCompositionStart={() => { isComposingRef.current = true }}
            onCompositionEnd={() => { isComposingRef.current = false }}
            onKeyDown={(e) => {
              // IME変換確定のEnterでは送信しない
              if (e.nativeEvent.isComposing || isComposingRef.current || e.keyCode === 229) return
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSend()
              }
            }}
            placeholder="メッセージを入力..."
            className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
          />
          <button
            onClick={handleSend}
            disabled={!message.trim() || sending}
            className="px-4 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50"
            style={{ backgroundColor: '#06C755' }}
          >
            {sending ? '...' : '送信'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function ChatsPage() {
  const { selectedAccountId } = useAccount()
  const [chats, setChats] = useState<Chat[]>([])
  const [allFriends] = useState<FriendItem[]>([])
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null)
  const [selectedFriendId, setSelectedFriendId] = useState<string | null>(null)
  const [chatDetail, setChatDetail] = useState<ChatDetail | null>(null)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [queueFilter, setQueueFilter] = useState<QueueFilter>('all')
  const [searchInput, setSearchInput] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const statusFilterRef = useRef<StatusFilter>('all')
  const unansweredOnlyRef = useRef(false)
  const [unansweredOnly] = useState(() => {
    if (typeof window === 'undefined') return false
    return new URLSearchParams(window.location.search).get('unanswered') === '1'
  })

  useEffect(() => {
    const id = window.setTimeout(() => setSearchQuery(searchInput.trim()), 250)
    return () => window.clearTimeout(id)
  }, [searchInput])

  useEffect(() => {
    try {
      const saved = localStorage.getItem(CHAT_QUEUE_FILTER_PREF_KEY)
      if (saved === 'all' || saved === 'in_progress' || saved === 'needs_action') {
        setQueueFilter(saved)
      }
    } catch {
      // localStorage unavailable
    }
  }, [])

  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMoreChats, setHasMoreChats] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false)
  const [error, setError] = useState('')
  const [messageContent, setMessageContent] = useState('')
  const [pendingImage, setPendingImage] = useState<ImageUploaderValue | null>(null)
  const [sending, setSending] = useState(false)
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null)
  const [deletingMessageId, setDeletingMessageId] = useState<string | null>(null)
  const [downloadingMessageId, setDownloadingMessageId] = useState<string | null>(null)
  const sendLockRef = useRef(false)
  const chatListRefreshInFlightRef = useRef(false)
  const chatDetailRequestsRef = useRef(new Map<string, Promise<ChatDetail | null>>())
  const chatDetailCacheRef = useRef(new Map<string, ChatDetail>())
  const olderMessagesInFlightRef = useRef(false)
  const selectedChatIdRef = useRef<string | null>(null)
  const chatRevisionRef = useRef<string | null>(null)
  const revisionRefreshInFlightRef = useRef(false)
  const nextCursorRef = useRef<{ at: string; id: string } | null>(null)
  const [notes, setNotes] = useState('')
  const [savingNotes, setSavingNotes] = useState(false)
  const [switchingHandlingMode, setSwitchingHandlingMode] = useState(false)
  const isComposingRef = useRef(false)
  const messagesScrollRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { selectedChatIdRef.current = selectedChatId }, [selectedChatId])

  const buildListParams = useCallback((cursor: { at: string; id: string } | null) => ({
    status: statusFilter === 'all' ? undefined : statusFilter,
    accountId: selectedAccountId || undefined,
    search: searchQuery || undefined,
    unansweredOnly,
    limit: CHAT_PAGE_SIZE,
    beforeAt: cursor?.at,
    beforeId: cursor?.id,
  }), [selectedAccountId, searchQuery, statusFilter, unansweredOnly])

  const loadChats = useCallback(async (silent = false) => {
    if (silent && chatListRefreshInFlightRef.current) return
    chatListRefreshInFlightRef.current = true
    const params = buildListParams(null)
    const cacheKey = chatListCacheKey(params)
    const cached = silent
      ? null
      : readClientCache<Chat[]>(cacheKey, CHAT_VIEW_CACHE_MAX_AGE)

    const applyRows = (rows: Chat[]) => {
      setChats(rows)
      const last = rows[rows.length - 1]
      nextCursorRef.current = last?.lastMessageAt ? { at: last.lastMessageAt, id: last.id } : null
      setHasMoreChats(!unansweredOnly && rows.length === CHAT_PAGE_SIZE)
    }

    if (!silent) {
      if (cached) {
        // Paint the last known list before the network round trip, then replace
        // it below with the authoritative D1 result.
        applyRows(cached.value)
        setLoading(false)
      } else {
        setLoading(true)
      }
      setError('')
    }
    try {
      const chatRes = await api.chats.list(params)
      if (chatRes.success) {
        const rows = chatRes.data as unknown as Chat[]
        applyRows(rows)
        writeClientCache(cacheKey, rows)
        return true
      }
      return false
    } catch {
      if (!silent && !cached) setError('チャットの読み込みに失敗しました。もう一度お試しください。')
      return false
    } finally {
      chatListRefreshInFlightRef.current = false
      if (!silent) setLoading(false)
    }
  }, [buildListParams, unansweredOnly])

  // 「さらに読み込む」— サーバ由来カーソルの続きを取得して末尾に追加する。
  // 楽観更新との競合に備えて既存 id は除外し、重複表示を防ぐ。
  const loadMoreChats = useCallback(async () => {
    if (loadingMore) return
    const cursor = nextCursorRef.current
    if (!cursor) {
      setHasMoreChats(false)
      return
    }
    setLoadingMore(true)
    try {
      const chatRes = await api.chats.list(buildListParams(cursor))
      if (chatRes.success) {
        const rows = chatRes.data as unknown as Chat[]
        setChats((prev) => {
          const seen = new Set(prev.map((c) => c.id))
          return [...prev, ...rows.filter((r) => !seen.has(r.id))]
        })
        const last = rows[rows.length - 1]
        nextCursorRef.current = last?.lastMessageAt ? { at: last.lastMessageAt, id: last.id } : null
        setHasMoreChats(rows.length === CHAT_PAGE_SIZE)
      }
    } catch {
      setError('チャットの追加読み込みに失敗しました。')
    } finally {
      setLoadingMore(false)
    }
  }, [loadingMore, buildListParams])

  // Keep refs in sync so setChats updater can read the latest filter without stale closure
  useEffect(() => { statusFilterRef.current = statusFilter }, [statusFilter])
  useEffect(() => { unansweredOnlyRef.current = unansweredOnly }, [unansweredOnly])

  const loadChatDetail = useCallback(async (chatId: string, silent = false) => {
    let cached = chatDetailCacheRef.current.get(chatId)
    if (!cached) {
      const stored = readClientCache<ChatDetail>(chatDetailCacheKey(chatId), CHAT_VIEW_CACHE_MAX_AGE)
      if (stored) {
        cached = stored.value
        chatDetailCacheRef.current.set(chatId, cached)
      }
    }
    if (!silent) {
      if (cached) {
        setChatDetail(cached)
        setNotes(cached.notes || '')
        setDetailLoading(false)
      } else {
        setChatDetail(null)
        setDetailLoading(true)
      }
      setError('')
    }

    let request = chatDetailRequestsRef.current.get(chatId)
    if (!request) {
      request = api.chats.get(chatId, { messageLimit: CHAT_MESSAGE_PAGE_SIZE })
        .then((res) => res.success ? res.data as unknown as ChatDetail : null)
        .finally(() => { chatDetailRequestsRef.current.delete(chatId) })
      chatDetailRequestsRef.current.set(chatId, request)
    }

    try {
      const detail = await request
      if (detail) {
        chatDetailCacheRef.current.delete(chatId)
        chatDetailCacheRef.current.set(chatId, detail)
        writeClientCache(chatDetailCacheKey(chatId), detail)
        if (chatDetailCacheRef.current.size > CHAT_DETAIL_CACHE_SIZE) {
          const oldestKey = chatDetailCacheRef.current.keys().next().value
          if (oldestKey) chatDetailCacheRef.current.delete(oldestKey)
        }
        if (selectedChatIdRef.current === chatId) {
          setChatDetail(detail)
          setNotes(detail.notes || '')
        }
        return true
      } else {
        if (!silent) setError('チャット詳細の読み込みに失敗しました。')
        return false
      }
    } catch (err) {
      // ネットワーク / parse / auth fail などの例外。empty catch だと原因不明だったので詳細を出す。
      const msg = err instanceof Error ? err.message : String(err)
      if (!silent) setError(`チャット詳細の読み込みに失敗しました: ${msg}`)
      return false
    } finally {
      if (!silent && selectedChatIdRef.current === chatId) setDetailLoading(false)
    }
  }, [])

  const loadOlderMessages = useCallback(async () => {
    if (!selectedChatId || !chatDetail?.hasMoreMessages || olderMessagesInFlightRef.current) return
    const firstMessage = chatDetail.messages?.[0]
    if (!firstMessage) return

    const chatId = selectedChatId
    const scrollElement = messagesScrollRef.current
    const previousScrollHeight = scrollElement?.scrollHeight ?? 0
    olderMessagesInFlightRef.current = true
    setLoadingOlderMessages(true)
    try {
      const res = await api.chats.get(chatId, {
        messageLimit: CHAT_MESSAGE_PAGE_SIZE,
        beforeAt: firstMessage.createdAt,
        beforeId: firstMessage.id,
      })
      if (!res.success || selectedChatIdRef.current !== chatId) return

      const page = res.data as unknown as ChatDetail
      setChatDetail((current) => {
        if (!current || current.id !== chatId) return current
        // 取得中にWebhook更新で最新25件が差し替わった場合、このカーソルの結果を
        // そのまま連結すると境界に抜けが生じ得る。古い結果は捨て、次のスクロールで
        // 新しい先頭メッセージを基準に取り直す。
        if (current.messages?.[0]?.id !== firstMessage.id) return current
        const existingIds = new Set((current.messages ?? []).map((message) => message.id))
        const olderMessages = (page.messages ?? []).filter((message) => !existingIds.has(message.id))
        const merged = {
          ...current,
          messages: [...olderMessages, ...(current.messages ?? [])],
          hasMoreMessages: page.hasMoreMessages,
        }
        chatDetailCacheRef.current.set(chatId, merged)
        return merged
      })
      window.requestAnimationFrame(() => {
        const currentElement = messagesScrollRef.current
        if (currentElement) currentElement.scrollTop += currentElement.scrollHeight - previousScrollHeight
      })
    } catch {
      setError('過去のメッセージを読み込めませんでした。もう一度上へスクロールしてください。')
    } finally {
      olderMessagesInFlightRef.current = false
      setLoadingOlderMessages(false)
    }
  }, [chatDetail, selectedChatId])

  useEffect(() => {
    loadChats()
  }, [loadChats])

  // Deep-link from other pages (e.g. /form-submissions): ?friend=<friendId>
  // chat list returns id = friend_id, so selectedChatId === friendId is correct.
  // If no chat exists yet, loadChatDetail will fail and the user can fall back to
  // the friend list — acceptable for now.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const friendId = params.get('friend')
    if (friendId) setSelectedChatId(friendId)
  }, [])

  useEffect(() => {
    if (selectedChatId) {
      const cachedDetail = chatDetailCacheRef.current.get(selectedChatId)
      if (cachedDetail) {
        setChatDetail(cachedDetail)
        setNotes(cachedDetail.notes || '')
        setDetailLoading(false)
      }
      void loadChatDetail(selectedChatId, Boolean(cachedDetail))
    } else {
      setChatDetail(null)
    }
  }, [selectedChatId, loadChatDetail])

  // LINE Webhook / 手動送信 / 対応状況の変更で revision が進んだ時だけ、
  // 重い一覧と本文を再取得する。通常時はインデックスだけを見る軽量API 1本で済む。
  // 常時接続ではなく revision を使うため、スリープや一時切断後も次回確認で必ず追いつく。
  useEffect(() => {
    let cancelled = false

    const refreshWhenChanged = async () => {
      if (document.visibilityState !== 'visible' || revisionRefreshInFlightRef.current) return
      revisionRefreshInFlightRef.current = true
      try {
        const revisionRes = await api.chats.revision({
          accountId: selectedAccountId || undefined,
        })
        if (cancelled || !revisionRes.success) return

        const nextRevision = revisionRes.data.revision
        // 初回は監視の基準値だけを保存する。本文は選択時の処理が既に取得しているため、
        // ここで再取得すると同じチャットへの重複通信になってしまう。
        if (chatRevisionRef.current === null) {
          chatRevisionRef.current = nextRevision
          return
        }
        if (chatRevisionRef.current === nextRevision) return

        const [listUpdated, detailUpdated] = await Promise.all([
          loadChats(true),
          selectedChatIdRef.current ? loadChatDetail(selectedChatIdRef.current, true) : Promise.resolve(true),
        ])
        if (!cancelled && listUpdated && detailUpdated) {
          chatRevisionRef.current = nextRevision
        }
      } catch {
        // 一時的な通信失敗では revision を進めない。次回確認で同じ変更を再取得する。
      } finally {
        revisionRefreshInFlightRef.current = false
      }
    }

    void refreshWhenChanged()
    const id = window.setInterval(refreshWhenChanged, 3000)
    document.addEventListener('visibilitychange', refreshWhenChanged)
    return () => {
      cancelled = true
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', refreshWhenChanged)
    }
  }, [loadChatDetail, loadChats, selectedAccountId])

  useEffect(() => {
    chatRevisionRef.current = null
  }, [selectedAccountId])

  // Surface deep-linked chats in the sidebar even when the current account
  // filter or status filter would exclude them — otherwise the user replies
  // and the conversation stays invisible until they refresh.
  // Re-runs when `chats` changes (e.g. after loadChats refetches on filter
  // change) so the synthetic entry is re-injected if the next API result
  // does not include it. Returning `prev` unchanged when already present
  // avoids any update loop.
  useEffect(() => {
    if (!chatDetail) return
    setChats((prev) => {
      if (prev.some((c) => c.id === chatDetail.id)) return prev
      // /api/chats/:id may not populate the lastMessage* fields; derive
      // from the messages array as a fallback so the sidebar preview is
      // not stuck on "(まだメッセージなし)".
      const lastMsg = chatDetail.messages?.[chatDetail.messages.length - 1]
      const entry: Chat = {
        id: chatDetail.id,
        friendId: chatDetail.friendId,
        friendName: chatDetail.friendName,
        lineDisplayName: chatDetail.lineDisplayName,
        managementNickname: chatDetail.managementNickname,
        friendPictureUrl: chatDetail.friendPictureUrl,
        operatorId: chatDetail.operatorId ?? null,
        status: chatDetail.status,
        handlingMode: chatDetail.handlingMode ?? 'bot',
        botState: chatDetail.botState ?? 'IDLE',
        attentionStatus: chatDetail.attentionStatus ?? 'NONE',
        priority: chatDetail.priority ?? 'NORMAL',
        assignedStaffId: chatDetail.assignedStaffId ?? null,
        lockOwnerId: chatDetail.lockOwnerId ?? null,
        lockExpiresAt: chatDetail.lockExpiresAt ?? null,
        nextActionAt: chatDetail.nextActionAt ?? null,
        lastCustomerMessageAt: chatDetail.lastCustomerMessageAt ?? null,
        version: chatDetail.version ?? 1,
        notes: chatDetail.notes ?? null,
        lastMessageAt: chatDetail.lastMessageAt ?? lastMsg?.createdAt ?? null,
        lastMessageContent: chatDetail.lastMessageContent ?? lastMsg?.content ?? null,
        lastMessageDirection: chatDetail.lastMessageDirection ?? lastMsg?.direction ?? null,
        lastMessageType: chatDetail.lastMessageType ?? lastMsg?.messageType ?? null,
        createdAt: chatDetail.createdAt,
        updatedAt: chatDetail.updatedAt,
      }
      return [entry, ...prev]
    })
  }, [chatDetail, chats])

  // 詳細が新しくロードされたら最下部（＝最新メッセージ）までスクロールする。
  // そこから上にスクロールすれば過去のメッセージを辿れる（LINE受信画面と同じUX）。
  // ユーザーが手動でスクロールしたら delayed auto-scroll は発動させない。
  useEffect(() => {
    if (!chatDetail?.messages || chatDetail.messages.length === 0) return
    const el = messagesScrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    let userScrolled = false
    const onScroll = () => {
      if (!messagesScrollRef.current) return
      const current = messagesScrollRef.current
      // 下端から一定以上離れたらユーザー操作とみなす
      if (current.scrollHeight - current.scrollTop - current.clientHeight > 20) {
        userScrolled = true
      }
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    // 画像/Flex の表示後に高さが増える場合に追従するフォロワー（ユーザーがスクロール済みなら発動させない）
    const id = window.setTimeout(() => {
      if (userScrolled || !messagesScrollRef.current) return
      messagesScrollRef.current.scrollTop = messagesScrollRef.current.scrollHeight
    }, 150)
    return () => {
      window.clearTimeout(id)
      el.removeEventListener('scroll', onScroll)
    }
  }, [chatDetail?.id, chatDetail?.messages?.[chatDetail.messages.length - 1]?.id])

  // Auto-resize textarea as messageContent grows
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [messageContent])

  const handleSelectChat = (chatId: string) => {
    setSelectedChatId(chatId)
    setMessageContent('')
    setPendingImage(null)
    setReplyTo(null)
  }

  const handleSendMessage = async () => {
    if (!selectedChatId || sending || sendLockRef.current) return
    if (!messageContent.trim() && !pendingImage) return
    const sendingChatId = selectedChatId  // capture the chat id for this send
    sendLockRef.current = true
    setSending(true)
    try {
      const now = new Date().toISOString()
      let currentVersion = chatDetail?.version ?? 1
      // --- Image send path (runs first when image is present) ---
      if (pendingImage && pendingImage.mode === 'line-image') {
        const imgPayload = JSON.stringify({
          originalContentUrl: pendingImage.originalContentUrl,
          previewImageUrl: pendingImage.previewImageUrl,
        })
        const imageResult = await api.chats.send(sendingChatId, {
          messageType: 'image', content: imgPayload, expectedVersion: currentVersion, idempotencyKey: crypto.randomUUID(),
        })
        if (imageResult.success) currentVersion = imageResult.data.version
        setPendingImage(null)
        // Optimistic update for image
        setChatDetail((prev) => (prev && prev.id === sendingChatId) ? {
          ...prev,
          lastMessageAt: now,
          status: 'in_progress',
          handlingMode: 'human',
          version: currentVersion,
          messages: [
            ...(prev.messages ?? []),
            {
              id: crypto.randomUUID(),
              direction: 'outgoing',
              messageType: 'image',
              content: imgPayload,
              createdAt: now,
            },
          ],
        } : prev)
        setChats((prev) => {
          const exists = prev.some((c) => c.id === sendingChatId)
          if (!exists) return prev
          const currentFilter = statusFilterRef.current
          const currentUnansweredOnly = unansweredOnlyRef.current
          const updated = prev.map((c) => c.id === sendingChatId ? {
            ...c,
            lastMessageAt: now,
            status: 'in_progress' as const,
            lastMessageContent: '[画像]',
            lastMessageDirection: 'outgoing' as const,
            lastMessageType: 'image' as const,
          } : c)
          // 未対応モード時は status filter を skip (worker 側で status を絞ってないため
          // 楽観更新で applied するとリストが歪む — Codex Round 1)
          let filtered = currentUnansweredOnly
            ? updated
            : (currentFilter === 'all' ? updated : updated.filter((c) => c.status === currentFilter))
          if (currentUnansweredOnly) {
            // 未対応モードでは、自分が返信したばかりの chat はもう未対応ではないのでリストから除外
            filtered = filtered.filter((c) => c.id !== sendingChatId)
          }
          return [...filtered].sort((a, b) => {
            const at = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0
            const bt = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0
            return bt - at
          })
        })
      }
      // --- Text send path (runs independently — both paths execute when both image and text are present) ---
      if (messageContent.trim()) {
        const content = messageContent.trim()
        const textResult = await api.chats.send(sendingChatId, {
          content, expectedVersion: currentVersion, idempotencyKey: crypto.randomUUID(), quoteMessageId: replyTo?.id,
        })
        if (textResult.success) currentVersion = textResult.data.version
        setMessageContent('')
        setReplyTo(null)
        // Optimistic update: append message locally instead of refetching (prevents scroll jump / full reload feel)
        // Only mutate chatDetail if it still corresponds to the chat we just sent to
        setChatDetail((prev) => (prev && prev.id === sendingChatId) ? {
          ...prev,
          lastMessageAt: now,
          status: 'in_progress',
          handlingMode: 'human',
          version: currentVersion,
          messages: [
            ...(prev.messages ?? []),
            {
              id: crypto.randomUUID(),
              direction: 'outgoing',
              messageType: 'text',
              content,
              createdAt: now,
            },
          ],
        } : prev)
        setChats((prev) => {
          // Skip reconciliation if the list no longer contains this chat (e.g. tab changed mid-send)
          const exists = prev.some((c) => c.id === sendingChatId)
          if (!exists) return prev
          const currentFilter = statusFilterRef.current
          const currentUnansweredOnly = unansweredOnlyRef.current
          const updated = prev.map((c) => c.id === sendingChatId ? {
            ...c,
            lastMessageAt: now,
            status: 'in_progress' as const,
            // 一覧の preview も即時更新する。server 側も direction/source を問わず
            // 実際の最新メッセージを返すため、次回 loadChats() 後も同じ表示になる。
            lastMessageContent: content,
            lastMessageDirection: 'outgoing' as const,
            lastMessageType: 'text' as const,
          } : c)
          // Drop rows that no longer match the current tab (e.g. replying from 未読 moves chat to in_progress)
          // 未対応モード時は status filter を skip (worker 側で status を絞ってないため
          // 楽観更新で applied するとリストが歪む — Codex Round 1)
          let filtered = currentUnansweredOnly
            ? updated
            : (currentFilter === 'all' ? updated : updated.filter((c) => c.status === currentFilter))
          if (currentUnansweredOnly) {
            // 未対応モードでは、自分が返信したばかりの chat はもう未対応ではないのでリストから除外
            filtered = filtered.filter((c) => c.id !== sendingChatId)
          }
          return [...filtered].sort((a, b) => {
            const at = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0
            const bt = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0
            return bt - at
          })
        })
      }
      // 手動返信で未対応が 1 件減るので、サイドバーのバッジを即時更新させる
      window.dispatchEvent(new Event(UNANSWERED_REFRESH_EVENT))
    } catch {
      setError('メッセージの送信に失敗しました。')
    } finally {
      setSending(false)
      sendLockRef.current = false
    }
  }

  const handleStatusUpdate = async (newStatus: Chat['status']) => {
    if (!selectedChatId) return
    try {
      await api.chats.update(selectedChatId, { status: newStatus })
      loadChatDetail(selectedChatId)
      loadChats()
      // 解決済/未読の切替は未対応バッジに影響するので即時更新させる
      window.dispatchEvent(new Event(UNANSWERED_REFRESH_EVENT))
    } catch {
      setError('ステータスの更新に失敗しました。')
    }
  }

  const handleDeleteMessage = async (messageId: string) => {
    if (!selectedChatId || deletingMessageId) return
    if (!window.confirm('このメッセージをHarness上から削除しますか？\n相手のLINE上からは削除されません。')) return
    setDeletingMessageId(messageId)
    try {
      const result = await api.chats.deleteMessage(selectedChatId, messageId)
      if (!result.success) throw new Error('delete_failed')
      setChatDetail((prev) => prev ? {
        ...prev,
        messages: (prev.messages ?? []).filter((message) => message.id !== messageId),
      } : prev)
      await loadChats(true)
    } catch {
      setError('メッセージの削除に失敗しました。')
    } finally {
      setDeletingMessageId(null)
    }
  }

  const handleDownloadMessage = async (message: ChatMessage) => {
    if (!selectedChatId || downloadingMessageId) return
    setDownloadingMessageId(message.id)
    try {
      const { blob, fileName } = await api.chats.downloadMessage(selectedChatId, message.id)
      const objectUrl = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = objectUrl
      link.download = fileName || message.content.replace(/^\[ファイル:\s*|]$/g, '') || 'download'
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(objectUrl)
    } catch {
      setError('ファイルを取得できませんでした。LINE側の保存期限を過ぎている可能性があります。')
    } finally {
      setDownloadingMessageId(null)
    }
  }

  const handleHandlingMode = async (mode: 'bot' | 'human') => {
    if (!selectedChatId || switchingHandlingMode) return
    if (mode === 'bot' && (messageContent.trim() || pendingImage)) {
      setError('未送信の文章または画像があります。送信するか削除してからBotへ戻してください。')
      return
    }
    setSwitchingHandlingMode(true)
    try {
      const key = crypto.randomUUID()
      if (mode === 'human') {
        await api.chats.handoff(selectedChatId, chatDetail?.version ?? 1, key)
      } else {
        await api.chats.returnToBot(selectedChatId, chatDetail?.version ?? 1, key)
      }
      await loadChatDetail(selectedChatId)
    } catch {
      setError('家元Botと有人対応の切替に失敗しました。')
    } finally {
      setSwitchingHandlingMode(false)
    }
  }

  const handleSaveNotes = async () => {
    if (!selectedChatId) return
    setSavingNotes(true)
    setError('')
    try {
      const result = await api.chats.update(selectedChatId, { notes })
      if (!result.success) throw new Error('save_failed')
      const savedNotes = result.data.notes ?? notes
      setNotes(savedNotes)
      setChatDetail((current) => current && current.id === selectedChatId
        ? { ...current, notes: savedNotes }
        : current)
      setChats((current) => current.map((chat) => chat.id === selectedChatId
        ? { ...chat, notes: savedNotes }
        : chat))
      const cached = chatDetailCacheRef.current.get(selectedChatId)
      if (cached) {
        const updated = { ...cached, notes: savedNotes }
        chatDetailCacheRef.current.set(selectedChatId, updated)
        writeClientCache(chatDetailCacheKey(selectedChatId), updated)
      }
    } catch {
      setError('メモの保存に失敗しました。')
    } finally {
      setSavingNotes(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    // IME変換確定のEnterでは送信しない
    if (e.nativeEvent.isComposing || isComposingRef.current || e.keyCode === 229) return
    if (e.key !== 'Enter') return
    // Enterで送信、Shift+Enterで改行
    if (!e.shiftKey) {
      e.preventDefault()
      handleSendMessage()
    }
  }

  const normalizedSearch = searchQuery.toLocaleLowerCase('ja-JP')
  const searchedChats = normalizedSearch
    ? chats.filter((chat) => (
        [chat.managementNickname, chat.lineDisplayName, chat.friendName]
          .some((name) => name?.toLocaleLowerCase('ja-JP').includes(normalizedSearch))
      ))
    : chats
  const visibleChats = queueFilter === 'needs_action'
    ? searchedChats.filter((chat) => chat.status === 'unread')
    : queueFilter === 'in_progress'
      ? searchedChats.filter((chat) => chat.status !== 'resolved')
      : searchedChats
  const queueCounts = {
    all: searchedChats.length,
    in_progress: searchedChats.filter((chat) => chat.status !== 'resolved').length,
    needs_action: searchedChats.filter((chat) => chat.status === 'unread').length,
  }

  return (
    <div className="lg:-mt-5">
      {/* この画面は会話の縦表示を優先するため、共通ヘッダーよりコンパクトにする。 */}
      {/* Error */}
      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      <div className="flex gap-3 h-[calc(100vh-84px)] lg:h-[calc(100vh-90px)]">
        {/* Left Panel: Chat List */}
        <div className={`w-full lg:w-72 lg:flex-shrink-0 bg-white rounded-lg shadow-sm border border-gray-200 flex-col overflow-hidden ${selectedChatId ? 'hidden lg:flex' : 'flex'}`}>
          {/* Name search */}
          <div className="border-b border-gray-100 p-2">
            <label htmlFor="chat-name-search" className="sr-only">チャットを名前で検索</label>
            <div className="relative">
              <svg
                aria-hidden="true"
                className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m21 21-4.35-4.35m2.35-5.65a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z" />
              </svg>
              <input
                id="chat-name-search"
                type="search"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="管理名・LINE名で検索"
                autoComplete="off"
                className="w-full rounded-md border border-gray-300 bg-gray-50 py-2 pl-8 pr-8 text-sm text-gray-900 placeholder:text-gray-400 focus:border-green-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-green-100"
              />
              {searchInput && (
                <button
                  type="button"
                  onClick={() => { setSearchInput(''); setSearchQuery('') }}
                  aria-label="検索をクリア"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 hover:bg-gray-200 hover:text-gray-600"
                >
                  <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18 18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
          </div>
          {/* Filter row */}
          <div className="px-2 py-2 border-b border-gray-100 flex items-center gap-1.5">
            {([
              { key: 'all', label: '全て' },
              { key: 'in_progress', label: '対応中' },
              { key: 'needs_action', label: '🔴 要対応' },
            ] as { key: QueueFilter; label: string }[]).map((f) => (
              <button
                key={f.key}
                onClick={() => {
                  setQueueFilter(f.key)
                  try {
                    localStorage.setItem(CHAT_QUEUE_FILTER_PREF_KEY, f.key)
                  } catch {
                    // localStorage unavailable
                  }
                }}
                disabled={unansweredOnly}
                className={`flex-shrink-0 px-2 py-0.5 rounded-full text-[11px] font-medium transition-colors ${
                  queueFilter === f.key
                    ? 'bg-green-500 text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                } ${unansweredOnly ? 'opacity-40 cursor-not-allowed' : ''}`}
              >
                {f.label} {queueCounts[f.key]}
              </button>
            ))}
          </div>

          {/* Chat List */}
          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <div>
                {[...Array(5)].map((_, i) => (
                  <div key={i} className="px-4 py-3 border-b border-gray-100 animate-pulse">
                    <div className="flex items-center gap-3">
                      <div className="flex-1 space-y-2">
                        <div className="h-3 bg-gray-200 rounded w-32" />
                        <div className="h-2 bg-gray-100 rounded w-20" />
                      </div>
                      <div className="h-5 bg-gray-100 rounded-full w-12" />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <>
                {visibleChats.map((chat) => {
                  const isSelected = selectedChatId === chat.id
                  // 「真の自発（要対応）」= chat.status='unread'。webhook 側で auto_reply に
                  // マッチしなかった incoming のみ unread に設定される。auto_reply trigger
                  // (キーワード "コスト比較" 等) は matched 扱いで unread 化しない。
                  // bold / 🟥 の表示はこの status を使う。direction だけだと button 押下も
                  // 強調してしまって S/N 比が悪化する。
                  const needsAttention = chat.status === 'unread'
                  // 最新メッセージの本文 preview。flex/image は文字列で見せても意味が薄いので type 表記に置換。
                  const previewRaw = chat.lastMessageContent ?? ''
                  const preview = (() => {
                    if (chat.lastMessageType === 'image') return '📷 画像'
                    if (chat.lastMessageType === 'flex') return '📋 Flexメッセージ'
                    if (chat.lastMessageType === 'sticker') return '🎨 スタンプ'
                    if (chat.lastMessageType === 'video') return '🎥 動画'
                    if (chat.lastMessageType === 'audio') return '🎤 音声'
                    if (chat.lastMessageType === 'file') return '📎 ファイル'
                    if (chat.lastMessageType === 'location') return '📍 位置情報'
                    return previewRaw.replace(/\n+/g, ' ').slice(0, 60)
                  })()
                  return (
                    <button
                      key={chat.id}
                      onClick={() => { setSelectedFriendId(null); handleSelectChat(chat.id); }}
                      className={`w-full text-left px-3 py-2 border-b border-gray-100 transition-colors ${
                        isSelected && !selectedFriendId ? 'bg-green-50' : 'hover:bg-gray-50'
                      }`}
                    >
                      <div className="flex items-start gap-2.5">
                        {chat.friendPictureUrl ? (
                          <img src={chat.friendPictureUrl} alt="" className="w-9 h-9 rounded-full flex-shrink-0" />
                        ) : (
                          <div className="w-9 h-9 rounded-full bg-gray-200 flex items-center justify-center flex-shrink-0">
                            <span className="text-gray-500 text-sm">{chat.friendName.charAt(0)}</span>
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-1.5 min-w-0 flex-1">
                              {chat.status === 'unread' && (
                                <span className="w-2 h-2 rounded-full bg-red-500 flex-shrink-0" aria-label="未読" />
                              )}
                              <p className="min-w-0 text-sm font-medium text-gray-900">
                                <FriendNamePair
                                  lineDisplayName={chat.lineDisplayName}
                                  managementNickname={chat.managementNickname}
                                  fallback={chat.friendName}
                                />
                              </p>
                            </div>
                            <span className="text-[10px] text-gray-400 flex-shrink-0">{formatDatetime(chat.lastMessageAt)}</span>
                          </div>
                          <p
                            className={`text-xs mt-0.5 truncate ${
                              needsAttention
                                ? 'text-gray-900 font-medium'
                                : 'text-gray-400'
                            }`}
                            title={preview}
                          >
                            {chat.lastMessageDirection === 'outgoing' && (
                              <span className="text-gray-400 mr-1">↪</span>
                            )}
                            {preview || <span className="italic text-gray-300">(まだメッセージなし)</span>}
                          </p>
                          <div className="mt-1 flex items-center gap-1">
                            {chat.status === 'unread' && (
                              <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-bold text-red-700">要対応</span>
                            )}
                            {chat.handlingMode === 'human' ? (
                              <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-medium text-orange-700">
                                有人
                              </span>
                            ) : isIemotoBotActive(chat) ? (
                              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
                                家元Bot
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    </button>
                  )
                })}
                {visibleChats.length === 0 && (
                  <div className="px-4 py-10 text-center text-sm text-gray-400">
                    {searchQuery ? '該当するチャットがありません' : '表示できるチャットがありません'}
                  </div>
                )}
                {hasMoreChats && !unansweredOnly && (
                  <button
                    onClick={() => { void loadMoreChats() }}
                    disabled={loadingMore}
                    className="w-full px-4 py-3 text-sm text-green-700 hover:bg-green-50 disabled:opacity-50 border-b border-gray-100"
                  >
                    {loadingMore ? '読み込み中...' : 'さらに読み込む'}
                  </button>
                )}
              </>
            )}
          </div>
        </div>

        {/* Right Panel: Chat Detail */}
        <div className={`flex-1 bg-white rounded-lg shadow-sm border border-gray-200 flex-col overflow-hidden ${selectedChatId || selectedFriendId ? 'flex' : 'hidden lg:flex'}`}>
          {selectedFriendId && !selectedChatId ? (
            /* Direct message to friend without existing chat */
            <DirectMessagePanel
              friendId={selectedFriendId}
              friend={allFriends.find((f) => f.id === selectedFriendId) || null}
              onBack={() => setSelectedFriendId(null)}
              onSent={() => { setSelectedFriendId(null); loadChats(); }}
            />
          ) : !selectedChatId ? (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-gray-400 text-sm">チャットを選択してください</p>
            </div>
          ) : detailLoading || !chatDetail || chatDetail.id !== selectedChatId ? (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-gray-400 text-sm">読み込み中...</p>
            </div>
          ) : chatDetail ? (
            <>
              {/* Chat Header */}
              <div className="px-4 py-4 border-b border-gray-200 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <button
                    onClick={() => setSelectedChatId(null)}
                    className="lg:hidden flex-shrink-0 p-1 -ml-1 text-gray-500 hover:text-gray-700"
                    aria-label="戻る"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                    </svg>
                  </button>
                  {chatDetail.friendPictureUrl && (
                    <img src={chatDetail.friendPictureUrl} alt="" className="w-8 h-8 rounded-full flex-shrink-0" />
                  )}
                  <div className="min-w-0">
                    <p className="min-w-0 text-sm font-medium text-gray-900">
                      <FriendNamePair
                        lineDisplayName={chatDetail.lineDisplayName}
                        managementNickname={chatDetail.managementNickname}
                        fallback={chatDetail.friendName}
                      />
                    </p>
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium mt-1 ${statusConfig[chatDetail.status].className}`}
                    >
                      {statusConfig[chatDetail.status].label}
                    </span>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {chatDetail.handlingMode === 'human' ? (
                    <span className="rounded-full bg-orange-100 px-3 py-1 text-xs font-bold text-orange-800">
                      家元・スタッフ対応中
                    </span>
                  ) : isIemotoBotActive(chatDetail) ? (
                    <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-bold text-emerald-800">
                      家元Bot対応中
                    </span>
                  ) : null}
                  {chatDetail.handlingMode === 'human' ? (
                    <button disabled={switchingHandlingMode} onClick={() => handleHandlingMode('bot')}
                      className="px-3 py-1 min-h-[44px] lg:min-h-0 text-xs font-medium text-emerald-700 bg-emerald-50 hover:bg-emerald-100 rounded-md disabled:opacity-50">
                      Botへ戻す
                    </button>
                  ) : (
                    <button disabled={switchingHandlingMode} onClick={() => handleHandlingMode('human')}
                      className="px-3 py-1 min-h-[44px] lg:min-h-0 text-xs font-medium text-orange-700 bg-orange-50 hover:bg-orange-100 rounded-md disabled:opacity-50">
                      本人対応へ切替
                    </button>
                  )}
                  {unansweredOnly && chats.length > 1 && (
                    <button
                      type="button"
                      onClick={() => {
                        const idx = chats.findIndex((c) => c.id === selectedChatId)
                        // idx < 0 = current chat is no longer in the list (e.g. just sent a reply)
                        // → fall back to the head of the list so the queue keeps moving
                        const nextIdx = idx < 0 ? 0 : (idx + 1) % chats.length
                        const next = chats[nextIdx]
                        if (next && next.id !== selectedChatId) {
                          setSelectedChatId(next.id)
                        }
                      }}
                      className="rounded-md bg-emerald-600 px-3 py-1.5 min-h-[44px] lg:min-h-0 text-sm font-medium text-white hover:bg-emerald-700"
                      title="次の未対応 friend に進む"
                    >
                      次の未対応 →
                    </button>
                  )}
                  {chatDetail.status !== 'unread' && (
                    <button
                      onClick={() => handleStatusUpdate('unread')}
                      className="px-3 py-1 min-h-[44px] lg:min-h-0 text-xs font-medium text-red-600 bg-red-50 hover:bg-red-100 rounded-md transition-colors"
                    >
                      未読に戻す
                    </button>
                  )}
                  {chatDetail.status !== 'in_progress' && (
                    <button
                      onClick={() => handleStatusUpdate('in_progress')}
                      className="px-3 py-1 min-h-[44px] lg:min-h-0 text-xs font-medium text-yellow-700 bg-yellow-50 hover:bg-yellow-100 rounded-md transition-colors"
                    >
                      対応中にする
                    </button>
                  )}
                  {chatDetail.status !== 'resolved' && (
                    <button
                      onClick={() => handleStatusUpdate('resolved')}
                      className="px-3 py-1 min-h-[44px] lg:min-h-0 text-xs font-medium text-green-700 bg-green-50 hover:bg-green-100 rounded-md transition-colors"
                    >
                      解決済にする
                    </button>
                  )}
                </div>
              </div>

              {/* Messages — LINE-style chat bubbles */}
              <div
                ref={messagesScrollRef}
                onScroll={(event) => {
                  const element = event.currentTarget
                  if (element.scrollHeight > element.clientHeight + 80 && element.scrollTop < 80) {
                    void loadOlderMessages()
                  }
                }}
                className="flex-1 overflow-y-auto p-4 space-y-2"
                style={{ backgroundColor: '#7494C0' }}
              >
                {chatDetail.hasMoreMessages && (
                  <div className="flex justify-center pb-2">
                    <button
                      type="button"
                      onClick={() => { void loadOlderMessages() }}
                      disabled={loadingOlderMessages}
                      className="rounded-full bg-white/90 px-3 py-1 text-xs font-medium text-gray-600 shadow-sm hover:bg-white disabled:opacity-60"
                    >
                      {loadingOlderMessages ? '過去のメッセージを読み込み中...' : '以前のメッセージを読み込む'}
                    </button>
                  </div>
                )}
                {(!chatDetail.messages || chatDetail.messages.length === 0) ? (
                  <div className="text-center py-8">
                    <p className="text-white/60 text-sm">メッセージはまだありません。</p>
                  </div>
                ) : (
                  (chatDetail.messages ?? []).map((msg, idx) => {
                    if (isImportedLineHistory(msg.source)) {
                      return <ImportedHistoryCard key={msg.id} message={msg} />
                    }
                    const prevMsg = idx > 0 ? (chatDetail.messages ?? [])[idx - 1] : null
                    const showDateSep = !prevMsg || !sameYmd(prevMsg.createdAt, msg.createdAt)
                    const isOutgoing = msg.direction === 'outgoing'

                    // メッセージ表示の分岐
                    let bubbleContent: React.ReactNode
                    if (msg.messageType === 'flex') {
                      bubbleContent = (
                        <div className="max-w-[300px]">
                          <FlexPreviewComponent content={msg.content} maxWidth={280} />
                        </div>
                      )
                    } else if (msg.messageType === 'image') {
                      try {
                        const parsed = JSON.parse(msg.content)
                        bubbleContent = (
                          <img src={parsed.originalContentUrl || parsed.previewImageUrl} alt="" className="max-w-[200px] rounded" />
                        )
                      } catch {
                        bubbleContent = <span>🖼️ [画像]</span>
                      }
                    } else if (msg.messageType === 'sticker') {
                      bubbleContent = <StickerMessageImage content={msg.content} />
                    } else if (msg.messageType === 'file') {
                      bubbleContent = (
                        <button
                          type="button"
                          onClick={() => handleDownloadMessage(msg)}
                          disabled={downloadingMessageId === msg.id}
                          className="flex max-w-[280px] items-center gap-2 text-left font-medium text-blue-700 underline disabled:opacity-60"
                        >
                          <span aria-hidden="true">📄</span>
                          <span className="break-all">{msg.content.replace(/^\[ファイル:\s*|]$/g, '')}</span>
                          <span className="shrink-0 text-xs">{downloadingMessageId === msg.id ? '取得中…' : '保存'}</span>
                        </button>
                      )
                    } else {
                      bubbleContent = <span>{msg.content}</span>
                    }

                    return (
                      <div key={msg.id}>
                        {showDateSep && (
                          <div className="flex justify-center my-3">
                            <span className="text-[11px] text-white/85 bg-black/20 px-2.5 py-0.5 rounded-full">
                              {formatYmdSlash(msg.createdAt)}
                            </span>
                          </div>
                        )}
                        <div
                          className={`flex items-end gap-2 ${isOutgoing ? 'justify-end' : 'justify-start'}`}
                        >
                          {/* 相手のアイコン（incoming のみ） */}
                          {!isOutgoing && (
                            chatDetail.friendPictureUrl ? (
                              <img src={chatDetail.friendPictureUrl} alt="" className="w-8 h-8 rounded-full flex-shrink-0 mb-1" />
                            ) : (
                              <div className="w-8 h-8 rounded-full bg-gray-300 flex-shrink-0 mb-1" />
                            )
                          )}

                          <div className={`flex flex-col ${isOutgoing ? 'items-end' : 'items-start'}`}>
                            <span className="text-[11px] font-medium text-white/85 mb-0.5 px-1">
                              {!isOutgoing ? 'お客様' : msg.source === 'iemoto_bot' ? '家元Bot' : msg.source === 'system_handoff' ? '対応切替のお知らせ' : '家元・スタッフ'}
                            </span>
                            {/* メッセージバブル */}
                            <div
                              className={`max-w-[320px] px-3 py-2 text-sm break-words whitespace-pre-wrap ${
                                isOutgoing
                                  ? 'rounded-tl-2xl rounded-tr-md rounded-bl-2xl rounded-br-2xl text-white'
                                  : 'rounded-tl-md rounded-tr-2xl rounded-bl-2xl rounded-br-2xl bg-white text-gray-900'
                              }`}
                              style={isOutgoing ? { backgroundColor: '#06C755' } : undefined}
                            >
                              {bubbleContent}
                            </div>
                            {/* 時刻 */}
                            <span className="text-xs text-white/50 mt-0.5 px-1">
                              {new Date(msg.createdAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}
                            </span>
                            <div className="mt-0.5 flex items-center gap-2 px-1 text-[11px]">
                              {msg.canQuote && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setReplyTo(msg)
                                    textareaRef.current?.focus()
                                  }}
                                  className="text-white/80 hover:text-white underline"
                                >
                                  リプライ
                                </button>
                              )}
                              {isOutgoing && (
                                <button
                                  type="button"
                                  disabled={deletingMessageId === msg.id}
                                  onClick={() => handleDeleteMessage(msg.id)}
                                  className="text-white/70 hover:text-white underline disabled:opacity-50"
                                >
                                  {deletingMessageId === msg.id ? '削除中…' : '削除'}
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    )
                  })
                )}
              </div>

              {/* On smaller screens the right column is hidden, so keep these tools available here. */}
              <div className="xl:hidden px-4 py-2 border-t border-gray-200 bg-gray-50 space-y-2">
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="メモを入力..."
                    className="flex-1 text-xs border border-gray-300 rounded-md px-2 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-green-500"
                  />
                  <button
                    onClick={handleSaveNotes}
                    disabled={savingNotes}
                    className="px-2 py-1 text-xs font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-md transition-colors disabled:opacity-50"
                  >
                    {savingNotes ? '保存中...' : 'メモ保存'}
                  </button>
                </div>
              </div>

              {/* Send Message Form */}
              <div className="px-4 py-3 border-t border-gray-200">
                {replyTo && (
                  <div className="mb-2 flex items-start justify-between gap-3 rounded-lg border-l-4 border-green-500 bg-green-50 px-3 py-2 text-xs text-gray-700">
                    <div className="min-w-0">
                      <p className="font-semibold text-green-700">このメッセージにリプライ</p>
                      <p className="truncate">{replyTo.content}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setReplyTo(null)}
                      className="flex-shrink-0 text-gray-500 hover:text-gray-800"
                      aria-label="リプライを解除"
                    >
                      ✕
                    </button>
                  </div>
                )}
                <div className="flex items-end gap-2 rounded-xl border border-gray-300 bg-white p-2 focus-within:ring-2 focus-within:ring-green-500">
                  <ImageUploader
                    mode="line-image"
                    value={pendingImage}
                    onChange={setPendingImage}
                    variant="composer"
                  />
                  <textarea
                    ref={textareaRef}
                    rows={2}
                    value={messageContent}
                    style={{ maxHeight: '200px', overflowY: 'auto' }}
                    onChange={(e) => {
                      setMessageContent(e.target.value)
                    }}
                    onCompositionStart={() => { isComposingRef.current = true }}
                    onCompositionEnd={() => { isComposingRef.current = false }}
                    onKeyDown={handleKeyDown}
                    placeholder="メッセージを入力..."
                    className="min-h-10 flex-1 resize-none overflow-y-auto border-0 bg-transparent px-2 py-2 text-sm focus:outline-none"
                  />
                  <button
                    onClick={handleSendMessage}
                    disabled={sending || (!messageContent.trim() && !pendingImage)}
                    className="px-4 py-2 text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{ backgroundColor: '#06C755' }}
                  >
                    {sending ? '送信中...' : '送信'}
                  </button>
                </div>
              </div>
            </>
          ) : null}
        </div>

        {/* Right-most Panel: 友だち詳細サイドバー — chat detail を開いている時のみ表示 */}
        {/*
          friendId は **現在の selection** を優先する。chatDetail の load 中は前の chat
          のデータが残ったままなので、それを参照するとサイドバーだけ前の友だちを
          表示し続けて pane 間の不整合になる。selection ID 自体が friend_id なので
          直接渡せる (chat list SQL が `id: f.id` で friend_id を返す)。
        */}
        {(selectedChatId || selectedFriendId) && (
          <div className="hidden xl:flex w-80 flex-shrink-0 flex-col gap-3 min-h-0">
            <FriendInfoSidebar
              friendId={selectedFriendId || selectedChatId}
              chatStatus={
                chatDetail && chatDetail.id === (selectedFriendId || selectedChatId)
                  ? { notes: chatDetail.notes }
                  : undefined
              }
              memoValue={chatDetail && chatDetail.id === selectedChatId ? notes : ''}
              memoSaving={savingNotes}
              onMemoChange={chatDetail && chatDetail.id === selectedChatId ? setNotes : undefined}
              onMemoSave={chatDetail && chatDetail.id === selectedChatId ? handleSaveNotes : undefined}
            />
          </div>
        )}
      </div>
      <CcPromptButton prompts={ccPrompts} />
    </div>
  )
}
