'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { getSpaceStatusAction, removeSourceAction, retrySourceAction } from '@/app/spaces/actions'
import type { SourceStatusView, SpaceStatus } from '@/services/spaceStatus'

export const POLL_INTERVAL_MS = 2000

export const isTerminal = (s: { status: string }) => s.status === 'ready' || s.status === 'failed'

/** After Retry: waiting (still showing the old failure), running (status moved on), failedAgain. `since` is the row's updatedAt when Retry was clicked. */
export type RetryPhase = { since: string; phase: 'waiting' | 'running' | 'failedAgain' }

type Options = {
  /**
   * Keep polling while the studyspace has no file at all. True in the setup wizard (a file is on its way); false where the studyspace
   * may legitimately have none (the two imported studyspaces): one read, then polling only while some file is unfinished.
   */
  keepPollingWhenEmpty: boolean
  /** Called after each read except the first, with the files as they were and as they are now. */
  onChange?: (previous: SourceStatusView[], next: SourceStatusView[]) => void
}

/**
 * The status of the files of one studyspace, read every 2 seconds while any file is unfinished (or a retry is waiting). Polling never
 * overlaps (a request for a read during a read makes one more read after it), stops when nothing is pending and while the tab is
 * hidden (it resumes on return). Shared by the processing step of the wizard and the "Add files" panel of the study interface.
 */
export function useSpaceSources(courseId: string, options: Options) {
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
  const previous = useRef<SourceStatusView[] | null>(null)
  const opts = useRef(options)
  useEffect(() => {
    opts.current = options
  })

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
        lastProcessing.current =
          (opts.current.keepPollingWhenEmpty && next.sources.length === 0) || next.sources.some((s) => !isTerminal(s)) || Object.values(retriesRef.current).some((r) => r.phase === 'waiting')
        if (previous.current) opts.current.onChange?.(previous.current, next.sources)
        previous.current = next.sources
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

  const retry = (s: SourceStatusView) =>
    void run(s.id, async () => {
      const result = await retrySourceAction(s.id)
      if (result.ok) {
        retriesRef.current = { ...retriesRef.current, [s.id]: { since: s.updatedAt, phase: 'waiting' } }
        setRetries(retriesRef.current)
      }
      return result
    })

  /** A file that failed can go right away; a file that was read or is being read asks once. */
  const remove = (s: SourceStatusView) => {
    if (s.status === 'failed' || confirmId === s.id) {
      void run(s.id, async () => {
        const result = await removeSourceAction(s.id)
        if (result.ok) setRemoved((prev) => [...prev, s.id])
        return result
      })
    } else {
      setConfirmId(s.id)
    }
  }

  return { status, missing, loadError, message, busyId, confirmId, retries, removed, poll, retry, remove }
}
