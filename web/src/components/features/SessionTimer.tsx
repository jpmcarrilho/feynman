'use client'

import { useState, useEffect } from 'react'
import { Progress } from '@/components/ui/progress'

interface SessionTimerProps {
  durationSeconds: number // target duration
  startTime: string | Date
  onComplete?: () => void
}

export function SessionTimer({ durationSeconds, startTime, onComplete }: SessionTimerProps) {
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    const start = new Date(startTime).getTime()

    const calculateElapsed = () => {
      const now = Date.now()
      const diff = Math.floor((now - start) / 1000)
      return Math.max(0, diff)
    }
    
    // Initial set
    const initialElapsed = calculateElapsed()
    setElapsed(initialElapsed)
    
    if (initialElapsed >= durationSeconds) {
      onComplete?.()
      return
    }

    const timer = setInterval(() => {
      const currentElapsed = calculateElapsed()
      setElapsed(currentElapsed)
      
      if (currentElapsed >= durationSeconds) {
        clearInterval(timer)
        onComplete?.()
      }
    }, 1000)

    return () => clearInterval(timer)
  }, [startTime, durationSeconds, onComplete])

  const progress = Math.min((elapsed / durationSeconds) * 100, 100)
  
  const formatTime = (totalSeconds: number) => {
    const mins = Math.floor(totalSeconds / 60)
    const secs = totalSeconds % 60
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  return (
    <div className="w-full space-y-2">
      <div className="flex justify-between text-sm font-medium text-muted-foreground">
        <span>Elapsed: {formatTime(elapsed)}</span>
        <span>Target: {formatTime(durationSeconds)}</span>
      </div>
      <Progress value={progress} className="h-2" />
    </div>
  )
}
