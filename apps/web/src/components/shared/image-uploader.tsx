'use client'

import { useCallback, useRef, useState } from 'react'
import { api } from '@/lib/api'

export type ImageUploaderMode = 'url' | 'line-image'

export type ImageUploaderValue =
  | { mode: 'url'; url: string }
  | { mode: 'line-image'; originalContentUrl: string; previewImageUrl: string }

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024
const LINE_TARGET_BYTES = 900 * 1024

export interface ImageUploaderProps {
  mode: ImageUploaderMode
  value: ImageUploaderValue | null
  onChange: (next: ImageUploaderValue | null) => void
  label?: string
  compact?: boolean
  variant?: 'default' | 'composer'
}

/**
 * 汎用画像アップローダー: ボタン + D&D + クリップボードペースト + プレビュー。
 *
 * mode='url' は単一 URL を返す (Event / Staff など)。
 * mode='line-image' は {originalContentUrl, previewImageUrl} を返す (Broadcast / Auto-reply / Template / Chats)。
 * 初版は preview = original の同 URL。後段で本格 resize が必要になれば worker 側で対応。
 */
export default function ImageUploader({ mode, value, onChange, label, compact = false, variant = 'default' }: ImageUploaderProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [manualUrlMode, setManualUrlMode] = useState(false)

  const prepareLineImage = useCallback(async (file: File): Promise<File> => {
    if (file.size <= LINE_TARGET_BYTES) return file

    const bitmap = await createImageBitmap(file)
    try {
      let scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height))
      let quality = 0.86

      for (let attempt = 0; attempt < 8; attempt++) {
        const width = Math.max(1, Math.round(bitmap.width * scale))
        const height = Math.max(1, Math.round(bitmap.height * scale))
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('canvas unavailable')
        ctx.drawImage(bitmap, 0, 0, width, height)
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
        if (!blob) throw new Error('image resize failed')
        if (blob.size <= LINE_TARGET_BYTES || attempt === 7) {
          const name = file.name.replace(/\.[^.]+$/, '') || 'image'
          return new File([blob], `${name}.jpg`, { type: 'image/jpeg' })
        }
        if (quality > 0.62) quality -= 0.08
        else scale *= 0.82
      }
    } finally {
      bitmap.close()
    }

    return file
  }, [])

  const upload = useCallback(
    async (file: File) => {
      if (!file.type.startsWith('image/')) {
        setError('画像ファイルのみアップロードできます')
        return
      }
      if (mode === 'line-image' && !['image/jpeg', 'image/png'].includes(file.type)) {
        setError('LINE 送信用は JPEG または PNG のみ対応')
        return
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        setError('20MB 以下にしてください')
        return
      }
      setBusy(true)
      setError('')
      try {
        const uploadFile = mode === 'line-image' ? await prepareLineImage(file) : file
        const res = await api.uploads.image(uploadFile)
        if (!res.success) {
          setError(res.error ?? 'アップロード失敗')
          return
        }
        const url = res.data.url
        if (mode === 'url') {
          onChange({ mode: 'url', url })
        } else {
          onChange({ mode: 'line-image', originalContentUrl: url, previewImageUrl: url })
        }
      } catch {
        setError('アップロード失敗')
      } finally {
        setBusy(false)
      }
    },
    [mode, onChange, prepareLineImage],
  )

  const handleFiles = useCallback(
    (files: FileList | null) => {
      const f = files?.[0]
      if (f) void upload(f)
    },
    [upload],
  )

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      handleFiles(e.dataTransfer.files)
    },
    [handleFiles],
  )

  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const item = [...e.clipboardData.items].find((i) => i.type.startsWith('image/'))
      const file = item?.getAsFile()
      if (file) void upload(file)
    },
    [upload],
  )

  const previewUrl =
    value === null
      ? null
      : value.mode === 'url'
        ? value.url
        : value.previewImageUrl

  if (variant === 'composer') {
    return (
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        onPaste={onPaste}
        tabIndex={0}
        className="flex shrink-0 items-center gap-2 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
      >
        {previewUrl ? (
          <div className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={previewUrl} alt="" className="h-8 w-8 rounded object-cover ring-1 ring-emerald-200" />
            <button
              type="button"
              onClick={() => onChange(null)}
              className="text-xs font-medium text-rose-600 hover:underline"
            >
              取消
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            aria-label="画像を追加"
            title="画像を追加。ドラッグ&ドロップや貼り付けもできます"
            className="h-10 rounded-md border border-gray-300 bg-white px-3 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            {busy ? '処理中' : '画像'}
          </button>
        )}
        <input
          ref={inputRef}
          type="file"
          accept={mode === 'line-image' ? 'image/jpeg,image/png' : 'image/*'}
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
        {error && <div className="text-xs text-rose-600">{error}</div>}
      </div>
    )
  }

  return (
    <div className={compact ? 'space-y-1' : 'space-y-2'}>
      {label && <div className="text-sm font-medium text-gray-700">{label}</div>}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setManualUrlMode((v) => !v)}
          className="text-xs text-emerald-700 underline"
        >
          {manualUrlMode ? '画像アップロードに戻す' : 'URL を直接入力'}
        </button>
      </div>
      {manualUrlMode ? (
        <input
          type="url"
          value={
            value === null
              ? ''
              : value.mode === 'url'
                ? value.url
                : value.originalContentUrl
          }
          onChange={(e) => {
            const url = e.target.value
            if (!url) {
              onChange(null)
              return
            }
            if (mode === 'url') {
              onChange({ mode: 'url', url })
            } else {
              onChange({ mode: 'line-image', originalContentUrl: url, previewImageUrl: url })
            }
          }}
          placeholder="https://... (外部 CDN / R2 URL)"
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
        />
      ) : (
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={onDrop}
          onPaste={onPaste}
          tabIndex={0}
          className={`rounded-lg border-2 border-dashed border-gray-300 bg-white transition-colors hover:border-gray-400 focus:border-emerald-500 focus:outline-none ${compact ? 'px-3 py-2' : 'p-4'}`}
        >
          {previewUrl ? (
            <div className="flex items-center gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={previewUrl} alt="" className={`${compact ? 'h-12 w-12' : 'h-24 w-24'} rounded object-cover ring-1 ring-gray-200`} />
              <div className="flex-1 space-y-2">
                <button
                  type="button"
                  onClick={() => inputRef.current?.click()}
                  className="text-xs font-medium text-gray-700 underline"
                >
                  差し替え
                </button>
                <button
                  type="button"
                  onClick={() => onChange(null)}
                  className="ml-3 text-xs font-medium text-rose-600 underline"
                >
                  取り消し
                </button>
              </div>
            </div>
          ) : (
            <div className={`flex items-center justify-center text-sm text-gray-500 ${compact ? 'gap-3 py-1' : 'flex-col gap-2 py-4'}`}>
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                disabled={busy}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {busy ? 'アップロード中…' : '📎 画像を選択'}
              </button>
              <div className={`text-xs text-gray-400 ${compact ? 'hidden sm:block' : ''}`}>またはドラッグ&ドロップ / Cmd+V でペースト</div>
            </div>
          )}
          <input
            ref={inputRef}
            type="file"
            accept={mode === 'line-image' ? 'image/jpeg,image/png' : 'image/*'}
            className="hidden"
            onChange={(e) => handleFiles(e.target.files)}
          />
        </div>
      )}
      {error && <div className="text-xs text-rose-600">{error}</div>}
    </div>
  )
}
