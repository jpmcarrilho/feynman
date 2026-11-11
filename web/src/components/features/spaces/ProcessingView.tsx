'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Loader2, XCircle } from 'lucide-react'
import { formatBytes } from '@/lib/formatBytes'
import { Button } from '@/components/ui/button'
import { getSpaceStatusAction, removeSourceAction, retrySourceAction } from '@/app/spaces/actions'
import type { SourceStatusView, SpaceStatus } from '@/services/spaceStatus'
import { SourceDropzone } from './SourceDropzone'

export const POLL_INTERVAL_MS = 2000

const isTerminal = (s: { status: string }) => s.status === 'ready' || s.status === 'failed'

const mb = formatBytes
const isPdfName = (name: string) => /\.pdf$/i.test(name)

/** After Retry: waiting (still showing the old failure), running (status moved on), failedAgain. `since` is the row's updatedAt when Retry was clicked. */
type RetryPhase = { since: string; phase: 'waiting' | 'running' | 'failedAgain' }

function SourceRow({ source, busy, confirming, retry, onRetry, onRemove }: { source: SourceStatusView; busy: boolean; confirming: boolean; retry?: RetryPhase; onRetry: () => void; onRemove: () => void }) {
  const retrying = retry?.phase === 'waiting'
  const failed = source.status === 'failed' && !retrying
  const ready = source.status === 'ready'
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-charcoal-graphite/10 bg-card px-3 py-3 text-sm sm:flex-row sm:items-start sm:justify-between" data-status={source.status}>
      <div className="flex min-w-0 gap-2">
        <span className="mt-0.5 shrink-0" aria-hidden>
          {failed ? <XCircle className="size-4 text-lecture-red" /> : ready ? <CheckCircle2 className="size-4 text-emerald-700" /> : <Loader2 className="size-4 animate-spin text-fountain-ink" />}
        </span>
        <div className="min-w-0">
          <p className="break-words font-medium text-charcoal-graphite">{source.originalName} <span className="font-normal text-charcoal-graphite/50">({mb(source.sizeBytes)}{source.pageCount && isPdfName(source.originalName) ? `, ${source.pageCount} page${source.pageCount === 1 ? '' : 's'}` : ''})</span></p>
          {failed ? (
            <p className="text-xs font-medium text-lecture-red">{retry?.phase === 'failedAgain' ? 'Retried and failed again' : 'Failed'}: {source.error ?? 'This file could not be processed.'}</p>
          ) : (
            <p className="text-xs text-charcoal-graphite/65">{retrying ? 'Retrying…' : source.progressText}</p>
          )}
          {source.warning && (
            <p className="mt-0.5 flex items-start gap-1 text-xs text-amber-800"><AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden /><span>{source.warning}</span></p>
          )}
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        {(failed || retrying) && source.canRetry && (
          <Button type="button" variant="outline" size="sm" className="h-9 px-3" disabled={busy || retrying} onClick={onRetry} aria-label={`Retry ${source.originalName}`}>Retry</Button>
        )}
        <Button type="button" variant={confirming ? 'destructive' : 'ghost'} size="sm" className="h-9 px-3" disabled={busy} onClick={onRemove} aria-label={confirming ? `Confirm removing ${source.originalName}` : `Remove ${source.originalName}`}>
          {confirming ? 'Confirm remove' : 'Remove'}
        </Button>
      </div>
    </li>
  )
}

/**
 * Step 2: shows every file of the studyspace and polls its status every 2 seconds while anything is unfinished. Polling stops when
 * everything is ready or failed and while the tab is hidden (it resumes on return), and never overlaps.
 */
