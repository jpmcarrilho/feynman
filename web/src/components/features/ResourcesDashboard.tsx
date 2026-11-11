'use client'

import { useEffect, useState } from 'react'
import { getCourseArtifacts, generateWeekSummaryAction } from '@/app/actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { 
  Loader2, 
  Sparkles, 
  BookOpen, 
  FileText, 
  Search, 
  ArrowRight, 
  Play, 
  HelpCircle,
  Clock,
  CheckCircle,
  FileCode,
  Award,
  Upload
} from 'lucide-react'

import { studyGuideBlurb } from '@/lib/studyspace/studyGuide'
import { AddFilesPanel } from './spaces/AddFilesPanel'

// Simple helper to prettify/format week and titles
const formatDisplayName = (name: string | null | undefined): string => {
  if (!name) return '';
  return name
    .replace(/_+/g, ' ')
    .trim();
}

interface ResourcesDashboardProps {
  /** The studyspace whose materials are listed. */
  courseId: string;
  onViewFile: (href: string, title?: string) => void;
  onStartWeekSession: (topicIds: string[], weekName: string) => void;
  /** True while a session is being created: the practice buttons are disabled so a second click cannot start another. */
  startingSession?: boolean;
  /** Subject of the studyspace's tutor profile, named in the study guide blurb. */
  subject?: string | null;
  /** Shows "Add files" in the header (uploads that are processed in the background; new topics appear here when a file is ready). */
  allowAddFiles?: boolean;
  /** A file was uploaded or became ready (the page may get a tutor-update suggestion). */
  onFilesActivity?: () => void;
}

