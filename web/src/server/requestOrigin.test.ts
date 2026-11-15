import { describe, it, expect } from 'vitest'
import { isLocalRequest } from './requestOrigin'

const h = (o: Record<string, string>) => new Headers(o)
/** What Next hands a route for a request from this Mac: Host plus the x-forwarded-* it fills in itself. */
const nextLocal = (over: Record<string, string> = {}) =>
  h({ host: 'localhost:3000', 'x-forwarded-host': 'localhost:3000', 'x-forwarded-port': '3000', 'x-forwarded-proto': 'http', 'x-forwarded-for': '::1', ...over })

describe('isLocalRequest', () => {
  it.each(['::1', '127.0.0.1', '::ffff:127.0.0.1', '127.1.2.3'])('(a) Next-filled headers with x-forwarded-for %s are local', (xff) => {
    expect(isLocalRequest(nextLocal({ 'x-forwarded-for': xff }))).toBe(true)
  })
  it('127.0.0.1 and [::1] hosts are local too', () => {
    expect(isLocalRequest(nextLocal({ host: '127.0.0.1:3000', 'x-forwarded-host': '127.0.0.1:3000', 'x-forwarded-for': '127.0.0.1' }))).toBe(true)
    expect(isLocalRequest(nextLocal({ host: '[::1]:3000', 'x-forwarded-host': '[::1]:3000' }))).toBe(true)
  })
  it('plain headers without Next additions are local', () => {
    expect(isLocalRequest(h({ host: 'localhost' }))).toBe(true)
  })
  it('(b) non-loopback x-forwarded-for is not local (LAN client spoofing Host)', () => {
    expect(isLocalRequest(nextLocal({ 'x-forwarded-for': '100.101.102.103' }))).toBe(false)
    expect(isLocalRequest(nextLocal({ 'x-forwarded-for': '192.168.1.20' }))).toBe(false)
  })
  it('(c) any non-loopback entry in a list is not local', () => {
    expect(isLocalRequest(nextLocal({ 'x-forwarded-for': '127.0.0.1, 100.64.0.5' }))).toBe(false)
    expect(isLocalRequest(nextLocal({ 'x-forwarded-for': '100.64.0.5, 127.0.0.1' }))).toBe(false)
    expect(isLocalRequest(nextLocal({ 'x-forwarded-for': '' }))).toBe(false)
  })
  it.each(['mac.tailnet.ts.net', 'mac.tailnet.ts.net:443', 'localhost.evil.com', '192.168.1.5:3000'])('(d) host %s is not local', (host) => {
    expect(isLocalRequest(h({ host }))).toBe(false)
    expect(isLocalRequest(nextLocal({ host, 'x-forwarded-host': host }))).toBe(false)
  })
  it('no host header is not local', () => {
    expect(isLocalRequest(h({}))).toBe(false)
  })
  it.each(['tailscale-user-login', 'Tailscale-User-Name', 'tailscale-user-profile-pic', 'tailscale-app-capabilities'])('(e) %s makes it not local', (name) => {
    expect(isLocalRequest(nextLocal({ [name]: 'x' }))).toBe(false)
  })
  it('(f) x-forwarded-host x.ts.net with host localhost is not local', () => {
    expect(isLocalRequest(nextLocal({ 'x-forwarded-host': 'x.ts.net' }))).toBe(false)
    expect(isLocalRequest(nextLocal({ 'x-forwarded-host': 'localhost:3000, x.ts.net' }))).toBe(false)
  })
  it.each(['forwarded', 'via', 'x-forwarded-server', 'x-forwarded-prefix'])('%s makes it not local', (name) => {
    expect(isLocalRequest(nextLocal({ [name]: 'x' }))).toBe(false)
  })
  it('x-forwarded-proto https and a different x-forwarded-port alone do not make it remote', () => {
    expect(isLocalRequest(nextLocal({ 'x-forwarded-proto': 'https', 'x-forwarded-port': '443' }))).toBe(true)
  })
  it('ignores unrelated headers', () => {
    expect(isLocalRequest(nextLocal({ cookie: 'a=b', 'user-agent': 'x' }))).toBe(true)
  })
})
