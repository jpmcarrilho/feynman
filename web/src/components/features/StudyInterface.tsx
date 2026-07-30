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
import { createStudySession, getTopics, getSessionHistory, logAnswer, saveChatLog } from '@/app/actions'
import { ChevronLeft, ChevronRight, PlusCircle, History } from 'lucide-react'
import { useLiveAPI } from '@/hooks/useLiveAPI'

export function StudyInterface() {
  const [topics, setTopics] = useState<any[]>([])
  const [selectedTopics, setSelectedTopics] = useState<string[]>([])
  const [histories, setHistories] = useState<any[]>([])
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [sessionDuration, setSessionDuration] = useState<number>(300) // Default 5 mins

  const [session, setSession] = useState<any>(null)
  const [exercises, setExercises] = useState<any[]>([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [selectedHistory, setSelectedHistory] = useState<any>(null)

  const currentExercise = exercises[currentIndex]

  const exerciseContext = currentExercise 
    ? `Topic: ${currentExercise.topic?.title || 'Unknown'}\nQuestion: ${currentExercise.questionText}\nChoices: ${JSON.parse(currentExercise.choices).join(', ')}`
    : ''

  const liveAPI = useLiveAPI(`You are a helpful tutor for an MIT economics course. Help the student understand the concepts. Don't give them the direct answer unless they've exhausted options.`)

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
      localStorage.setItem('dedp_active_session', JSON.stringify({
        session,
        exercises,
        currentIndex,
        chatLog: liveAPI.messages
      }))
    }
  }, [session, exercises, currentIndex, liveAPI.messages])

  const groupedTopics = useMemo(() => {
    return topics.reduce((acc, t) => {
      const course = t.course?.code || 'Unknown'
      if (!acc[course]) acc[course] = []
      acc[course].push(t)
      return acc
    }, {} as Record<string, any[]>)
  }, [topics])

  const handleStartSession = async () => {
    setIsLoading(true)
    try {
      const res = await createStudySession(selectedTopics, 10) // 10 questions per session
      setSession(res.session)
      setExercises(res.exercises)
      setCurrentIndex(0)
      setIsModalOpen(false)
      // refresh histories
      getSessionHistory().then(setHistories)
    } catch (e) {
      console.error(e)
    }
    setIsLoading(false)
  }

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

  const handleAnswer = async (isCorrect: boolean) => {
    if (session && currentExercise) {
      await logAnswer(session.id, currentExercise.id, isCorrect, 30) // dummy duration
    }
  }

  useEffect(() => {
    if (liveAPI.isConnected && currentExercise) {
      const context = `[SYSTEM MESSAGE: The student has navigated to a new exercise. Topic: ${currentExercise.topic?.title || 'Unknown'}. Question: ${currentExercise.questionText}. Choices: ${JSON.parse(currentExercise.choices).join(', ')}]`
      liveAPI.sendText(context)
    }
  }, [currentExercise?.id, liveAPI.isConnected])

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
    <div className="flex w-full h-screen overflow-hidden bg-background">
      
      {/* LEFT SIDEBAR - 20vw */}
      <div className="w-[20vw] border-r flex flex-col bg-muted/20 shrink-0">
        <div className="p-4 border-b">
          <Dialog open={isModalOpen} onOpenChange={setIsModalOpen}>
            <DialogTrigger render={<Button className="w-full flex gap-2" />}>
              <PlusCircle className="w-4 h-4" />
              Create Session
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>New Study Session</DialogTitle>
              </DialogHeader>
              <div className="py-4 space-y-6">
                <div>
                  <Label className="mb-2 block">Session Duration</Label>
                  <select 
                    value={sessionDuration / 60} 
                    onChange={e => setSessionDuration(Number(e.target.value) * 60)}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <option value="5">5 Minutes</option>
                    <option value="10">10 Minutes</option>
                    <option value="15">15 Minutes</option>
                    <option value="30">30 Minutes</option>
                    <option value="60">60 Minutes</option>
                  </select>
                </div>

                <div>
                  <div className="flex justify-between items-center mb-2">
                    <Label>Select Topics</Label>
                    <Button 
                      variant="ghost" 
                      size="sm" 
                      className="h-auto p-0 text-xs text-muted-foreground"
                      onClick={() => setSelectedTopics([])}
                    >
                      Clear / Randomize All
                    </Button>
                  </div>
                  <ScrollArea className="h-[250px] border rounded-md p-3">
                    {Object.keys(groupedTopics).map(courseCode => (
                      <div key={courseCode} className="mb-4 last:mb-0">
                        <div className="font-semibold text-sm text-foreground/80 mb-2 pb-1 border-b">
                          {courseCode}
                        </div>
                        <div className="space-y-2 pl-1">
                          {groupedTopics[courseCode].map((t: any) => (
                            <div key={t.id} className="flex items-start space-x-2">
                              <Checkbox 
                                id={t.id} 
                                checked={selectedTopics.includes(t.id)}
                                className="mt-1"
                                onCheckedChange={(c) => {
                                  if (c) setSelectedTopics([...selectedTopics, t.id])
                                  else setSelectedTopics(selectedTopics.filter(id => id !== t.id))
                                }}
                              />
                              <label htmlFor={t.id} className="text-sm leading-tight cursor-pointer">
                                {t.title}
                              </label>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </ScrollArea>
                </div>

                <Button onClick={handleStartSession} disabled={isLoading} className="w-full">
                  {isLoading ? 'Generating Exercises...' : 'Start Session'}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
        
        <div className="flex-1 overflow-auto p-4">
          <h3 className="font-semibold mb-4 flex items-center gap-2 text-sm text-muted-foreground">
            <History className="w-4 h-4" />
            Session History
          </h3>
          <div className="space-y-2">
            {histories.map(h => {
              const correct = h.logs.filter((l: any) => l.isCorrect).length
              const total = h.logs.length
              return (
                <div 
                  key={h.id} 
                  className="text-xs p-3 bg-white dark:bg-slate-900 border rounded-md shadow-sm cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                  onClick={() => setSelectedHistory(h)}
                >
                  <div className="font-medium text-foreground">{new Date(h.startTime).toLocaleString()}</div>
                  <div className="text-muted-foreground mt-1 flex justify-between">
                    <span>Score: {correct}/{total}</span>
                    <span className={h.status === 'active' ? 'text-green-600' : 'text-blue-600'}>
                      {h.status}
                    </span>
                  </div>
                </div>
              )
            })}
            {histories.length === 0 && (
              <div className="text-sm text-muted-foreground text-center py-4">No past sessions</div>
            )}
          </div>
        </div>
      </div>

      {/* CENTER - 60vw */}
      <div className="flex-1 w-[60vw] flex flex-col p-8 overflow-y-auto">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-3xl font-bold tracking-tight">Active Study Session</h1>
          {session && (
            <Button variant="ghost" className="text-red-500 hover:text-red-700 hover:bg-red-50" onClick={() => {
              setSession(null)
              setExercises([])
              setCurrentIndex(0)
              localStorage.removeItem('dedp_active_session')
            }}>
              End Session
            </Button>
          )}
        </div>
        
        {session ? (
          <div className="w-full max-w-3xl mx-auto space-y-8 pb-12">
            <SessionTimer durationSeconds={sessionDuration} startTime={session.startTime} />
            
            {currentExercise ? (
              <div className="space-y-4">
                <div className="flex justify-between items-center text-sm font-medium text-muted-foreground bg-muted/50 p-3 rounded-lg border">
                  <span>Question {currentIndex + 1} of {exercises.length}</span>
                  <span className="font-semibold">{currentExercise.topic?.course?.code || ''} - {currentExercise.topic?.title}</span>
                </div>
                
                <Flashcard 
                  key={currentExercise.id} // forces remount on question change
                  questionText={currentExercise.questionText}
                  choices={JSON.parse(currentExercise.choices)}
                  correctAnswer={currentExercise.correctAnswer}
                  explanation={currentExercise.explanation}
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
                    variant={currentIndex === exercises.length - 1 ? "default" : "outline"}
                    onClick={() => {
                      if (currentIndex === exercises.length - 1) {
                        handleFinishSession()
                      } else {
                        setCurrentIndex(Math.min(exercises.length - 1, currentIndex + 1))
                      }
                    }}
                  >
                    {currentIndex === exercises.length - 1 ? 'Finish Session' : 'Next'}
                    {currentIndex !== exercises.length - 1 && <ChevronRight className="w-4 h-4 ml-2" />}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="text-center text-muted-foreground py-12">No exercises found for this selection.</div>
            )}
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-4">
            <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center">
              <PlusCircle className="w-8 h-8 text-muted-foreground/50" />
            </div>
            <p>Create a session from the left sidebar to begin.</p>
          </div>
        )}
      </div>

      {/* RIGHT SIDEBAR - 20vw */}
      <div className="w-[20vw] border-l bg-muted/10 shrink-0">
        <VoiceHub liveAPI={liveAPI} />
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
                  <p className="text-sm"><strong>Score:</strong> {selectedHistory.logs.filter((l: any) => l.isCorrect).length} / {selectedHistory.logs.length} correct</p>
                  {selectedHistory.logs.length > 0 && (
                    <ScrollArea className="h-[120px] border rounded-md p-3 mt-2 bg-muted/30">
                      {selectedHistory.logs.map((log: any, idx: number) => (
                        <div key={log.id} className="text-sm py-1 border-b last:border-0 flex items-center gap-2">
                          <span>{log.isCorrect ? '✅' : '❌'}</span>
                          <span>Question {idx + 1}</span>
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
                          <div className={`max-w-[85%] rounded-xl px-4 py-2 text-sm ${msg.role === 'user' ? 'bg-blue-600 text-white' : 'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700'}`}>
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
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