export function ResourcesDashboard({ courseId, onViewFile, onStartWeekSession, startingSession = false, subject = null, allowAddFiles = false, onFilesActivity }: ResourcesDashboardProps) {
  const [courses, setCourses] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [activeCourseCode, setActiveCourseCode] = useState<string>('')
  const [searchText, setSearchText] = useState('')
  const [generatingWeek, setGeneratingWeek] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  // Bumped when a file added later is ready: the list is read again in place (no loading screen, so the open panel stays)
  const [reloadKey, setReloadKey] = useState(0)

  // Load initial data
  useEffect(() => {
    let cancelled = false
    getCourseArtifacts(courseId).then((data) => {
      if (cancelled) return
      setCourses(data)
      setActiveCourseCode((current) => (data.some((c: { courseCode: string }) => c.courseCode === current) ? current : data[0]?.courseCode ?? ''))
      setLoading(false)
    }).catch(err => {
      console.error("Failed to load course artifacts:", err)
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [courseId, reloadKey])

  // Find currently active course
  const activeCourse = courses.find(c => c.courseCode === activeCourseCode)

  // Filter weeks by search text
  const filteredWeeks = activeCourse?.weeks.filter((week: any) => {
    const term = searchText.toLowerCase()
    const matchName = week.weekName.toLowerCase().includes(term)
    const matchSlides = week.slides.some((s: any) => s.title.toLowerCase().includes(term))
    const matchTranscripts = week.transcriptions.some((t: any) => t.title.toLowerCase().includes(term))
    return matchName || matchSlides || matchTranscripts
  }) || []

  // Handler for opening files in side-visualizer
  const handleOpenFile = (link: string | null, title: string) => {
    if (!link) return
    // link is an /api/files/... URL built by the server (topic id or summary key)
    onViewFile(link, title)
  }

  // Handler for generating Feynman study guide summary on-demand
  const handleGenerateSummary = async (courseCode: string, weekName: string) => {
    const key = `${courseCode}_${weekName}`
    setGeneratingWeek(key)
    try {
      const result = await generateWeekSummaryAction(courseCode, weekName)
      if (result && result.link) {
        // Open the newly generated summary in visualizer
        handleOpenFile(result.link, "Feynman Study Guide: " + formatDisplayName(weekName))
        
        // Refresh local courses list to reflect summaryExists = true
        const updatedData = await getCourseArtifacts(courseId)
        setCourses(updatedData)
      }
    } catch (err) {
      console.error("Failed to generate Feynman study guide:", err)
      alert("Encountered an error while generating study guide. Please try again.")
    } finally {
      setGeneratingWeek(null)
    }
  }

  if (loading) {
    return (
      <div className="py-24 flex flex-col items-center justify-center text-center gap-4 bg-background h-full font-sans animate-pulse">
        <Loader2 className="w-12 h-12 text-lecture-red animate-spin" />
        <h4 className="font-bold text-lg font-display italic text-charcoal-graphite">Retrieving Course Materials & Study Guides...</h4>
        <p className="text-sm text-charcoal-graphite/60 max-w-xs">Organizing slides, transcriptions, and summaries per module</p>
      </div>
    )
  }

  if (courses.length === 0) {
    return (
      <div className="py-24 flex flex-col items-center justify-center text-center gap-4 bg-background h-full font-sans max-w-md mx-auto">
        <BookOpen className="w-12 h-12 text-charcoal-graphite/40" />
        <h4 className="font-bold text-lg font-display italic text-charcoal-graphite">No Resources Available</h4>
        <p className="text-sm text-charcoal-graphite/60">
          This studyspace has no material yet.
        </p>
      </div>
    )
  }

  return (
    <div className="w-full max-w-6xl mx-auto space-y-8 pb-16 font-sans">
      
      {/* 1. Header and Intro */}
      <div className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-2">
            <h1 className="text-3xl font-bold tracking-tight font-display italic text-charcoal-graphite">Resources</h1>
            <p className="text-sm text-charcoal-graphite/65 max-w-2xl">
              Explore and study all lecture materials, original slides, video lecture transcripts, reading notes, and AI-generated Feynman summaries of this studyspace, organized per module.
            </p>
          </div>
          {allowAddFiles && (
            <Button
              type="button"
              variant="outline"
              aria-expanded={addOpen}
              aria-controls="add-files-panel"
              onClick={() => setAddOpen((o) => !o)}
              className="h-10 shrink-0 gap-1.5 self-start px-4 font-semibold sm:h-9"
            >
              <Upload className="w-4 h-4" aria-hidden />
              Add files
            </Button>
          )}
        </div>
        {allowAddFiles && <AddFilesPanel courseId={courseId} open={addOpen} onTopicsChanged={() => setReloadKey((k) => k + 1)} onActivity={onFilesActivity} />}
      </div>

      {/* 2. Search and Course Select Filters */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-card p-4 rounded-xl border border-charcoal-graphite/10 shadow-sm">
        {/* Course Tabs (only when several courses are listed; a studyspace has one) */}
        <div className={`flex items-center gap-2 overflow-x-auto pb-1 md:pb-0 scrollbar-none ${courses.length > 1 ? '' : 'hidden'}`}>
          {courses.map((course) => (
            <button
              key={course.courseId}
              onClick={() => {
                setActiveCourseCode(course.courseCode)
                setSearchText('')
              }}
              className={`px-4 py-2 text-sm font-semibold rounded-lg transition-all duration-200 border shrink-0 ${
                activeCourseCode === course.courseCode
                  ? 'bg-sketchbook-cream border-charcoal-graphite text-charcoal-graphite shadow-sm'
                  : 'bg-background border-charcoal-graphite/10 text-charcoal-graphite/60 hover:bg-muted hover:text-charcoal-graphite'
              }`}
            >
              {course.courseCode} — {course.courseTitle}
            </button>
          ))}
        </div>

        {/* Search Input */}
        <div className="relative w-full md:max-w-xs shrink-0">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-charcoal-graphite/45" />
          <Input
            placeholder="Search slides, transcripts..."
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            className="pl-9 bg-background border-charcoal-graphite/10 text-charcoal-graphite font-sans focus-visible:ring-fountain-ink/40"
          />
        </div>
      </div>

      {/* 3. Weeks List Accordion / Timeline */}
      {filteredWeeks.length === 0 ? (
        <div className="text-center py-16 bg-card border border-charcoal-graphite/15 rounded-xl">
          <p className="text-sm text-charcoal-graphite/50">No modules or materials matching your search terms.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {filteredWeeks.map((week: any) => {
            const isWeekGenerating = generatingWeek === `${activeCourseCode}_${week.weekName}`
            
            return (
              <div 
                key={week.weekName}
                className="bg-card border border-charcoal-graphite/10 rounded-xl overflow-hidden shadow-sm transition-all duration-300 hover:shadow-md hover:border-charcoal-graphite/20"
              >
                {/* Week Header */}
                <div className="bg-muted/15 border-b border-charcoal-graphite/10 px-5 py-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div className="space-y-1">
                    <h3 className="font-display italic text-lg sm:text-xl font-bold text-charcoal-graphite">
                      {formatDisplayName(week.weekName)}
                    </h3>
                    <div className="flex flex-wrap items-center gap-2.5 text-xs text-charcoal-graphite/55">
                      <span className="flex items-center gap-1">
                        <FileText className="w-3.5 h-3.5" />
                        {week.slides.length} Slide Deck{week.slides.length !== 1 ? 's' : ''}
                      </span>
                      <span>•</span>
                      <span className="flex items-center gap-1">
                        <BookOpen className="w-3.5 h-3.5" />
                        {week.transcriptions.length} Transcription{week.transcriptions.length !== 1 ? 's' : ''}
                      </span>
                      <span>•</span>
                      <span className="flex items-center gap-1">
                        <HelpCircle className="w-3.5 h-3.5" />
                        {week.exercisesCount} Ingested Question{week.exercisesCount !== 1 ? 's' : ''}
                      </span>
                    </div>
                  </div>

                  {/* Actions (Start practice for this week) */}
                  {week.exercisesCount > 0 && (
                    <Button
                      onClick={() => onStartWeekSession(week.topicIds, week.weekName)}
                      disabled={startingSession}
                      size="sm"
                      className="bg-lecture-red hover:bg-lecture-red/90 text-white font-semibold text-xs rounded-lg shrink-0 flex items-center gap-1.5 shadow-sm animate-sketch-draw h-9"
                    >
                      <Play className="w-3.5 h-3.5 fill-current" />
                      <span>Practice This Module</span>
                    </Button>
                  )}
                </div>

                {/* Week Grid Content */}
                <div className="p-5 grid grid-cols-1 lg:grid-cols-3 gap-6">
                  
                  {/* Column 1: Feynman Study Guide (AI Summary) */}
                  <div className="space-y-3 flex flex-col h-full bg-muted/5 p-4 rounded-lg border border-charcoal-graphite/5">
                    <div className="flex items-center gap-2 text-bongo-gold">
                      <Sparkles className="w-4 h-4 fill-current" />
                      <h4 className="font-bold text-sm tracking-tight text-charcoal-graphite">Feynman Study Guide</h4>
                    </div>
                    <p className="text-xs text-charcoal-graphite/65 leading-relaxed flex-1">
                      {studyGuideBlurb(subject)}
                    </p>
                    
                    {week.summaryExists ? (
                      <Button
                        onClick={() => handleOpenFile(week.summaryLink, "Feynman Study Guide: " + formatDisplayName(week.weekName))}
                        variant="outline"
                        size="sm"
                        className="w-full text-xs font-semibold h-9 rounded-lg border-bongo-gold/40 text-bongo-gold bg-bongo-gold/5 hover:bg-bongo-gold/15 flex items-center justify-center gap-1.5 shadow-sm"
                      >
                        <BookOpen className="w-3.5 h-3.5" />
                        <span>Read Study Guide</span>
                      </Button>
                    ) : (
                      <Button
                        onClick={() => handleGenerateSummary(activeCourseCode, week.weekName)}
                        disabled={isWeekGenerating}
                        variant="outline"
                        size="sm"
                        className="w-full text-xs font-semibold h-9 rounded-lg border-bongo-gold/30 text-bongo-gold bg-background hover:bg-bongo-gold/5 flex items-center justify-center gap-1.5"
                      >
                        {isWeekGenerating ? (
                          <>
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            <span>Compiling Guide...</span>
                          </>
                        ) : (
                          <>
                            <Sparkles className="w-3.5 h-3.5" />
                            <span>Generate Feynman Guide</span>
                          </>
                        )}
                      </Button>
                    )}
                  </div>

                  {/* Column 2: Lecture Slide Decks */}
                  <div className="space-y-3 bg-muted/5 p-4 rounded-lg border border-charcoal-graphite/5 lg:col-span-1">
                    <div className="flex items-center gap-2 text-lecture-red">
                      <FileText className="w-4 h-4" />
                      <h4 className="font-bold text-sm tracking-tight text-charcoal-graphite">Original Slide Decks (PDF)</h4>
                    </div>
                    
                    {week.slides.length === 0 ? (
                      <p className="text-xs text-charcoal-graphite/45 italic py-4">No slide PDFs ingested for this week.</p>
                    ) : (
                      <div className="space-y-2 max-h-48 overflow-y-auto custom-scrollbar pr-1">
                        {week.slides.map((slide: any) => (
                          <div 
                            key={slide.id}
                            role="button"
                            tabIndex={0}
                            aria-label={`Open ${slide.title}`}
                            onClick={() => handleOpenFile(slide.link, slide.title)}
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleOpenFile(slide.link, slide.title) } }}
                            className="p-2.5 min-h-11 rounded-md border border-charcoal-graphite/5 bg-background hover:bg-muted/35 cursor-pointer transition-all duration-150 flex items-start gap-2.5 group focus-visible:outline-2 focus-visible:outline-fountain-ink"
                          >
                            <div className="w-6 h-6 rounded bg-lecture-red/10 text-lecture-red flex items-center justify-center text-[10px] font-bold shrink-0 mt-0.5">
                              PDF
                            </div>
                            <div className="space-y-0.5 min-w-0 flex-1">
                              <p className="text-xs font-semibold text-charcoal-graphite leading-tight truncate group-hover:text-lecture-red transition-colors duration-100">
                                {slide.title}
                              </p>
                              {slide.detail ? (
                                <p className="text-[10px] text-muted-foreground">{slide.detail}</p>
                              ) : slide.unit && (
                                <p className="text-[10px] text-muted-foreground">Unit {slide.unit} {slide.className ? `• ${slide.className}` : ''}</p>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Column 3: Transcriptions & Readings */}
                  <div className="space-y-3 bg-muted/5 p-4 rounded-lg border border-charcoal-graphite/5 lg:col-span-1">
                    <div className="flex items-center gap-2 text-fountain-ink">
                      <BookOpen className="w-4 h-4" />
                      <h4 className="font-bold text-sm tracking-tight text-charcoal-graphite">Transcripts & Notes</h4>
                    </div>

                    {week.transcriptions.length === 0 ? (
                      <p className="text-xs text-charcoal-graphite/45 italic py-4">No transcriptions or notes found.</p>
                    ) : (
                      <div className="space-y-2 max-h-48 overflow-y-auto custom-scrollbar pr-1">
                        {week.transcriptions.map((transcript: any) => (
                          <div 
                            key={transcript.id}
                            role="button"
                            tabIndex={0}
                            aria-label={`Open ${transcript.title}`}
                            onClick={() => handleOpenFile(transcript.link, transcript.title)}
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleOpenFile(transcript.link, transcript.title) } }}
                            className="p-2.5 min-h-11 rounded-md border border-charcoal-graphite/5 bg-background hover:bg-muted/35 cursor-pointer transition-all duration-150 flex items-start gap-2.5 group focus-visible:outline-2 focus-visible:outline-fountain-ink"
                          >
                            <div className="w-6 h-6 rounded bg-fountain-ink/10 text-fountain-ink flex items-center justify-center text-[10px] font-bold shrink-0 mt-0.5">
                              TXT
                            </div>
                            <div className="space-y-0.5 min-w-0 flex-1">
                              <p className="text-xs font-semibold text-charcoal-graphite leading-tight truncate group-hover:text-fountain-ink transition-colors duration-100">
                                {transcript.title}
                              </p>
                              {transcript.detail ? (
                                <p className="text-[10px] text-muted-foreground">{transcript.detail}</p>
                              ) : transcript.unit && (
                                <p className="text-[10px] text-muted-foreground">Unit {transcript.unit} {transcript.className ? `• ${transcript.className}` : ''}</p>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}