import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const m = vi.hoisted(() => ({ auth: vi.fn(), status: vi.fn(), enable: vi.fn(), disable: vi.fn() }))
vi.mock('@/app/auth-actions', () => ({ checkIsAuthenticated: () => m.auth() }))
vi.mock('@/server/phoneAccess', async (orig) => ({
  ...(await orig<typeof import('@/server/phoneAccess')>()),
  getPhoneAccessStatus: (...a: unknown[]) => m.status(...a),
  enablePhoneAccess: (...a: unknown[]) => m.enable(...a),
  disablePhoneAccess: (...a: unknown[]) => m.disable(...a),
}))

import { GET, POST } from './route'

const URL_OK = 'https://my-mac.tail1234.ts.net'
// What Next gives a route for a request made on this Mac: Host plus the x-forwarded-* headers Next fills in itself.
const LOCAL = { host: 'localhost:3000', 'x-forwarded-host': 'localhost:3000', 'x-forwarded-port': '3000', 'x-forwarded-proto': 'http', 'x-forwarded-for': '::1' }
const req = (method: string, headers: Record<string, string> = LOCAL, body?: unknown) =>
  new NextRequest('http://localhost:3000/api/phone-access', { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })

beforeEach(() => {
  vi.clearAllMocks()
  m.auth.mockResolvedValue(true)
  m.status.mockResolvedValue({ state: 'off', url: URL_OK })
  m.enable.mockResolvedValue({ ok: true, needsConsent: false, message: '' })
  m.disable.mockResolvedValue({ ok: true, needsConsent: false, message: '' })
})

describe('GET /api/phone-access', () => {
  it('401 before anything else', async () => {
    m.auth.mockResolvedValue(false)
    expect((await GET(req('GET'))).status).toBe(401)
    expect(m.status).not.toHaveBeenCalled()
  })
  it('returns state, url, canToggle and no QR when off', async () => {
    const res = await GET(req('GET'))
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toMatchObject({ state: 'off', url: URL_OK, qrSvg: null, canToggle: true, reason: null, isLocal: true })
  })
  it('returns an SVG QR when on', async () => {
    m.status.mockResolvedValue({ state: 'on', url: URL_OK })
    const body = await (await GET(req('GET'))).json()
    expect(body.state).toBe('on')
    expect(body.qrSvg).toMatch(/^<\?xml|^<svg/)
    expect(body.qrSvg).toContain('<svg')
  })
  it('no QR for an invalid URL', async () => {
    m.status.mockResolvedValue({ state: 'on', url: 'https://evil.example.com' })
    expect((await (await GET(req('GET'))).json()).qrSvg).toBeNull()
  })
  it('from the phone: state visible, toggle unavailable with a reason', async () => {
    const body = await (await GET(req('GET', { host: 'my-mac.tail1234.ts.net', 'x-forwarded-host': 'my-mac.tail1234.ts.net', 'x-forwarded-for': '100.101.102.103', 'tailscale-user-login': 'a@b.c' }))).json()
    expect(body).toMatchObject({ canToggle: false, isLocal: false })
    expect(body.reason).toContain('Mac')
  })
  it.each([
    ['not_installed', 'not installed'],
    ['tailscale_not_running', 'not running'],
  ])('%s disables the toggle', async (state, text) => {
    m.status.mockResolvedValue({ state, url: null })
    const body = await (await GET(req('GET'))).json()
    expect(body.canToggle).toBe(false)
    expect(body.reason).toContain(text)
  })
})

describe('POST /api/phone-access', () => {
  it('401 unauthenticated', async () => {
    m.auth.mockResolvedValue(false)
    expect((await POST(req('POST', undefined, { enabled: true }))).status).toBe(401)
    expect(m.enable).not.toHaveBeenCalled()
  })
  it('403 for host x.ts.net', async () => {
    const res = await POST(req('POST', { host: 'x.ts.net' }, { enabled: true }))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/Mac/)
    expect(m.enable).not.toHaveBeenCalled()
  })
  it('403 with a Tailscale identity header even for host localhost', async () => {
    const res = await POST(req('POST', { ...LOCAL, 'tailscale-user-login': 'a@b.c' }, { enabled: true }))
    expect(res.status).toBe(403)
    expect(m.enable).not.toHaveBeenCalled()
  })
  it('403 for a LAN client that only spoofs Host: localhost', async () => {
    const res = await POST(req('POST', { ...LOCAL, 'x-forwarded-for': '192.168.1.20' }, { enabled: true }))
    expect(res.status).toBe(403)
  })
  it('local enable calls enablePhoneAccess with the port and returns fresh status', async () => {
    m.status.mockResolvedValue({ state: 'on', url: URL_OK })
    const res = await POST(req('POST', undefined, { enabled: true }))
    expect(res.status).toBe(200)
    expect(m.enable).toHaveBeenCalledWith(3000)
    expect(await res.json()).toMatchObject({ ok: true, state: 'on' })
  })
  it('local disable calls disablePhoneAccess', async () => {
    await POST(req('POST', undefined, { enabled: false }))
    expect(m.disable).toHaveBeenCalledTimes(1)
    expect(m.enable).not.toHaveBeenCalled()
  })
  it('consent case is passed through', async () => {
    m.enable.mockResolvedValue({ ok: false, needsConsent: true, message: 'run it once' })
    expect(await (await POST(req('POST', undefined, { enabled: true }))).json()).toMatchObject({ ok: false, needsConsent: true, message: 'run it once' })
  })
  it('400 for a bad body', async () => {
    expect((await POST(req('POST', undefined, { enabled: 'yes' }))).status).toBe(400)
    expect((await POST(req('POST'))).status).toBe(400)
  })
})
