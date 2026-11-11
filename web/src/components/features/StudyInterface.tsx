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
  getTopicsWithPerformance,
  getSessionHistory,
  logAnswer,
  saveChatLog,
  finishStudySession,
  getSessionWithExercises,
  getSessionDetail,
  getClassContextForTopic,
  generateNextExercise,
  deleteStudySession,
  generateSessionSummary,
  generateExamDiagnosis,
  generateStructuredStudyPlan,
  saveAndDeployStudyPlan,
  getStudyPlans,
  deleteStudyPlan,
  getAnalyticsData,
  generatePlannerResponse
} from '@/app/actions'
import {
  ChevronLeft,
  ChevronRight,
  PlusCircle,
  History,
  Loader2,
  Minimize2,
  Maximize2,
  Sparkles,
  Calendar,
  CheckCircle,
  Play,
  Trash2,
  AlertCircle,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen
} from 'lucide-react'
import { useLiveAPI } from '@/hooks/useLiveAPI'
import { AnalyticsDashboard } from './AnalyticsDashboard'
import { FeynmanLogo } from './FeynmanLogo'
import { ConfigureSessionDialog } from './ConfigureSessionDialog'
import { SessionResultsDialog } from './SessionResultsDialog'
import { SessionHistoryList } from './SessionHistoryList'
import { SideVisualizer } from './SideVisualizer'
import { StudyPlanDraftWidget } from './StudyPlanDraftWidget'
import { ResourcesDashboard } from './ResourcesDashboard'

// Helper functions for safe storage access with automatic sessionStorage fallback if localStorage is full
const safeGetItem = (key: string): string | null => {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(key) || sessionStorage.getItem(key);
  } catch (e) {
    try {
      return sessionStorage.getItem(key);
    } catch (inner) {
      return null;
    }
  }
};

const safeSetItem = (key: string, value: string): boolean => {
  if (typeof window === 'undefined') return false;
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (e) {
    try {
      sessionStorage.setItem(key, value);
      return true;
    } catch (inner) {
      return false;
    }
  }
};

