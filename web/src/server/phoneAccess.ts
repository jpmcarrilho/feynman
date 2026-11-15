import { execFile } from 'node:child_process'
import fs from 'node:fs'

/**
 * Wrapper around the Tailscale CLI for the "Phone access" card. It only ever runs `tailscale status --json`,
 * `tailscale serve status --json`, `tailscale serve --bg --https=443 --yes localhost:<port>` and `tailscale serve --https=443 off`.
 * `tailscale funnel` (public internet) is never called. No command goes through a shell, and the only variable argument is the port.
 */

export type PhoneAccessState = 'on' | 'off' | 'tailscale_not_running' | 'not_installed' | 'error'

export interface PhoneAccessStatus {
  state: PhoneAccessState
  /** `https://<name>.<tailnet>.ts.net` when Tailscale is running and the name is valid. */
  url: string | null
  message?: string
}

export interface PhoneAccessActionResult {
  ok: boolean
  needsConsent: boolean
  message: string
}

export interface ExecResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  notFound: boolean
}

export interface PhoneAccessDeps {
  /** Runs `file` with `args`, no shell. Never rejects. */
  exec: (file: string, args: string[]) => Promise<ExecResult>
  /** Resolves the Tailscale executable, or null. */
  findBinary: () => string | null
}

export const DEFAULT_PORT = 3000
export const TIMEOUT_MS = 15_000
export const BINARY_CANDIDATES = [
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale', // unconfirmed (plan U7)
]

/** First executable file among `TAILSCALE_BIN` and the known install paths. */
export function resolveTailscaleBinary(
  env: Record<string, string | undefined> = process.env,
  isExecutable: (p: string) => boolean = defaultIsExecutable,
): string | null {
  const candidates = [env.TAILSCALE_BIN, ...BINARY_CANDIDATES].filter((p): p is string => Boolean(p))
  return candidates.find(isExecutable) ?? null
}

function defaultIsExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK)
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/** The app's port: `PORT` or 3000. Returns null when `PORT` is set to something that is not an integer from 1 to 65535. */
export function resolvePort(env: Record<string, string | undefined> = process.env): number | null {
  const raw = env.PORT
  if (raw === undefined || raw.trim() === '') return DEFAULT_PORT
  return parsePort(raw.trim())
}

export function parsePort(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,5}$/.test(value) ? Number(value) : NaN
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null
}

/** `https://<label>.<more labels>.ts.net` and nothing else (no path, port, userinfo or query). */
export function isValidPhoneUrl(url: string): boolean {
  return /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+\.ts\.net$/i.test(url)
}

/** The exact command the owner runs once in Terminal when enabling needs a one-time approval. */
export function consentCommand(port: number): string {
  return `tailscale serve --bg --https=443 localhost:${port}`
}

export function defaultExec(file: string, args: string[]): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve({ code: 0, stdout: String(stdout), stderr: String(stderr), timedOut: false, notFound: false })
      const e = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null }
      resolve({
        code: typeof e.code === 'number' ? e.code : null,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        timedOut: e.killed === true && e.signal === 'SIGTERM',
        notFound: e.code === 'ENOENT',
      })
    })
  })
}

const defaultDeps: PhoneAccessDeps = { exec: defaultExec, findBinary: () => resolveTailscaleBinary() }

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * Assumptions about output formats (the Tailscale docs, https://tailscale.com/kb/1080/cli, say only that `status --json` is
 * machine-readable and "subject to change"; they do not document these fields):
 *  - `tailscale status --json` has a string `BackendState` ("Running" when connected) and `Self.DNSName` ("name.tailnet.ts.net." with a trailing dot).
 *  - `tailscale serve status --json` is a JSON document in which a proxied target appears as a string value such as
 *    "http://127.0.0.1:3000" or "http://localhost:3000" (possibly with a path). The parser searches every string in the document
 *    instead of relying on a path such as Web.*.Handlers.*.Proxy, and treats empty output / "{}" as "serve off".
 */
