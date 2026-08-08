'use client'

import { useState, useEffect, useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { Flashcard } from './Flashcard'
import { SessionTimer } from './SessionTimer'
import { VoiceHub } from './VoiceHub'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Input } from '@/components/ui/input'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { createStudySession, getTopics, getSessionHistory, logAnswer, saveChatLog, getSessionWithExercises, getClassContextForTopic, generateNextExercise, deleteStudySession } from '@/app/actions'
import { ChevronLeft, ChevronRight, PlusCircle, History, PlayCircle, Loader2, Trash2, X, Search, Maximize2, Minimize2 } from 'lucide-react'
import { useLiveAPI } from '@/hooks/useLiveAPI'
import { AnalyticsDashboard } from './AnalyticsDashboard'
import { FeynmanLogo } from './FeynmanLogo'

const formatDisplayName = (name: string | null | undefined): string => {
  if (!name) return '';
  return name
    .replace(/_+/g, ' ')
    .trim();
}

export function StudyInterface() {
  const [topics, setTopics] = useState<any[]>([])
  const [selectedTopics, setSelectedTopics] = useState<string[]>([])
  const [histories, setHistories] = useState<any[]>([])
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [sessionDuration, setSessionDuration] = useState<number>(300) // Default 5 mins

  const [session, setSession] = useState<any>(null)
  const [exercises, setExercises] = useState<any[]>([])
  const [missingCount, setMissingCount] = useState(0)
  const [isGeneratingNext, setIsGeneratingNext] = useState(false)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [selectedHistory, setSelectedHistory] = useState<any>(null)
  const [isFocusMode, setIsFocusMode] = useState(false)

  // Side Visualizer States
  const [activeFile, setActiveFile] = useState<string | null>(null)
  const [activeFilePage, setActiveFilePage] = useState<number | null>(null)
  const [activeFileHighlight, setActiveFileHighlight] = useState<string | null>(null)
  const [activeFileTitle, setActiveFileTitle] = useState<string>('')
  const [fileContent, setFileContent] = useState<string>('')
  const [fileLoading, setFileLoading] = useState<boolean>(false)
  
  type Platform = 'mac' | 'windows' | 'linux' | 'other'
  const [platform, setPlatform] = useState<Platform>('other')

  useEffect(() => {
    const userAgent = navigator.userAgent.toLowerCase();
    if (userAgent.indexOf('mac') !== -1) {
      setPlatform('mac');
    } else if (userAgent.indexOf('win') !== -1) {
      setPlatform('windows');
    } else if (userAgent.indexOf('linux') !== -1) {
      setPlatform('linux');
    } else {
      setPlatform('other');
    }
  }, [])

  const currentExercise = exercises[currentIndex]

  const parsedChoices = useMemo(() => {
    if (!currentExercise?.choices) return [];
    try {
      return JSON.parse(currentExercise.choices);
    } catch (e) {
      console.warn('Failed to parse choices', e);
      return [];
    }
  }, [currentExercise?.choices]);

  const exerciseContext = currentExercise 
    ? `Topic: ${currentExercise.topic?.title || 'Unknown'}\nQuestion: ${currentExercise.questionText}\nChoices: ${parsedChoices.join(', ')}`
    : ''

  const liveAPI = useLiveAPI(`You are a helpful, brilliant professor for MIT MicroMasters courses, embodying the Feynman learning philosophy. Help the student understand complex concepts by breaking them down into simple, intuitive analogies when it makes sense, rather than relying on dry jargon. Adhere to these teaching guidelines:
1. Simplify, but remain concise: Do not be verbose. Keep your explanations brief and focused unless asked for deep detail.
2. The Feynman Technique: When a student is struggling or asks a question, encourage them to explain the concept in their own simple terms, or use a clear, colorful analogy (like a bongo drum, visual sketches, or water pipes) to clarify the intuition behind equations or economics theorems.
3. Don't give away answers: Guide them with leading questions or hints to let them find the answer themselves.`)

  useEffect(() => {
    // Load initial data
    getTopics().then(setTopics)
    getSessionHistory().then(setHistories)

    // Load active session from local storage
    const savedSession = localStorage.getItem('dedp_active_session')
    if (savedSession) {
      try {
        const parsed = JSON.parse(savedSession)
        setSession(parsed.session)
        setExercises(parsed.exercises)
        setCurrentIndex(parsed.currentIndex || 0)
        if (parsed.missingCount !== undefined) {
          setMissingCount(parsed.missingCount)
        }
        if (parsed.chatLog && Array.isArray(parsed.chatLog)) {
          liveAPI.setMessages(parsed.chatLog)
        }
      } catch (e) {
        console.error("Failed to parse saved session", e)
      }
    }
  }, [])

  // Save session state to local storage when it changes
  useEffect(() => {
    if (session && exercises.length > 0) {
      try {
        localStorage.setItem('dedp_active_session', JSON.stringify({
          session,
          exercises,
          currentIndex,
          missingCount,
          chatLog: liveAPI.messages
        }))
      } catch (error: any) {
        // Handle localStorage quota limits gracefully without crashing the app
        if (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED' || error.code === 22) {
          console.warn("localStorage quota exceeded due to large Voice Tutor chat log. Conserving space by stripping the chat log from saved session state.")
          try {
            localStorage.setItem('dedp_active_session', JSON.stringify({
              session,
              exercises,
              currentIndex,
              missingCount,
              chatLog: [] // Strip the heavy chat log to save space
            }))
          } catch (fallbackError) {
            console.error("Failed to write even basic session info to localStorage:", fallbackError)
          }
        } else {
          console.error("Failed to save active session state to localStorage:", error)
        }
      }
    }
  }, [session, exercises, currentIndex, missingCount, liveAPI.messages])

  const [selectedCourses, setSelectedCourses] = useState<string[]>([])
  const [selectedWeeks, setSelectedWeeks] = useState<string[]>([])
  const [selectedClasses, setSelectedClasses] = useState<string[]>([])
  const [selectedUnits, setSelectedUnits] = useState<string[]>([])
  const [questionCount, setQuestionCount] = useState<number>(10)
  const [topicSearchText, setTopicSearchText] = useState('')

  const courses = useMemo(() => Array.from(new Set(topics.map(t => t.course?.code).filter(Boolean))), [topics])
  
  const weeks = useMemo(() => {
    let filtered = topics;
    if (selectedCourses.length > 0) filtered = filtered.filter(t => selectedCourses.includes(t.course?.code))
    return Array.from(new Set(filtered.map(t => t.week).filter(Boolean)))
  }, [topics, selectedCourses])

  const classes = useMemo(() => {
    let filtered = topics;
    if (selectedCourses.length > 0) filtered = filtered.filter(t => selectedCourses.includes(t.course?.code))
    if (selectedWeeks.length > 0) filtered = filtered.filter(t => selectedWeeks.includes(t.week))
    return Array.from(new Set(filtered.map(t => t.className).filter(Boolean)))
  }, [topics, selectedCourses, selectedWeeks])

  const units = useMemo(() => {
    let filtered = topics;
    if (selectedCourses.length > 0) filtered = filtered.filter(t => selectedCourses.includes(t.course?.code))
    if (selectedWeeks.length > 0) filtered = filtered.filter(t => selectedWeeks.includes(t.week))
    if (selectedClasses.length > 0) filtered = filtered.filter(t => selectedClasses.includes(t.className))
    return Array.from(new Set(filtered.map(t => t.unit).filter(Boolean)))
  }, [topics, selectedCourses, selectedWeeks, selectedClasses])

  const filteredTopics = useMemo(() => {
    return topics.filter(t => {
      if (selectedCourses.length > 0 && !selectedCourses.includes(t.course?.code)) return false
      if (selectedWeeks.length > 0 && !selectedWeeks.includes(t.week)) return false
      if (selectedClasses.length > 0 && !selectedClasses.includes(t.className)) return false
      if (selectedUnits.length > 0 && !selectedUnits.includes(t.unit)) return false
      return true
    })
  }, [topics, selectedCourses, selectedWeeks, selectedClasses, selectedUnits])

  const searchedTopics = useMemo(() => {
    if (!topicSearchText.trim()) return filteredTopics;
    const searchLower = topicSearchText.toLowerCase();
    return filteredTopics.filter(t => 
      t.title.toLowerCase().includes(searchLower) ||
      (t.week && t.week.toLowerCase().includes(searchLower)) ||
      (t.className && t.className.toLowerCase().includes(searchLower))
    );
  }, [filteredTopics, topicSearchText])

  const handleDeleteSession = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (confirm("Are you sure you want to delete this study session and all its logs? This cannot be undone.")) {
      const ok = await deleteStudySession(id);
      if (ok) {
        setHistories(prev => prev.filter(h => h.id !== id));
        if (session?.id === id) {
          setSession(null);
          setExercises([]);
          setCurrentIndex(0);
          localStorage.removeItem('dedp_active_session');
        }
      } else {
        alert("Failed to delete session.");
      }
    }
  }

  const handleViewFile = (href: string) => {
    try {
      // Parse URL
      const url = new URL(href, window.location.origin);
      const filePath = url.searchParams.get('path');
      if (filePath) {
        setActiveFile(filePath);
        setActiveFileTitle(filePath.split('/').pop() || 'Document');
        
        // Parse page hash (e.g. #page=5)
        const pageMatch = url.hash.match(/page=(\d+)/);
        if (pageMatch) {
          setActiveFilePage(parseInt(pageMatch[1]));
        } else {
          setActiveFilePage(null);
        }

        // Parse highlight query param
        const highlightParam = url.searchParams.get('highlight');
        if (highlightParam) {
          setActiveFileHighlight(decodeURIComponent(highlightParam));
        } else {
          setActiveFileHighlight(null);
        }
      }
    } catch (e) {
      console.error("Failed to parse view file link:", e);
    }
  }

  const handleCloseFile = () => {
    setActiveFile(null)
    setActiveFilePage(null)
    setActiveFileHighlight(null)
    setActiveFileTitle('')
    setFileContent('')
  }

  useEffect(() => {
    if (activeFile && !activeFile.toLowerCase().endsWith('.pdf')) {
      setFileLoading(true);
      fetch(`/api/file?path=${encodeURIComponent(activeFile)}`)
        .then(res => res.text())
        .then(text => {
          setFileContent(text);
          setFileLoading(false);
        })
        .catch(err => {
          console.error("Failed to fetch file content:", err);
          setFileContent("Error loading file content.");
          setFileLoading(false);
        });
    }
  }, [activeFile]);

  const renderTranscriptWithHighlight = (text: string, highlight: string | null) => {
    if (!highlight || !text) return text;
    
    const index = text.toLowerCase().indexOf(highlight.toLowerCase());
    if (index === -1) return text;

    const before = text.slice(0, index);
    const match = text.slice(index, index + highlight.length);
    const after = text.slice(index + highlight.length);

    return (
      <>
        {before}
        <mark 
          ref={(el) => {
            if (el) {
              // Smoothly scroll the highlighted section into view in the center of the scroll area
              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
          }}
          className="bg-yellow-200 dark:bg-yellow-800 text-foreground px-1 rounded font-semibold animate-pulse"
        >
          {match}
        </mark>
        {after}
      </>
    );
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // 1. PDF Search shortcut (Cmd+F / Ctrl+F)
      if ((e.metaKey || e.ctrlKey) && e.code === 'KeyF') {
        if (activeFile && activeFile.toLowerCase().endsWith('.pdf')) {
          const iframe = document.querySelector('iframe');
          if (iframe) {
            iframe.focus();
            iframe.contentWindow?.focus();
          }
        }
      }

      // 2. Start/Stop Voice Tutor (Alt+V)
      if (e.altKey && e.code === 'KeyV') {
        e.preventDefault();
        if (liveAPI.isConnected) {
          liveAPI.disconnect();
        } else if (!liveAPI.isConnecting) {
          liveAPI.connect(true);
        }
      }

      // 3. Mute/Unmute microphone (Alt+M)
      if (e.altKey && e.code === 'KeyM') {
        e.preventDefault();
        if (liveAPI.isConnected) {
          liveAPI.setMuted(!liveAPI.isMuted);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeFile, liveAPI]);

  const handleStartSession = async () => {
    setIsLoading(true)
    try {
      const res = await createStudySession(selectedTopics, questionCount)
      setSession(res.session)
      setExercises(res.exercises)
      setMissingCount(res.missingCount || 0)
      setCurrentIndex(0)
      setIsModalOpen(false)
      // refresh histories
      getSessionHistory().then(setHistories)
    } catch (e) {
      console.error(e)
    }
    setIsLoading(false)
  }

  useEffect(() => {
    if (session && missingCount > 0 && !isGeneratingNext) {
      setIsGeneratingNext(true);
      const generateOne = async () => {
        try {
          const currentIds = exercises.map((e: any) => e.id);
          const newEx = await generateNextExercise(session.id, selectedTopics.length > 0 ? selectedTopics : topics.map(t => t.id), currentIds, missingCount);
          if (newEx) {
            setExercises(prev => [...prev, newEx]);
            setMissingCount(prev => prev - 1);
          } else {
            // Failed or no topics
            setMissingCount(0);
          }
        } catch (e) {
          console.error(e);
          setMissingCount(0);
        } finally {
          setIsGeneratingNext(false);
        }
      };
      generateOne();
    }
  }, [session, missingCount, isGeneratingNext, exercises, selectedTopics, topics]);

  const handleFinishSession = async () => {
    if (session) {
      // Save the final chat log from liveAPI
      await saveChatLog(session.id, liveAPI.messages)
    }
    setSession(null)
    setExercises([])
    setCurrentIndex(0)
    liveAPI.setMessages([])
    localStorage.removeItem('dedp_active_session')
    getSessionHistory().then(setHistories)
  }

  const currentLog = session?.logs?.find((l: any) => l.exerciseId === currentExercise?.id)

  const [classContext, setClassContext] = useState<any[] | null>(null)

  useEffect(() => {
    if (currentExercise?.topicId) {
      getClassContextForTopic(currentExercise.topicId).then(setClassContext)
    } else {
      setClassContext(null)
    }
  }, [currentExercise?.topicId])

  const handleAnswer = async (isCorrect: boolean, userAnswer: string) => {
    if (session && currentExercise) {
      await logAnswer(session.id, currentExercise.id, isCorrect, 30, userAnswer) // dummy duration
      
      setSession((prev: any) => ({
        ...prev,
        logs: [...(prev.logs || []), { exerciseId: currentExercise.id, isCorrect, userAnswer }]
      }))
    }
  }

  useEffect(() => {
    if (liveAPI.isConnected && currentExercise) {
      let contextMsg = `[SYSTEM MESSAGE: The student has navigated to a new exercise. Topic: ${currentExercise.topic?.title || 'Unknown'}. Question: ${currentExercise.questionText}. Choices: ${parsedChoices.join(', ')}]`;
      
      if (classContext && classContext.length > 0) {
        contextMsg += `\n\nHere is the context of the whole class for this topic. Use this to help the student. ALWAYS reference the exact file (using the localPath provided) with a Markdown link to the API route that serves the file.
Format it EXACTLY like this:
- For Slides PDFs: [Source File Title](/api/file?path=URL_ENCODED_LOCAL_PATH#page=PAGE_NUMBER) (choose the exact page number of the slides that describes the topic, e.g., page 5)
- For Transcripts/Readings: [Source File Title](/api/file?path=URL_ENCODED_LOCAL_PATH&highlight=SHORT_UNIQUE_QUOTE_FROM_TEXT) (choose a short, unique 5-10 word quote from the transcript text that you are referring to so it can be highlighted)
Example: [Lecture Slides](/api/file?path=/Users/name/slides.pdf#page=5) or [Lecture Transcript](/api/file?path=/Users/name/transcript.txt&highlight=welcome%20to%20the%20lecture)\n`;
        classContext.forEach((t: any) => {
          contextMsg += `\n--- Unit: ${t.title} (File: ${t.localPath || 'Unknown'}) ---\n${t.content ? t.content : 'No content available.'}\n`;
        });
      }
      
      liveAPI.sendText(contextMsg)
    }
  }, [currentExercise?.id, liveAPI.isConnected, parsedChoices, classContext])

  const handleRequestExplanation = (userAnswer: string) => {
    if (!currentExercise) return
    const msg = `I selected "${userAnswer}", but the correct answer is "${currentExercise.correctAnswer}". Can you explain why I am wrong?`
    
    if (!liveAPI.isConnected) {
      // Connect first (text-only), then send message after a brief delay
      liveAPI.connect(false).then(() => {
        setTimeout(() => liveAPI.sendText(msg), 1500)
      })
    } else {
      liveAPI.sendText(msg)
    }
  }

  return (
    <div className="flex w-full h-screen overflow-hidden bg-background font-sans relative">

      {/* FIXED FLOATING LOGO BAR - Top Left (stays in place whether left sidebar is active or collapsed) */}
      <div className="absolute top-[16px] left-4 z-50 cursor-pointer flex items-center gap-2 select-none" onClick={() => window.location.href = '/'}>
        <FeynmanLogo variant="mini" size={48} className="stroke-charcoal-graphite transition-transform duration-200 hover:scale-105 animate-sketch-draw" />
        <span className="font-display text-2xl italic font-bold tracking-tight text-charcoal-graphite transition-colors duration-200 hover:text-fountain-ink">Feynman</span>
      </div>

      {/* LEFT SIDEBAR - 20vw */}
      <div className={`h-full border-r flex flex-col bg-card text-charcoal-graphite shrink-0 transition-all duration-300 ease-in-out border-charcoal-graphite/10 relative z-30 ${
        isFocusMode ? 'w-0 overflow-hidden border-r-0 opacity-0' : 'w-[20vw] opacity-100'
      }`}>
        {/* Header spacer to match the fixed absolute logo */}
        <div className="h-[80px] border-b border-charcoal-graphite/10 shrink-0" />

        <div className="p-4 border-b border-charcoal-graphite/10 shrink-0">
          <Dialog open={isModalOpen} onOpenChange={setIsModalOpen}>
            <DialogTrigger render={<Button className="w-full flex gap-2 bg-lecture-red hover:bg-lecture-red/90 text-white border-0 shadow-sm font-semibold h-11 shrink-0" />}>
              <PlusCircle className="w-4 h-4" />
              Create Session
            </DialogTrigger>
            <DialogContent className="sm:max-w-5xl md:max-w-6xl w-[90vw] max-h-[90vh] overflow-y-auto bg-background border-2 border-charcoal-graphite/20 shadow-2xl rounded-xl p-6 font-sans">
              <DialogHeader className="border-b border-charcoal-graphite/10 pb-4 mb-4">
                <DialogTitle className="text-2xl font-display italic text-charcoal-graphite">Configure Study Session</DialogTitle>
              </DialogHeader>
              <div className="py-4 space-y-6">
                  <div className="flex gap-4 items-end mb-4">
                    <div className="w-[200px]">
                      <Label className="mb-2 block">Session Duration</Label>
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
                    </div>
                    <div className="w-[200px]">
                      <Label className="mb-2 block">Number of Questions</Label>
                      <select 
                        value={questionCount} 
                        onChange={e => setQuestionCount(Number(e.target.value))}
                        className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      >
                        <option value="5">5 Questions</option>
                        <option value="10">10 Questions</option>
                        <option value="20">20 Questions</option>
                        <option value="50">50 Questions</option>
                      </select>
                    </div>
                  </div>

                  <div className="flex justify-between items-center mb-4 pb-2 border-b">
                    <div>
                      <Label className="text-base">Select Topics</Label>
                      <p className="text-sm text-muted-foreground mt-1">Select specific topics or leave blank to randomize across all courses.</p>
                    </div>
                    <Button 
                      variant="outline" 
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
                  
                  <div className="grid grid-cols-1 md:grid-cols-[1fr_1.8fr_2.2fr_0.8fr] gap-4 mb-4">
                    {/* Course selection */}
                    <div className="flex flex-col">
                      <Label className="mb-2 block font-medium text-xs text-muted-foreground uppercase tracking-wider">Course</Label>
                      <ScrollArea className="h-44 w-full rounded-md border border-input bg-card/40 p-1">
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
                      <ScrollArea className="h-44 w-full rounded-md border border-input bg-card/40 p-1">
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
                      <ScrollArea className="h-44 w-full rounded-md border border-input bg-card/40 p-1">
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
                      <ScrollArea className="h-44 w-full rounded-md border border-input bg-card/40 p-1">
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
                          <div key={t.id} className="flex items-start space-x-3 bg-background p-3 rounded-md border shadow-sm hover:border-blue-400 transition-colors">
                            <Checkbox 
                              id={t.id} 
                              checked={selectedTopics.includes(t.id)}
                              className="mt-1"
                              onCheckedChange={(c) => {
                                if (c) setSelectedTopics([...selectedTopics, t.id])
                                else setSelectedTopics(selectedTopics.filter((id: any) => id !== t.id))
                              }}
                            />
                            <div className="flex-1">
                              <label htmlFor={t.id} className="text-sm font-medium leading-tight cursor-pointer block">
                                {t.title}
                              </label>
                              <span className="text-xs text-muted-foreground block mt-1">
                                {t.course?.code} • {formatDisplayName(t.week)} {t.className ? `• ${formatDisplayName(t.className)}` : ''}
                              </span>
                            </div>
                          </div>
                        ))}
                        {searchedTopics.length === 0 && (
                          <div className="col-span-full py-8 text-center text-muted-foreground">
                            {topicSearchText.trim() ? 'No topics match your search.' : 'No topics found for the selected filters.'}
                          </div>
                        )}
                      </div>
                    </ScrollArea>
                  </div>

                <div className="pt-4 border-t space-y-3">
                  <Button onClick={handleStartSession} disabled={isLoading} className="w-full text-lg h-12 bg-lecture-red hover:bg-lecture-red/90 text-white border-0 shadow-sm font-semibold">
                    {isLoading ? (
                      <><FeynmanLogo variant="thinking" size={20} className="mr-2" /> Generating Exercises...</>
                    ) : (
                      selectedTopics.length === 0 ? 'Start Random Session' : 'Start Focused Session'
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
          </Dialog>
        </div>
        
        <div className="flex-1 overflow-auto p-4">
          <h3 className="font-semibold mb-4 flex items-center gap-2 text-sm text-charcoal-graphite/60">
            <History className="w-4 h-4 text-fountain-ink" />
            Session History
          </h3>
          <div className="space-y-2">
            {histories.map(h => {
              const answeredLogs = h.logs.filter((l: any) => l.userAnswer !== null && l.userAnswer !== undefined && l.userAnswer !== '');
              const correct = answeredLogs.filter((l: any) => l.isCorrect).length
              const total = answeredLogs.length
              const isActiveSession = session?.id === h.id;
              return (
                <div 
                  key={h.id} 
                  className={`text-xs p-3 border rounded-md shadow-sm cursor-pointer transition-colors group relative pr-8 ${
                    isActiveSession 
                      ? 'bg-background text-charcoal-graphite border-fountain-ink/40 shadow-md font-semibold' 
                      : 'bg-muted/40 text-charcoal-graphite/70 border-charcoal-graphite/10 hover:bg-muted hover:text-charcoal-graphite'
                  }`}
                  onClick={() => setSelectedHistory(h)}
                >
                  <div className="font-medium text-charcoal-graphite">
                    {h.title || new Date(h.startTime).toLocaleString()}
                  </div>
                  {h.title && (
                    <div className="text-[10px] mt-0.5 text-charcoal-graphite/50">
                      {new Date(h.startTime).toLocaleString()}
                    </div>
                  )}
                  <div className="mt-1 flex justify-between text-charcoal-graphite/60">
                    <span>Score: {correct}/{total}</span>
                    <span className={h.status === 'active' ? 'text-lecture-red font-semibold' : isActiveSession ? 'text-fountain-ink' : 'text-fountain-ink/80'}>
                      {h.status}
                    </span>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={`h-6 w-6 absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity ${
                      isActiveSession 
                        ? 'text-lecture-red hover:bg-lecture-red/10' 
                        : 'text-charcoal-graphite/40 hover:text-lecture-red hover:bg-lecture-red/10'
                    }`}
                    onClick={(e) => handleDeleteSession(e, h.id)}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              )
            })}
            {histories.length === 0 && (
              <div className="text-sm text-muted-foreground text-center py-4">No past sessions</div>
            )}
          </div>
        </div>
      </div>

      {/* CENTER - 60vw / 45vw */}
      <Tabs 
        defaultValue="study" 
        className={`flex-1 flex flex-col transition-all duration-300 ease-in-out bg-background ${
          isFocusMode 
            ? activeFile ? 'w-[55vw]' : 'w-[80vw]'
            : activeFile ? 'w-[35vw]' : 'w-[60vw]'
        }`}
      >
        <div className={`pt-8 pb-4 pr-8 flex justify-between items-center border-b border-charcoal-graphite/10 transition-all duration-300 ${
          isFocusMode ? 'pl-48' : 'pl-8'
        }`}>
          <div className="flex items-center gap-4">
            <TabsList className="bg-muted border border-charcoal-graphite/5 p-1 rounded-lg">
              <TabsTrigger value="study" className="data-[state=active]:bg-sketchbook-cream data-[state=active]:text-charcoal-graphite font-semibold">Study Session</TabsTrigger>
              <TabsTrigger value="analytics" className="data-[state=active]:bg-sketchbook-cream data-[state=active]:text-charcoal-graphite font-semibold">Analytics</TabsTrigger>
            </TabsList>
            
            {/* Focus Mode Trigger */}
            <Button 
              variant="ghost" 
              size="icon" 
              onClick={() => setIsFocusMode(!isFocusMode)}
              title={isFocusMode ? "Exit Focus Mode" : "Focus Mode"}
              className="h-8 w-8 text-charcoal-graphite/70 hover:bg-muted hover:text-charcoal-graphite rounded-md transition-all duration-200 border border-charcoal-graphite/5 shadow-sm"
            >
              {isFocusMode ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
            </Button>
          </div>

          {session && (
            <Button 
              variant="ghost" 
              className="text-lecture-red hover:text-lecture-red hover:bg-lecture-red/10 border border-transparent hover:border-lecture-red/20 font-medium" 
              onClick={() => {
                setSession(null)
                setExercises([])
                setCurrentIndex(0)
                localStorage.removeItem('dedp_active_session')
              }}
            >
              End Session
            </Button>
          )}
        </div>
        
        <TabsContent value="study" className="flex-1 overflow-y-auto p-8 m-0 min-w-0">
          {session ? (
            <div className="w-full max-w-3xl mx-auto space-y-8 pb-12 min-w-0">
              <SessionTimer durationSeconds={sessionDuration} startTime={session.startTime} />
              
              {currentExercise ? (
                <div className="space-y-4">
                  <div className="flex justify-between items-center text-sm font-medium text-charcoal-graphite bg-card p-3 rounded-lg border border-charcoal-graphite/10 shadow-sm">
                    <div className="flex items-center gap-4">
                      <span>Question {currentIndex + 1} of {exercises.length + missingCount}</span>
                      {missingCount > 0 && (
                        <span className="flex items-center text-fountain-ink text-xs font-semibold animate-pulse">
                          <FeynmanLogo variant="thinking" size={14} className="mr-1" />
                          Generating {missingCount} more...
                        </span>
                      )}
                    </div>
                    <span className="font-semibold text-fountain-ink">{currentExercise.topic?.course?.code || ''} - {currentExercise.topic?.title}</span>
                  </div>
                  
                  <Flashcard 
                    key={currentExercise.id} // forces remount on question change
                    questionText={currentExercise.questionText}
                    exerciseType={currentExercise.exerciseType || 'single_choice'}
                    choices={parsedChoices}
                    correctAnswer={currentExercise.correctAnswer}
                    explanation={currentExercise.explanation}
                    initialSelectedChoice={currentLog?.userAnswer}
                    hasBeenAnswered={!!currentLog}
                    onAnswer={handleAnswer}
                    onRequestExplanation={handleRequestExplanation}
                  />
                  
                  <div className="flex justify-between pt-6">
                    <Button 
                      variant="outline" 
                      onClick={() => setCurrentIndex(Math.max(0, currentIndex - 1))}
                      disabled={currentIndex === 0}
                    >
                      <ChevronLeft className="w-4 h-4 mr-2" />
                      Previous
                    </Button>
                    <Button
                      variant={currentIndex === exercises.length - 1 && missingCount === 0 ? "default" : "outline"}
                      disabled={currentIndex === exercises.length - 1 && missingCount > 0}
                      onClick={() => {
                        if (currentIndex === exercises.length - 1 && missingCount === 0) {
                          handleFinishSession()
                        } else {
                          setCurrentIndex(Math.min(exercises.length - 1, currentIndex + 1))
                        }
                      }}
                    >
                      {currentIndex === exercises.length - 1 && missingCount > 0 ? (
                        <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Generating...</>
                      ) : currentIndex === exercises.length - 1 && missingCount === 0 ? (
                        'Finish Session'
                      ) : (
                        <>Next <ChevronRight className="w-4 h-4 ml-2" /></>
                      )}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="text-center text-muted-foreground py-12">No exercises found for this selection.</div>
              )}
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center h-full text-charcoal-graphite gap-6 py-24 select-none">
              <FeynmanLogo size={280} />
              <div className="text-center max-w-sm px-4 space-y-2">
                <h2 className="font-display text-2xl font-bold italic text-charcoal-graphite">Feynman Study Hub</h2>
                <p className="text-sm text-charcoal-graphite/60 leading-relaxed font-sans">
                  "Understand everything. Simplify anything."
                </p>
                <p className="text-xs text-charcoal-graphite/40 mt-6 pt-4 border-t border-charcoal-graphite/10 font-sans">
                  Configure and start a custom study session from the left sidebar to begin.
                </p>
              </div>
            </div>
          )}
        </TabsContent>
        <TabsContent value="analytics" className="flex-1 overflow-y-auto m-0 p-0 min-w-0">
          <AnalyticsDashboard />
        </TabsContent>
      </Tabs>

      {/* VISUALIZER - 25vw */}
      {activeFile && (
        <div className="w-[25vw] border-l bg-background shrink-0 flex flex-col h-full relative z-40 shadow-lg">
          <div className="p-4 border-b flex items-center justify-between bg-muted/20">
            <div className="flex flex-col gap-0.5 min-w-0 max-w-[80%]">
              <h4 className="font-semibold text-sm truncate" title={activeFileTitle}>
                {activeFileTitle || 'Document Viewer'}
              </h4>
              {activeFile.toLowerCase().endsWith('.pdf') && (
                <span className="text-[10px] text-muted-foreground font-medium select-none">
                  Press <kbd className="bg-muted px-1 py-0.5 rounded border font-mono">{platform === 'mac' ? '⌘F' : 'Ctrl+F'}</kbd> to search PDF
                </span>
              )}
            </div>
            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground shrink-0" onClick={handleCloseFile}>
              <X className="w-4 h-4" />
            </Button>
          </div>
          <div className="flex-1 overflow-hidden p-0 relative">
            {activeFile.toLowerCase().endsWith('.pdf') ? (
              <iframe 
                src={`/api/file?path=${encodeURIComponent(activeFile)}${activeFilePage ? `#page=${activeFilePage}` : ''}`} 
                className="w-full h-full border-0"
              />
            ) : (
              <ScrollArea className="h-full w-full p-4">
                <div className="prose dark:prose-invert max-w-none text-xs leading-relaxed whitespace-pre-wrap font-sans">
                  {fileLoading ? (
                    <div className="flex items-center justify-center py-12">
                      <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
                    </div>
                  ) : (
                    renderTranscriptWithHighlight(fileContent, activeFileHighlight)
                  )}
                </div>
              </ScrollArea>
            )}
          </div>
        </div>
      )}

      {/* RIGHT SIDEBAR - 20vw */}
      <div className="h-full border-l bg-card shrink-0 flex flex-col border-charcoal-graphite/10 relative z-30 w-[20vw]">
        <VoiceHub liveAPI={liveAPI} onViewFile={handleViewFile} />
      </div>

      <Dialog open={!!selectedHistory} onOpenChange={(open) => !open && setSelectedHistory(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Session Results</DialogTitle>
          </DialogHeader>
          <div className="py-4 space-y-6">
            {selectedHistory && (
              <>
                <div className="space-y-2 border-b pb-4">
                  <p className="text-sm"><strong>Date:</strong> {new Date(selectedHistory.startTime).toLocaleString()}</p>
                  <p className="text-sm"><strong>Score:</strong> {selectedHistory.logs.filter((l: any) => (l.userAnswer !== null && l.userAnswer !== undefined && l.userAnswer !== '') && l.isCorrect).length} / {selectedHistory.logs.filter((l: any) => l.userAnswer !== null && l.userAnswer !== undefined && l.userAnswer !== '').length} correct</p>
                  {selectedHistory.logs.length > 0 && (
                    <ScrollArea className="h-[250px] border rounded-md p-3 mt-2 bg-muted/30">
                      {selectedHistory.logs.map((log: any, idx: number) => (
                        <div key={log.id} className="text-sm py-3 border-b last:border-0 flex flex-col gap-1">
                          <div className="flex items-start gap-2 font-medium">
                            <span className="mt-0.5">{log.isCorrect ? '✅' : '❌'}</span>
                            <span className="line-clamp-2">Q{idx + 1}: {log.exercise?.questionText}</span>
                          </div>
                          <div className="pl-6 space-y-0.5 text-xs">
                            <p className="text-muted-foreground"><span className="font-semibold text-foreground/70">Your Answer:</span> {log.userAnswer || 'Skipped'}</p>
                            {!log.isCorrect && (
                              <p className="text-green-600 dark:text-green-500"><span className="font-semibold">Correct Answer:</span> {log.exercise?.correctAnswer}</p>
                            )}
                          </div>
                        </div>
                      ))}
                    </ScrollArea>
                  )}
                </div>

                <div className="space-y-2">
                  <Label className="font-semibold">Tutor Chat History</Label>
                  {selectedHistory.chatLog ? (
                    <ScrollArea className="h-[250px] border rounded-md p-3 bg-muted/10 scrollbar-thin">
                      {JSON.parse(selectedHistory.chatLog).filter((m: any) => !m.text.startsWith('[SYSTEM')).map((msg: any, idx: number) => (
                        <div key={idx} className={`flex mb-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                          <div className={`max-w-[85%] rounded-xl px-4 py-2 text-sm shadow-sm border ${
                            msg.role === 'user' 
                              ? 'bg-fountain-ink/15 border-fountain-ink/25 text-charcoal-graphite' 
                              : 'bg-background border-charcoal-graphite/10 text-charcoal-graphite/90'
                          }`}>
                            {msg.text}
                          </div>
                        </div>
                      ))}
                      {JSON.parse(selectedHistory.chatLog).filter((m: any) => !m.text.startsWith('[SYSTEM')).length === 0 && (
                        <div className="text-sm text-muted-foreground text-center py-4">No conversation recorded.</div>
                      )}
                    </ScrollArea>
                  ) : (
                    <div className="text-sm text-muted-foreground text-center py-4">No conversation recorded.</div>
                  )}
                </div>

                <div className="pt-4 border-t">
                  <Button 
                    className="w-full bg-lecture-red hover:bg-lecture-red/90 text-white border-0 shadow-sm font-semibold h-11" 
                    onClick={async () => {
                      setIsLoading(true)
                      try {
                        const data = await getSessionWithExercises(selectedHistory.id)
                        if (data) {
                          setSession(data.session)
                          setExercises(data.exercises)
                          setCurrentIndex(0)
                          if (data.session.chatLog) {
                            liveAPI.setMessages(JSON.parse(data.session.chatLog))
                          } else {
                            liveAPI.setMessages([])
                          }
                          setSelectedHistory(null)
                        }
                      } catch (e) {
                        console.error(e)
                      }
                      setIsLoading(false)
                    }}
                    disabled={isLoading}
                  >
                    <PlayCircle className="w-4 h-4 mr-2" />
                    Load This Session
                  </Button>
                </div>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
