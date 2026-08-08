'use client'

import { useEffect, useState } from 'react'
import { getAnalyticsData } from '@/app/actions'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
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
  const [selectedWeekKey, setSelectedWeekKey] = useState<string | null>(null)

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
                {data.heatmapData.map((courseData: any) => {
                  // Find the selected week within this specific course, if any is active
                  const activeWeekData = courseData.weeks.find((w: any) => `${courseData.course}_${w.week}` === selectedWeekKey);

                  return (
                    <div key={courseData.course} className="border border-charcoal-graphite/10 rounded-md p-4 bg-background shadow-sm">
                      <h3 className="font-display italic text-lg font-bold mb-3 text-charcoal-graphite">{courseData.course}</h3>
                      <div className="flex flex-wrap gap-2 mb-2">
                        {courseData.weeks.sort((a: any, b: any) => a.week.localeCompare(b.week)).map((weekData: any) => {
                          const groupKey = `${courseData.course}_${weekData.week}`;
                          const isSelected = selectedWeekKey === groupKey;

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
                            <button 
                              key={weekData.week} 
                              onClick={() => setSelectedWeekKey(isSelected ? null : groupKey)}
                              disabled={weekData.total === 0}
                              className={`flex flex-col items-center justify-center p-3 rounded-md min-w-[90px] text-center border relative overflow-hidden shadow-sm transition-all duration-200 select-none ${
                                weekData.total > 0 ? 'cursor-pointer hover:scale-[1.03] active:scale-[0.98]' : 'cursor-not-allowed opacity-60'
                              } ${bgColor} ${sketchClass} ${
                                isSelected ? 'ring-2 ring-fountain-ink border-transparent shadow-md scale-[1.02]' : ''
                              }`}
                              title={weekData.total > 0 ? `${cleanedWeekName}: ${weekData.accuracy}% accuracy (${weekData.total} questions) - Click for details` : `${cleanedWeekName}: No answers logged`}
                            >
                              <span className="text-[10px] font-semibold uppercase tracking-wider opacity-85 mb-1 break-words max-w-full" title={cleanedWeekName}>
                                {cleanedWeekName}
                              </span>
                              <span className="text-lg font-bold">{weekData.total > 0 ? `${weekData.accuracy}%` : '-'}</span>
                            </button>
                          )
                        })}
                      </div>

                      {/* Week detailed breakdown container */}
                      {activeWeekData && activeWeekData.classes && activeWeekData.classes.length > 0 && (
                        <div className="mt-4 border-2 border-dashed border-charcoal-graphite/15 rounded-md p-5 bg-card shadow-sm font-sans text-charcoal-graphite animate-in fade-in slide-in-from-top-2 duration-300">
                          <div className="flex justify-between items-center mb-4 border-b border-charcoal-graphite/10 pb-2">
                            <h4 className="font-display italic text-base font-bold text-fountain-ink">
                              {formatDisplayName(activeWeekData.week)} — Lesson Accuracy Details
                            </h4>
                            <Button 
                              variant="ghost" 
                              size="sm" 
                              onClick={() => setSelectedWeekKey(null)}
                              className="h-7 px-2 text-xs text-charcoal-graphite/50 hover:text-lecture-red hover:bg-lecture-red/10"
                            >
                              Close Details
                            </Button>
                          </div>
                          
                          <div className="space-y-4">
                            {activeWeekData.classes.map((cl: any, idx: number) => (
                              <div key={idx} className="space-y-2 border-b border-charcoal-graphite/5 pb-3 last:border-b-0 last:pb-0">
                                <div className="flex justify-between items-center text-sm font-semibold text-charcoal-graphite">
                                  <span className="font-display italic text-charcoal-graphite/90">{cl.className}</span>
                                  <span className={`px-2 py-0.5 rounded-sm font-bold text-xs border ${
                                    cl.accuracy >= 80 ? 'bg-green-50 text-green-800 border-green-300' :
                                    cl.accuracy >= 50 ? 'bg-yellow-50 text-yellow-800 border-yellow-300' :
                                    'bg-red-50 text-red-800 border-lecture-red/30'
                                  }`}>{cl.accuracy}% ({cl.correct}/{cl.total} correct)</span>
                                </div>
                                
                                <div className="pl-4 border-l-2 border-charcoal-graphite/10 space-y-1.5 pt-1">
                                  {cl.subtopics.map((sub: any, sIdx: number) => (
                                    <div key={sIdx} className="flex justify-between items-center text-xs text-charcoal-graphite/75 py-0.5">
                                      <span>{sub.unit ? `Unit ${sub.unit}: ` : ''}{sub.title}</span>
                                      <span className="font-medium text-charcoal-graphite/90 bg-muted/30 px-1.5 py-0.5 rounded border border-charcoal-graphite/5">{sub.accuracy}% ({sub.correct}/{sub.total})</span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
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
