/**
 * Decides whether an HTTP request was made on this Mac itself (as opposed to arriving through `tailscale serve` from the phone).
 *
 * What Next adds: before a route handler runs, Next's base server fills in forwarding headers on EVERY request
 * (node_modules/next/dist/server/base-server.js, "Update the `x-forwarded-*` headers"), each with `??=` so a value already
 * present is kept:
 *   x-forwarded-host  = Host header
 *   x-forwarded-port  = server port
 *   x-forwarded-proto = http | https
 *   x-forwarded-for   = the TCP socket's remote address (e.g. `::1`, `127.0.0.1`, `::ffff:127.0.0.1`)
 * So these headers are present on genuine local requests too, and their mere presence proves nothing. The rules are:
 *   - Host is a loopback name (`localhost`, `127.0.0.1`, `[::1]`, any port).
 *   - No `tailscale-*` header (Serve sets `Tailscale-User-Login` etc. for tailnet users and strips client copies; absent for tagged
 *     devices), no `forwarded`, no `via`.
 *   - `x-forwarded-host`, if present: every comma-separated value is a loopback name.
 *   - `x-forwarded-for`, if present: every entry is a loopback address (127.0.0.0/8, `::1`, `::ffff:127.x.x.x`).
 *   - `x-forwarded-proto` and `x-forwarded-port` alone do not matter; any other `x-forwarded-*` header (e.g. `x-forwarded-server`) means a proxy.
 *
 * What a remote client can and cannot forge:
 *  - Direct connection to a server listening on the LAN (`next dev` binds all interfaces): the client controls Host and may send its
 *    own `X-Forwarded-For`/`-Host` (Next keeps them). A client that only spoofs `Host: localhost` is caught, because Next fills
 *    `x-forwarded-for` with its real, non-loopback address. A client that also sends `X-Forwarded-For: 127.0.0.1` and
 *    `X-Forwarded-Host: localhost` is NOT caught. Residual gap; the passcode is still required, and the supported setup (production
 *    build bound to 127.0.0.1) has no direct remote connections.
 *  - Through Tailscale Serve (https://tailscale.com/kb/1312/serve): the connection reaches Next from the Mac itself, so the socket
 *    address is loopback. The docs do not say whether Serve keeps the client's Host or adds `X-Forwarded-*`. If Host is kept, it is
 *    `<name>.ts.net` and the request is rejected. If Serve rewrote Host to localhost, tailnet users are still rejected by the
 *    `Tailscale-User-Login` header (Serve strips forged copies), but a tagged device (no identity headers) would pass unless Serve adds a
 *    non-loopback `X-Forwarded-For`. That combination is the residual gap, not excluded by the docs.
 */

export interface HeaderReader {
  get(name: string): string | null
  forEach(callback: (value: string, key: string) => void): void
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** Host value without its port: `localhost:3000` -> `localhost`, `[::1]:3000` -> `[::1]`. */
function hostWithoutPort(host: string): string {
  const value = host.trim().toLowerCase()
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    return end === -1 ? value : value.slice(0, end + 1)
  }
  const colon = value.indexOf(':')
  return colon === -1 ? value : value.slice(0, colon)
}

function isLoopbackHostValue(value: string): boolean {
  return LOOPBACK_HOSTS.has(hostWithoutPort(value))
}

function isLoopbackAddress(value: string): boolean {
  const v = value.trim().toLowerCase()
  if (v === '::1' || v === '[::1]') return true
  const v4 = v.startsWith('::ffff:') ? v.slice(7) : v
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v4)
  return m !== null && [m[1], m[2], m[3]].every((n) => Number(n) <= 255)
}

function listValues(value: string): string[] {
  return value.split(',').map((s) => s.trim())
}

const IGNORED_FORWARDED = new Set(['x-forwarded-host', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-port'])

export function isLocalRequest(headers: HeaderReader): boolean {
  const host = headers.get('host')
  if (!host || !isLoopbackHostValue(host)) return false

  const forwardedHost = headers.get('x-forwarded-host')
  if (forwardedHost !== null && !listValues(forwardedHost).every((v) => v !== '' && isLoopbackHostValue(v))) return false

  const forwardedFor = headers.get('x-forwarded-for')
  if (forwardedFor !== null && !listValues(forwardedFor).every((v) => v !== '' && isLoopbackAddress(v))) return false

  let proxied = false
  headers.forEach((_value, key) => {
    const name = key.toLowerCase()
    if (name.startsWith('tailscale-') || name === 'forwarded' || name === 'via') proxied = true
    else if (name.startsWith('x-forwarded-') && !IGNORED_FORWARDED.has(name)) proxied = true
  })
  return !proxied
}
