'use client'

import { useState, useMemo } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { Sliders, Sparkles, TrendingUp } from 'lucide-react'

interface TopicEvolutionChartProps {
  evolutionData: {
    courseData: any[];
    weekData: any[];
    topicData: any[];
    courseCoverageData?: any[];
    weekCoverageData?: any[];
    topicCoverageData?: any[];
  }
}

export function TopicEvolutionChart({ evolutionData }: TopicEvolutionChartProps) {
  const [granularity, setGranularity] = useState<'course' | 'week' | 'topic'>('course')
  const [metric, setMetric] = useState<'accuracy' | 'coverage' | 'combined'>('combined')
  
  // Track checked lines per granularity level to prevent spaghetti clutter
  const [checkedCourses, setCheckedCourses] = useState<Record<string, boolean>>({})
  const [checkedWeeks, setCheckedWeeks] = useState<Record<string, boolean>>({})
  const [checkedTopics, setCheckedTopics] = useState<Record<string, boolean>>({})

  // Resolve datasets based on selected granularity and metric
  const { currentDataset, checkedMap, setCheckedMap, allBaseKeys } = useMemo(() => {
    let accuracyData: any[] = [];
    let coverageData: any[] = [];
    let map: Record<string, boolean> = {};
    let setMap: React.Dispatch<React.SetStateAction<Record<string, boolean>>> = () => {};

    if (granularity === 'course') {
      accuracyData = evolutionData.courseData || [];
      coverageData = evolutionData.courseCoverageData || [];
      map = checkedCourses;
      setMap = setCheckedCourses;
    } else if (granularity === 'week') {
      accuracyData = evolutionData.weekData || [];
      coverageData = evolutionData.weekCoverageData || [];
      map = checkedWeeks;
      setMap = setCheckedWeeks;
    } else {
      accuracyData = evolutionData.topicData || [];
      coverageData = evolutionData.topicCoverageData || [];
      map = checkedTopics;
      setMap = setCheckedTopics;
    }

    // Determine target dataset
    let dataset: any[] = [];
    if (metric === 'accuracy') {
      dataset = accuracyData;
    } else if (metric === 'coverage') {
      dataset = coverageData;
    } else {
      // Merge accuracy and coverage chronologically
      const dateMap: Record<string, any> = {};
      accuracyData.forEach(row => {
        const d = row.date;
        if (!dateMap[d]) dateMap[d] = { date: d };
        Object.entries(row).forEach(([key, val]) => {
          if (key !== 'date') {
            dateMap[d][`${key} (Accuracy)`] = val;
          }
        });
      });
      coverageData.forEach(row => {
        const d = row.date;
        if (!dateMap[d]) dateMap[d] = { date: d };
        Object.entries(row).forEach(([key, val]) => {
          if (key !== 'date') {
            dateMap[d][`${key} (Coverage)`] = val;
          }
        });
      });
      dataset = Object.values(dateMap).sort((a: any, b: any) => a.date.localeCompare(b.date));
    }

    // Extract unique base keys
    const baseKeysSet = new Set<string>();
    accuracyData.forEach(row => {
      Object.keys(row).forEach(key => {
        if (key !== 'date') baseKeysSet.add(key);
      });
    });
    const finalBaseKeys = Array.from(baseKeysSet);

    // Initialize map if it's completely empty (pre-check first 3 lines by default)
    if (Object.keys(map).length === 0 && finalBaseKeys.length > 0) {
      const initialMap: Record<string, boolean> = {};
      finalBaseKeys.forEach((key, idx) => {
        initialMap[key] = idx < 3; // Pre-check first 3 lines to keep the graph beautifully clear
      });
      // Fire state update safely inside microtask to avoid react render warnings
      setTimeout(() => {
        setMap(initialMap);
      }, 0);
      map = initialMap;
    }

    return { 
      currentDataset: dataset, 
      checkedMap: map, 
      setCheckedMap: setMap,
      allBaseKeys: finalBaseKeys 
    };
  }, [granularity, metric, evolutionData, checkedCourses, checkedWeeks, checkedTopics]);

  // Extract checked line keys
  const activeBaseKeys = useMemo(() => {
    return Object.entries(checkedMap)
      .filter(([_, checked]) => checked)
      .map(([key]) => key);
  }, [checkedMap]);

  const allAvailableKeys = useMemo(() => {
    return Object.keys(checkedMap);
  }, [checkedMap]);

  // Beautiful custom color palette for different lines
  const colors = [
    '#3B6D9A', // Fountain Ink (Blue)
    '#C13D30', // Lecture Red
    '#D99B26', // Bongo Gold
    '#2F855A', // Emerald
    '#7B341E', // Dark Terracotta
    '#553C9A', // Royal Purple
    '#319795', // Teal
    '#D53F8C', // Magenta
  ];

  return (
    <Card className="col-span-full border border-charcoal-graphite/10 shadow-md bg-card text-charcoal-graphite font-sans">
      <CardHeader className="border-b border-charcoal-graphite/5 pb-4 mb-4 flex flex-col xl:flex-row xl:items-center justify-between gap-4">
        <div className="space-y-1">
          <CardTitle className="font-display italic text-lg font-bold text-charcoal-graphite flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-lecture-red" />
            Performance Evolution Timeline
          </CardTitle>
          <CardDescription className="text-charcoal-graphite/60 font-sans text-xs">
            {metric === 'combined'
              ? "Simultaneously trace your cumulative accuracy (solid lines) and syllabus coverage (dashed lines) over time."
              : metric === 'accuracy'
              ? "Trace your learning curve and cumulative accuracy score progress over time."
              : "Trace your absolute syllabus coverage and unique questions completed progress over time."
            }
          </CardDescription>
        </div>

        {/* Toggles Container */}
        <div className="flex flex-col sm:flex-row flex-wrap items-stretch sm:items-center gap-3 w-full xl:w-auto xl:justify-end xl:self-center shrink-0">
          {/* Metric Select Toggles */}
          <div className="flex bg-muted p-1 rounded-lg border border-charcoal-graphite/10 shadow-inner gap-1 w-full sm:w-auto justify-between sm:justify-start">
            <button
              type="button"
              onClick={() => setMetric('combined')}
              className={`flex-1 sm:flex-initial text-[10px] sm:text-xs px-2.5 py-1.5 rounded-md font-semibold transition-all duration-150 shrink-0 ${
                metric === 'combined' 
                  ? 'bg-background text-charcoal-graphite shadow-sm border border-charcoal-graphite/5' 
                  : 'text-charcoal-graphite/60 hover:text-charcoal-graphite'
              }`}
            >
              💫 Combined
            </button>
            <button
              type="button"
              onClick={() => setMetric('accuracy')}
              className={`flex-1 sm:flex-initial text-[10px] sm:text-xs px-2.5 py-1.5 rounded-md font-semibold transition-all duration-150 shrink-0 ${
                metric === 'accuracy' 
                  ? 'bg-background text-charcoal-graphite shadow-sm border border-charcoal-graphite/5' 
                  : 'text-charcoal-graphite/60 hover:text-charcoal-graphite'
              }`}
            >
              🎯 Accuracy
            </button>
            <button
              type="button"
              onClick={() => setMetric('coverage')}
              className={`flex-1 sm:flex-initial text-[10px] sm:text-xs px-2.5 py-1.5 rounded-md font-semibold transition-all duration-150 shrink-0 ${
                metric === 'coverage' 
                  ? 'bg-background text-charcoal-graphite shadow-sm border border-charcoal-graphite/5' 
                  : 'text-charcoal-graphite/60 hover:text-charcoal-graphite'
              }`}
            >
              📈 Coverage
            </button>
          </div>

          {/* Granularity Select Toggles */}
          <div className="flex bg-muted p-1 rounded-lg border border-charcoal-graphite/10 shadow-inner gap-1 w-full sm:w-auto justify-between sm:justify-start">
            <button
              type="button"
              onClick={() => setGranularity('course')}
              className={`flex-1 sm:flex-initial text-[10px] sm:text-xs px-2.5 py-1.5 rounded-md font-semibold transition-all duration-150 shrink-0 ${
                granularity === 'course' 
                  ? 'bg-background text-charcoal-graphite shadow-sm border border-charcoal-graphite/5' 
                  : 'text-charcoal-graphite/60 hover:text-charcoal-graphite'
              }`}
            >
              🏫 Course
            </button>
            <button
              type="button"
              onClick={() => setGranularity('week')}
              className={`flex-1 sm:flex-initial text-[10px] sm:text-xs px-2.5 py-1.5 rounded-md font-semibold transition-all duration-150 shrink-0 ${
                granularity === 'week' 
                  ? 'bg-background text-charcoal-graphite shadow-sm border border-charcoal-graphite/5' 
                  : 'text-charcoal-graphite/60 hover:text-charcoal-graphite'
              }`}
            >
              📅 Week
            </button>
            <button
              type="button"
              onClick={() => setGranularity('topic')}
              className={`flex-1 sm:flex-initial text-[10px] sm:text-xs px-2.5 py-1.5 rounded-md font-semibold transition-all duration-150 shrink-0 ${
                granularity === 'topic' 
                  ? 'bg-background text-charcoal-graphite shadow-sm border border-charcoal-graphite/5' 
                  : 'text-charcoal-graphite/60 hover:text-charcoal-graphite'
              }`}
            >
              📖 Topic
            </button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="grid grid-cols-1 xl:grid-cols-4 gap-6 p-6 pt-2">
        {currentDataset.length === 0 ? (
          <div className="col-span-full py-16 text-center text-muted-foreground italic text-sm">
            Complete some practice or timed exam sessions to generate your chronological performance evolution chart!
          </div>
        ) : (
          <>
            {/* Chart Area (3 Columns on Desktop) */}
            <div className="xl:col-span-3 h-[320px] w-full min-w-0">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={currentDataset} margin={{ top: 20, right: 20, bottom: 20, left: -20 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis 
                    dataKey="date" 
                    tick={{ fontSize: 11, fill: 'var(--charcoal-graphite, #2C2E33)', opacity: 0.7 }} 
                  />
                  <YAxis 
                    domain={[0, 100]} 
                    tick={{ fontSize: 10, fill: 'var(--charcoal-graphite, #2C2E33)', opacity: 0.7 }} 
                    unit="%"
                  />
                  <Tooltip 
                    contentStyle={{ 
                      backgroundColor: 'var(--card, #FFFFFF)', 
                      borderColor: 'rgba(44, 46, 51, 0.15)',
                      color: 'var(--charcoal-graphite, #2C2E33)',
                      fontSize: 11,
                      fontFamily: 'sans-serif',
                      borderRadius: '8px',
                      boxShadow: '0 4px 12px rgba(0,0,0,0.05)'
                    }}
                  />
                  {activeBaseKeys.flatMap((baseKey, idx) => {
                    const color = colors[idx % colors.length];
                    const lines = [];
                    const renderAccuracy = metric === 'accuracy' || metric === 'combined';
                    const renderCoverage = metric === 'coverage' || metric === 'combined';

                    if (renderAccuracy) {
                      lines.push(
                        <Line
                          key={`${baseKey}-accuracy`}
                          type="monotone"
                          dataKey={metric === 'combined' ? `${baseKey} (Accuracy)` : baseKey}
                          name={metric === 'combined' ? `${baseKey} (Accuracy)` : baseKey}
                          stroke={color}
                          strokeWidth={3}
                          activeDot={{ r: 6 }}
                          dot={{ r: 4, strokeWidth: 1 }}
                          connectNulls
                        />
                      );
                    }
                    if (renderCoverage) {
                      lines.push(
                        <Line
                          key={`${baseKey}-coverage`}
                          type="monotone"
                          dataKey={metric === 'combined' ? `${baseKey} (Coverage)` : baseKey}
                          name={metric === 'combined' ? `${baseKey} (Coverage)` : baseKey}
                          stroke={color}
                          strokeWidth={metric === 'combined' ? 2 : 3}
                          strokeDasharray={metric === 'combined' ? "5 5" : undefined}
                          activeDot={{ r: 5 }}
                          dot={{ r: 3, strokeWidth: 1 }}
                          connectNulls
                        />
                      );
                    }
                    return lines;
                  })}
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* Checkboxes Legend Panel (1 Column on Desktop) */}
            <div className="xl:col-span-1 border border-charcoal-graphite/10 rounded-xl p-4 bg-muted/10 flex flex-col h-[320px]">
              <div className="flex justify-between items-center text-[10px] font-bold text-charcoal-graphite/60 uppercase tracking-wider pb-2 border-b border-charcoal-graphite/10 mb-2 shrink-0">
                <span className="flex items-center gap-1.5"><Sliders className="w-3.5 h-3.5 text-fountain-ink" /> Filters</span>
                <span>{activeBaseKeys.length} of {allAvailableKeys.length} Lines</span>
              </div>

              <div className="flex-1 overflow-y-auto pr-1.5 custom-scrollbar min-h-0">
                <div className="space-y-2.5 pb-2">
                  {allAvailableKeys.map((key, idx) => {
                    const isChecked = !!checkedMap[key];
                    const color = colors[idx % colors.length];
                    return (
                      <div key={key} className="flex items-start space-x-2.5 bg-background p-2.5 rounded-lg border border-charcoal-graphite/5 hover:bg-background/80 transition-colors shadow-xs">
                        <Checkbox
                          id={`line-check-${idx}`}
                          checked={isChecked}
                          onCheckedChange={(c) => {
                            setCheckedMap(prev => ({
                              ...prev,
                              [key]: !!c
                            }));
                          }}
                          className="mt-0.5"
                          style={{
                            borderColor: color,
                            backgroundColor: isChecked ? color : 'transparent',
                          }}
                        />
                        <div className="flex-1 min-w-0">
                          <label 
                            htmlFor={`line-check-${idx}`} 
                            className="text-[11px] font-semibold text-charcoal-graphite cursor-pointer block leading-normal truncate"
                            title={key}
                          >
                            {key}
                          </label>
                          <div className="flex gap-1.5 mt-1.5 flex-wrap">
                            {(metric === 'accuracy' || metric === 'combined') && (
                              <span 
                                className="text-[8px] font-extrabold px-1.5 py-0.5 rounded-sm bg-black/5"
                                style={{ color }}
                              >
                                ━ Accuracy
                              </span>
                            )}
                            {(metric === 'coverage' || metric === 'combined') && (
                              <span 
                                className="text-[8px] font-extrabold px-1.5 py-0.5 rounded-sm bg-black/5"
                                style={{ color }}
                              >
                                ╌╌ Coverage
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {allAvailableKeys.length === 0 && (
                    <div className="text-[11px] text-muted-foreground italic text-center py-8">
                      No logs recorded for this view.
                    </div>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
