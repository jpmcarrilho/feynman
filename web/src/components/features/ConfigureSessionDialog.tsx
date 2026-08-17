'use client'

import { useState, useMemo } from 'react'
import { DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Search, X } from 'lucide-react'
import { FeynmanLogo } from './FeynmanLogo'

const formatDisplayName = (name: string | null | undefined): string => {
  if (!name) return '';
  return name
    .replace(/_+/g, ' ')
    .trim();
}

interface ConfigureSessionDialogProps {
  topics: any[];
  selectedTopics: string[];
  setSelectedTopics: (topics: string[]) => void;
  sessionDuration: number;
  setSessionDuration: (duration: number) => void;
  questionCount: number;
  setQuestionCount: (count: number) => void;
  onStartSession: (mode: 'study' | 'exam', timeLimit: number | null, sourcingMix: number, weakPct: number, unstudiedPct: number, expertPct: number) => void;
  isLoading: boolean;
}

export function ConfigureSessionDialog({
  topics,
  selectedTopics,
  setSelectedTopics,
  sessionDuration,
  setSessionDuration,
  questionCount,
  setQuestionCount,
  onStartSession,
  isLoading,
}: ConfigureSessionDialogProps) {
  const [selectedCourses, setSelectedCourses] = useState<string[]>([])
  const [selectedWeeks, setSelectedWeeks] = useState<string[]>([])
  const [selectedClasses, setSelectedClasses] = useState<string[]>([])
  const [selectedUnits, setSelectedUnits] = useState<string[]>([])
  const [topicSearchText, setTopicSearchText] = useState('')

  // Local state for Timed Exams and Custom Sourcing Mix Controls
  const [sessionMode, setSessionMode] = useState<'study' | 'exam'>('study')
  const [examDuration, setExamDuration] = useState<number>(75) // Default 75 mins for exam
  const [sourcingMix, setSourcingMix] = useState<number>(50) // Default 50% AI / 50% Ingested

  // Local state for Custom Retrieval Spacing Proportions (Weak vs Unstudied vs Expert)
  const [retrievalFocus, setRetrievalFocus] = useState<string>('balanced')
  const [weakPct, setWeakPct] = useState<number>(60)
  const [unstudiedPct, setUnstudiedPct] = useState<number>(20)
  const [expertPct, setExpertPct] = useState<number>(20)

  const handleFocusChange = (val: string) => {
    setRetrievalFocus(val);
    if (val === 'balanced') {
      setWeakPct(60);
      setUnstudiedPct(20);
      setExpertPct(20);
    } else if (val === 'remedial') {
      setWeakPct(80);
      setUnstudiedPct(10);
      setExpertPct(10);
    } else if (val === 'unstudied') {
      setWeakPct(10);
      setUnstudiedPct(85);
      setExpertPct(5);
    } else if (val === 'maintenance') {
      setWeakPct(10);
      setUnstudiedPct(10);
      setExpertPct(80);
    }
  };

  const courses = useMemo(() => Array.from(new Set(topics.map(t => t.course?.code).filter(Boolean))), [topics])

  const weeks = useMemo(() => {
    const filtered = topics.filter(t => selectedCourses.length === 0 || selectedCourses.includes(t.course?.code))
    return Array.from(new Set(filtered.map(t => t.week).filter(Boolean)))
  }, [topics, selectedCourses])

  const classes = useMemo(() => {
    const filtered = topics.filter(t => 
      (selectedCourses.length === 0 || selectedCourses.includes(t.course?.code)) &&
      (selectedWeeks.length === 0 || selectedWeeks.includes(t.week))
    )
    return Array.from(new Set(filtered.map(t => t.className).filter(Boolean)))
  }, [topics, selectedCourses, selectedWeeks])

  const units = useMemo(() => {
    const filtered = topics.filter(t => 
      (selectedCourses.length === 0 || selectedCourses.includes(t.course?.code)) &&
      (selectedWeeks.length === 0 || selectedWeeks.includes(t.week)) &&
      (selectedClasses.length === 0 || selectedClasses.includes(t.className))
    )
    return Array.from(new Set(filtered.map(t => t.title).filter(Boolean))) // Using title as unit identifier for selection
  }, [topics, selectedCourses, selectedWeeks, selectedClasses])

  const filteredTopics = useMemo(() => {
    return topics.filter(t => {
      if (selectedCourses.length > 0 && !selectedCourses.includes(t.course?.code)) return false;
      if (selectedWeeks.length > 0 && !selectedWeeks.includes(t.week)) return false;
      if (selectedClasses.length > 0 && !selectedClasses.includes(t.className)) return false;
      if (selectedUnits.length > 0 && !selectedUnits.includes(t.title)) return false;
      return true;
    });
  }, [topics, selectedCourses, selectedWeeks, selectedClasses, selectedUnits])

  const searchedTopics = useMemo(() => {
    if (!topicSearchText.trim()) return filteredTopics;
    const searchLower = topicSearchText.toLowerCase();
    return filteredTopics.filter(t => 
      t.title?.toLowerCase().includes(searchLower) ||
      t.week?.toLowerCase().includes(searchLower) ||
      (t.className && t.className.toLowerCase().includes(searchLower)) ||
      (t.course?.code && t.course.code.toLowerCase().includes(searchLower))
    );
  }, [filteredTopics, topicSearchText])

  return (
    <DialogContent className="sm:max-w-5xl md:max-w-6xl w-[90vw] max-h-[90vh] overflow-y-auto bg-background border-2 border-charcoal-graphite/20 shadow-2xl rounded-xl p-4 sm:p-6 font-sans">
      <DialogHeader className="border-b border-charcoal-graphite/10 pb-4 mb-4">
        <DialogTitle className="text-xl sm:text-2xl font-display italic text-charcoal-graphite">Configure Study Session</DialogTitle>
      </DialogHeader>
      <div className="py-2 sm:py-4 space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 sm:items-end mb-4 bg-card/20 p-4 rounded-lg border border-border/40">
          <div className="flex flex-col">
            <Label htmlFor="session-mode-select" className="mb-2 block text-xs sm:text-sm font-semibold">Session Mode</Label>
            <select 
              id="session-mode-select"
              value={sessionMode} 
              onChange={e => setSessionMode(e.target.value as 'study' | 'exam')}
              className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring font-sans"
            >
              <option value="study">🎓 Practice / Study Mode</option>
              <option value="exam">⏱️ Timed Exam Mode</option>
            </select>
          </div>

          <div className="flex flex-col">
            <Label className="mb-2 block text-xs sm:text-sm font-semibold">
              {sessionMode === 'exam' ? 'Exam Duration' : 'Practice Duration'}
            </Label>
            {sessionMode === 'study' ? (
              <select 
                value={sessionDuration / 60} 
                onChange={e => setSessionDuration(Number(e.target.value) * 60)}
                className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="5">5 Minutes</option>
                <option value="10">10 Minutes</option>
                <option value="15">15 Minutes</option>
                <option value="30">30 Minutes</option>
                <option value="60">60 Minutes</option>
              </select>
            ) : (
              <select 
                value={examDuration} 
                onChange={e => setExamDuration(Number(e.target.value))}
                className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="15">15 Minutes</option>
                <option value="30">30 Minutes</option>
                <option value="45">45 Minutes</option>
                <option value="60">60 Minutes</option>
                <option value="75">75 Minutes</option>
                <option value="0">Unlimited (No Timer)</option>
              </select>
            )}
          </div>

          <div className="flex flex-col">
            <Label className="mb-2 block text-xs sm:text-sm font-semibold">Number of Questions</Label>
            <select 
              value={questionCount} 
              onChange={e => setQuestionCount(Number(e.target.value))}
              className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <option value="5">5 Questions</option>
              <option value="10">10 Questions</option>
              <option value="20">20 Questions</option>
              <option value="32">32 Questions (14.750x Final)</option>
              <option value="50">50 Questions</option>
              <option value="53">53 Questions (JPAL102x Final)</option>
            </select>
          </div>

          <div className="flex flex-col">
            <Label className="mb-2 block text-xs sm:text-sm font-semibold">Question Sourcing Mix</Label>
            <select 
              value={sourcingMix} 
              onChange={e => setSourcingMix(Number(e.target.value))}
              className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <option value="0">100% Ingested (Historical)</option>
              <option value="25">75% Ingested / 25% AI-Generated</option>
              <option value="50">50% Ingested / 50% AI-Generated</option>
              <option value="75">25% Ingested / 75% AI-Generated</option>
              <option value="100">100% Fresh AI-Generated</option>
            </select>
          </div>
        </div>

        {/* Syllabus Retrieval Spacing Focus Panel */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 sm:items-end mb-4 bg-card/10 p-4 rounded-lg border border-border/30">
          <div className="flex flex-col md:col-span-1">
            <Label className="mb-2 block text-xs sm:text-sm font-semibold">Syllabus Retrieval Focus</Label>
            <select 
              value={retrievalFocus} 
              onChange={e => handleFocusChange(e.target.value)}
              className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring font-sans"
            >
              <option value="balanced">⚖️ Balanced Mix (60% Weak, 20% Unseen, 20% Expert)</option>
              <option value="remedial">🔥 Remedial Sprint (80% Weak, 10% Unseen, 10% Expert)</option>
              <option value="unstudied">✨ Fresh Exploration (10% Weak, 85% Unseen, 5% Expert)</option>
              <option value="maintenance">📖 Maintenance Review (10% Weak, 10% Unseen, 80% Expert)</option>
              <option value="custom">🛠️ Custom Proportions...</option>
            </select>
          </div>

          {retrievalFocus === 'custom' ? (
            <div className="md:col-span-3 grid grid-cols-3 gap-3">
              <div className="flex flex-col">
                <Label className="mb-2 block text-[10px] font-semibold text-charcoal-graphite/60 uppercase">% Weakest (Accuracy &lt; 60%)</Label>
                <Input 
                  type="number" 
                  min="0" max="100"
                  value={weakPct}
                  onChange={e => setWeakPct(Math.min(100, Math.max(0, Number(e.target.value))))}
                  className="h-10 text-xs bg-transparent border-input"
                />
              </div>
              <div className="flex flex-col">
                <Label className="mb-2 block text-[10px] font-semibold text-charcoal-graphite/60 uppercase">% Unstudied (0 Logs)</Label>
                <Input 
                  type="number" 
                  min="0" max="100"
                  value={unstudiedPct}
                  onChange={e => setUnstudiedPct(Math.min(100, Math.max(0, Number(e.target.value))))}
                  className="h-10 text-xs bg-transparent border-input"
                />
              </div>
              <div className="flex flex-col">
                <Label className="mb-2 block text-[10px] font-semibold text-charcoal-graphite/60 uppercase">% Expert (Accuracy &gt; 70%)</Label>
                <Input 
                  type="number" 
                  min="0" max="100"
                  value={expertPct}
                  onChange={e => setExpertPct(Math.min(100, Math.max(0, Number(e.target.value))))}
                  className="h-10 text-xs bg-transparent border-input"
                />
              </div>
            </div>
          ) : (
            <div className="md:col-span-3 text-xs text-muted-foreground italic h-10 flex items-center bg-muted/20 px-3 rounded border border-dashed">
              💡 Current strategy is locked to: {weakPct}% Worst Topics, {unstudiedPct}% Unstudied Topics, and {expertPct}% Spaced Expert Review. Select "Custom Proportions" to adjust manually.
            </div>
          )}
        </div>

        <div className="flex flex-col sm:flex-row justify-between sm:items-center gap-3 mb-4 pb-2 border-b">
          <div>
            <Label className="text-sm sm:text-base">Select Topics</Label>
            <p className="text-xs sm:text-sm text-muted-foreground mt-1">Select specific topics or leave blank to randomize across all courses.</p>
          </div>
          <Button 
            variant="outline" 
            className="w-full sm:w-auto self-start sm:self-auto shrink-0 text-xs sm:text-sm"
            onClick={() => {
              setSelectedTopics([]);
              setSelectedCourses([]);
              setSelectedWeeks([]);
              setSelectedClasses([]);
              setSelectedUnits([]);
              setTopicSearchText('');
            }}
          >
            Clear All Filters
          </Button>
        </div>
        
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-[1fr_1.8fr_2.2fr_0.8fr] gap-4 mb-4">
          {/* Course selection */}
          <div className="flex flex-col">
            <Label className="mb-2 block font-medium text-xs text-muted-foreground uppercase tracking-wider">Course</Label>
            <ScrollArea className="h-32 sm:h-44 w-full rounded-md border border-input bg-card/40 p-1">
              <div className="flex flex-col space-y-0.5 pr-2">
                {courses.map((c: any) => {
                  const isSelected = selectedCourses.includes(c);
                  return (
                    <button
                      key={c}
                      type="button"
                      onClick={() => {
                        if (isSelected) {
                          setSelectedCourses(selectedCourses.filter(v => v !== c));
                        } else {
                          setSelectedCourses([...selectedCourses, c]);
                        }
                        setSelectedWeeks([]);
                        setSelectedClasses([]);
                        setSelectedUnits([]);
                      }}
                      className={`w-full text-left px-2.5 py-1.5 rounded-sm transition-colors text-xs hover:bg-muted flex items-start justify-between group ${
                        isSelected ? 'bg-fountain-ink/15 text-fountain-ink font-semibold' : 'text-charcoal-graphite/80'
                      }`}
                      title={c}
                    >
                      <span className="whitespace-normal break-words pr-2">{c}</span>
                      {isSelected && <span className="text-[10px] bg-fountain-ink/20 text-fountain-ink px-1.5 py-0.5 rounded-sm font-semibold shrink-0 mt-0.5">✓</span>}
                    </button>
                  );
                })}
                {courses.length === 0 && (
                  <div className="text-xs text-muted-foreground p-3 text-center italic">No courses</div>
                )}
              </div>
            </ScrollArea>
          </div>

          {/* Week selection */}
          <div className="flex flex-col">
            <Label className="mb-2 block font-medium text-xs text-muted-foreground uppercase tracking-wider">Week</Label>
            <ScrollArea className="h-32 sm:h-44 w-full rounded-md border border-input bg-card/40 p-1">
              <div className="flex flex-col space-y-0.5 pr-2">
                {weeks.map((w: any) => {
                  const isSelected = selectedWeeks.includes(w);
                  const cleaned = formatDisplayName(w);
                  return (
                    <button
                      key={w}
                      type="button"
                      onClick={() => {
                        if (isSelected) {
                          setSelectedWeeks(selectedWeeks.filter(v => v !== w));
                        } else {
                          setSelectedWeeks([...selectedWeeks, w]);
                        }
                        setSelectedClasses([]);
                        setSelectedUnits([]);
                      }}
                      className={`w-full text-left px-2.5 py-1.5 rounded-sm transition-colors text-xs hover:bg-muted flex items-start justify-between group ${
                        isSelected ? 'bg-fountain-ink/15 text-fountain-ink font-semibold' : 'text-charcoal-graphite/80'
                      }`}
                      title={cleaned}
                    >
                      <span className="whitespace-normal break-words pr-2">{cleaned}</span>
                      {isSelected && <span className="text-[10px] bg-fountain-ink/20 text-fountain-ink px-1.5 py-0.5 rounded-sm font-semibold shrink-0 mt-0.5">✓</span>}
                    </button>
                  );
                })}
                {weeks.length === 0 && (
                  <div className="text-xs text-muted-foreground p-3 text-center italic">Select course first</div>
                )}
              </div>
            </ScrollArea>
          </div>

          {/* Class selection */}
          <div className="flex flex-col">
            <Label className="mb-2 block font-medium text-xs text-muted-foreground uppercase tracking-wider">Class</Label>
            <ScrollArea className="h-32 sm:h-44 w-full rounded-md border border-input bg-card/40 p-1">
              <div className="flex flex-col space-y-0.5 pr-2">
                {classes.map((cl: any) => {
                  const isSelected = selectedClasses.includes(cl);
                  const cleaned = formatDisplayName(cl);
                  return (
                    <button
                      key={cl}
                      type="button"
                      onClick={() => {
                        if (isSelected) {
                          setSelectedClasses(selectedClasses.filter(v => v !== cl));
                        } else {
                          setSelectedClasses([...selectedClasses, cl]);
                        }
                        setSelectedUnits([]);
                      }}
                      className={`w-full text-left px-2.5 py-1.5 rounded-sm transition-colors text-xs hover:bg-muted flex items-start justify-between group ${
                        isSelected ? 'bg-fountain-ink/15 text-fountain-ink font-semibold' : 'text-charcoal-graphite/80'
                      }`}
                      title={cleaned}
                    >
                      <span className="whitespace-normal break-words pr-2">{cleaned}</span>
                      {isSelected && <span className="text-[10px] bg-fountain-ink/20 text-fountain-ink px-1.5 py-0.5 rounded-sm font-semibold shrink-0 mt-0.5">✓</span>}
                    </button>
                  );
                })}
                {classes.length === 0 && (
                  <div className="text-xs text-muted-foreground p-3 text-center italic">Select week first</div>
                )}
              </div>
            </ScrollArea>
          </div>

          {/* Unit selection */}
          <div className="flex flex-col">
            <Label className="mb-2 block font-medium text-xs text-muted-foreground uppercase tracking-wider">Unit</Label>
            <ScrollArea className="h-32 sm:h-44 w-full rounded-md border border-input bg-card/40 p-1">
              <div className="flex flex-col space-y-0.5 pr-2">
                {units.map((u: any) => {
                  const isSelected = selectedUnits.includes(u);
                  const cleaned = formatDisplayName(u);
                  return (
                    <button
                      key={u}
                      type="button"
                      onClick={() => {
                        if (isSelected) {
                          setSelectedUnits(selectedUnits.filter(v => v !== u));
                        } else {
                          setSelectedUnits([...selectedUnits, u]);
                        }
                      }}
                      className={`w-full text-left px-2.5 py-1.5 rounded-sm transition-colors text-xs hover:bg-muted flex items-start justify-between group ${
                        isSelected ? 'bg-fountain-ink/15 text-fountain-ink font-semibold' : 'text-charcoal-graphite/80'
                      }`}
                      title={cleaned}
                    >
                      <span className="whitespace-normal break-words pr-2">{cleaned}</span>
                      {isSelected && <span className="text-[10px] bg-fountain-ink/20 text-fountain-ink px-1.5 py-0.5 rounded-sm font-semibold shrink-0 mt-0.5">✓</span>}
                    </button>
                  );
                })}
                {units.length === 0 && (
                  <div className="text-xs text-muted-foreground p-3 text-center italic">Select class first</div>
                )}
              </div>
            </ScrollArea>
          </div>
        </div>

        <div className="border rounded-md p-4 bg-muted/10">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-4 pb-3 border-b">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold">{filteredTopics.length} Topics Found</span>
              {topicSearchText.trim() && (
                <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
                  {searchedTopics.length} matches
                </span>
              )}
            </div>
            
            {/* Search Bar */}
            <div className="relative w-full md:w-80">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search topics by title, week, or class..."
                value={topicSearchText}
                onChange={e => setTopicSearchText(e.target.value)}
                className="pl-9 h-9 text-xs bg-background"
              />
              {topicSearchText && (
                <button
                  type="button"
                  onClick={() => setTopicSearchText('')}
                  className="absolute right-2.5 top-2.5 text-muted-foreground hover:text-foreground text-xs font-semibold"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>

            <Button 
              variant="secondary" 
              size="sm"
              onClick={(e) => {
                e.preventDefault();
                const ids = searchedTopics.map((t: any) => t.id);
                const allSelected = ids.length > 0 && ids.every((id: any) => selectedTopics.includes(id));
                if (allSelected) {
                  setSelectedTopics(selectedTopics.filter((id: any) => !ids.includes(id)));
                } else {
                  const newSelection = new Set([...selectedTopics, ...ids]);
                  setSelectedTopics(Array.from(newSelection));
                }
              }}
            >
              Select / Deselect All
            </Button>
          </div>
          <ScrollArea className="h-[300px] w-full pr-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pl-1">
              {searchedTopics.map((t: any) => (
                <div key={t.id} className="flex items-start space-x-3 bg-background p-3.5 rounded-lg border shadow-sm hover:border-blue-400 transition-colors">
                  <Checkbox 
                    id={t.id} 
                    checked={selectedTopics.includes(t.id)}
                    className="mt-1"
                    onCheckedChange={(c) => {
                      if (c) setSelectedTopics([...selectedTopics, t.id])
                      else setSelectedTopics(selectedTopics.filter((id: any) => id !== t.id))
                    }}
                  />
                  <div className="flex-1 space-y-1.5 min-w-0">
                    <div className="flex justify-between items-start gap-2">
                      <label htmlFor={t.id} className="text-sm font-semibold leading-tight cursor-pointer block truncate">
                        {t.title}
                      </label>
                      
                      {/* ACCURACY BADGE (Micro visualizer indicator) */}
                      {t.accuracy !== null && t.accuracy !== undefined ? (
                        <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-sm shrink-0 uppercase tracking-wide border ${
                          t.accuracy >= 70 
                            ? 'bg-green-50 border-green-200 text-green-700' 
                            : t.accuracy >= 50 
                              ? 'bg-amber-50 border-amber-200 text-amber-700' 
                              : 'bg-red-50 border-red-200 text-red-700'
                        }`}>
                          {t.accuracy}% acc
                        </span>
                      ) : (
                        <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-sm shrink-0 uppercase tracking-wide border bg-muted/40 text-muted-foreground">Unseen</span>
                      )}
                    </div>

                    <span className="text-[10px] text-muted-foreground block truncate">
                      {t.courseCode || t.course?.code} • {formatDisplayName(t.week)} {t.className ? `• ${formatDisplayName(t.className)}` : ''}
                    </span>

                    {/* COVERAGE PROGRESS BAR (Macro to micro coverage visualization) */}
                    <div className="space-y-1 pt-1">
                      <div className="flex justify-between text-[9px] text-muted-foreground font-semibold">
                        <span>Progress Coverage</span>
                        <span>{t.uniquelyCompleted || 0}/{t.totalExercises || 0} ({t.coverage || 0}%)</span>
                      </div>
                      <div className="w-full bg-muted rounded-full h-1.5 overflow-hidden">
                        <div 
                          className="bg-fountain-ink h-full rounded-full transition-all duration-300"
                          style={{ width: `${t.coverage || 0}%` }}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              ))}
              {searchedTopics.length === 0 && (
                <div className="col-span-full py-8 text-center text-muted-foreground font-sans">
                  {topicSearchText.trim() ? 'No topics match your search.' : 'No topics found for the selected filters.'}
                </div>
              )}
            </div>
          </ScrollArea>
        </div>

        {selectedTopics.length > 0 && (
          <div className="border rounded-md p-3.5 bg-fountain-ink/5 border-fountain-ink/15">
            <div className="flex items-center justify-between mb-2">
              <Label className="text-xs font-semibold text-fountain-ink uppercase tracking-wider">
                Selected Topics ({selectedTopics.length})
              </Label>
              <button 
                onClick={(e) => {
                  e.preventDefault();
                  setSelectedTopics([]);
                }} 
                className="text-[10px] text-muted-foreground hover:text-fountain-ink font-semibold"
              >
                Deselect All
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto pr-2">
              {selectedTopics.map(id => {
                const topic = topics.find(t => t.id === id);
                if (!topic) return null;
                return (
                  <div key={id} className="flex items-center gap-1.5 bg-background border px-2 py-1 rounded text-xs font-medium max-w-xs">
                    <span className="truncate" title={topic.title}>{topic.title}</span>
                    <button 
                      onClick={(e) => {
                        e.preventDefault();
                        setSelectedTopics(selectedTopics.filter(x => x !== id));
                      }}
                      className="text-muted-foreground hover:text-lecture-red font-bold text-xs"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="pt-4 border-t space-y-3">
          <Button 
            onClick={() => {
              const limit = sessionMode === 'exam' 
                ? (examDuration === 0 ? null : examDuration * 60)
                : sessionDuration; // Let study mode use standard practice duration
              onStartSession(sessionMode, limit, sourcingMix, weakPct, unstudiedPct, expertPct);
            }} 
            disabled={isLoading} 
            className="w-full text-lg h-12 bg-lecture-red hover:bg-lecture-red/90 text-white border-0 shadow-sm font-semibold animate-sketch-draw"
          >
            {isLoading ? (
              <><FeynmanLogo variant="thinking" size={20} className="mr-2" /> Generating Exercises...</>
            ) : (
              sessionMode === 'exam' ? '📋 Start Timed Exam' : (selectedTopics.length === 0 ? 'Start Random Session' : 'Start Focused Session')
            )}
          </Button>
          {isLoading && (
            <div className="text-center text-sm text-muted-foreground animate-pulse">
              The AI is analyzing course materials and generating your custom test-prep questions. This usually takes 5-15 seconds.
            </div>
          )}
        </div>
      </div>
    </DialogContent>
  )
}
