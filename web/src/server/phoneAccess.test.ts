import { describe, it, expect, vi } from 'vitest'
import {
  BINARY_CANDIDATES,
  disablePhoneAccess,
  enablePhoneAccess,
  getPhoneAccessStatus,
  isValidPhoneUrl,
  parsePort,
  resolvePort,
  resolveTailscaleBinary,
  type ExecResult,
  type PhoneAccessDeps,
} from './phoneAccess'

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '', timedOut: false, notFound: false })
const fail = (over: Partial<ExecResult> = {}): ExecResult => ({ code: 1, stdout: '', stderr: '', timedOut: false, notFound: false, ...over })

// ASSUMED shapes (docs do not show them): see parseTailscaleStatus.
const RUNNING = JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'my-mac.tail1234.ts.net.' } })
const STOPPED = JSON.stringify({ BackendState: 'Stopped', Self: { DNSName: 'my-mac.tail1234.ts.net.' } })
const NEEDS_LOGIN = JSON.stringify({ BackendState: 'NeedsLogin' })
const SERVE_OFF = '{}'
const serveOn = (target: string) =>
  JSON.stringify({ TCP: { '443': { HTTPS: true } }, Web: { 'my-mac.tail1234.ts.net:443': { Handlers: { '/': { Proxy: target } } } } })

function deps(responses: Record<string, ExecResult>, bin: string | null = '/bin/tailscale') {
  const exec = vi.fn(async (_file: string, args: string[]) => responses[args.join(' ')] ?? fail({ stderr: 'unexpected ' + args.join(' ') }))
  const d: PhoneAccessDeps = { exec, findBinary: () => bin }
  return { d, exec }
}

describe('resolveTailscaleBinary', () => {
  it('prefers TAILSCALE_BIN, then the app, /usr/local, homebrew', () => {
    const all = () => true
    expect(resolveTailscaleBinary({ TAILSCALE_BIN: '/custom/ts' }, all)).toBe('/custom/ts')
    expect(resolveTailscaleBinary({}, all)).toBe(BINARY_CANDIDATES[0])
    expect(resolveTailscaleBinary({}, (p) => p !== BINARY_CANDIDATES[0])).toBe('/usr/local/bin/tailscale')
    expect(resolveTailscaleBinary({}, (p) => p === '/opt/homebrew/bin/tailscale')).toBe('/opt/homebrew/bin/tailscale')
  })
  it('skips a TAILSCALE_BIN that is not executable and returns null when nothing exists', () => {
    expect(resolveTailscaleBinary({ TAILSCALE_BIN: '/nope' }, (p) => p === '/usr/local/bin/tailscale')).toBe('/usr/local/bin/tailscale')
    expect(resolveTailscaleBinary({}, () => false)).toBeNull()
  })
})

describe('port validation', () => {
  it('uses 3000 by default and validates PORT', () => {
    expect(resolvePort({})).toBe(3000)
    expect(resolvePort({ PORT: '4100' })).toBe(4100)
    expect(resolvePort({ PORT: '0' })).toBeNull()
    expect(resolvePort({ PORT: '70000' })).toBeNull()
    expect(resolvePort({ PORT: '3000; rm -rf /' })).toBeNull()
    expect(resolvePort({ PORT: '30.5' })).toBeNull()
  })
  it('parsePort accepts only integers 1..65535', () => {
    expect(parsePort(1)).toBe(1)
    expect(parsePort(65535)).toBe(65535)
    expect(parsePort(65536)).toBeNull()
    expect(parsePort(1.5)).toBeNull()
    expect(parsePort('abc')).toBeNull()
    expect(parsePort(undefined)).toBeNull()
  })
})

describe('isValidPhoneUrl', () => {
  it('accepts https name.tailnet.ts.net only', () => {
    expect(isValidPhoneUrl('https://my-mac.tail1234.ts.net')).toBe(true)
    expect(isValidPhoneUrl('http://my-mac.tail1234.ts.net')).toBe(false)
    expect(isValidPhoneUrl('https://my-mac.tail1234.ts.net/x')).toBe(false)
    expect(isValidPhoneUrl('https://my-mac.tail1234.ts.net:8443')).toBe(false)
    expect(isValidPhoneUrl('https://ts.net')).toBe(false)
    expect(isValidPhoneUrl('https://evil.com/.ts.net')).toBe(false)
    expect(isValidPhoneUrl('https://a.b.ts.net.evil.com')).toBe(false)
    expect(isValidPhoneUrl('https://user@my-mac.tail1234.ts.net')).toBe(false)
  })
})

