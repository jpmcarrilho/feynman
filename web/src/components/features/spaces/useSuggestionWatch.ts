'use client'

import { useCallback, useEffect, useRef } from 'react'
import { getSpaceStatusAction, getUpdateSuggestionAction } from '@/app/spaces/actions'
import type { ProfileSuggestion } from '@/lib/studyspace/profile'

export const WATCH_INTERVAL_MS = 2000
/** Reads in a row that must show nothing pending before the watch stops (the check starts a moment after the file is ready). */
export const SETTLED_READS = 2

/**
 * Lets an open page pick up a tutor update that is stored (or replaced) after it was rendered. It reads the status once on mount and
 * whenever `kick()` is called (a file was added or became ready); it keeps reading every 2 seconds while a file is unfinished or the
 * server says the tutor-update check is running, then for SETTLED_READS more reads after a kick, then stops. Reads never overlap and
 * pause while the tab is hidden. `onSuggestion` gets the stored update whenever its `createdAt` differs from `currentCreatedAt`, and null when the stored update is gone.
 */
export function useSuggestionWatch(courseId: string, currentCreatedAt: string | null, onSuggestion: (s: ProfileSuggestion | null) => void): { kick: () => void } {
  const known = useRef(currentCreatedAt)
  const cb = useRef(onSuggestion)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inFlight = useRef(false)
  const alive = useRef(true)
  const armed = useRef(false)
  const quiet = useRef(0)
  const again = useRef(false)
  const pollRef = useRef<() => void>(() => {})
  useEffect(() => {
    known.current = currentCreatedAt
    cb.current = onSuggestion
  })

  const poll = useCallback(async () => {
    if (!alive.current) return
    if (inFlight.current) {
      again.current = true
      return
    }
    inFlight.current = true
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    let keepGoing = true
    try {
      const status = await getSpaceStatusAction(courseId)
      if (!alive.current) return
      if (!status) {
        keepGoing = false
      } else {
        const stored = status.profileSuggestion
        if (stored && stored.kind === 'update' && stored.createdAt !== known.current) {
          const full = await getUpdateSuggestionAction(courseId)
          if (!alive.current) return
          if (full) {
            known.current = full.createdAt
            cb.current(full)
          }
        }
        if (!(stored && stored.kind === 'update') && known.current !== null) {
          // The stored update is gone (its file was removed, or it was handled elsewhere): the page drops it too
          known.current = null
          cb.current(null)
        }
        const active = status.updateCheckPending || status.sources.some((s) => s.status !== 'ready' && s.status !== 'failed')
        if (active) quiet.current = 0
        else quiet.current++
        keepGoing = active || (armed.current && quiet.current < SETTLED_READS)
        if (!keepGoing) armed.current = false
      }
    } catch {
      keepGoing = armed.current
    } finally {
      inFlight.current = false
    }
    if (again.current) {
      again.current = false
      keepGoing = true
    }
    if (alive.current && keepGoing && document.visibilityState === 'visible') timer.current = setTimeout(() => pollRef.current(), WATCH_INTERVAL_MS)
  }, [courseId])

  useEffect(() => {
    pollRef.current = () => void poll()
    alive.current = true
    timer.current = setTimeout(() => pollRef.current(), 0)
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !timer.current && !inFlight.current && (armed.current || quiet.current === 0)) void poll()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive.current = false
      if (timer.current) clearTimeout(timer.current)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [poll])

  const kick = useCallback(() => {
    armed.current = true
    quiet.current = 0
    void poll()
  }, [poll])
  return { kick }
}
