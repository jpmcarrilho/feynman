'use client'

import { useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

const formatDisplayName = (name: string | null | undefined): string => {
  if (!name) return '';
  return name
    .replace(/_+/g, ' ')
    .trim();
}

interface AccuracyHeatmapProps {
  heatmapData: {
    course: string
    weeks: {
      week: string
      accuracy: number
      total: number
      classes: {
        className: string
        accuracy: number
        total: number
        correct: number
        subtopics: {
          unit: string
          title: string
          accuracy: number
          total: number
          correct: number
        }[]
      }[]
    }[]
  }[]
}

export function AccuracyHeatmap({ heatmapData }: AccuracyHeatmapProps) {
  const [selectedWeekKey, setSelectedWeekKey] = useState<string | null>(null)

  return (
    <Card className="col-span-1 lg:col-span-2 border border-charcoal-graphite/10 shadow-sm bg-card text-charcoal-graphite">
      <CardHeader className="border-b border-charcoal-graphite/5 pb-4 mb-4">
        <CardTitle className="font-display italic text-lg font-bold text-charcoal-graphite">Module Accuracy Heatmap</CardTitle>
        <CardDescription className="text-charcoal-graphite/60 font-sans text-xs">Visualizing performance across weeks and courses (Click a card for breakdown)</CardDescription>
      </CardHeader>
      <CardContent>
        {heatmapData && heatmapData.length > 0 ? (
          <div className="space-y-6">
            {heatmapData.map((courseData) => {
              // Find the selected week within this specific course, if any is active
              const activeWeekData = courseData.weeks.find((w) => `${courseData.course}_${w.week}` === selectedWeekKey)

              return (
                <div key={courseData.course} className="border border-charcoal-graphite/10 rounded-md p-4 bg-background shadow-sm">
                  <h3 className="font-display italic text-lg font-bold mb-3 text-charcoal-graphite">{courseData.course}</h3>
                  <div className="flex flex-wrap gap-2 mb-2">
                    {courseData.weeks.sort((a, b) => a.week.localeCompare(b.week)).map((weekData) => {
                      const groupKey = `${courseData.course}_${weekData.week}`
                      const isSelected = selectedWeekKey === groupKey

                      let bgColor = 'bg-muted/40 text-charcoal-graphite/40 border-charcoal-graphite/10' // Default low/no data
                      let sketchClass = ''
                      if (weekData.total > 0) {
                        if (weekData.accuracy >= 80) {
                          bgColor = 'bg-green-100 text-green-900 border-green-400 font-semibold'
                          sketchClass = 'sketch-crosshatch-green'
                        } else if (weekData.accuracy >= 60) {
                          bgColor = 'bg-green-50 text-green-800 border-green-300'
                          sketchClass = 'sketch-crosshatch-green opacity-90'
                        } else if (weekData.accuracy >= 40) {
                          bgColor = 'bg-yellow-100 text-yellow-900 border-yellow-400 font-semibold'
                          sketchClass = 'sketch-crosshatch-yellow'
                        } else if (weekData.accuracy >= 20) {
                          bgColor = 'bg-orange-100 text-orange-950 border-orange-400'
                          sketchClass = 'sketch-crosshatch-red opacity-80'
                        } else {
                          bgColor = 'bg-red-100 text-red-900 border-lecture-red/40 font-semibold'
                          sketchClass = 'sketch-crosshatch-red'
                        }
                      }
                      
                      const cleanedWeekName = formatDisplayName(weekData.week)
                      
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
                        {activeWeekData.classes.map((cl, idx) => (
                          <div key={idx} className="space-y-2 border-b border-charcoal-graphite/5 pb-3 last:border-b-0 last:pb-0">
                            <div className="flex justify-between items-center text-sm font-semibold text-charcoal-graphite">
                              <span className="font-display italic text-charcoal-graphite/90">{cl.className}</span>
                              <span className={`px-2 py-0.5 rounded-sm font-bold text-xs border ${
                                cl.accuracy >= 80 ? 'bg-green-50 text-green-800 border-green-300' :
                                cl.accuracy >= 50 ? 'bg-yellow-50 text-yellow-800 border-yellow-300' :
                                'bg-red-50 text-red-800 border-lecture-red/30'
                              }`}>{cl.accuracy}% ({cl.correct}/{cl.total} score)</span>
                            </div>
                            
                            <div className="pl-4 border-l-2 border-charcoal-graphite/10 space-y-1.5 pt-1">
                              {cl.subtopics.map((sub, sIdx) => (
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
              )
            })}
          </div>
        ) : (
          <div className="text-center text-muted-foreground py-8">Not enough data to display heatmap.</div>
        )}
      </CardContent>
    </Card>
  )
}
