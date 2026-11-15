'use client'

import { useState, useEffect } from 'react'
import { Progress } from '@/components/ui/progress'

interface SessionTimerProps {
  durationSeconds: number // target duration
  startTime: string | Date
  /** Set once the session is over: the clock stops and the fixed duration (endTime - startTime) is shown. */
  endTime?: string | Date | null
  /** False for a completed or cancelled session: no running clock. */
  active?: boolean
  /** Server clock minus client clock in ms (from the session state), so elapsed time follows the server's startTime. */
  serverOffsetMs?: number
  /** One inline figure ("Elapsed: m:ss", or "Duration: m:ss" once over) for a compact header: no target, no progress bar. */
  compact?: boolean
}

export const formatClock = (totalSeconds: number) => {
  const mins = Math.floor(totalSeconds / 60)
  const secs = totalSeconds % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

/** Whole seconds between two instants, never negative. */
export function secondsBetween(startMs: number, endMs: number): number {
  return Math.max(0, Math.floor((endMs - startMs) / 1000))
}

/**
 * Elapsed time of a study session. The target is a goal, not a limit: an active session keeps counting past it (the
 * bar stays full). Elapsed time is measured on the server's clock from the stored startTime, so a reload or another
 * device shows the same value. A session that is over shows its actual duration as a fixed value, or nothing when
 * the end time is unknown.
 */
export function SessionTimer({ durationSeconds, startTime, endTime = null, active = true, serverOffsetMs = 0, compact = false }: SessionTimerProps) {
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (!active) return
    const start = new Date(startTime).getTime()
    const tick = () => setElapsed(secondsBetween(start, Date.now() + serverOffsetMs))
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [startTime, active, serverOffsetMs])

  if (!active) {
    if (!endTime) return null
    const total = secondsBetween(new Date(startTime).getTime(), new Date(endTime).getTime())
    if (compact) return <span className="shrink-0 text-xs font-medium tabular-nums text-muted-foreground">Duration: {formatClock(total)}</span>
    return (
      <div className="w-full text-sm font-medium text-muted-foreground">
        <span>Duration: {formatClock(total)}</span>
      </div>
    )
  }

  if (compact) return <span className="shrink-0 text-xs font-medium tabular-nums text-muted-foreground">Elapsed: {formatClock(elapsed)}</span>

  const progress = Math.min((elapsed / durationSeconds) * 100, 100)

  return (
    <div className="w-full space-y-2">
      <div className="flex justify-between text-sm font-medium text-muted-foreground">
        <span>Elapsed: {formatClock(elapsed)}</span>
        <span>Target: {formatClock(durationSeconds)}</span>
      </div>
      <Progress value={progress} className="h-2" />
    </div>
  )
}
