import { beforeEach, describe, expect, test, vi } from 'vitest'

describe('friend detail APIs', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.com')
  })

  test('saves a management name with the worker API contract', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { managementNickname: '辻本 太郎' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const { api } = await import('./api')

    await api.friends.updateManagementNickname('friend-1', '辻本 太郎')

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/api/friends/friend-1/management-nickname',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ nickname: '辻本 太郎' }),
      }),
    )
  })

  test('loads the management name audit history from the worker route', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const { api } = await import('./api')

    await api.friends.nicknameHistory('friend-1')

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/api/friends/friend-1/nickname-history',
      expect.objectContaining({ credentials: 'include' }),
    )
  })

  test('saves the Sagawa-format customer contact details and file path as friend metadata', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { metadata: {} } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const { api } = await import('./api')
    const fields = {
      customer_phone_number: '090-1234-5678',
      customer_postal_code: '100-0005',
      customer_address_line1: '東京都千代田区丸の内',
      customer_address_line2: '一丁目1番1号',
      customer_address_line3: null,
      customer_address: '東京都千代田区丸の内一丁目1番1号',
      customer_recipient_name_line1: '山田太郎',
      customer_recipient_name_line2: '経理部御中',
      customer_recipient_name: '山田太郎 経理部御中',
      customer_file_path: 'C:\\顧客管理\\山田太郎',
    }

    await api.friends.updateMetadata('friend-1', fields)

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/api/friends/friend-1/metadata',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify(fields),
      }),
    )
  })
})
