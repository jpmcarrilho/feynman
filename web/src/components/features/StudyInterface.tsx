'use client'

import { useState, useEffect, useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { Flashcard } from './Flashcard'
import { SessionTimer } from './SessionTimer'
import { VoiceHub } from './VoiceHub'
import { Dialog, DialogTrigger } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { 
  createStudySession, 
  getTopics, 
  getSessionHistory, 
  logAnswer, 
  saveChatLog, 
  finishStudySession, 
  getSessionWithExercises, 
  getClassContextForTopic, 
  generateNextExercise, 
  deleteStudySession, 
  generateSessionSummary 
} from '@/app/actions'
import { 
  ChevronLeft, 
  ChevronRight, 
  PlusCircle, 
  History, 
  Loader2, 
  Minimize2, 
  Maximize2, 
  Sparkles 
} from 'lucide-react'
import { useLiveAPI } from '@/hooks/useLiveAPI'
import { AnalyticsDashboard } from './AnalyticsDashboard'
import { FeynmanLogo } from './FeynmanLogo'
import { ConfigureSessionDialog } from './ConfigureSessionDialog'
import { SessionResultsDialog } from './SessionResultsDialog'
import { SessionHistoryList } from './SessionHistoryList'
import { SideVisualizer } from './SideVisualizer'

export function StudyInterface() {
  const [topics, setTopics] = useState<any[]>([])
  const [selectedTopics, setSelectedTopics] = useState<string[]>([])
  const [histories, setHistories] = useState<any[]>([])
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [sessionDuration, setSessionDuration] = useState<number>(300) // Default 5 mins
  const [questionCount, setQuestionCount] = useState<number>(10)

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
  const [isGeneratingSummary, setIsGeneratingSummary] = useState<boolean>(false)

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
        if (parsed.sessionDuration !== undefined) {
          setSessionDuration(parsed.sessionDuration)
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
          chatLog: liveAPI.messages,
          sessionDuration
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
              chatLog: [], // Strip the heavy chat log to save space
              sessionDuration
            }))
          } catch (fallbackError) {
            console.error("Failed to write even basic session info to localStorage:", fallbackError)
          }
        } else {
          console.error("Failed to save active session state to localStorage:", error)
        }
      }
    }
  }, [session, exercises, currentIndex, missingCount, liveAPI.messages, sessionDuration])

  const handleDeleteSession = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    if (typeof window !== 'undefined') {
      const ok = window.confirm('Are you sure you want to delete this study session?')
      if (ok) {
        const success = await deleteStudySession(id);
        if (success) {
          setHistories(prev => prev.filter(h => h.id !== id))
          if (session?.id === id) {
            setSession(null)
            setExercises([])
            setCurrentIndex(0)
            localStorage.removeItem('dedp_active_session')
          }
        }
      }
    }
  }

  const handleViewFile = (href: string) => {
    try {
      const url = new URL(href, window.location.origin);
      const filePath = url.searchParams.get('path');
      if (filePath) {
        setActiveFile(filePath);
        
        // Extract page parameter if present
        const pageMatch = url.hash.match(/page=(\d+)/);
        if (pageMatch) {
          setActiveFilePage(parseInt(pageMatch[1], 10));
        } else {
          setActiveFilePage(null);
        }

        // Extract highlight parameter if present
        const highlightParam = url.searchParams.get('highlight');
        if (highlightParam) {
          setActiveFileHighlight(decodeURIComponent(highlightParam));
        } else {
          setActiveFileHighlight(null);
        }

        // Set readable title
        const parts = filePath.split('/');
        const fileName = parts[parts.length - 1];
        setActiveFileTitle(fileName.replace(/_+/g, ' '));
      }
    } catch (e) {
      console.error("Failed to parse document link:", e);
    }
  }

  const handleCloseFile = () => {
    setActiveFile(null);
    setActiveFilePage(null);
    setActiveFileHighlight(null);
    setActiveFileTitle('');
    setFileContent('');
  }

  const handleGenerateSummary = async () => {
    if (!session) return
    setIsGeneratingSummary(true)
    try {
      const result = await generateSessionSummary(session.id)
      if (result && result.filePath) {
        // Force the visualizer to show the newly generated markdown file!
        setActiveFile(result.filePath)
        setActiveFileTitle("Session Summary Study Guide")
        setActiveFilePage(null)
        setActiveFileHighlight(null)
        setFileContent(result.content || '')
      }
    } catch (e) {
      console.error("Failed to generate session summary:", e)
    } finally {
      setIsGeneratingSummary(false)
    }
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
          const newEx = await generateNextExercise(
            session.id, 
            selectedTopics.length > 0 ? selectedTopics : topics.map(t => t.id), 
            currentIds, 
            missingCount
          );
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
      // Save final chat log and mark session as completed in DB
      await Promise.all([
        saveChatLog(session.id, liveAPI.messages),
        finishStudySession(session.id)
      ])
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

  const handleLoadSession = async (id: string) => {
    setIsLoading(true)
    try {
      const data = await getSessionWithExercises(id)
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
  }

  return (
    <div className="flex w-full h-screen overflow-hidden bg-background font-sans relative">

      {/* FIXED FLOATING LOGO BAR - Top Left (stays in place whether left sidebar is active or collapsed - Desktop only) */}
      <div className="hidden xl:flex absolute top-[16px] left-4 z-50 cursor-pointer items-center gap-2 select-none" onClick={() => window.location.href = '/'}>
        <FeynmanLogo variant="mini" size={48} className="stroke-charcoal-graphite transition-transform duration-200 hover:scale-105 animate-sketch-draw" />
        <span className="font-display text-2xl italic font-bold tracking-tight text-charcoal-graphite transition-colors duration-200 hover:text-fountain-ink">Feynman</span>
      </div>

      {/* LEFT SIDEBAR - 20vw (Desktop only) */}
      <div className={`hidden xl:flex h-full border-r flex-col bg-card text-charcoal-graphite shrink-0 transition-all duration-300 ease-in-out border-charcoal-graphite/10 relative z-30 ${
        isFocusMode ? 'xl:w-0 xl:overflow-hidden xl:border-r-0 xl:opacity-0' : 'xl:w-[20vw] xl:opacity-100'
      }`}>
        {/* Header spacer to match the fixed absolute logo */}
        <div className="h-[80px] border-b border-charcoal-graphite/10 shrink-0" />

        <div className="p-4 border-b border-charcoal-graphite/10 shrink-0">
          <Dialog open={isModalOpen} onOpenChange={setIsModalOpen}>
            <DialogTrigger render={<Button className="w-full flex gap-2 bg-lecture-red hover:bg-lecture-red/90 text-white border-0 shadow-sm font-semibold h-11 shrink-0" />}>
              <PlusCircle className="w-4 h-4" />
              Create Session
            </DialogTrigger>
            <ConfigureSessionDialog 
              topics={topics}
              selectedTopics={selectedTopics}
              setSelectedTopics={setSelectedTopics}
              sessionDuration={sessionDuration}
              setSessionDuration={setSessionDuration}
              questionCount={questionCount}
              setQuestionCount={setQuestionCount}
              onStartSession={handleStartSession}
              isLoading={isLoading}
            />
          </Dialog>
        </div>
        
        <div className="flex-1 overflow-auto p-4">
          <h3 className="font-semibold mb-4 flex items-center gap-2 text-sm text-charcoal-graphite/60">
            <History className="w-4 h-4 text-fountain-ink" />
            Session History
          </h3>
          <SessionHistoryList
            histories={histories}
            session={session}
            setSelectedHistory={setSelectedHistory}
            onDeleteSession={handleDeleteSession}
          />
        </div>
      </div>

      {/* CENTER MAIN COMPONENT - Responsive width layout */}
      <Tabs 
        defaultValue="study" 
        className={`flex-1 flex flex-col transition-all duration-300 ease-in-out bg-background w-full ${
          isFocusMode 
            ? activeFile ? 'xl:w-[55vw]' : 'xl:w-[80vw]'
            : activeFile ? 'xl:w-[35vw]' : 'xl:w-[60vw]'
        }`}
      >
        <div className={`pt-4 pb-4 px-4 sm:px-8 border-b border-charcoal-graphite/10 transition-all duration-300 flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 ${
          isFocusMode ? 'xl:pl-48' : 'xl:pl-8'
        }`}>
          {/* Logo & Title (Desktop & Mobile Unified Header) */}
          <div className="cursor-pointer flex items-center gap-2 select-none" onClick={() => window.location.href = '/'}>
            <FeynmanLogo variant="mini" size={36} className="stroke-charcoal-graphite transition-transform duration-200 hover:scale-105" />
            <span className="font-display text-xl sm:text-2xl italic font-bold tracking-tight text-charcoal-graphite">Feynman</span>
          </div>

          {/* Tabs and Focus Mode Trigger row */}
          <div className="flex items-center gap-4 w-full sm:w-auto">
            <TabsList className="bg-muted border border-charcoal-graphite/5 p-1 rounded-lg w-full sm:w-auto flex justify-around">
              <TabsTrigger value="study" className="flex-1 sm:flex-initial data-[state=active]:bg-sketchbook-cream data-[state=active]:text-charcoal-graphite font-semibold text-xs sm:text-sm">Study</TabsTrigger>
              <TabsTrigger value="chat" className="xl:hidden flex-1 sm:flex-initial data-[state=active]:bg-sketchbook-cream data-[state=active]:text-charcoal-graphite font-semibold text-xs sm:text-sm">Tutor</TabsTrigger>
              <TabsTrigger value="history" className="xl:hidden flex-1 sm:flex-initial data-[state=active]:bg-sketchbook-cream data-[state=active]:text-charcoal-graphite font-semibold text-xs sm:text-sm">History</TabsTrigger>
              <TabsTrigger value="analytics" className="flex-1 sm:flex-initial data-[state=active]:bg-sketchbook-cream data-[state=active]:text-charcoal-graphite font-semibold text-xs sm:text-sm">Analytics</TabsTrigger>
            </TabsList>
            
            {/* Focus Mode Trigger (Desktop only helper) */}
            <Button 
              variant="ghost" 
              size="icon" 
              onClick={() => setIsFocusMode(!isFocusMode)}
              title={isFocusMode ? "Exit Focus Mode" : "Focus Mode"}
              className="hidden sm:flex h-8 w-8 text-charcoal-graphite/70 hover:bg-muted hover:text-charcoal-graphite rounded-md transition-all duration-200 border border-charcoal-graphite/5 shadow-sm shrink-0"
            >
              {isFocusMode ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
            </Button>
          </div>
        </div>
        
        <TabsContent value="study" className="flex-1 overflow-y-auto p-4 sm:p-8 m-0 min-w-0">
          {session ? (
            <div className="w-full max-w-3xl mx-auto space-y-6 pb-12 min-w-0">
              
              {/* Actions Row: Create Session, Session Summary, and End Session (Above elapsed time) */}
              <div className="flex flex-wrap items-center gap-3 bg-card p-4 rounded-xl border border-charcoal-graphite/10 shadow-sm justify-between">
                <div className="flex flex-wrap items-center gap-2">
                  <Dialog open={isModalOpen} onOpenChange={setIsModalOpen}>
                    <DialogTrigger render={<Button className="flex gap-1.5 bg-lecture-red hover:bg-lecture-red/90 text-white border-0 shadow-sm font-semibold h-9 px-3 text-xs rounded-lg" />}>
                      <PlusCircle className="w-4 h-4" />
                      <span>New Session</span>
                    </DialogTrigger>
                    <ConfigureSessionDialog 
                      topics={topics}
                      selectedTopics={selectedTopics}
                      setSelectedTopics={setSelectedTopics}
                      sessionDuration={sessionDuration}
                      setSessionDuration={setSessionDuration}
                      questionCount={questionCount}
                      setQuestionCount={setQuestionCount}
                      onStartSession={handleStartSession}
                      isLoading={isLoading}
                    />
                  </Dialog>

                  <Button 
                    variant="outline"
                    className="text-fountain-ink border-fountain-ink/30 hover:bg-fountain-ink/5 font-medium flex items-center gap-1.5 shadow-sm h-9 px-3 text-xs rounded-lg"
                    onClick={handleGenerateSummary}
                    disabled={isGeneratingSummary}
                  >
                    {isGeneratingSummary ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-fountain-ink" />
                    ) : (
                      <Sparkles className="w-3.5 h-3.5 text-bongo-gold fill-bongo-gold" />
                    )}
                    <span>Session Summary</span>
                  </Button>
                </div>

                <Button 
                  variant="ghost" 
                  className="text-lecture-red hover:text-lecture-red hover:bg-lecture-red/10 border border-transparent hover:border-lecture-red/20 font-medium h-9 px-3 text-xs rounded-lg" 
                  onClick={handleFinishSession}
                >
                  End Session
                </Button>
              </div>

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
                    <span className="font-semibold text-fountain-ink truncate max-w-[120px] sm:max-w-none">{currentExercise.topic?.course?.code || ''} - {currentExercise.topic?.title}</span>
                  </div>

                  {/* Interactive Arrow Navigation Bar */}
                  <div className="flex justify-between items-center w-full select-none gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setCurrentIndex(Math.max(0, currentIndex - 1))}
                      disabled={currentIndex === 0}
                      className="flex-1 max-w-[120px] h-9 gap-1 font-semibold text-xs border border-charcoal-graphite/10 hover:bg-muted rounded-lg shrink-0"
                    >
                      <ChevronLeft className="w-3.5 h-3.5" />
                      Prev
                    </Button>
                    
                    <div className="flex-1 border-b border-dashed border-charcoal-graphite/10" />

                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        if (currentIndex === exercises.length - 1 && missingCount === 0) {
                          handleFinishSession()
                        } else {
                          setCurrentIndex(Math.min(exercises.length - 1, currentIndex + 1))
                        }
                      }}
                      disabled={currentIndex === exercises.length - 1 && missingCount > 0}
                      className="flex-1 max-w-[120px] h-9 gap-1 font-semibold text-xs border border-charcoal-graphite/10 hover:bg-muted rounded-lg shrink-0"
                    >
                      Next
                      <ChevronRight className="w-3.5 h-3.5" />
                    </Button>
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
            <div className="flex-1 flex flex-col items-center justify-center h-full text-charcoal-graphite gap-6 py-12 sm:py-24 select-none">
              <FeynmanLogo size={180} variant="thinking" className="sm:w-[280px] sm:h-[280px]" />
              <div className="text-center max-w-sm px-4 space-y-2">
                <h2 className="font-display text-2xl font-bold italic text-charcoal-graphite">Feynman Study Hub</h2>
                <p className="text-sm text-charcoal-graphite/60 leading-relaxed font-sans">
                  "Understand everything. Simplify anything."
                </p>
                <p className="text-xs text-charcoal-graphite/40 mt-6 pt-4 border-t border-charcoal-graphite/10 font-sans mb-6">
                  Configure and start a custom study session to begin.
                </p>

                {/* Center Create Session Button for all screen sizes */}
                <Dialog open={isModalOpen} onOpenChange={setIsModalOpen}>
                  <DialogTrigger render={<Button className="w-full max-w-[240px] flex gap-2 bg-lecture-red hover:bg-lecture-red/90 text-white border-0 shadow-md font-semibold h-11 mx-auto rounded-lg" />}>
                    <PlusCircle className="w-5 h-5" />
                    Create Study Session
                  </DialogTrigger>
                  <ConfigureSessionDialog 
                    topics={topics}
                    selectedTopics={selectedTopics}
                    setSelectedTopics={setSelectedTopics}
                    sessionDuration={sessionDuration}
                    setSessionDuration={setSessionDuration}
                    questionCount={questionCount}
                    setQuestionCount={setQuestionCount}
                    onStartSession={handleStartSession}
                    isLoading={isLoading}
                  />
                </Dialog>
              </div>
            </div>
          )}
        </TabsContent>

        <TabsContent value="chat" className="xl:hidden flex-1 overflow-y-auto m-0 p-0 min-w-0">
          <VoiceHub liveAPI={liveAPI} onViewFile={handleViewFile} />
        </TabsContent>

        <TabsContent value="history" className="xl:hidden flex-1 overflow-y-auto p-4 m-0 min-w-0">
          <h3 className="font-semibold mb-4 flex items-center gap-2 text-sm text-charcoal-graphite/60">
            <History className="w-4 h-4 text-fountain-ink" />
            Session History
          </h3>
          <SessionHistoryList
            histories={histories}
            session={session}
            setSelectedHistory={setSelectedHistory}
            onDeleteSession={handleDeleteSession}
          />
        </TabsContent>

        <TabsContent value="analytics" className="flex-1 overflow-y-auto m-0 p-4 sm:p-8 min-w-0">
          <AnalyticsDashboard />
        </TabsContent>
      </Tabs>

      {/* VISUALIZER - Full-screen overlay on mobile, beautiful side drawer on desktop */}
      {activeFile && (
        <div className="fixed inset-0 z-50 bg-background flex flex-col xl:relative xl:inset-auto xl:w-[25vw] xl:h-full xl:border-l xl:shadow-lg">
          <SideVisualizer
            activeFile={activeFile}
            activeFileTitle={activeFileTitle}
            activeFilePage={activeFilePage}
            activeFileHighlight={activeFileHighlight}
            platform={platform}
            fileLoading={fileLoading}
            fileContent={fileContent}
            onCloseFile={handleCloseFile}
            onViewFile={handleViewFile}
          />
        </div>
      )}

      {/* RIGHT SIDEBAR - 20vw (Desktop only) */}
      <div className="hidden xl:flex h-full border-l bg-card shrink-0 flex flex-col border-charcoal-graphite/10 relative z-30 w-[20vw]">
        <VoiceHub liveAPI={liveAPI} onViewFile={handleViewFile} />
      </div>

      {/* SESSION RESULTS MODAL */}
      <Dialog open={!!selectedHistory} onOpenChange={(open) => !open && setSelectedHistory(null)}>
        <SessionResultsDialog 
          selectedHistory={selectedHistory}
          onLoadSession={handleLoadSession}
          isLoading={isLoading}
        />
      </Dialog>
    </div>
  )
}
