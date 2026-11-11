'use client'

import { useEffect, useState } from 'react'
import { getAnalyticsData, generateExamDiagnosis, generateGlobalDiagnosis } from '@/app/actions'
import { AnalyticsMetrics } from './analytics/AnalyticsMetrics'
import { ActivityChart } from './analytics/ActivityChart'
import { AccuracyHeatmap } from './analytics/AccuracyHeatmap'
import { TopicEvolutionChart } from './analytics/TopicEvolutionChart'
import { Button } from '@/components/ui/button'
import { formatScore } from '@/lib/grading'
import { Loader2, Sparkles, AlertCircle } from 'lucide-react'
import { LocalDate } from './LocalDate'
import { DiagnosisMarkdown, type ViewFile } from './DiagnosisMarkdown'

function ExamItem({ exam, onViewFile }: { exam: any; onViewFile?: ViewFile }) {
  const [isGenerating, setIsGenerating] = useState(false)
  const [examDiagnosis, setExamDiagnosis] = useState(exam.diagnosis)
  const [isExpanded, setIsExpanded] = useState(false)

  const handleGenerate = async () => {
    setIsGenerating(true)
    try {
      const markdown = await generateExamDiagnosis(exam.id)
      if (markdown) {
        setExamDiagnosis(markdown)
        setIsExpanded(true)
      }
    } catch (e) {
      console.error(e)
    }
    setIsGenerating(false)
  }

  return (
    <div className="border border-charcoal-graphite/10 rounded-lg p-4 bg-background/50 space-y-3 font-sans">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3">
        <div className="space-y-0.5">
          <h4 className="font-semibold text-sm sm:text-base text-charcoal-graphite">{exam.title}</h4>
          <p className="text-xs text-muted-foreground">
            Completed on <LocalDate value={exam.startTime} /> • {exam.totalQuestions} Questions
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="px-3 py-1 bg-fountain-ink/10 rounded-md border border-fountain-ink/20">
            <span className="text-xs sm:text-sm font-bold text-fountain-ink">{formatScore(exam.scoreSum ?? exam.correctQuestions)}/{exam.totalQuestions} ({exam.accuracy}%)</span>
          </div>

          {examDiagnosis ? (
            <Button 
              type="button"
              variant="outline" 
              size="sm"
              onClick={() => setIsExpanded(!isExpanded)}
              className="text-xs font-semibold h-8 rounded-lg"
            >
              {isExpanded ? "Hide Diagnosis" : "View Diagnosis"}
            </Button>
          ) : (
            <Button 
              type="button"
              size="sm"
              onClick={handleGenerate}
              disabled={isGenerating}
              className="text-xs font-semibold h-8 bg-lecture-red hover:bg-lecture-red/90 text-white border-0 rounded-lg"
            >
              {isGenerating ? "Analyzing..." : "Generate Diagnosis"}
            </Button>
          )}
        </div>
      </div>

      {isExpanded && examDiagnosis && (
        <div className="mt-4 pt-4 border-t border-dashed border-charcoal-graphite/10 prose dark:prose-invert max-w-none text-xs sm:text-sm leading-relaxed text-charcoal-graphite/85">
          <DiagnosisMarkdown text={examDiagnosis} onViewFile={onViewFile} />
        </div>
      )}
    </div>
  )
}

