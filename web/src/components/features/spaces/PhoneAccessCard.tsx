'use client'

import { useCallback, useEffect, useState } from 'react'
import { Check, Copy, RefreshCw, Smartphone } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { PhoneAccessPayload } from '@/app/api/phone-access/route'

type Payload = PhoneAccessPayload & { ok?: boolean; needsConsent?: boolean }

const PILL: Record<PhoneAccessPayload['state'], { label: string; className: string }> = {
  on: { label: 'On', className: 'bg-green-600/15 text-green-800' },
  off: { label: 'Off', className: 'bg-charcoal-graphite/10 text-charcoal-graphite/80' },
  tailscale_not_running: { label: 'Tailscale not running', className: 'bg-amber-500/20 text-amber-900' },
  not_installed: { label: 'Tailscale not installed', className: 'bg-amber-500/20 text-amber-900' },
  error: { label: 'Problem', className: 'bg-red-600/15 text-red-800' },
}

/** The QR code comes from the server as SVG text. It is shown through an <img> data URL, so it can never run script or touch the page. */
function qrSrc(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/** "Phone access" on /spaces: switches `tailscale serve` on or off for this Mac and shows the address and QR code. */
export function PhoneAccessCard() {
  const [data, setData] = useState<Payload | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(true) // true until the first status arrives
  const [copied, setCopied] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    setBusy(true)
    try {
      const res = await fetch('/api/phone-access', { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setData((await res.json()) as Payload)
      setLoadError(null)
    } catch {
      setLoadError('Could not read the phone access status.')
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    // First read, written as a promise chain: state is set in callbacks, not synchronously in the effect body
    let cancelled = false
    fetch('/api/phone-access', { cache: 'no-store' })
      .then((res) => (res.ok ? (res.json() as Promise<Payload>) : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((body) => { if (!cancelled) setData(body) })
      .catch(() => { if (!cancelled) setLoadError('Could not read the phone access status.') })
      .finally(() => { if (!cancelled) setBusy(false) })
    return () => { cancelled = true }
  }, [])

  async function toggle() {
    if (!data || !data.canToggle || busy) return
    setBusy(true)
    setNotice(null)
    try {
      const res = await fetch('/api/phone-access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: data.state !== 'on' }),
      })
      const body = (await res.json()) as Payload & { error?: string }
      if (!res.ok) {
        setNotice(body.error ?? 'Could not switch phone access.')
      } else {
        setData(body)
        setNotice(body.ok ? null : body.message)
      }
    } catch {
      setNotice('Could not switch phone access.')
    } finally {
      setBusy(false)
    }
  }

  async function copy() {
    if (!data?.url) return
    try {
      await navigator.clipboard.writeText(data.url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setNotice('Copying is not available here. Select the address and copy it.')
    }
  }

  const on = data?.state === 'on'
  const pill = data ? PILL[data.state] : null

  return (
    <Card aria-labelledby="phone-access-title" role="region" className="border-charcoal-graphite/15">
      <CardHeader className="flex flex-row flex-wrap items-center gap-3">
        <Smartphone className="size-5 shrink-0 text-charcoal-graphite/70" aria-hidden />
        <CardTitle id="phone-access-title" className="font-display text-lg">Phone access</CardTitle>
        {pill && (
          <span data-testid="phone-status" className={`rounded-full px-2.5 py-1 text-xs font-semibold ${pill.className}`}>
            {pill.label}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button type="button" variant="outline" className="h-10 min-w-10 px-3" onClick={() => void load()} disabled={busy} aria-label="Refresh phone access status">
            <RefreshCw className={`size-4 ${busy ? 'animate-spin' : ''}`} aria-hidden />
            <span className="hidden sm:inline">Refresh</span>
          </Button>
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label="Phone access"
            disabled={!data || !data.canToggle || busy}
            onClick={() => void toggle()}
            className={`relative inline-flex h-10 w-16 shrink-0 items-center rounded-full border transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fountain-ink disabled:cursor-not-allowed disabled:opacity-50 ${on ? 'border-green-700 bg-green-600' : 'border-charcoal-graphite/30 bg-charcoal-graphite/15'}`}
          >
            <span aria-hidden className={`inline-block size-7 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-8' : 'translate-x-1.5'}`} />
          </button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 font-sans text-sm text-charcoal-graphite/80">
        {loadError && <p role="alert" className="text-red-700">{loadError}</p>}
        {busy && !data && <p>Checking Tailscale…</p>}

        {data && (
          <>
            {data.reason && <p data-testid="phone-reason">{data.reason}</p>}
            {data.message && !notice && <p>{data.message}</p>}
            {notice && <p role="alert" className="text-red-700">{notice}</p>}

            {data.needsConsent && (
              <div data-testid="phone-consent" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
                <p>Tailscale needs a one-time approval. In Terminal, run:</p>
                <code className="mt-1 block overflow-x-auto rounded bg-charcoal-graphite/10 px-2 py-1.5 text-xs">{data.consentCommand}</code>
                <p className="mt-1">Open the link it prints, approve, then come back here and press Refresh. Switching it on from here works afterwards.</p>
              </div>
            )}

            {data.state === 'not_installed' && (
              <p>
                Install Tailscale on this Mac from tailscale.com/download (or the Mac App Store), sign in, and install it on your phone with the
                same account. Then press Refresh.
              </p>
            )}
            {data.state === 'tailscale_not_running' && <p>Open the Tailscale app on this Mac and sign in, then press Refresh.</p>}

            {on && data.url && (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                {data.qrSvg && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={qrSrc(data.qrSvg)} alt={`QR code for ${data.url}`} width={160} height={160} className="size-40 shrink-0 rounded-lg border border-charcoal-graphite/10 bg-white p-1" />
                )}
                <div className="flex min-w-0 flex-col gap-2">
                  <p>Scan the code with your phone, or open this address:</p>
                  <a href={data.url} target="_blank" rel="noopener noreferrer" className="break-all font-semibold text-fountain-ink underline">{data.url}</a>
                  <Button type="button" variant="outline" className="h-10 w-fit px-3" onClick={() => void copy()}>
                    {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
                    {copied ? 'Copied' : 'Copy address'}
                  </Button>
                </div>
              </div>
            )}

            <p className="text-xs text-charcoal-graphite/60">
              The phone and this Mac must be signed in to the same Tailscale account. The passcode is still asked on the phone. Only your own
              devices on that account can open the address; it is not public.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  )
}
