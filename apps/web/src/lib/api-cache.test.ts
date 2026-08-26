import { beforeEach, describe, expect, test, vi } from 'vitest'

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('API client cache', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.com')
  })

  test('reuses a fresh GET response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true, data: ['tag-1'] }))
    vi.stubGlobal('fetch', fetchMock)
    const { fetchApi } = await import('./api')

    const first = await fetchApi('/api/tags')
    const second = await fetchApi('/api/tags')

    expect(second).toEqual(first)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('deduplicates matching GET requests that are already in flight', async () => {
    let resolveResponse: ((response: Response) => void) | undefined
    const fetchMock = vi.fn().mockReturnValue(
      new Promise<Response>((resolve) => { resolveResponse = resolve }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const { fetchApi } = await import('./api')

    const first = fetchApi('/api/templates')
    const second = fetchApi('/api/templates')
    resolveResponse?.(jsonResponse({ success: true, data: [] }))

    await expect(Promise.all([first, second])).resolves.toEqual([
      { success: true, data: [] },
      { success: true, data: [] },
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('invalidates read entries after a successful write', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ success: true, data: ['old'] }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { id: 'new' } }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: ['new'] }))
    vi.stubGlobal('fetch', fetchMock)
    const { fetchApi } = await import('./api')

    await fetchApi('/api/tags')
    await fetchApi('/api/tags', { method: 'POST', body: JSON.stringify({ name: 'new' }) })
    const refreshed = await fetchApi<{ success: boolean; data: string[] }>('/api/tags')

    expect(refreshed.data).toEqual(['new'])
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  test('never caches live chat reads', async () => {
    const fetchMock = vi.fn().mockImplementation(
      () => Promise.resolve(jsonResponse({ success: true, data: [] })),
    )
    vi.stubGlobal('fetch', fetchMock)
    const { fetchApi } = await import('./api')

    await fetchApi('/api/chats?limit=100')
    await fetchApi('/api/chats?limit=100')

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