/** Dashboard of one studyspace: every number, chart, exam and the diagnosis cover only `courseId`. */
export function AnalyticsDashboard({ courseId, onViewFile }: { courseId: string; onViewFile?: ViewFile }) {
  const [data, setData] = useState<any>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [globalDiagnosisText, setGlobalDiagnosisText] = useState<string | null>(null)
  const [isGeneratingGlobal, setIsGeneratingGlobal] = useState(false)
  const [isGlobalExpanded, setIsGlobalExpanded] = useState(true)

  useEffect(() => {
    getAnalyticsData(courseId).then((res) => {
      setData(res)
      if (res?.globalDiagnosis) {
        setGlobalDiagnosisText(res.globalDiagnosis)
      }
      setIsLoading(false)
    })
  }, [courseId])

  const handleGenerateGlobal = async () => {
    setIsGeneratingGlobal(true)
    try {
      const markdown = await generateGlobalDiagnosis(courseId)
      if (markdown) {
        setGlobalDiagnosisText(markdown)
        setIsGlobalExpanded(true)
      }
    } catch (e) {
      console.error(e)
    }
    setIsGeneratingGlobal(false)
  }

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

      {/* 2. Personalized Global AI Learning Diagnosis Section */}
      <div className="mt-8 mb-8 bg-card p-6 rounded-xl border border-charcoal-graphite/10 shadow-md space-y-4">
        <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-4">
          <div className="space-y-1">
            <h2 className="text-xl font-bold font-display italic text-charcoal-graphite flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-bongo-gold fill-bongo-gold animate-pulse" />
              AI Learning Diagnosis
            </h2>
            <p className="text-xs sm:text-sm text-muted-foreground">
              A comprehensive analysis of your performance across all study and exam sessions in this studyspace, cross-referenced with its material.
            </p>
          </div>

          {globalDiagnosisText && (
            <Button
              type="button"
              onClick={handleGenerateGlobal}
              disabled={isGeneratingGlobal}
              className="text-xs font-semibold h-9 px-4 rounded-lg bg-lecture-red hover:bg-lecture-red/90 text-white border-0 shrink-0"
            >
              {isGeneratingGlobal ? (
                <><Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" /> Analyzing...</>
              ) : (
                'Regenerate Diagnosis'
              )}
            </Button>
          )}
        </div>

        {isGeneratingGlobal && !globalDiagnosisText && (
          <div className="py-12 flex flex-col items-center justify-center text-center gap-4 bg-background/50 rounded-lg border border-dashed border-charcoal-graphite/20">
            <Loader2 className="w-10 h-10 text-lecture-red animate-spin" />
            <div className="space-y-1 max-w-sm">
              <h4 className="font-bold text-sm">Professor Grading In Progress</h4>
              <p className="text-xs text-muted-foreground">
                Analyzing all of your study session logs, grading history, and cross-referencing your weak areas with lecture transcriptions. This takes 5-15 seconds.
              </p>
            </div>
          </div>
        )}

        {!isGeneratingGlobal && !globalDiagnosisText && (
          <div className="py-8 flex flex-col items-center justify-center text-center gap-4 bg-background/30 rounded-lg border border-dashed border-charcoal-graphite/10">
            <AlertCircle className="w-8 h-8 text-fountain-ink" />
            <div className="space-y-3 max-w-sm">
              <p className="text-xs sm:text-sm text-muted-foreground">
                You have not generated a learning diagnosis for this studyspace yet. Click the button below to analyze your performance here!
              </p>
              <Button
                type="button"
                onClick={handleGenerateGlobal}
                className="text-xs font-semibold bg-lecture-red hover:bg-lecture-red/90 text-white border-0 rounded-lg h-9 px-4"
              >
                Generate AI Diagnosis & Study Guide
              </Button>
            </div>
          </div>
        )}

        {globalDiagnosisText && (
          <div className="space-y-4">
            <div className="flex justify-end">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setIsGlobalExpanded(!isGlobalExpanded)}
                className="text-xs font-semibold text-fountain-ink hover:bg-fountain-ink/10"
              >
                {isGlobalExpanded ? "Collapse Diagnosis" : "Expand Diagnosis"}
              </Button>
            </div>

            {isGlobalExpanded && (
              <div className="p-5 rounded-lg border border-charcoal-graphite/10 bg-background/40 prose dark:prose-invert max-w-none text-xs sm:text-sm leading-relaxed text-charcoal-graphite/85 max-h-[500px] overflow-y-auto scrollbar-thin">
                {isGeneratingGlobal && (
                  <div className="absolute inset-0 bg-background/60 z-10 flex items-center justify-center">
                    <Loader2 className="w-8 h-8 text-lecture-red animate-spin" />
                  </div>
                )}
                <DiagnosisMarkdown text={globalDiagnosisText} onViewFile={onViewFile} />
              </div>
            )}
          </div>
        )}
      </div>

      {/* 3. Performance Evolution Curve Timeline (Hierarchical Macro-to-Micro) */}
      {data.evolutionData && (
        <div className="mt-8 mb-8">
          <TopicEvolutionChart evolutionData={data.evolutionData} />
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* 3. Middle Row: Recharts Activity chart (no per-course chart: a studyspace is one course) */}
        <ActivityChart activityData={data.activityChartData} />

        {/* 4. Bottom Row: Module Accuracy Heatmap Drilldown Box */}
        <AccuracyHeatmap heatmapData={data.heatmapData} />
      </div>

      {/* 5. Past Exams Diagnostics & Professor Study Plans */}
      <div className="mt-8 bg-card p-6 rounded-xl border border-charcoal-graphite/10 shadow-sm space-y-6">
        <div>
          <h2 className="text-xl font-bold font-display italic text-charcoal-graphite">Exam Diagnostics & Professor Study Plans</h2>
          <p className="text-xs sm:text-sm text-muted-foreground mt-1">Review deep socratic analysis and custom syllabi compiled for your completed mock exams.</p>
        </div>

        {data.completedExams && data.completedExams.length > 0 ? (
          <div className="space-y-4">
            {data.completedExams.map((exam: any) => (
              <ExamItem key={exam.id} exam={exam} onViewFile={onViewFile} />
            ))}
          </div>
        ) : (
          <div className="text-center py-8 text-muted-foreground italic text-xs sm:text-sm">
            You have not completed any timed exams yet. Configure a session as a "Timed Exam" to generate your first diagnostic study plan!
          </div>
        )}
      </div>
    </div>
  )
}
