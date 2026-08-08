'use client'

import { useEffect, useState } from 'react'
import { getAnalyticsData } from '@/app/actions'
import { AnalyticsMetrics } from './analytics/AnalyticsMetrics'
import { ActivityChart } from './analytics/ActivityChart'
import { CourseAccuracyChart } from './analytics/CourseAccuracyChart'
import { AccuracyHeatmap } from './analytics/AccuracyHeatmap'

export function AnalyticsDashboard() {
  const [data, setData] = useState<any>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    getAnalyticsData().then((res) => {
      setData(res)
      setIsLoading(false)
    })
  }, [])

  if (isLoading || !data) {
    return (
      <div className="flex-1 w-full flex items-center justify-center text-muted-foreground p-8 bg-background font-sans">
        Loading analytics...
      </div>
    )
  }

  return (
    <div className="flex-1 w-full p-8 overflow-y-auto bg-background text-charcoal-graphite font-sans">
      <h1 className="text-3xl font-bold tracking-tight mb-8 font-display italic">Analytics Dashboard</h1>
      
      {/* 1. Top Row: Key Metrics KPI Cards */}
      <AnalyticsMetrics 
        totalSessions={data.totalSessions}
        totalExercises={data.totalExercises}
        overallAccuracy={data.overallAccuracy}
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* 2. Middle Row: Recharts Activity & Course Accuracy Charts */}
        <ActivityChart activityData={data.activityChartData} />
        <CourseAccuracyChart courseAccuracyData={data.courseAccuracy} />

        {/* 3. Bottom Row: Module Accuracy Heatmap Drilldown Box */}
        <AccuracyHeatmap heatmapData={data.heatmapData} />
      </div>
    </div>
  )
}