const safeRemoveItem = (key: string) => {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(key);
  } catch (e) {}
  try {
    sessionStorage.removeItem(key);
  } catch (e) {}
};

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
  const [isProfessorSidebarHidden, setIsProfessorSidebarHidden] = useState(false)
  const [isVisualizerFullWidth, setIsVisualizerFullWidth] = useState(false)

  // --- NEW EXAM MODE STATES ---
  const [draftAnswers, setDraftAnswers] = useState<Record<string, string>>({})
  const [flaggedIds, setFlaggedIds] = useState<string[]>([])
  const [timeLeft, setTimeLeft] = useState<number | null>(null)
  const [isDiagnosisLoading, setIsDiagnosisLoading] = useState(false)

  // --- NEW STRUCTURED STUDY PLAN STATES ---
  const [activePlan, setActivePlan] = useState<any>(null)
  const [draftPlan, setDraftPlan] = useState<any>(null)
  const [isGeneratingPlan, setIsGeneratingPlan] = useState(false)
  const [isDeployingPlan, setIsDeployingPlan] = useState(false)
  const [activeTab, setActiveTab] = useState<string>('study')

  // Dedicated conversational planner chat states
  const [plannerChat, setPlannerChat] = useState<Array<{ role: 'user' | 'assistant', content: string }>>([])
  const [plannerInput, setPlannerInput] = useState('')
  const [isPlannerChatLoading, setIsPlannerChatLoading] = useState(false)

  // Side Visualizer States
  const [activeFile, setActiveFile] = useState<string | null>(null)
  const [activeFilePage, setActiveFilePage] = useState<number | null>(null)
  const [activeFileHighlight, setActiveFileHighlight] = useState<string | null>(null)
  const [activeFileTitle, setActiveFileTitle] = useState<string>('')
  const [fileContent, setFileContent] = useState<string>('')
  const [fileLoading, setFileLoading] = useState<boolean>(false)
  const [isGeneratingSummary, setIsGeneratingSummary] = useState<boolean>(false)
  const [isVisualizerExpanded, setIsVisualizerExpanded] = useState<boolean>(false)

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

  const liveAPI = useLiveAPI(`You are a helpful, encouraging, and brilliant professor for MIT MicroMasters courses, embodying the Feynman learning philosophy. You are currently acting as an interactive learning guide and Socratic Examiner.

Adhere strictly to these teaching guidelines:
1. Dynamic Socratic Exploration: Act like a supportive MIT mentor. Encourage the student to think through problems and share their logic when they are trying to solve them, rather than immediately giving away the answers.
2. HELP & STUCK MANDATE (CRITICAL): If the student explicitly states "I don't know", "I am stuck", "Please explain", "Explain it to me", "Help", or similar, you MUST IMMEDIATELY stop the Socratic questioning. Break character and provide a beautifully clear, step-by-step, intuitive explanation of the concepts, correct answer, and logic. Never keep asking a student to explain or defend their logic when they state they do not know or are stuck.
3. Proactive Encouraging Challenges: Before a student selects an option, you can guide them with gentle, leading questions to analyze the context (e.g., "In this scenario, how do you think we should calculate standard errors?"). If they aren't sure, offer them a small hint or explain the core intuition first.
4. Feynman Technique Analogy: When explaining complex concepts or equations, make them extremely easy to understand by using simple language and colorful, intuitive analogies (e.g., water pipes, bongo drums, or visual sketches). Remain clear, concise, and highly educational.
5. Loop Prevention: If the student has already shared their reasoning, asks for direct confirmation, or submits their answer, break the Socratic exploration immediately to validate them and explain the correct concepts clearly and rewardingly. Avoid repetitive Socratic prompting.`)

  const loadActivePlan = async () => {
    try {
      const plans = await getStudyPlans();
      const active = plans.find((p: any) => p.status === 'active');
      setActivePlan(active || null);

      // Initialize the planner workspace chat list with a highly personalized Socratic greeting if empty
      if (!active && plannerChat.length === 0) {
        setPlannerChat([
          {
            role: 'assistant',
            content: "Welcome to your AI Curriculum Planner Workspace! I am your Socratic Academic Advisor.\n\nI've analyzed your performance history and found some critical focus areas: JPAL Data Logistics (33%), Sampling & Power (44%), and Leaders (44%).\n\nHow should we structure your timeline? Tell me your available daily hours (e.g. 'I want 3 sessions a day, 2 hours each, from Tuesday to Friday'), or click on one of the suggested pre-ideas below to design your curriculum!"
          }
        ]);
      }
    } catch (e) {
      console.error("Failed to load active study plan", e);
    }
  }

  const handleGeneratePlan = async () => {
    setIsGeneratingPlan(true)
    try {
      // Clear any active session states first to let the draft planner render without state collisions
      setSession(null)
      setExercises([])
      setCurrentIndex(0)
      safeRemoveItem('dedp_active_session')

      // Fetch actual, current data analytics metrics to feed into Gemini advisor
      const analytics = await getAnalyticsData()
      
      // Prioritize the planner workspace chat messages first, falling back to general liveAPI history if empty
      const activeMessages = plannerChat.length > 1 ? plannerChat.map(m => ({
        role: m.role,
        text: m.content
      })) : liveAPI.messages;

      const plan = await generateStructuredStudyPlan(activeMessages, analytics)
      if (plan) {
        setDraftPlan(plan)
        setActiveTab('plan') // Programmatically switch to Plan tab where the draft widget renders!
      } else {
        alert("Failed to compile study plan. Please write more detail in the chat and try again.")
      }
    } catch (e) {
      console.error(e)
    }
    setIsGeneratingPlan(false)
  }

  const handleSendPlannerMessage = async (text: string) => {
    if (!text.trim() || isPlannerChatLoading) return
    const updatedMessages = [...plannerChat, { role: 'user' as const, content: text }]
    setPlannerChat(updatedMessages)
    setPlannerInput('')
    setIsPlannerChatLoading(true)

    try {
      const analytics = await getAnalyticsData()
      const response = await generatePlannerResponse(updatedMessages, analytics)
      if (response) {
        setPlannerChat([...updatedMessages, { role: 'assistant' as const, content: response }])
      }
    } catch (e) {
      console.error("Failed to send planner message:", e)
    } finally {
      setIsPlannerChatLoading(false)
    }
  }

  const handleDeployPlan = async (finalPlan: any) => {
    setIsDeployingPlan(true)
    try {
      const plan = await saveAndDeployStudyPlan(finalPlan)
      if (plan) {
        setDraftPlan(null)
        await loadActivePlan()
        getSessionHistory().then(setHistories)
      }
    } catch (e) {
      console.error(e)
    }
    setIsDeployingPlan(false)
  }

  const handleDeletePlan = async (planId: string) => {
    if (typeof window !== 'undefined') {
      const ok = window.confirm("Are you sure you want to delete this study plan curriculum? This will delete all of its pre-created study sessions.")
      if (ok) {
        await deleteStudyPlan(planId)
        await loadActivePlan()
        getSessionHistory().then(setHistories)
      }
    }
  }

  useEffect(() => {
    // Load initial data (including performance coverage metrics)
    getTopicsWithPerformance().then(setTopics)
    getSessionHistory().then(setHistories)
    loadActivePlan()

    // Load active session from local storage
    const savedSession = safeGetItem('dedp_active_session')
    if (savedSession) {
      try {
        const parsed = JSON.parse(savedSession)
        
        // Sync with the database to ensure we don't lose any questions generated on the server during refresh
        if (parsed.session?.id) {
          getSessionWithExercises(parsed.session.id).then(dbData => {
            if (dbData) {
              setSession(dbData.session)
              setExercises(dbData.exercises)
              
              // Correctly compute missingCount from target total count
              const targetCount = (parsed.exercises?.length || 0) + (parsed.missingCount || 0)
              const actualMissing = Math.max(0, targetCount - dbData.exercises.length)
              setMissingCount(actualMissing)
              
              setCurrentIndex(parsed.currentIndex || 0)
              if (parsed.sessionDuration !== undefined) {
                setSessionDuration(parsed.sessionDuration)
              }
              if (parsed.draftAnswers !== undefined) {
                setDraftAnswers(parsed.draftAnswers)
              }
              if (parsed.flaggedIds !== undefined) {
                setFlaggedIds(parsed.flaggedIds)
              }
              if (parsed.timeLeft !== undefined) {
                setTimeLeft(parsed.timeLeft)
              }
              if (parsed.chatLog && Array.isArray(parsed.chatLog)) {
                liveAPI.setMessages(parsed.chatLog)
              }
            } else {
              // Fallback to local storage state if not found in DB
              setSession(parsed.session)
              setExercises(parsed.exercises)
              setCurrentIndex(parsed.currentIndex || 0)
              if (parsed.missingCount !== undefined) {
                setMissingCount(parsed.missingCount)
              }
              if (parsed.sessionDuration !== undefined) {
                setSessionDuration(parsed.sessionDuration)
              }
              if (parsed.draftAnswers !== undefined) {
                setDraftAnswers(parsed.draftAnswers)
              }
              if (parsed.flaggedIds !== undefined) {
                setFlaggedIds(parsed.flaggedIds)
              }
              if (parsed.timeLeft !== undefined) {
                setTimeLeft(parsed.timeLeft)
              }
              if (parsed.chatLog && Array.isArray(parsed.chatLog)) {
                liveAPI.setMessages(parsed.chatLog)
              }
            }
          }).catch(err => {
            console.error("Error syncing active session with database:", err)
            // Fallback to local storage state on error
            setSession(parsed.session)
            setExercises(parsed.exercises)
            setCurrentIndex(parsed.currentIndex || 0)
            if (parsed.missingCount !== undefined) {
              setMissingCount(parsed.missingCount)
            }
            if (parsed.sessionDuration !== undefined) {
              setSessionDuration(parsed.sessionDuration)
            }
            if (parsed.draftAnswers !== undefined) {
              setDraftAnswers(parsed.draftAnswers)
            }
            if (parsed.flaggedIds !== undefined) {
              setFlaggedIds(parsed.flaggedIds)
            }
            if (parsed.timeLeft !== undefined) {
              setTimeLeft(parsed.timeLeft)
            }
            if (parsed.chatLog && Array.isArray(parsed.chatLog)) {
              liveAPI.setMessages(parsed.chatLog)
            }
          })
        } else {
          setSession(parsed.session)
          setExercises(parsed.exercises)
          setCurrentIndex(parsed.currentIndex || 0)
          if (parsed.missingCount !== undefined) {
            setMissingCount(parsed.missingCount)
          }
          if (parsed.sessionDuration !== undefined) {
            setSessionDuration(parsed.sessionDuration)
          }
          if (parsed.draftAnswers !== undefined) {
            setDraftAnswers(parsed.draftAnswers)
          }
          if (parsed.flaggedIds !== undefined) {
            setFlaggedIds(parsed.flaggedIds)
          }
          if (parsed.timeLeft !== undefined) {
            setTimeLeft(parsed.timeLeft)
          }
          if (parsed.chatLog && Array.isArray(parsed.chatLog)) {
            liveAPI.setMessages(parsed.chatLog)
          }
        }
      } catch (e) {
        console.error("Failed to parse saved session", e)
      }
    }
  }, [])

  // Save session state to local storage when it changes
  useEffect(() => {
    if (session) {
      try {
        // Strip out heavy fields like topic.content to avoid QuotaExceededError in localStorage
        const cleanExercises = exercises.map((ex: any) => {
          if (!ex) return ex;
          const { topic, ...rest } = ex;
          if (!topic) return ex;
          const { content, ...topicRest } = topic;
          return {
            ...rest,
            topic: topicRest
          };
        });

        const dataStr = JSON.stringify({
          session,
          exercises: cleanExercises,
          currentIndex,
          missingCount,
          chatLog: liveAPI.messages,
          sessionDuration,
          draftAnswers,
          flaggedIds,
          timeLeft
        });

        const success = safeSetItem('dedp_active_session', dataStr);
        if (!success) {
          throw new Error("QuotaExceededError");
        }
      } catch (error: any) {
        // Handle localStorage/sessionStorage quota limits gracefully without crashing the app
        console.warn("Browser storage limit reached. Conserving space by stripping the chat log from saved session state.")
        try {
          // Strip out heavy fields like topic.content to avoid QuotaExceededError in localStorage
          const cleanExercises = exercises.map((ex: any) => {
            if (!ex) return ex;
            const { topic, ...rest } = ex;
            if (!topic) return ex;
            const { content, ...topicRest } = topic;
            return {
              ...rest,
              topic: topicRest
            };
          });

          const fallbackStr = JSON.stringify({
            session,
            exercises: cleanExercises,
            currentIndex,
            missingCount,
            chatLog: [], // Strip the heavy chat log to save space
            sessionDuration,
            draftAnswers,
            flaggedIds,
            timeLeft
          });

          safeSetItem('dedp_active_session', fallbackStr);
        } catch (fallbackError) {
          console.warn("Failed to write even basic session info to browser storage:", fallbackError)
        }
      }
    }
  }, [session, exercises, currentIndex, missingCount, liveAPI.messages, sessionDuration, draftAnswers, flaggedIds, timeLeft])

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
            safeRemoveItem('dedp_active_session')
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
    setIsVisualizerFullWidth(false);
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

  const handleStartSession = async (
    mode: 'study' | 'exam' = 'study', 
    timeLimit: number | null = null, 
    sourcingMix: number = 50,
    weakPct: number = 60,
    unstudiedPct: number = 20,
    expertPct: number = 20
  ) => {
    setIsLoading(true)
    try {
      const res = await createStudySession(selectedTopics, questionCount, mode, timeLimit, sourcingMix, weakPct, unstudiedPct, expertPct)
      setSession(res.session)
      setExercises(res.exercises)
      setMissingCount(res.missingCount || 0)
      setCurrentIndex(0)
      setDraftAnswers({})
      setFlaggedIds([])
      setTimeLeft(timeLimit)
      setIsModalOpen(false)
      setActiveTab('study') // Ensure active tab shifts to 'study' immediately to reveal the active cards!
      // refresh histories
      getSessionHistory().then(setHistories)
    } catch (e) {
      console.error(e)
    }
    setIsLoading(false)
  }

  const handleStartWeekSession = async (topicIds: string[], weekName: string) => {
    setIsLoading(true)
    try {
      setSelectedTopics(topicIds)
      const res = await createStudySession(topicIds, questionCount, 'study', null, 50, 60, 20, 20)
      setSession(res.session)
      setExercises(res.exercises)
      setMissingCount(res.missingCount || 0)
      setCurrentIndex(0)
      setDraftAnswers({})
      setFlaggedIds([])
      setTimeLeft(null)
      setIsModalOpen(false)
      setActiveTab('study')
      getSessionHistory().then(setHistories)
    } catch (e) {
      console.error("Failed to start weekly session:", e)
    }
    setIsLoading(false)
  }

  const handleFinishExam = async () => {
    if (!session || isDiagnosisLoading) return;
    setIsDiagnosisLoading(true);
    try {
      const totalCount = exercises.length;
      let examScoreSum = 0;

      for (const ex of exercises) {
        const draftAns = draftAnswers[ex.id] || "";
        
        // Evaluate correctness (with proportional partial credit & negative marking rule)
        let isCorrect = false;
        let partialScore = 0;

        if (draftAns) {
          const isUserAnsArray = draftAns.startsWith('[') && draftAns.endsWith(']');
          const isCorrAnsArray = ex.correctAnswer.startsWith('[') && ex.correctAnswer.endsWith(']');

          if (isUserAnsArray) {
            try {
              const userAnsList = JSON.parse(draftAns);
              const correctAnsList = isCorrAnsArray ? JSON.parse(ex.correctAnswer) : [ex.correctAnswer];
              const choicesList = ex.choices ? JSON.parse(ex.choices) : [];

              const rightOptions = correctAnsList;
              const wrongOptions = choicesList.filter((c: string) => !correctAnsList.includes(c));

              const rightSelected = userAnsList.filter((c: string) => rightOptions.includes(c)).length;
              const wrongSelected = userAnsList.filter((c: string) => wrongOptions.includes(c)).length;

              const totalRight = rightOptions.length;
              const isDiscussionOrSurvey = totalRight > 0 && totalRight === choicesList.length;

              if (isDiscussionOrSurvey) {
                partialScore = 1.0;
                isCorrect = true;
              } else if (totalRight > 0) {
                // One wrong cancels one right, normalized to totalRight count
                const netScore = (rightSelected - wrongSelected) / totalRight;
                partialScore = Math.max(0, netScore);
                // Mark as correct if they got at least 50% of the choices right (proportional credit)
                isCorrect = partialScore >= 0.5;
              }
            } catch {
              isCorrect = false;
              partialScore = 0;
            }
          } else if (ex.exerciseType === 'numeric') {
            isCorrect = Math.abs(parseFloat(draftAns) - parseFloat(ex.correctAnswer)) < 0.01;
            partialScore = isCorrect ? 1.0 : 0.0;
          } else if (ex.exerciseType === 'dropdown') {
            try {
              if (draftAns.startsWith('{') && draftAns.endsWith('}')) {
                const parsedUserAns = JSON.parse(draftAns);
                const isCorrAnsArray = ex.correctAnswer.startsWith('[') && ex.correctAnswer.endsWith(']');
                const correctAnsList = isCorrAnsArray ? JSON.parse(ex.correctAnswer) : [ex.correctAnswer];
                
                let matchedCount = 0;
                const totalDropdowns = Object.keys(parsedUserAns).length;
                
                for (const [key, userVal] of Object.entries(parsedUserAns)) {
                  const cleanUserVal = String(userVal).trim().toLowerCase();
                  const cleanKey = String(key).trim().toLowerCase();
                  
                  const isMatch = correctAnsList.some((corr: string) => {
                    const cleanCorr = String(corr).trim().toLowerCase();
                    if (cleanCorr.includes(cleanKey)) {
                      const cleanCorrVal = cleanCorr.replace(cleanKey, "").trim();
                      return cleanCorrVal === cleanUserVal || 
                             cleanCorrVal.replace(/\\+/g, "") === cleanUserVal.replace(/\\+/g, "");
                    }
                    return cleanCorr === cleanUserVal || 
                           cleanCorr.replace(/\\+/g, "") === cleanUserVal.replace(/\\+/g, "");
                  });
                  
                  if (isMatch) matchedCount++;
                }
                
                if (totalDropdowns === 1) {
                  const userVal = Object.values(parsedUserAns)[0];
                  const cleanUserVal = String(userVal).trim().toLowerCase().replace(/\\+/g, "");
                  const cleanCorr = String(correctAnsList[0]).trim().toLowerCase().replace(/\\+/g, "");
                  isCorrect = cleanUserVal === cleanCorr;
                } else {
                  isCorrect = matchedCount === totalDropdowns && totalDropdowns === correctAnsList.length;
                }
              } else {
                isCorrect = draftAns.trim().toLowerCase() === ex.correctAnswer.trim().toLowerCase();
              }
            } catch {
              isCorrect = draftAns.trim().toLowerCase() === ex.correctAnswer.trim().toLowerCase();
            }
            partialScore = isCorrect ? 1.0 : 0.0;
          } else {
            isCorrect = draftAns.trim().toLowerCase() === ex.correctAnswer.trim().toLowerCase();
            partialScore = isCorrect ? 1.0 : 0.0;
          }
        }

        examScoreSum += partialScore;

        // Log to DB (dummy duration 30s)
        await logAnswer(session.id, ex.id, isCorrect, 30, draftAns);
      }

      // Mark session as completed
      const updatedSession = await finishStudySession(session.id);
      
      // Update local session state
      if (updatedSession) {
        const finalSession = await getSessionWithExercises(session.id);
        if (finalSession) {
          setSession(finalSession.session);
          setExercises(finalSession.exercises);
        }
      }

      // Trigger generateExamDiagnosis action
      const reportMarkdown = await generateExamDiagnosis(session.id);
      if (reportMarkdown) {
        // Automatically open inside Visualizer
        setFileContent(reportMarkdown);
        setActiveFileHighlight(null);
        setActiveFilePage(null);
        setActiveFileTitle("Timed Exam Diagnostic Report");
        
        // Trigger voice tutor summary if connected
        if (liveAPI.isConnected) {
          const scoreDisplay = `${examScoreSum.toFixed(2)}/${totalCount}`;
          const speechMsg = `[SYSTEM MESSAGE: The student has submitted their timed exam. They scored ${scoreDisplay} (${Math.round((examScoreSum/totalCount)*100)}%). Speak a supportive, Socratic, brief 2-3 sentence overview of their diagnostic results. Keep it warm, and mention you've pushed their full studies guide directly to their Side Visualizer.]`;
          liveAPI.sendText(speechMsg);
        }
      }

      // Clear active local storage
      safeRemoveItem('dedp_active_session');
      
      // Refresh histories
      getSessionHistory().then(setHistories);
    } catch (e) {
      console.error("Failed to finish timed exam:", e);
    } finally {
      setIsDiagnosisLoading(false);
    }
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

  // Exam Countdown Timer tick useEffect
  useEffect(() => {
    if (session?.mode === 'exam' && timeLeft !== null && timeLeft > 0 && session.status === 'active') {
      const interval = setInterval(() => {
        setTimeLeft(prev => {
          if (prev !== null && prev <= 1) {
            clearInterval(interval);
            handleFinishExam();
            return 0;
          }
          return prev !== null ? prev - 1 : null;
        });
      }, 1000);
      return () => clearInterval(interval);
    }
  }, [session, timeLeft]);

  const handleFinishSession = async () => {
    if (session) {
      setIsLoading(true)
      try {
        // Save final chat log and mark session as completed in DB
        await Promise.all([
          saveChatLog(session.id, liveAPI.messages),
          finishStudySession(session.id)
        ])

        // Fetch updated history so we can show results immediately!
        const updatedHistories = await getSessionHistory()
        setHistories(updatedHistories)

        const finishedSession = updatedHistories.find((h: any) => h.id === session.id)
        if (finishedSession) {
          setSelectedHistory(finishedSession)
        }
      } catch (e) {
        console.error("Failed to finish and save study session:", e)
      } finally {
        setIsLoading(false)
      }
    }

    setSession(null)
    setExercises([])
    setCurrentIndex(0)
    liveAPI.setMessages([])
    setDraftAnswers({})
    setFlaggedIds([])
    setTimeLeft(null)
    safeRemoveItem('dedp_active_session')

    if (!session) {
      getSessionHistory().then(setHistories)
    }
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
      if (session.mode === 'exam') {
        setDraftAnswers(prev => ({
          ...prev,
          [currentExercise.id]: userAnswer
        }));
      } else {
        await logAnswer(session.id, currentExercise.id, isCorrect, 30, userAnswer) // dummy duration

        setSession((prev: any) => ({
          ...prev,
          logs: [...(prev.logs || []), { exerciseId: currentExercise.id, isCorrect, userAnswer }]
        }))
      }
    }
  }

  useEffect(() => {
    if (!liveAPI.isConnected) return;

    if (session && currentExercise) {
      let contextMsg = `[SYSTEM MESSAGE: The student has navigated to a new exercise.
Topic: ${currentExercise.topic?.title || 'Unknown'}
Question: ${currentExercise.questionText}
Choices: ${parsedChoices.join(', ')}
Active Mode: ${session?.mode === 'exam' ? 'Timed Socratic Oral Defense Exam' : 'Interactive Practice'}]

<private_knowledge>
This is your private, hidden reference library. Use this context to formulate Socratic, probing questions and guide the student, but NEVER reveal, repeat, or summarize this text out loud.
If the student struggles, guide them to use analogies or explain concepts in their own words. Always reference exact file sources using clickable markdown links to the localPath.
Format links exactly like this:
- For Slides: [Slides File Title](/api/file?path=URL_ENCODED_LOCAL_PATH#page=PAGE_NUMBER)
- For Transcripts/Readings: [Transcript Title](/api/file?path=URL_ENCODED_LOCAL_PATH&highlight=SHORT_QUOTE)
`;

      if (classContext && classContext.length > 0) {
        classContext.forEach((t: any) => {
          contextMsg += `\n--- Unit: ${t.title} (File: ${t.localPath || 'Unknown'}) ---\n${t.content ? t.content : 'No content available.'}\n`;
        });
      }

      contextMsg += `\n</private_knowledge>

Now, act as the Thesis Examiner. Initiate oral defense. Welcome them to the question, challenge them on what they are thinking, and probe their initial intuition BEFORE they select any draft answer. Do not read the choices out loud. Ask them to explain the concepts in their own words!`;

      liveAPI.sendText(contextMsg)
    } else if (!session) {
      if (activeTab === 'plan') {
        const contextMsg = `[SYSTEM MESSAGE: The student is currently on the "Study Plan" tab, designing their personalized multi-day timeline curriculum preparing for their MicroMasters exams.
The student has stated they can study 2 hours in the morning, 2 hours in the afternoon, and 2 hours at night, Monday to Sunday (a 6-hour daily study block).
Converse with them as a warm Socratic Academic Advisor. Talk to them about opportunity costs of this rigorous schedule, discuss study methodologies (like Active Recall and Spaced Repetition), probe their study habits, and help them refine the plan.
If they ask to change or generate a study plan, guide them to click the gold "Plan" button in the chat header to compile/re-compile the curriculum timeline on screen!]`;
        liveAPI.sendText(contextMsg)
      } else {
        const contextMsg = `[SYSTEM MESSAGE: The student is currently browsing their main dashboard. They can configure and start custom practice sessions, review their histories, or go to the "Study Plan" tab to design a multi-day schedule.]`;
        liveAPI.sendText(contextMsg)
      }
    }
  }, [currentExercise?.id, liveAPI.isConnected, parsedChoices, classContext, session, activeTab])

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
        setDraftAnswers({})
        setFlaggedIds([])
        setTimeLeft(data.session.timeLimit)
        // The chat log is not part of the session payload; load it on demand
        liveAPI.setMessages([])
        try {
          const detail = await getSessionDetail(id)
          if (detail?.chatLog) {
            const restored = JSON.parse(detail.chatLog)
            if (Array.isArray(restored)) liveAPI.setMessages(restored)
          }
        } catch (e) {
          console.error('Failed to load chat log', e)
        }
        setSelectedHistory(null)
        setActiveTab('study') // Force-switch to the Study tab so the session starts immediately!
      }
    } catch (e) {
      console.error(e)
    }
    setIsLoading(false)
  }

  const getMainWidthClass = () => {
    if (isVisualizerFullWidth) {
      return 'xl:w-0 xl:overflow-hidden xl:border-r-0 xl:opacity-0';
    }
    if (isFocusMode && isProfessorSidebarHidden) {
      if (activeFile) {
        return isVisualizerExpanded ? 'xl:w-[55vw]' : 'xl:w-[75vw]';
      }
      return 'xl:w-[100vw]';
    }
    if (isFocusMode && !isProfessorSidebarHidden) {
      if (activeFile) {
        return isVisualizerExpanded ? 'xl:w-[35vw]' : 'xl:w-[55vw]';
      }
      return 'xl:w-[80vw]';
    }
    if (!isFocusMode && isProfessorSidebarHidden) {
      if (activeFile) {
        return isVisualizerExpanded ? 'xl:w-[35vw]' : 'xl:w-[55vw]';
      }
      return 'xl:w-[80vw]';
    }
    // Both sidebars open
    if (activeFile) {
      return isVisualizerExpanded ? 'xl:w-[15vw]' : 'xl:w-[35vw]';
    }
    return 'xl:w-[60vw]';
  }

  return (
    <div className="flex w-full h-screen overflow-hidden bg-background font-sans relative">

      {/* LEFT SIDEBAR - 20vw / 64px / 0px (Desktop only) */}
      <div className={`hidden xl:flex h-full border-r flex-col bg-card text-charcoal-graphite shrink-0 transition-all duration-300 ease-in-out border-charcoal-graphite/10 relative z-30 ${
        isVisualizerFullWidth 
          ? 'xl:w-0 xl:overflow-hidden xl:border-r-0 xl:opacity-0' 
          : isFocusMode ? 'xl:w-[64px] xl:opacity-100' : 'xl:w-[20vw] xl:opacity-100'
      }`}>
        {isFocusMode ? (
          /* COLLAPSED VIEW: Show only the Open toggle button */
          <div className="h-[80px] shrink-0 flex items-center justify-center border-b border-charcoal-graphite/10">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setIsFocusMode(false)}
              title="Show Left Sidebar"
              className="h-9 w-9 text-charcoal-graphite/70 hover:bg-muted rounded-md transition-all duration-200"
            >
              <PanelLeftOpen className="w-5 h-5 animate-sketch-draw" />
            </Button>
          </div>
        ) : (
          /* EXPANDED VIEW: Show full logo, Close toggle button, and sidebar contents */
          <>
            {/* Header with Logo and Close toggle */}
            <div className="h-[80px] px-4 border-b border-charcoal-graphite/10 shrink-0 flex items-center justify-between">
              <div className="cursor-pointer flex items-center gap-2 select-none" onClick={() => window.location.href = '/'}>
                <FeynmanLogo variant="mini" size={40} className="stroke-charcoal-graphite transition-transform duration-200 hover:scale-105 animate-sketch-draw" />
                <span className="font-display text-xl sm:text-2xl italic font-bold tracking-tight text-charcoal-graphite transition-colors duration-200 hover:text-fountain-ink">Feynman</span>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => setIsFocusMode(true)}
                title="Hide Left Sidebar"
                className="h-8 w-8 text-charcoal-graphite/70 hover:bg-muted rounded-md transition-all duration-200 shrink-0"
              >
                <PanelLeftClose className="w-4 h-4" />
              </Button>
            </div>

            {/* Sidebar Contents */}
            <div className="flex-1 flex flex-col min-h-0">
              <div className="p-4 border-b border-charcoal-graphite/10 shrink-0 space-y-3">
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

                <Button 
                  onClick={handleGeneratePlan}
                  disabled={isGeneratingPlan}
                  variant="outline"
                  className="w-full flex gap-2 border-bongo-gold/40 text-bongo-gold bg-bongo-gold/5 hover:bg-bongo-gold/15 font-semibold h-11 shrink-0 rounded-lg shadow-sm"
                >
                  {isGeneratingPlan ? (
                    <><Loader2 className="w-4 h-4 animate-spin text-bongo-gold" /> Designing...</>
                  ) : (
                    <><Sparkles className="w-4 h-4 fill-bongo-gold text-bongo-gold" /> Design Study Plan</>
                  )}
                </Button>
              </div>

              <div className="flex-1 overflow-auto p-4 custom-scrollbar">
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
          </>
        )}
      </div>

      {/* CENTER MAIN COMPONENT - Responsive width layout */}
      <Tabs
        value={activeTab}
        onValueChange={setActiveTab}
        className={`flex-1 flex flex-col transition-all duration-300 ease-in-out bg-background w-full ${getMainWidthClass()}`}
      >
        <div className="pt-4 pb-4 px-4 sm:px-8 border-b border-charcoal-graphite/10 transition-all duration-300 flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 xl:pl-8">
          {/* Logo & Title (Desktop & Mobile Unified Header - Hidden on Desktop) */}
          <div className="cursor-pointer flex xl:hidden items-center gap-2 select-none" onClick={() => window.location.href = '/'}>
            <FeynmanLogo variant="mini" size={36} className="stroke-charcoal-graphite transition-transform duration-200 hover:scale-105" />
            <span className="font-display text-xl sm:text-2xl italic font-bold tracking-tight text-charcoal-graphite">Feynman</span>
          </div>

          {/* Tabs row */}
          <div className="flex items-center gap-4 w-full sm:w-auto">
            <TabsList className="bg-muted border border-charcoal-graphite/5 p-1 rounded-lg w-full sm:w-auto flex justify-around">
              <TabsTrigger value="study" className="flex-1 sm:flex-initial data-[state=active]:bg-sketchbook-cream data-[state=active]:text-charcoal-graphite font-semibold text-xs sm:text-sm">Study</TabsTrigger>
              <TabsTrigger value="plan" className="flex-1 sm:flex-initial data-[state=active]:bg-sketchbook-cream data-[state=active]:text-charcoal-graphite font-semibold text-xs sm:text-sm">Study Plan</TabsTrigger>
              <TabsTrigger value="resources" className="flex-1 sm:flex-initial data-[state=active]:bg-sketchbook-cream data-[state=active]:text-charcoal-graphite font-semibold text-xs sm:text-sm">Resources</TabsTrigger>
              <TabsTrigger value="chat" className="xl:hidden flex-1 sm:flex-initial data-[state=active]:bg-sketchbook-cream data-[state=active]:text-charcoal-graphite font-semibold text-xs sm:text-sm">Tutor</TabsTrigger>
              <TabsTrigger value="history" className="xl:hidden flex-1 sm:flex-initial data-[state=active]:bg-sketchbook-cream data-[state=active]:text-charcoal-graphite font-semibold text-xs sm:text-sm">History</TabsTrigger>
              <TabsTrigger value="analytics" className="flex-1 sm:flex-initial data-[state=active]:bg-sketchbook-cream data-[state=active]:text-charcoal-graphite font-semibold text-xs sm:text-sm">Analytics</TabsTrigger>
            </TabsList>
          </div>
        </div>

        <TabsContent value="study" className="flex-1 overflow-y-auto p-4 sm:p-8 m-0 min-w-0">
          {session ? (
            <div className="w-full max-w-3xl mx-auto space-y-6 pb-12 min-w-0">

              {/* Actions Row: Create Session, Session Summary, and End Session (Above elapsed time) */}
              <div className="flex flex-wrap items-center gap-3 bg-card p-4 rounded-xl border border-charcoal-graphite/10 shadow-sm justify-between">
                <div className="flex flex-wrap items-center gap-2">
                  <Dialog open={isModalOpen} onOpenChange={setIsModalOpen}>
                    <DialogTrigger render={<Button className="flex gap-1.5 bg-lecture-red hover:bg-lecture-red/90 text-white border-0 shadow-sm font-semibold h-9 px-3 text-xs rounded-lg animate-sketch-draw" />}>
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

                  {session.mode !== 'exam' && (
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
                  )}
                </div>

                <Button
                  variant="ghost"
                  className="text-lecture-red hover:text-lecture-red hover:bg-lecture-red/10 border border-transparent hover:border-lecture-red/20 font-medium h-9 px-3 text-xs rounded-lg"
                  onClick={handleFinishSession}
                >
                  {session.mode === 'exam' ? 'Cancel Exam' : 'End Session'}
                </Button>
              </div>

              {/* TIMERS: Timed Exam Countdown Timer vs Standard Study Session Timer */}
              {session.mode === 'exam' ? (
                <div className={`p-4 rounded-xl border shadow-md flex justify-between items-center transition-all duration-300 font-sans ${
                  timeLeft !== null && timeLeft < 300 
                    ? 'bg-lecture-red/10 border-lecture-red text-lecture-red animate-pulse'
                    : 'bg-card border-charcoal-graphite/10 text-charcoal-graphite'
                }`}>
                  <div className="flex items-center gap-2">
                    <span className="text-xl sm:text-2xl font-bold font-mono tracking-wider">
                      {timeLeft === null ? 'No Limit' : (
                        <>
                          ⏱️ {Math.floor(timeLeft / 3600) > 0 ? `${Math.floor(timeLeft / 3600)}:` : ''}
                          {Math.floor((timeLeft % 3600) / 60).toString().padStart(2, '0')}:
                          {(timeLeft % 60).toString().padStart(2, '0')}
                        </>
                      )}
                    </span>
                    {timeLeft !== null && timeLeft < 300 && (
                      <span className="text-xs font-semibold uppercase tracking-wider">Time Warning: Under 5 mins!</span>
                    )}
                  </div>
                  <Button 
                    onClick={() => {
                      if (typeof window !== 'undefined') {
                        const totalQs = exercises.length;
                        const answeredQs = Object.keys(draftAnswers).length;
                        const ok = window.confirm(`Are you sure you want to submit your exam paper?\n\nProgress: ${answeredQs} of ${totalQs} questions answered.`);
                        if (ok) {
                          handleFinishExam();
                        }
                      }
                    }}
                    className="bg-lecture-red hover:bg-lecture-red/90 text-white font-semibold text-sm shadow-sm h-10 px-4 rounded-lg"
                  >
                    Submit Exam Paper
                  </Button>
                </div>
              ) : (
                <SessionTimer durationSeconds={sessionDuration} startTime={session.startTime} />
              )}

              {/* EXAM HUD: Complete Navigation Map Grid */}
              {session.mode === 'exam' && exercises.length > 0 && (
                <div className="bg-card p-4 sm:p-5 rounded-xl border border-charcoal-graphite/10 shadow-sm space-y-4 font-sans">
                  <div className="flex justify-between items-center text-xs font-semibold text-charcoal-graphite/60 uppercase tracking-wider pb-2 border-b border-charcoal-graphite/10">
                    <span>Exam Navigation Map</span>
                    <span className="text-fountain-ink font-bold">{Object.keys(draftAnswers).length} of {exercises.length} Answered</span>
                  </div>
                  <div className="flex flex-wrap gap-2.5">
                    {exercises.map((ex, idx) => {
                      const isCurrent = idx === currentIndex;
                      const isAnswered = !!draftAnswers[ex.id];
                      const isFlagged = flaggedIds.includes(ex.id);
                      
                      let btnClass = "border-charcoal-graphite/15 text-charcoal-graphite hover:bg-muted bg-background";
                      if (isCurrent) {
                        btnClass = "border-fountain-ink text-fountain-ink font-bold ring-2 ring-fountain-ink bg-fountain-ink/10";
                      } else if (isFlagged) {
                        btnClass = "bg-amber-100 border-amber-300 text-amber-800 font-semibold shadow-sm hover:bg-amber-150";
                      } else if (isAnswered) {
                        btnClass = "bg-blue-50 border-blue-200 text-blue-800 font-semibold hover:bg-blue-100";
                      }
                      
                      return (
                        <Button
                          key={ex.id}
                          type="button"
                          variant="outline"
                          onClick={() => setCurrentIndex(idx)}
                          className={`w-10 h-10 p-0 text-sm font-medium rounded-md transition-all duration-200 relative ${btnClass}`}
                        >
                          {idx + 1}
                          {isFlagged && <span className="absolute -top-1 -right-1 text-[8px] bg-amber-500 text-white w-3.5 h-3.5 rounded-full flex items-center justify-center font-bold">⚑</span>}
                        </Button>
                      );
                    })}
                  </div>
                  <div className="flex flex-wrap gap-x-5 gap-y-2 text-[10px] font-semibold text-charcoal-graphite/50 pt-1">
                    <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 bg-background border border-charcoal-graphite/15 rounded-sm inline-block"></span> Unanswered</span>
                    <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 bg-blue-50 border border-blue-200 rounded-sm inline-block"></span> Answered (Draft)</span>
                    <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 bg-amber-100 border border-amber-300 rounded-sm inline-block"></span> Flagged for Review</span>
                  </div>
                </div>
              )}

              {isDiagnosisLoading && (
                <div className="bg-card border border-charcoal-graphite/10 p-8 rounded-xl shadow-lg flex flex-col items-center justify-center text-center gap-4 animate-sketch-draw font-sans">
                  <Loader2 className="w-12 h-12 text-lecture-red animate-spin" />
                  <div className="space-y-2 max-w-sm">
                    <h3 className="text-lg font-bold text-charcoal-graphite italic font-display">Professor Grading In Progress</h3>
                    <p className="text-sm text-charcoal-graphite/70">
                      The MIT Economics Professor is evaluating your exam answers and generating your customized study diagnostic plan. This usually takes 5-15 seconds.
                    </p>
                  </div>
                </div>
              )}

              {!isDiagnosisLoading && currentExercise ? (
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

                    {/* Socratic Sibling Toggle: Flag for Review Toggle (Exam Mode only) */}
                    {session.mode === 'exam' ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          const isFlagged = flaggedIds.includes(currentExercise.id);
                          if (isFlagged) {
                            setFlaggedIds(flaggedIds.filter(id => id !== currentExercise.id));
                          } else {
                            setFlaggedIds([...flaggedIds, currentExercise.id]);
                          }
                        }}
                        className={`h-9 px-4 gap-1.5 font-semibold text-xs border rounded-lg shrink-0 transition-all duration-200 ${
                          flaggedIds.includes(currentExercise.id)
                            ? 'bg-amber-100 text-amber-800 border-amber-400 font-bold hover:bg-amber-150'
                            : 'border-charcoal-graphite/10 hover:bg-muted text-charcoal-graphite/80'
                        }`}
                      >
                        <span className="text-sm">⚑</span>
                        {flaggedIds.includes(currentExercise.id) ? 'Flagged' : 'Flag for Review'}
                      </Button>
                    ) : (
                      <div className="flex-1 border-b border-dashed border-charcoal-graphite/10" />
                    )}

                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        if (currentIndex === exercises.length - 1 && missingCount === 0) {
                          if (session.mode === 'exam') {
                            const totalQs = exercises.length;
                            const answeredQs = Object.keys(draftAnswers).length;
                            const ok = window.confirm(`You have reached the end of the exam.\n\nProgress: ${answeredQs} of ${totalQs} questions answered. Submit now?`);
                            if (ok) handleFinishExam();
                          } else {
                            handleFinishSession()
                          }
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
                    initialSelectedChoice={session.mode === 'exam' && session.status !== 'completed' ? draftAnswers[currentExercise.id] : currentLog?.userAnswer}
                    hasBeenAnswered={session.status === 'completed' ? true : (session.mode === 'exam' ? false : !!currentLog)}
                    isExamMode={session.mode === 'exam' && session.status !== 'completed'}
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
                          if (session.mode === 'exam') {
                            const totalQs = exercises.length;
                            const answeredQs = Object.keys(draftAnswers).length;
                            const ok = window.confirm(`Ready to submit exam?\n\nProgress: ${answeredQs} of ${totalQs} questions answered.`);
                            if (ok) handleFinishExam();
                          } else {
                            handleFinishSession()
                          }
                        } else {
                          setCurrentIndex(Math.min(exercises.length - 1, currentIndex + 1))
                        }
                      }}
                    >
                      {currentIndex === exercises.length - 1 && missingCount > 0 ? (
                        <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Generating...</>
                      ) : currentIndex === exercises.length - 1 && missingCount === 0 ? (
                        session.mode === 'exam' ? 'Submit Exam' : 'Finish Session'
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
              <div className="text-center max-w-sm px-4 space-y-2 font-sans">
                <h2 className="font-display text-2xl font-bold italic text-charcoal-graphite">Feynman</h2>
                <p className="text-sm text-charcoal-graphite/60 leading-relaxed">
                  "Understand everything. Simplify anything."
                </p>
                <p className="text-xs text-charcoal-graphite/40 mt-6 pt-4 border-t border-charcoal-graphite/10 mb-6">
                  Configure and start a custom study session to begin, or go to the "Study Plan" tab to design your custom curriculum.
                </p>

                {/* Center Create Session Button for all screen sizes */}
                <div className="flex flex-col gap-3 items-center">
                  <Dialog open={isModalOpen} onOpenChange={setIsModalOpen}>
                    <DialogTrigger render={<Button className="w-full max-w-[240px] flex gap-2 bg-lecture-red hover:bg-lecture-red/90 text-white border-0 shadow-md font-semibold h-11 mx-auto rounded-lg shadow-sm" />}>
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
            </div>
          )}
        </TabsContent>

        <TabsContent value="plan" className="flex-1 overflow-y-auto p-4 sm:p-8 m-0 min-w-0">
          {isGeneratingPlan && !draftPlan ? (
            <div className="py-24 flex flex-col items-center justify-center text-center gap-4 bg-background h-full font-sans animate-pulse">
              <Loader2 className="w-12 h-12 text-lecture-red animate-spin" />
              <div className="space-y-1 max-w-sm">
                <h4 className="font-bold text-lg font-display italic text-charcoal-graphite">Professor Planning in Progress</h4>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Analyzing all of your study session logs, grading history, and cross-referencing your weak areas with lecture transcriptions. This takes 5-15 seconds.
                </p>
              </div>
            </div>
          ) : draftPlan ? (
            <div className="w-full max-w-5xl mx-auto p-4 sm:p-8 min-w-0">
              <StudyPlanDraftWidget 
                draftPlan={draftPlan}
                onDeploy={handleDeployPlan}
                onCancel={() => setDraftPlan(null)}
                isDeploying={isDeployingPlan}
              />
            </div>
          ) : activePlan ? (
            <div className="w-full max-w-4xl mx-auto space-y-6 pb-12 p-4 sm:p-8 min-w-0 font-sans">
              <div className="bg-card p-6 rounded-xl border border-charcoal-graphite/10 shadow-sm space-y-4 animate-sketch-draw">
                <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-4">
                  <div className="space-y-1">
                    <span className="text-[10px] bg-green-100 text-green-800 px-2.5 py-1 rounded-full font-bold uppercase tracking-wider">Active Study Curriculum</span>
                    <h2 className="text-2xl font-bold font-display italic text-charcoal-graphite mt-2">{activePlan.title}</h2>
                    <p className="text-xs sm:text-sm text-charcoal-graphite/80 leading-relaxed pt-2">
                      {activePlan.executiveSummary}
                    </p>
                  </div>
                  <Button 
                    variant="outline" 
                    onClick={() => handleDeletePlan(activePlan.id)}
                    className="text-xs font-semibold h-9 px-3 rounded-lg text-lecture-red border-lecture-red/20 hover:bg-lecture-red/10 shrink-0 flex items-center gap-1.5 shadow-sm border"
                  >
                    <Trash2 className="w-3.5 h-3.5" /> Clear Curriculum
                  </Button>
                </div>
              </div>

              <div className="space-y-4 pt-4">
                <h3 className="font-semibold text-xs sm:text-sm text-charcoal-graphite/60 uppercase tracking-wider flex items-center gap-2">
                  <Calendar className="w-4 h-4 text-fountain-ink animate-pulse" />
                  Your Study Timeline Schedule
                </h3>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {activePlan.sessions.map((s: any) => {
                    const isCompleted = s.status === 'completed';
                    const hasStarted = s.logs.length > 0;
                    
                    return (
                      <div 
                        key={s.id} 
                        className={`border rounded-xl p-5 bg-card/40 transition-all duration-200 flex flex-col justify-between gap-4 ${
                          isCompleted 
                            ? 'border-green-200 bg-green-50/10' 
                            : 'border-charcoal-graphite/15 hover:border-charcoal-graphite/30'
                        }`}
                      >
                        <div className="space-y-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[9px] font-bold tracking-wider uppercase bg-fountain-ink/10 text-fountain-ink px-2 py-0.5 rounded-sm">
                              {s.mode === 'exam' ? '⏱️ Timed Exam' : '🎓 Practice'}
                            </span>
                            {isCompleted ? (
                              <span className="text-[10px] font-bold text-green-600 flex items-center gap-1">
                                <CheckCircle className="w-3.5 h-3.5 text-green-500" /> Completed
                              </span>
                            ) : hasStarted ? (
                              <span className="text-[10px] font-bold text-blue-600 animate-pulse">
                                In Progress ({s.logs.length} logged)
                              </span>
                            ) : (
                              <span className="text-[10px] font-semibold text-muted-foreground">
                                Pending
                              </span>
                            )}
                          </div>

                          <h4 className="font-bold text-sm sm:text-base text-charcoal-graphite leading-snug">{s.title}</h4>
                        </div>

                        <div className="flex items-center justify-between gap-4 pt-3 border-t border-charcoal-graphite/10">
                          <span className="text-[10px] sm:text-xs text-muted-foreground font-medium">
                            {s.timeLimit ? `${s.timeLimit / 60} min timer` : 'Self-paced'} • {s.sourcingMix}% AI
                          </span>
                          
                          {!isCompleted && (
                            <Button 
                              onClick={async () => {
                                setIsLoading(true);
                                try {
                                  await handleLoadSession(s.id);
                                } catch (e) {
                                  console.error(e);
                                }
                                setIsLoading(false);
                              }}
                              size="sm"
                              className="bg-fountain-ink hover:bg-fountain-ink/90 text-white font-semibold text-xs h-8 px-3 rounded-lg flex items-center gap-1.5 shadow-sm border-0"
                            >
                              <Play className="w-3 h-3 fill-white" /> Launch Slot
                            </Button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          ) : (
            <div className="w-full max-w-3xl mx-auto space-y-6 pb-12 p-4 sm:p-8 min-w-0 font-sans animate-sketch-draw flex flex-col h-full">
              {/* Header Box */}
              <div className="bg-card p-5 rounded-xl border border-charcoal-graphite/10 shadow-sm space-y-2 shrink-0">
                <span className="text-[9px] bg-bongo-gold/10 text-bongo-gold px-2 py-0.5 rounded-full font-bold uppercase tracking-wider flex items-center gap-1 w-fit">
                  <Sparkles className="w-3 h-3 fill-bongo-gold text-bongo-gold" /> Socratic Planner Workspace
                </span>
                <h2 className="text-xl font-bold font-display italic text-charcoal-graphite">AI Curriculum Planner</h2>
                <p className="text-xs sm:text-sm text-muted-foreground leading-relaxed">
                  Design a personalized, multi-day Socratic Study Syllabus based on your exact strengths, weaknesses, and preferred available hours. Discuss with the professor below, or click a suggested pre-idea to generate your study timeline.
                </p>
              </div>

              {/* Chat Message Box Timeline */}
              <div className="flex-1 min-h-[300px] border border-charcoal-graphite/10 rounded-xl p-4 bg-card/40 flex flex-col justify-between overflow-hidden gap-4">
                <div className="flex-1 overflow-y-auto space-y-3 pr-1 scrollbar-thin">
                  {plannerChat.map((msg, idx) => (
                    <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      <div 
                        className={`max-w-[85%] rounded-xl px-4 py-2.5 text-xs sm:text-sm shadow-xs border leading-relaxed whitespace-pre-wrap ${
                          msg.role === 'user' 
                            ? 'bg-fountain-ink/10 text-charcoal-graphite border-fountain-ink/20' 
                            : 'bg-background/90 text-charcoal-graphite border-charcoal-graphite/10'
                        }`}
                      >
                        {msg.content}
                      </div>
                    </div>
                  ))}
                  {isPlannerChatLoading && (
                    <div className="flex justify-start">
                      <div className="bg-background/90 text-charcoal-graphite border border-charcoal-graphite/10 rounded-xl px-4 py-2.5 text-xs sm:text-sm shadow-xs flex items-center gap-2 font-medium">
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-fountain-ink" />
                        <span>Professor is planning...</span>
                      </div>
                    </div>
                  )}
                </div>

                {/* Pre-ideas suggested prompts list */}
                <div className="space-y-2 shrink-0 pt-2 border-t border-charcoal-graphite/5">
                  <span className="text-[10px] font-bold text-charcoal-graphite/50 uppercase tracking-wider block">Suggested Pre-Ideas:</span>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <button
                      type="button"
                      disabled={isPlannerChatLoading}
                      onClick={() => handleSendPlannerMessage("I have 6 hours a day. Build me a high-intensity 4-day sprint targeting my weak areas: Sampling and Leaders.")}
                      className="text-left p-2.5 rounded-lg border border-bongo-gold/25 bg-bongo-gold/5 hover:bg-bongo-gold/15 text-[10px] sm:text-xs leading-snug font-medium text-charcoal-graphite transition-colors duration-150"
                    >
                      📅 <strong>4-Day Peak Prep</strong><br />
                      Focus on Sampling & Leaders
                    </button>
                    <button
                      type="button"
                      disabled={isPlannerChatLoading}
                      onClick={() => handleSendPlannerMessage("I want to study 4 hours a day, focusing on logistics and research integrity. Let's do timed exams on Friday.")}
                      className="text-left p-2.5 rounded-lg border border-bongo-gold/25 bg-bongo-gold/5 hover:bg-bongo-gold/15 text-[10px] sm:text-xs leading-snug font-medium text-charcoal-graphite transition-colors duration-150"
                    >
                      ⏱️ <strong>5-Day Intense Sprint</strong><br />
                      Focus on Logistics & Ethics
                    </button>
                    <button
                      type="button"
                      disabled={isPlannerChatLoading}
                      onClick={() => handleSendPlannerMessage("Create a complete conceptual review study plan. Cover OLS regressions, Voting theory, and Measurement Networks.")}
                      className="text-left p-2.5 rounded-lg border border-bongo-gold/25 bg-bongo-gold/5 hover:bg-bongo-gold/15 text-[10px] sm:text-xs leading-snug font-medium text-charcoal-graphite transition-colors duration-150"
                    >
                      📖 <strong>Conceptual Review</strong><br />
                      Cover OLS, Voting, & Networks
                    </button>
                  </div>
                </div>

                {/* Conversation text input form */}
                <form 
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!plannerInput.trim() || isPlannerChatLoading) return;
                    handleSendPlannerMessage(plannerInput);
                  }}
                  className="flex gap-2 shrink-0 pt-2 border-t border-charcoal-graphite/5"
                >
                  <input
                    type="text"
                    value={plannerInput}
                    onChange={(e) => setPlannerInput(e.target.value)}
                    placeholder="Type your study availability, preferred slots, or feedback here..."
                    disabled={isPlannerChatLoading}
                    className="flex-1 rounded-md border border-charcoal-graphite/15 bg-background text-charcoal-graphite px-3 py-2 text-xs sm:text-sm placeholder:text-charcoal-graphite/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-fountain-ink outline-none"
                  />
                  <Button 
                    type="submit" 
                    size="sm" 
                    className="bg-fountain-ink hover:bg-fountain-ink/90 border-0 text-white shrink-0 text-xs font-semibold px-4 rounded-md"
                    disabled={isPlannerChatLoading || !plannerInput.trim()}
                  >
                    Send
                  </Button>
                </form>
              </div>

              {/* Compile Timeline Trigger Button */}
              <div className="shrink-0 flex justify-center">
                <Button 
                  onClick={handleGeneratePlan}
                  disabled={isGeneratingPlan || plannerChat.length <= 1}
                  className="w-full max-w-[280px] h-11 bg-lecture-red hover:bg-lecture-red/90 text-white font-semibold text-sm shadow-md border-0 rounded-lg flex items-center justify-center gap-2 animate-sketch-draw"
                >
                  {isGeneratingPlan ? (
                    <><Loader2 className="w-4 h-4 animate-spin" /> Compiling Your Timeline...</>
                  ) : (
                    <><Sparkles className="w-4 h-4 fill-white text-white" /> Compile Timeline Schedule</>
                  )}
                </Button>
              </div>
            </div>
          )}
        </TabsContent>

        <TabsContent value="chat" className="xl:hidden flex-1 overflow-y-auto m-0 p-0 min-w-0">
          <VoiceHub 
            liveAPI={liveAPI} 
            onViewFile={handleViewFile} 
            onGeneratePlan={handleGeneratePlan}
            isGeneratingPlan={isGeneratingPlan}
          />
        </TabsContent>

        <TabsContent value="history" className="xl:hidden flex-1 overflow-y-auto p-4 m-0 min-w-0 custom-scrollbar">
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

        <TabsContent value="resources" className="flex-1 overflow-y-auto m-0 p-4 sm:p-8 min-w-0">
          <ResourcesDashboard onViewFile={handleViewFile} onStartWeekSession={handleStartWeekSession} />
        </TabsContent>

        <TabsContent value="analytics" className="flex-1 overflow-y-auto m-0 p-4 sm:p-8 min-w-0">
          <AnalyticsDashboard />
        </TabsContent>
      </Tabs>

      {/* VISUALIZER - Full-screen overlay on mobile, beautiful side drawer on desktop */}
      {activeFile && (
        <div className={`fixed inset-0 z-50 bg-background flex flex-col xl:relative xl:inset-auto xl:h-full xl:border-l xl:shadow-lg transition-all duration-300 ease-in-out ${
          isVisualizerFullWidth 
            ? 'xl:w-[100vw]' 
            : isVisualizerExpanded ? 'xl:w-[45vw]' : 'xl:w-[25vw]'
        }`}>
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
            isExpanded={isVisualizerExpanded}
            onToggleExpand={() => setIsVisualizerExpanded(!isVisualizerExpanded)}
            isFullWidth={isVisualizerFullWidth}
            onToggleFullWidth={() => setIsVisualizerFullWidth(!isVisualizerFullWidth)}
          />
        </div>
      )}

      {/* RIGHT SIDEBAR - 20vw / 64px / 0px (Desktop only) */}
      <div className={`hidden xl:flex h-full border-l bg-card shrink-0 flex flex-col border-charcoal-graphite/10 relative z-30 transition-all duration-300 ease-in-out ${
        isVisualizerFullWidth 
          ? 'xl:w-0 xl:overflow-hidden xl:border-l-0 xl:opacity-0' 
          : isProfessorSidebarHidden ? 'xl:w-[64px] xl:opacity-100' : 'xl:w-[20vw] xl:opacity-100'
      }`}>
        {isProfessorSidebarHidden ? (
          /* COLLAPSED VIEW: Show only the Open toggle button */
          <div className="h-[80px] shrink-0 flex items-center justify-center border-b border-charcoal-graphite/10">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setIsProfessorSidebarHidden(false)}
              title="Show Professor Sidebar"
              className="h-9 w-9 text-charcoal-graphite/70 hover:bg-muted rounded-md transition-all duration-200"
            >
              <PanelRightOpen className="w-5 h-5" />
            </Button>
          </div>
        ) : (
          /* EXPANDED VIEW: Render full VoiceHub with onClose parameter */
          <VoiceHub 
            liveAPI={liveAPI} 
            onViewFile={handleViewFile} 
            onGeneratePlan={handleGeneratePlan}
            isGeneratingPlan={isGeneratingPlan}
            onToggleClose={() => setIsProfessorSidebarHidden(true)}
          />
        )}
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
