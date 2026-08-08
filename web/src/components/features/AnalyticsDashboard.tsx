'use client'

import { useEffect, useState } from 'react'
import { getAnalyticsData } from '@/app/actions'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LineChart, Line } from 'recharts'
import { Activity, CheckCircle, Target, TrendingUp } from 'lucide-react'

const formatDisplayName = (name: string | null | undefined): string => {
  if (!name) return '';
  return name
    .replace(/_+/g, ' ')
    .trim();
}

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
      
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Sessions</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{data.totalSessions}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Exercises Completed</CardTitle>
            <CheckCircle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{data.totalExercises}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Overall Accuracy</CardTitle>
            <Target className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{data.overallAccuracy}%</div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <Card className="col-span-1">
          <CardHeader>
            <CardTitle>Activity (Last 7 Days)</CardTitle>
            <CardDescription>Number of study sessions per day</CardDescription>
          </CardHeader>
          <CardContent className="h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data.activityChartData} margin={{ top: 20, right: 20, bottom: 20, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis 
                  dataKey="date" 
                  tickFormatter={(val) => {
                    const date = new Date(val);
                    return `${date.getMonth()+1}/${date.getDate()}`;
                  }}
                />
                <YAxis allowDecimals={false} />
                <Tooltip />
                <Line type="monotone" dataKey="sessions" stroke="var(--charcoal-graphite, #2C2E33)" strokeWidth={2.5} dot={{ r: 4, fill: "var(--fountain-ink)", stroke: "var(--charcoal-graphite)", strokeWidth: 1.5 }} />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card className="col-span-1">
          <CardHeader>
            <CardTitle>Course Accuracy</CardTitle>
            <CardDescription>Percentage of correct answers by course</CardDescription>
          </CardHeader>
          <CardContent className="h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.courseAccuracy} margin={{ top: 20, right: 20, bottom: 20, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                <YAxis domain={[0, 100]} />
                <Tooltip cursor={{ fill: 'transparent' }} />
                <Bar dataKey="accuracy" fill="var(--fountain-ink, #3B6D9A)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card className="col-span-1 lg:col-span-2">
          <CardHeader>
            <CardTitle>Module Accuracy Heatmap</CardTitle>
            <CardDescription>Visualizing performance across weeks and courses</CardDescription>
          </CardHeader>
          <CardContent>
            {data.heatmapData && data.heatmapData.length > 0 ? (
              <div className="space-y-6">
                {data.heatmapData.map((courseData: any) => (
                  <div key={courseData.course} className="border rounded-md p-4">
                    <h3 className="font-semibold mb-3">{courseData.course}</h3>
                    <div className="flex flex-wrap gap-2">
                      {courseData.weeks.sort((a: any, b: any) => a.week.localeCompare(b.week)).map((weekData: any) => {
                        let bgColor = 'bg-muted/40 text-charcoal-graphite/40 border-charcoal-graphite/10'; // Default low/no data
                        let sketchClass = '';
                        if (weekData.total > 0) {
                          if (weekData.accuracy >= 80) {
                            bgColor = 'bg-green-100 text-green-900 border-green-400 font-semibold';
                            sketchClass = 'sketch-crosshatch-green';
                          } else if (weekData.accuracy >= 60) {
                            bgColor = 'bg-green-50 text-green-800 border-green-300';
                            sketchClass = 'sketch-crosshatch-green opacity-90';
                          } else if (weekData.accuracy >= 40) {
                            bgColor = 'bg-yellow-100 text-yellow-900 border-yellow-400 font-semibold';
                            sketchClass = 'sketch-crosshatch-yellow';
                          } else if (weekData.accuracy >= 20) {
                            bgColor = 'bg-orange-100 text-orange-950 border-orange-400';
                            sketchClass = 'sketch-crosshatch-red opacity-80';
                          } else {
                            bgColor = 'bg-red-100 text-red-900 border-lecture-red/40 font-semibold';
                            sketchClass = 'sketch-crosshatch-red';
                          }
                        }
                        
                        const cleanedWeekName = formatDisplayName(weekData.week);
                        
                        return (
                          <div 
                            key={weekData.week} 
                            className={`flex flex-col items-center justify-center p-3 rounded-md min-w-[90px] text-center border relative overflow-hidden shadow-sm transition-all duration-200 ${bgColor} ${sketchClass}`}
                            title={`${cleanedWeekName}: ${weekData.accuracy}% accuracy (${weekData.total} questions)`}
                          >
                            <span className="text-[10px] font-semibold uppercase tracking-wider opacity-85 mb-1 break-words max-w-full" title={cleanedWeekName}>
                              {cleanedWeekName}
                            </span>
                            <span className="text-lg font-bold">{weekData.total > 0 ? `${weekData.accuracy}%` : '-'}</span>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center text-muted-foreground py-8">Not enough data to display heatmap.</div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
