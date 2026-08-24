import { beforeEach, describe, expect, test, vi } from 'vitest'

describe('friend management name API', () => {
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
})
