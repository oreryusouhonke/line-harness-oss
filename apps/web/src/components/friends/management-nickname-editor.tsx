'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import type { FriendNicknameHistory } from '@/lib/api'

interface Props {
  friendId: string
  lineDisplayName: string | null
  managementNickname: string | null
  onSaved?: (nickname: string | null) => void
}

function formatDate(value: string): string {
  return value.replace('T', ' ').replace(/(\.\d+)?([+\-]\d{2}:?\d{2}|Z)?$/, '').slice(0, 16)
}

export default function ManagementNicknameEditor({
  friendId,
  lineDisplayName,
  managementNickname,
  onSaved,
}: Props) {
  const [value, setValue] = useState(managementNickname ?? '')
  const [savedValue, setSavedValue] = useState(managementNickname ?? '')
  const [history, setHistory] = useState<FriendNicknameHistory[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const loadHistory = async () => {
    try {
      const res = await api.friends.nicknameHistory(friendId)
      if (res.success) setHistory(res.data)
    } catch {
      // History is supplementary; nickname editing remains available.
    }
  }

  useEffect(() => {
    setValue(managementNickname ?? '')
    setSavedValue(managementNickname ?? '')
    void loadHistory()
  }, [friendId, managementNickname])

  const save = async (nickname: string | null) => {
    setSaving(true)
    setError('')
    try {
      const res = await api.friends.updateManagementNickname(friendId, nickname)
      if (!res.success) throw new Error(res.error)
      const next = res.data.managementNickname ?? ''
      setValue(next)
      setSavedValue(next)
      onSaved?.(next || null)
      await loadHistory()
    } catch {
      setError('管理用顧客名の保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-2">
      <div>
        <label className="block text-[11px] font-medium text-gray-500 mb-1">顧客名（管理用）</label>
        <input
          value={value}
          maxLength={100}
          onChange={(e) => setValue(e.target.value)}
          placeholder="例：辻本 太郎"
          className="w-full border border-gray-300 rounded px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-green-500"
        />
      </div>
      <p className="text-[11px] text-gray-500 break-words">
        LINE表示名: <span className="text-gray-700">{lineDisplayName || '名前なし'}</span>
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={saving || value.trim() === savedValue}
          onClick={() => void save(value.trim() || null)}
          className="px-2.5 py-1 rounded text-xs font-medium text-white disabled:opacity-40"
          style={{ backgroundColor: '#06C755' }}
        >
          {saving ? '保存中...' : '保存'}
        </button>
        {savedValue && (
          <button
            type="button"
            disabled={saving}
            onClick={() => void save(null)}
            className="px-2.5 py-1 rounded text-xs border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-40"
          >
            削除
          </button>
        )}
      </div>
      {error && <p className="text-[11px] text-red-600">{error}</p>}
      {history.length > 0 && (
        <details className="pt-1">
          <summary className="text-[11px] text-gray-500 cursor-pointer">変更履歴 ({history.length})</summary>
          <ul className="mt-1 space-y-1 max-h-28 overflow-y-auto">
            {history.map((item) => (
              <li key={item.id} className="text-[10px] text-gray-500 border-l-2 border-gray-100 pl-2">
                <span className="text-gray-700">{item.newNickname || '削除'}</span>
                {' · '}{item.changedByName} · {formatDate(item.changedAt)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
