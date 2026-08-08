'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Activity, CheckCircle, Target } from 'lucide-react'

interface AnalyticsMetricsProps {
  totalSessions: number
  totalExercises: number
  overallAccuracy: number
}

export function AnalyticsMetrics({ totalSessions, totalExercises, overallAccuracy }: AnalyticsMetricsProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
      <Card className="border border-charcoal-graphite/10 shadow-sm bg-card text-charcoal-graphite">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 border-b border-charcoal-graphite/5 mb-3">
          <CardTitle className="text-sm font-semibold text-charcoal-graphite/60 uppercase tracking-wider">Total Sessions</CardTitle>
          <Activity className="h-4 w-4 text-fountain-ink" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold font-display italic">{totalSessions}</div>
          <p className="text-[10px] text-charcoal-graphite/50 mt-1 font-sans">Active study sessions completed</p>
        </CardContent>
      </Card>

      <Card className="border border-charcoal-graphite/10 shadow-sm bg-card text-charcoal-graphite">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 border-b border-charcoal-graphite/5 mb-3">
          <CardTitle className="text-sm font-semibold text-charcoal-graphite/60 uppercase tracking-wider">Exercises Completed</CardTitle>
          <CheckCircle className="h-4 w-4 text-lecture-red" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold font-display italic">{totalExercises}</div>
          <p className="text-[10px] text-charcoal-graphite/50 mt-1 font-sans">Total practice exercises answered</p>
        </CardContent>
      </Card>

      <Card className="border border-charcoal-graphite/10 shadow-sm bg-card text-charcoal-graphite">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 border-b border-charcoal-graphite/5 mb-3">
          <CardTitle className="text-sm font-semibold text-charcoal-graphite/60 uppercase tracking-wider">Overall Accuracy</CardTitle>
          <Target className="h-4 w-4 text-bongo-gold" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold font-display italic">{overallAccuracy}%</div>
          <p className="text-[10px] text-charcoal-graphite/50 mt-1 font-sans">Weighted answer correctness score</p>
        </CardContent>
      </Card>
    </div>
  )
}