describe('getPhoneAccessStatus', () => {
  it('not installed: no binary', async () => {
    const { d, exec } = deps({}, null)
    expect(await getPhoneAccessStatus(3000, d)).toEqual({ state: 'not_installed', url: null })
    expect(exec).not.toHaveBeenCalled()
  })
  it('not installed: ENOENT from exec', async () => {
    const { d } = deps({ 'status --json': fail({ code: null, notFound: true }) })
    expect((await getPhoneAccessStatus(3000, d)).state).toBe('not_installed')
  })
  it.each([
    ['non-zero exit', fail({ stderr: 'failed to connect to local tailscaled' })],
    ['BackendState Stopped', ok(STOPPED)],
    ['NeedsLogin', ok(NEEDS_LOGIN)],
    ['garbage output', ok('not json')],
    ['timeout', fail({ code: null, timedOut: true })],
  ])('not running: %s', async (_n, res) => {
    const { d } = deps({ 'status --json': res })
    expect(await getPhoneAccessStatus(3000, d)).toEqual({ state: 'tailscale_not_running', url: null })
  })
  it('running, serve off', async () => {
    const { d, exec } = deps({ 'status --json': ok(RUNNING), 'serve status --json': ok(SERVE_OFF) })
    expect(await getPhoneAccessStatus(3000, d)).toEqual({ state: 'off', url: 'https://my-mac.tail1234.ts.net' })
    expect(exec).toHaveBeenCalledWith('/bin/tailscale', ['serve', 'status', '--json'])
  })
  it('running, serve off with empty output', async () => {
    const { d } = deps({ 'status --json': ok(RUNNING), 'serve status --json': ok('') })
    expect((await getPhoneAccessStatus(3000, d)).state).toBe('off')
  })
  it.each(['http://127.0.0.1:3000', 'http://localhost:3000', 'http://127.0.0.1:3000/', 'localhost:3000'])('running, serve on for %s', async (target) => {
    const { d } = deps({ 'status --json': ok(RUNNING), 'serve status --json': ok(serveOn(target)) })
    expect(await getPhoneAccessStatus(3000, d)).toEqual({ state: 'on', url: 'https://my-mac.tail1234.ts.net' })
  })
  it('serve proxying a different port is off', async () => {
    const { d } = deps({ 'status --json': ok(RUNNING), 'serve status --json': ok(serveOn('http://127.0.0.1:30001')) })
    expect((await getPhoneAccessStatus(3000, d)).state).toBe('off')
  })
  it('finds the target wherever it sits in the JSON', async () => {
    const odd = JSON.stringify({ Services: [{ deep: { list: ['x', 'http://[::1]:3000'] } }] })
    const { d } = deps({ 'status --json': ok(RUNNING), 'serve status --json': ok(odd) })
    expect((await getPhoneAccessStatus(3000, d)).state).toBe('on')
  })
  it('error when the DNS name is missing or not a ts.net name', async () => {
    for (const self of [{}, { DNSName: 'evil.example.com.' }]) {
      const { d } = deps({ 'status --json': ok(JSON.stringify({ BackendState: 'Running', Self: self })) })
      const s = await getPhoneAccessStatus(3000, d)
      expect(s.state).toBe('error')
      expect(s.url).toBeNull()
    }
  })
  it('rejects an invalid port without running anything', async () => {
    const { d, exec } = deps({})
    expect((await getPhoneAccessStatus(0, d)).state).toBe('error')
    expect(exec).not.toHaveBeenCalled()
  })
})

describe('enable / disable', () => {
  it('enable runs exactly the intended argv, no shell, never funnel', async () => {
    const { d, exec } = deps({ 'serve --bg --https=443 --yes localhost:3000': ok() })
    expect(await enablePhoneAccess(3000, d)).toEqual({ ok: true, needsConsent: false, message: '' })
    expect(exec).toHaveBeenCalledTimes(1)
    expect(exec).toHaveBeenCalledWith('/bin/tailscale', ['serve', '--bg', '--https=443', '--yes', 'localhost:3000'])
  })
  it('disable runs exactly the intended argv', async () => {
    const { d, exec } = deps({ 'serve --https=443 off': ok() })
    expect((await disablePhoneAccess(d)).ok).toBe(true)
    expect(exec).toHaveBeenCalledWith('/bin/tailscale', ['serve', '--https=443', 'off'])
  })
  it('refuses an invalid port', async () => {
    const { d, exec } = deps({})
    expect((await enablePhoneAccess(99999, d)).ok).toBe(false)
    expect(exec).not.toHaveBeenCalled()
  })
  it('consent on timeout', async () => {
    const { d } = deps({ 'serve --bg --https=443 --yes localhost:3000': fail({ code: null, timedOut: true }) })
    const r = await enablePhoneAccess(3000, d)
    expect(r.ok).toBe(false)
    expect(r.needsConsent).toBe(true)
    expect(r.message).toContain('tailscale serve --bg --https=443 localhost:3000')
  })
  it('consent when the output carries a login.tailscale.com URL', async () => {
    const { d } = deps({ 'serve --bg --https=443 --yes localhost:4100': fail({ stderr: 'Serve is not enabled on your tailnet.\nTo enable, visit:\n https://login.tailscale.com/f/serve?node=abc' }) })
    const r = await enablePhoneAccess(4100, d)
    expect(r.needsConsent).toBe(true)
    expect(r.message).toContain('localhost:4100')
  })
  it('other failures are reported without consent', async () => {
    const { d } = deps({ 'serve --https=443 off': fail({ stderr: 'boom' }) })
    const r = await disablePhoneAccess(d)
    expect(r).toMatchObject({ ok: false, needsConsent: false })
    expect(r.message).toContain('boom')
  })
  it('not installed', async () => {
    const { d } = deps({}, null)
    expect(await enablePhoneAccess(3000, d)).toMatchObject({ ok: false, needsConsent: false })
  })
})