export function ProcessingView({ courseId, onReview }: { courseId: string; onReview: () => void }) {
  const [status, setStatus] = useState<SpaceStatus | null>(null)
  const [missing, setMissing] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [retries, setRetries] = useState<Record<string, RetryPhase>>({})
  const [removed, setRemoved] = useState<string[]>([])
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inFlight = useRef(false)
  const alive = useRef(true)
  const lastProcessing = useRef(true)
  const again = useRef(false)
  const retriesRef = useRef<Record<string, RetryPhase>>({})
  const pollRef = useRef<() => void>(() => {})

  const poll = useCallback(async () => {
    if (!alive.current) return
    if (inFlight.current) {
      again.current = true // asked for during a poll: the result may predate the change, so poll once more
      return
    }
    inFlight.current = true
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    try {
      const next = await getSpaceStatusAction(courseId)
      if (!alive.current) return
      if (!next) {
        setMissing(true)
        lastProcessing.current = false
      } else {
        setStatus(next)
        // Follow each retried file: it left 'failed' (or changed while failed) and either got further or failed again
        const out: Record<string, RetryPhase> = {}
        for (const [id, r] of Object.entries(retriesRef.current)) {
          const src = next.sources.find((x) => x.id === id)
          if (!src || src.status === 'ready') continue
          if (src.status !== 'failed') out[id] = { ...r, phase: 'running' }
          else if (r.phase === 'waiting' && src.updatedAt === r.since) out[id] = r
          else out[id] = { ...r, phase: 'failedAgain' }
        }
        retriesRef.current = out
        setRetries(out)
        setLoadError(false)
        lastProcessing.current = next.sources.length === 0 || next.sources.some((s) => !isTerminal(s)) || Object.values(retriesRef.current).some((r) => r.phase === 'waiting')
      }
    } catch {
      if (alive.current) setLoadError(true)
      lastProcessing.current = true
    } finally {
      inFlight.current = false
    }
    if (again.current) {
      again.current = false
      lastProcessing.current = true
    }
    if (alive.current && lastProcessing.current && document.visibilityState === 'visible') timer.current = setTimeout(() => pollRef.current(), POLL_INTERVAL_MS)
  }, [courseId])

  useEffect(() => {
    pollRef.current = () => void poll()
    alive.current = true
    timer.current = setTimeout(() => pollRef.current(), 0)
    const onVisible = () => {
      if (document.visibilityState === 'visible' && lastProcessing.current && !timer.current) void poll()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive.current = false
      if (timer.current) clearTimeout(timer.current)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [poll])

  const run = async (id: string, action: () => Promise<{ ok: boolean; reason?: string }>) => {
    setBusyId(id)
    setMessage(null)
    try {
      const result = await action()
      if (!result.ok) setMessage(result.reason ?? 'That did not work. Try again.')
    } catch {
      setMessage('Could not reach the server. Try again.')
    } finally {
      setBusyId(null)
      setConfirmId(null)
      void poll()
    }
  }

  const sources = status?.sources ?? []
  const initial = sources.filter((s) => s.bundle === 'initial')
  const pending = sources.some((s) => !isTerminal(s))
  const anyReady = initial.some((s) => s.status === 'ready')
  const allFailed = sources.length > 0 && !pending && !sources.some((s) => s.status === 'ready')

  return (
    <div className="flex flex-col gap-5 font-sans">
      <div>
        <h2 className="font-display text-xl font-bold italic text-charcoal-graphite">Processing your files</h2>
        <p className="mt-1 text-sm text-charcoal-graphite/70">
          Each file is read and split into topics on the server. This takes from a few seconds to a few minutes per file. You can close this page: the work continues and picks up again if the server restarts. Come back to this page to see the result.
        </p>
      </div>

      {missing && <p role="alert" className="text-sm font-medium text-lecture-red">This studyspace no longer exists.</p>}
      {loadError && <p role="alert" className="text-sm font-medium text-lecture-red">Could not read the status. Retrying...</p>}
      {message && <p role="alert" className="text-sm font-medium text-lecture-red">{message}</p>}

      {status === null && !missing && <p className="flex items-center gap-2 text-sm text-charcoal-graphite/65"><Loader2 className="size-4 animate-spin" aria-hidden /> Loading...</p>}

      {sources.length > 0 && (
        <ul className="flex flex-col gap-2" aria-label="Files of this studyspace">
          {sources.map((s) => (
            <SourceRow
              key={s.id}
              source={s}
              busy={busyId === s.id}
              confirming={confirmId === s.id}
              retry={retries[s.id]}
              onRetry={() => void run(s.id, async () => {
                const result = await retrySourceAction(s.id)
                if (result.ok) {
                  retriesRef.current = { ...retriesRef.current, [s.id]: { since: s.updatedAt, phase: 'waiting' } }
                  setRetries(retriesRef.current)
                }
                return result
              })}
              onRemove={() => {
                // A file that failed can go right away; a file that was read or is being read asks once
                if (s.status === 'failed' || confirmId === s.id) void run(s.id, async () => {
                  const result = await removeSourceAction(s.id)
                  if (result.ok) setRemoved((prev) => [...prev, s.id])
                  return result
                })
                else setConfirmId(s.id)
              }}
            />
          ))}
        </ul>
      )}

      {allFailed && <p role="status" className="rounded-lg border border-lecture-red/30 bg-lecture-red/5 p-3 text-sm text-charcoal-graphite">No file could be processed. Retry a file, remove it, or add other files below.</p>}
      {!pending && anyReady && (
        <div className="flex flex-col gap-2 rounded-lg border border-emerald-700/25 bg-emerald-50/50 p-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-charcoal-graphite">All files are done. Check how they were split into topics.</p>
          <Button type="button" className="h-10 border-0 bg-lecture-red px-5 font-semibold text-white hover:bg-lecture-red/90" onClick={onReview}>Review outline</Button>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-charcoal-graphite">Add more files</h3>
        <SourceDropzone courseId={courseId} bundle="initial" removedSourceIds={removed} onUploaded={() => void poll()} />
      </div>
    </div>
  )
}
