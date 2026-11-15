import { NextRequest, NextResponse } from 'next/server'
import QRCode from 'qrcode'
import { checkIsAuthenticated } from '@/app/auth-actions'
import { isLocalRequest } from '@/server/requestOrigin'
import {
  consentCommand,
  disablePhoneAccess,
  enablePhoneAccess,
  getPhoneAccessStatus,
  isValidPhoneUrl,
  resolvePort,
  type PhoneAccessActionResult,
  type PhoneAccessState,
} from '@/server/phoneAccess'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }

export interface PhoneAccessPayload {
  state: PhoneAccessState
  url: string | null
  /** SVG markup of the QR code for `url`, only when the state is `on`. Generated here from a validated ts.net URL. */
  qrSvg: string | null
  canToggle: boolean
  /** Why the switch is unavailable (null when it can be used). */
  reason: string | null
  message: string | null
  /** The Terminal command for the one-time approval. */
  consentCommand: string
  /** True when this request was made on the Mac itself. */
  isLocal: boolean
}

function reasonFor(state: PhoneAccessState, local: boolean): string | null {
  if (!local) return 'Switching is done on the Mac that runs the app, not from here.'
  if (state === 'not_installed') return 'Tailscale is not installed on this Mac.'
  if (state === 'tailscale_not_running') return 'Tailscale is not running or not signed in on this Mac.'
  if (state === 'error') return 'Phone access cannot be controlled until the problem below is fixed.'
  return null
}

async function buildPayload(request: NextRequest): Promise<PhoneAccessPayload> {
  const port = resolvePort()
  const local = isLocalRequest(request.headers)
  const status = port === null
    ? { state: 'error' as const, url: null, message: 'The PORT environment variable is not an integer from 1 to 65535.' }
    : await getPhoneAccessStatus(port)
  let qrSvg: string | null = null
  if (status.state === 'on' && status.url && isValidPhoneUrl(status.url)) {
    qrSvg = await QRCode.toString(status.url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
  }
  const reason = reasonFor(status.state, local)
  return {
    state: status.state,
    url: status.url,
    qrSvg,
    canToggle: reason === null,
    reason,
    message: status.message ?? null,
    consentCommand: consentCommand(port ?? 3000),
    isLocal: local,
  }
}

export async function GET(request: NextRequest) {
  if (!(await checkIsAuthenticated())) return new NextResponse('Unauthorized', { status: 401 })
  return NextResponse.json(await buildPayload(request), { headers: NO_STORE })
}

export async function POST(request: NextRequest) {
  if (!(await checkIsAuthenticated())) return new NextResponse('Unauthorized', { status: 401 })
  if (!isLocalRequest(request.headers)) {
    return NextResponse.json({ error: 'Phone access can only be switched on the Mac that runs the app.' }, { status: 403, headers: NO_STORE })
  }
  let enabled: unknown
  try {
    enabled = ((await request.json()) as { enabled?: unknown } | null)?.enabled
  } catch {
    enabled = undefined
  }
  if (typeof enabled !== 'boolean') {
    return NextResponse.json({ error: 'Expected { "enabled": true | false }.' }, { status: 400, headers: NO_STORE })
  }

  const port = resolvePort()
  let action: PhoneAccessActionResult
  if (enabled) {
    action = port === null
      ? { ok: false, needsConsent: false, message: 'The PORT environment variable is not an integer from 1 to 65535.' }
      : await enablePhoneAccess(port)
  } else {
    action = await disablePhoneAccess()
  }
  const payload = await buildPayload(request)
  return NextResponse.json({ ...payload, ok: action.ok, needsConsent: action.needsConsent, message: action.message || payload.message }, { headers: NO_STORE })
}
