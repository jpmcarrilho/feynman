import { describe, it, expect, vi, afterEach } from 'vitest'
import { mintLiveToken } from './liveToken'

afterEach(() => vi.unstubAllGlobals())

describe('mintLiveToken', () => {
  it('posts the expected header and body and returns only the token name', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ name: 'auth_tokens/abc' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const now = Date.UTC(2026, 0, 1, 12, 0, 0)

    const result = await mintLiveToken('SECRET-KEY', now)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/auth_tokens')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('SECRET-KEY')
    expect(JSON.parse(init.body as string)).toEqual({
      uses: 1,
      expireTime: '2026-01-01T12:30:00.000Z',
      newSessionExpireTime: '2026-01-01T12:01:00.000Z',
    })
    expect(result).toEqual({ token: 'auth_tokens/abc', expiresAt: '2026-01-01T12:30:00.000Z' })
    expect(JSON.stringify(result)).not.toContain('SECRET-KEY')
  })

  it('throws without leaking the key when the API refuses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('denied SECRET-KEY', { status: 403 })))
    await expect(mintLiveToken('SECRET-KEY')).rejects.toThrow(/HTTP 403/)
    await expect(mintLiveToken('SECRET-KEY')).rejects.not.toThrow(/SECRET-KEY/)
  })

  it('throws when the response has no token name or the key is missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    await expect(mintLiveToken('k')).rejects.toThrow()
    await expect(mintLiveToken('')).rejects.toThrow('Missing Gemini API Key')
  })
})