export function parseTailscaleStatus(stdout: string): { running: boolean; dnsName: string | null } {
  const json = safeJson(stdout)
  if (!json || typeof json !== 'object') return { running: false, dnsName: null }
  const o = json as { BackendState?: unknown; Self?: { DNSName?: unknown } }
  const running = o.BackendState === 'Running'
  const dns = typeof o.Self?.DNSName === 'string' ? o.Self.DNSName.replace(/\.$/, '') : null
  return { running, dnsName: dns || null }
}

export function serveJsonProxiesPort(stdout: string, port: number): boolean {
  const json = safeJson(stdout)
  if (json === null) return false
  const target = new RegExp(`^(?:[a-z+]+://)?(?:127\\.0\\.0\\.1|localhost|\\[::1\\]):${port}(?:/.*)?$`, 'i')
  const visit = (node: unknown): boolean => {
    if (typeof node === 'string') return target.test(node.trim())
    if (Array.isArray(node)) return node.some(visit)
    if (node && typeof node === 'object') return Object.values(node).some(visit)
    return false
  }
  return visit(json)
}

export async function getPhoneAccessStatus(port: number, deps: PhoneAccessDeps = defaultDeps): Promise<PhoneAccessStatus> {
  if (parsePort(port) === null) return { state: 'error', url: null, message: 'The app port is not valid.' }
  const bin = deps.findBinary()
  if (!bin) return { state: 'not_installed', url: null }

  const status = await deps.exec(bin, ['status', '--json'])
  if (status.notFound) return { state: 'not_installed', url: null }
  // Exit code 0 is not required for useful JSON (a stopped daemon exits non-zero), but without it we cannot trust the output.
  const parsed = status.code === 0 ? parseTailscaleStatus(status.stdout) : { running: false, dnsName: null }
  if (!parsed.running) return { state: 'tailscale_not_running', url: null }

  const url = parsed.dnsName ? `https://${parsed.dnsName}` : null
  if (!url || !isValidPhoneUrl(url)) {
    return { state: 'error', url: null, message: 'Tailscale is running but did not report a valid .ts.net name for this Mac. Check that MagicDNS and HTTPS certificates are enabled for your tailnet.' }
  }

  const serve = await deps.exec(bin, ['serve', 'status', '--json'])
  if (serve.code !== 0) return { state: 'off', url, message: 'Could not read the Tailscale Serve status.' }
  return { state: serveJsonProxiesPort(serve.stdout, port) ? 'on' : 'off', url }
}

const CONSENT_PATTERN = /login\.tailscale\.com|tailscale\.com\/admin|admin console/i

function consentResult(port: number): PhoneAccessActionResult {
  return {
    ok: false,
    needsConsent: true,
    message: `Tailscale needs a one-time approval before it can serve this app. Run this once in Terminal, follow the link it prints, approve, then press Refresh: ${consentCommand(port)}`,
  }
}

async function runServe(args: string[], port: number, deps: PhoneAccessDeps, failure: string): Promise<PhoneAccessActionResult> {
  const bin = deps.findBinary()
  if (!bin) return { ok: false, needsConsent: false, message: 'Tailscale is not installed.' }
  const result = await deps.exec(bin, args)
  if (result.notFound) return { ok: false, needsConsent: false, message: 'Tailscale is not installed.' }
  if (result.timedOut || CONSENT_PATTERN.test(`${result.stdout}\n${result.stderr}`)) return consentResult(port)
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().slice(0, 300)
    return { ok: false, needsConsent: false, message: detail ? `${failure} ${detail}` : failure }
  }
  return { ok: true, needsConsent: false, message: '' }
}

export async function enablePhoneAccess(port: number, deps: PhoneAccessDeps = defaultDeps): Promise<PhoneAccessActionResult> {
  const valid = parsePort(port)
  if (valid === null) return { ok: false, needsConsent: false, message: 'The app port is not valid.' }
  return runServe(['serve', '--bg', '--https=443', '--yes', `localhost:${valid}`], valid, deps, 'Could not turn phone access on.')
}

export async function disablePhoneAccess(deps: PhoneAccessDeps = defaultDeps): Promise<PhoneAccessActionResult> {
  return runServe(['serve', '--https=443', 'off'], DEFAULT_PORT, deps, 'Could not turn phone access off.')
}
