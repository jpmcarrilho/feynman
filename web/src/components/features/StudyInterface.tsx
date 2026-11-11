'use client'

import { useState, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import { Flashcard } from './Flashcard'
import { SessionTimer } from './SessionTimer'
import { generateWithRetry } from '@/lib/generationRetry'
import { requestNextExercise } from '@/lib/generationClient'
import { VoiceHub } from './VoiceHub'
import { Dialog, DialogTrigger } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  startSession,
  getActiveSession,
  getSessionState,
  saveDraft,
  setFlagged,
  setCurrentPosition,
  getTopicsWithPerformance,
  getSessionHistory,
  logAnswer,
  submitExam,
  saveChatLog,
  finishStudySession,
  getSessionDetail,
  getVoiceContextForExercise,
  reportExercise,
  deleteStudySession,
  cancelStudySession,
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
import {
  voiceSystemInstruction,
  voiceExerciseContextMessage,
  voicePlannerContextMessage,
  voiceDashboardContextMessage,
} from '@/lib/prompts'
import { LEGACY_VOICE_PROFILE } from '@/lib/studyspace/legacyProfiles'
import { formatScore, sessionScore } from '@/lib/grading'
import type { TutorChatMode } from '@/lib/studyspace/profile'
import { getChatMode, setChatMode, subscribeChatMode } from '@/lib/studyspace/chatMode'
import { AnalyticsDashboard } from './AnalyticsDashboard'
import { FeynmanLogo } from './FeynmanLogo'
import { ConfigureSessionDialog } from './ConfigureSessionDialog'
import { SessionResultsDialog } from './SessionResultsDialog'
import { SessionHistoryList } from './SessionHistoryList'
import { SideVisualizer, type ActiveFileKind } from './SideVisualizer'
import { parseFileLink } from '@/lib/fileLinks'
import { DebouncedWriter } from '@/lib/debouncedWriter'
import { ChatBuffer } from '@/lib/chatBuffer'
import {
  viewFromState,
  remainingSeconds,
  activeSessionHintKey,
  legacySessionId,
  stateDiffers,
  serverOffsetOf,
} from '@/lib/sessionClient'
import type { SessionState } from '@/services/sessionService'
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

const EXAM_DIAGNOSIS_FILE = 'inline:exam-diagnosis.md'

// Module-level so the instruction string is stable across renders. T19 replaces the legacy persona with the space profile.
const VOICE_SYSTEM_INSTRUCTION = voiceSystemInstruction(LEGACY_VOICE_PROFILE)
// localStorage key suffix for the chat mode (feynman_chat_mode_legacy) until studyspaces exist in the UI
const CHAT_MODE_SCOPE = 'legacy'
// How long a typed first message waits for the exercise context prefetch before it is sent without it
const CONTEXT_WAIT_MS = 5000

/** How long typing in a numeric field waits before the draft is sent, and the same for moving between questions. */
const DRAFT_DEBOUNCE_MS = 500
/** The tutor conversation is saved to the session this often while it changes. */
const CHAT_SAVE_INTERVAL_MS = 15_000
const LEGACY_SESSION_KEY = 'dedp_active_session'

/**
 * The study screen. The state of the running session (question, drafts, flags, answers, deadline, questions still to
 * be generated, topics) lives on the server; this component renders what `getSessionState` / `getActiveSession`
 * return. The only thing the browser keeps is a hint: the id of the session this browser had open
 * (`feynman_active_session_<courseId|global>`). `courseId` scopes the session actions to one studyspace (T19 passes it).
 */
export function StudyInterface({ courseId }: { courseId?: string } = {}) {
  const [topics, setTopics] = useState<any[]>([])
  // The Create Session dialog's selection only
  const [selectedTopics, setSelectedTopics] = useState<string[]>([])
  const [histories, setHistories] = useState<any[]>([])
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [sessionDuration, setSessionDuration] = useState<number>(300) // Default 5 mins
  const [questionCount, setQuestionCount] = useState<number>(10)

  const [session, setSession] = useState<any>(null)
  const [exercises, setExercises] = useState<any[]>([])
  const [missingCount, setMissingCount] = useState(0)
  // Set when one question slot failed 3 times in a row; holds the message to show. Generation stops until Retry.
  const [generationError, setGenerationError] = useState<string | null>(null)
  // Guards for the background generator: only one loop at a time, and a loop stops when the session changes or ends
  const generationLoopActiveRef = useRef(false)
  const generationRunRef = useRef(0)
  // Cancels the request in flight; set to true when the student ends the session so that no new loop starts meanwhile
  const generationAbortRef = useRef<AbortController | null>(null)
  const generationStoppedRef = useRef(false)
  const stopGeneration = () => {
    generationStoppedRef.current = true
    generationRunRef.current += 1
    generationAbortRef.current?.abort()
    generationAbortRef.current = null
    generationLoopActiveRef.current = false
  }
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
  const [activeFileKind, setActiveFileKind] = useState<ActiveFileKind | null>(null)
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

  const stillGenerating = missingCount > 0 && !generationError
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

  // Until studyspaces exist in the UI (T19) the tutor uses the global legacy persona and one chat mode key.
  const liveAPI = useLiveAPI(VOICE_SYSTEM_INSTRUCTION)

  // The mode lives in a small external store (memory + localStorage `feynman_chat_mode_legacy`). The exercise-context
  // effect reads it with getChatMode() instead of depending on it, so a mode change never re-sends the exercise context.
  const chatMode = useSyncExternalStore(
    subscribeChatMode,
    () => getChatMode(CHAT_MODE_SCOPE, LEGACY_VOICE_PROFILE.defaultChatMode),
    () => LEGACY_VOICE_PROFILE.defaultChatMode
  )
  const handleChatModeChange = (mode: TutorChatMode) => setChatMode(CHAT_MODE_SCOPE, mode)

  // ---------------------------------------------------------------------------------------------------------------
  // Server-owned session state. The screen renders what the server returns; the browser keeps only a hint (session id).
  // ---------------------------------------------------------------------------------------------------------------
  // One serial, debounced queue for the small writes (drafts, flags, current question): they reach the server in the
  // order they were made, each carrying the session it belongs to, and are flushed before submitting or switching.
  const [writer] = useState(() => new DebouncedWriter())
  const hintKey = activeSessionHintKey(courseId)
  // server clock minus client clock (ms), refreshed whenever a state is read
  const serverOffsetRef = useRef(0)
  // the same offset as state, for the study timer's render
  const [clockOffsetMs, setClockOffsetMs] = useState(0)
  // the session the screen shows, for async callbacks that must not apply to a session that is no longer shown
  const sessionIdRef = useRef<string | null>(null)
  // which session the tutor conversation in memory belongs to: it can only be saved to that session (see chatBuffer.ts)
  const [chat] = useState(() => new ChatBuffer<(typeof liveAPI.messages)[number]>())
  // a message the student typed while the tutor was disconnected, sent once the connection is up (dropped when the session changes)
  const pendingMessageRef = useRef<string | null>(null)
  // true while a start request is in flight: a second click cannot create a second session
  const startingRef = useRef(false)
  const autoSubmitRef = useRef<string | null>(null)
  const finishExamRef = useRef<() => Promise<void>>(async () => {})
  const latestRef = useRef<{ status: string | undefined; itemCount: number; missingCount: number }>({ status: undefined, itemCount: 0, missingCount: 0 })

  /**
   * Replaces the conversation on screen with `messages` and makes `owner` the only session it can be saved to.
   * A live voice/text connection is closed when the session changes: the model keeps the conversation of the old
   * session on its side and that history cannot be removed from an open connection. Reconnecting starts a new
   * conversation seeded only with this session's own messages.
   */
  const switchChat = (owner: string | null, messages: typeof liveAPI.messages = []) => {
    liveAPI.setMessages(chat.replace(owner, messages))
    pendingMessageRef.current = null
    liveAPI.disconnect()
  }

  const applyState = (state: SessionState, opts: { keepIndex?: boolean } = {}) => {
    // A different session than the one on screen (start, load, resume): its chat starts empty and is loaded separately
    if (sessionIdRef.current !== state.session.id) switchChat(state.session.id)
    const v = viewFromState(state)
    serverOffsetRef.current = v.serverOffsetMs
    setClockOffsetMs(v.serverOffsetMs)
    sessionIdRef.current = state.session.id
    setSession(v.session)
    setExercises(v.exercises)
    setDraftAnswers(v.draftAnswers)
    setFlaggedIds(v.flaggedIds)
    setMissingCount(v.missingCount)
    setCurrentIndex(opts.keepIndex ? (i) => Math.min(i, Math.max(0, v.exercises.length - 1)) : v.currentIndex)
  }

  const loadChatLog = async (id: string) => {
    try {
      const detail = await getSessionDetail(id)
      if (!detail?.chatLog || sessionIdRef.current !== id) return
      const restored = JSON.parse(detail.chatLog)
      // Only into an empty conversation of this very session: messages that arrived meanwhile are not overwritten
      if (Array.isArray(restored) && chat.ownerId() === id && chat.snapshot(id) === null) {
        liveAPI.setMessages(chat.replace(id, restored))
      }
    } catch (e) {
      console.error('Failed to load chat log', e)
    }
  }

  /** Re-reads one session and applies it when the screen is out of date (status, number of questions, questions left). */
  const refreshFromServer = async (id: string, opts: { force?: boolean } = {}): Promise<SessionState | null> => {
    await writer.flush()
    const state = await getSessionState(id, courseId)
    if (!state || sessionIdRef.current !== id) return state
    serverOffsetRef.current = serverOffsetOf(state)
    setClockOffsetMs(serverOffsetRef.current)
    if (opts.force || stateDiffers(latestRef.current, state)) {
      const statusChanged = latestRef.current.status !== state.session.status
      applyState(state, { keepIndex: true })
      // the server ended the session (deadline passed, finished elsewhere): the list shows its new status and score
      if (statusChanged) getSessionHistory().then(setHistories)
    }
    return state
  }

  const clearSessionView = (opts: { forgetHint?: boolean; keepChat?: boolean } = {}) => {
    stopGeneration()
    if (opts.forgetHint !== false) safeRemoveItem(hintKey)
    sessionIdRef.current = null
    setSession(null)
    setExercises([])
    setCurrentIndex(0)
    setDraftAnswers({})
    setFlaggedIds([])
    setTimeLeft(null)
    setMissingCount(0)
    if (!opts.keepChat) switchChat(null)
  }

  // A rejected small write means the server no longer treats the session as open (ended elsewhere, deadline passed):
  // show what the server says. Deferred so it never waits on the write queue it is running in.
  const syncAfterRejection = (sid: string, result: { ok: boolean; reason?: string }) => {
    if (result.ok || (result.reason !== 'not_active' && result.reason !== 'deadline_passed')) return
    setTimeout(() => { void refreshFromServer(sid, { force: true }) }, 0)
  }

  const persistDraft = (sid: string, exerciseId: string, value: string | null, debounce: boolean) => {
    writer.schedule(`${sid}:draft:${exerciseId}`, async () => syncAfterRejection(sid, await saveDraft(sid, exerciseId, value, 0)), debounce ? DRAFT_DEBOUNCE_MS : 0)
  }

  const toggleFlag = (exerciseId: string) => {
    if (!session) return
    const next = !flaggedIds.includes(exerciseId)
    setFlaggedIds(next ? [...flaggedIds, exerciseId] : flaggedIds.filter((id) => id !== exerciseId))
    const sid = session.id
    writer.schedule(`${sid}:flag:${exerciseId}`, async () => syncAfterRejection(sid, await setFlagged(sid, exerciseId, next)), 0)
  }

  /** Moves to another question and remembers it on the server (debounced). */
  const goToIndex = (index: number) => {
    setCurrentIndex(index)
    if (session?.status === 'active') {
      const sid = session.id
      writer.schedule(`${sid}:pos`, async () => syncAfterRejection(sid, await setCurrentPosition(sid, index)), DRAFT_DEBOUNCE_MS)
    }
  }

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
            content: "Welcome to your AI Curriculum Planner Workspace! I am your Socratic Academic Advisor.\n\nHow should we structure your timeline? Tell me your available daily hours (e.g. 'I want 3 sessions a day, 2 hours each, from Tuesday to Friday'), or click on one of the suggested pre-ideas below to design your curriculum!"
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
      // Hide the running session first to let the draft planner render without state collisions. It stays active on the
      // server (and is resumed on the next load); only its screen is cleared.
      await writer.flush()
      clearSessionView({ forgetHint: false, keepChat: true })

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

    // Resume the running session from the server. The hint (session id this browser had open) is preferred while that
    // session is still active; otherwise the latest active session of the scope. An empty localStorage works too.
    // Before T17 the browser kept a whole snapshot under `dedp_active_session`; only its session id is used, once, as the
    // hint (written at once, so a second run of this effect in development finds it)
    let hint = safeGetItem(hintKey)
    const legacy = safeGetItem(LEGACY_SESSION_KEY)
    if (legacy !== null) {
      const legacyId = legacySessionId(legacy)
      safeRemoveItem(LEGACY_SESSION_KEY)
      if (legacyId && !hint) {
        hint = legacyId
        safeSetItem(hintKey, legacyId)
      }
    }
    let cancelled = false
    ;(async () => {
      try {
        let state: SessionState | null = null
        if (hint) {
          state = await getSessionState(hint, courseId).catch(() => null)
          if (state && state.session.status !== 'active') state = null
        }
        if (!state) state = await getActiveSession(courseId)
        // A session started while this request was in flight wins
        if (cancelled || sessionIdRef.current) return
        if (!state) {
          if (hint) safeRemoveItem(hintKey)
          return
        }
        applyState(state)
        await loadChatLog(state.session.id)
      } catch (e) {
        console.error('Failed to resume the active session', e)
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The hint follows the session on screen: set while it is active, dropped when the server says it is over
  useEffect(() => {
    if (!session) return
    if (session.status === 'active') safeSetItem(hintKey, session.id)
    else if (safeGetItem(hintKey) === session.id) safeRemoveItem(hintKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, session?.status])

  // What the generation loop and the visibility handler compare the server's state against
  useEffect(() => {
    latestRef.current = { status: session?.status, itemCount: exercises.length, missingCount }
    chat.observe(liveAPI.messages)
  })

  // Pending drafts are sent when the page is hidden or closed; coming back re-reads the session (clock, status)
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        void writer.flush()
        const sid = sessionIdRef.current
        const messages = sid && latestRef.current.status === 'active' ? chat.changedSnapshot(sid) : null
        if (sid && messages) {
          chat.markSaved(sid, messages)
          void saveChatLog(sid, messages).catch(() => {})
        }
      } else if (sessionIdRef.current && latestRef.current.status === 'active') {
        void refreshFromServer(sessionIdRef.current).catch((e) => console.error('Failed to refresh the session', e))
      }
    }
    const onPageHide = () => { void writer.flush() }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onPageHide)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Exam clock: remaining time comes from the server deadline and the server clock offset, so a wrong client clock does
  // not matter. At zero the exam is submitted with the drafts stored on the server.
  useEffect(() => {
    // (The clock is shown only for an active exam; nothing to reset otherwise)
    if (!session || session.mode !== 'exam' || session.status !== 'active' || !session.deadline) return
    const sid: string = session.id
    const deadlineMs = Date.parse(session.deadline)
    const tick = () => {
      const left = remainingSeconds(deadlineMs, Date.now(), serverOffsetRef.current)
      setTimeLeft(left)
      if (left <= 0 && autoSubmitRef.current !== sid) {
        autoSubmitRef.current = sid
        void finishExamRef.current()
      }
    }
    tick()
    const interval = setInterval(tick, 1000)
    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, session?.mode, session?.status, session?.deadline])

  // The tutor conversation is saved to the running session while it changes, so another device can read it
  useEffect(() => {
    if (!session?.id || session.status !== 'active') return
    const sid: string = session.id
    const interval = setInterval(() => {
      // sid is the session this timer was started for; the buffer only hands out messages that belong to it
      const messages = chat.changedSnapshot(sid)
      if (!messages) return
      chat.markSaved(sid, messages)
      void saveChatLog(sid, messages).catch((e) => console.error('Failed to save the chat log', e))
    }, CHAT_SAVE_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [session?.id, session?.status])

  const handleDeleteSession = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    if (typeof window !== 'undefined') {
      const ok = window.confirm('Are you sure you want to delete this study session?')
      if (ok) {
        const success = await deleteStudySession(id);
        if (success) {
          setHistories(prev => prev.filter(h => h.id !== id))
          writer.discard(`${id}:`)
          if (session?.id === id) clearSessionView()
        }
      }
    }
  }

  const handleViewFile = (href: string, title?: string) => {
    // Accepts every file link form: topic/source/summary links and the legacy /api/file?path= links of saved logs
    const link = parseFileLink(href, window.location.origin);
    if (!link) {
      console.error("Not a document link:", href);
      return;
    }
    setActiveFile(link.url);
    setActiveFilePage(link.page);
    setActiveFileHighlight(link.highlight);
    // Topic, source and summary responses carry X-File-Title; legacy links only have the file name
    let provisional = title || '';
    if (!provisional && link.kind === 'legacy') {
      const legacyPath = new URL(link.url, window.location.origin).searchParams.get('path') || '';
      provisional = (legacyPath.split('/').pop() || '').replace(/_+/g, ' ');
    }
    setActiveFileTitle(provisional);
  }

  const handleCloseFile = () => {
    setActiveFile(null);
    setActiveFileKind(null);
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
      if (result && result.link) {
        // Force the visualizer to show the newly generated markdown file!
        setActiveFile(result.link)
        setActiveFileKind('markdown')
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
    // Inline documents (for example the exam diagnosis) carry their own content and are never fetched
    if (!activeFile || activeFile.startsWith('inline:')) return
    let cancelled = false
    setActiveFileKind(null)
    setFileLoading(true)
    fetch(activeFile)
      .then(async (res) => {
        if (cancelled) return
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const headerTitle = res.headers.get('X-File-Title')
        if (headerTitle) {
          try {
            const decoded = decodeURIComponent(headerTitle)
            setActiveFileTitle((prev) => prev || decoded)
          } catch { /* malformed header: keep the current title */ }
        }
        // PDF vs markdown vs plain text is decided by the response Content-Type
        const type = (res.headers.get('Content-Type') || '').toLowerCase()
        if (type.includes('application/pdf')) {
          setActiveFileKind('pdf')
          setFileContent('')
          setFileLoading(false)
          void res.body?.cancel() // the viewer iframe loads the PDF itself
          return
        }
        const text = await res.text()
        if (cancelled) return
        setActiveFileKind(type.includes('markdown') ? 'markdown' : 'text')
        setFileContent(text)
        setFileLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        console.error("Failed to fetch file content:", err)
        setActiveFileKind('text')
        setFileContent("This file could not be opened.")
        setFileLoading(false)
      })
    return () => { cancelled = true }
  }, [activeFile]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // 1. PDF Search shortcut (Cmd+F / Ctrl+F)
      if ((e.metaKey || e.ctrlKey) && e.code === 'KeyF') {
        if (activeFileKind === 'pdf') {
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
  }, [activeFileKind, liveAPI]);

  /**
   * Starts a session on the server and shows it. Buttons are disabled while this runs and a second call is ignored, so a
   * double click cannot create two sessions. Starting ends the previous active session of the scope without losing its
   * answers (a study session is completed, an exam is submitted with its saved drafts), so an exam asks first.
   */
  const beginSession = async (input: Parameters<typeof startSession>[0]) => {
    if (startingRef.current) return
    if (session?.status === 'active' && session.mode === 'exam') {
      const ok = window.confirm('Starting a new session will submit your current exam with the answers saved so far. Continue?')
      if (!ok) return
    }
    startingRef.current = true
    setIsLoading(true)
    try {
      // Drafts and flags still queued belong to the session that is about to end: send them first
      await writer.flush()
      const state = await startSession({ ...input, courseId })
      applyState(state)
      setIsModalOpen(false)
      setActiveTab('study') // Ensure active tab shifts to 'study' immediately to reveal the active cards!
      getSessionHistory().then(setHistories)
    } catch (e) {
      console.error('Failed to start the session', e)
      // The previous session may or may not have been ended: show what the server has
      if (sessionIdRef.current) void refreshFromServer(sessionIdRef.current, { force: true }).catch(() => {})
    } finally {
      startingRef.current = false
      setIsLoading(false)
    }
  }

  const handleStartSession = async (
    mode: 'study' | 'exam' = 'study',
    timeLimit: number | null = null,
    sourcingMix: number = 50,
    weakPct: number = 60,
    unstudiedPct: number = 20,
    expertPct: number = 20,
    // The dialog decides the pool (ticked topics, else the topics its filters match, else [] = everything shown)
    topicIds: string[] = selectedTopics
  ) => beginSession({ topicIds, count: questionCount, mode, timeLimit, sourcingMix, weakPct, unstudiedPct, expertPct })

  const handleStartWeekSession = async (topicIds: string[], weekName: string) => {
    void weekName
    await beginSession({ topicIds, count: questionCount, mode: 'study', timeLimit: null, sourcingMix: 50, weakPct: 60, unstudiedPct: 20, expertPct: 20 })
  }

  const handleFinishExam = async () => {
    stopGeneration()
    if (!session || isDiagnosisLoading) return;
    setIsDiagnosisLoading(true);
    try {
      // Drafts still queued are sent first; the server then grades every question from the drafts it stores (unanswered
      // ones score 0), writes the logs and completes the session in one transaction. Submitting twice is harmless.
      await writer.flush();
      const examMessages = chat.snapshot(session.id);
      if (examMessages) void saveChatLog(session.id, examMessages).catch(() => {});
      const submission = await submitExam(session.id);
      if (!submission) {
        console.error("Exam could not be submitted (unknown, cancelled or non-exam session)");
        return;
      }
      const examScoreSum = submission.scoreSum;
      const totalCount = submission.total;

      // The screen shows what the server now says: a completed exam, not an active one
      const finalState = await getSessionState(session.id, courseId);
      if (finalState) applyState(finalState, { keepIndex: true });
      // The exam is in History as soon as it is graded, not only after the diagnosis has been written
      getSessionHistory().then(setHistories);

      // Trigger generateExamDiagnosis action
      const reportMarkdown = await generateExamDiagnosis(session.id);
      if (reportMarkdown) {
        // Automatically open inside Visualizer
        // The ".md" suffix makes the visualizer render it as markdown; "inline:" keeps the fetch effect away
        setActiveFile(EXAM_DIAGNOSIS_FILE);
        setActiveFileKind('markdown');
        setFileLoading(false);
        setFileContent(reportMarkdown);
        setActiveFileHighlight(null);
        setActiveFilePage(null);
        setActiveFileTitle("Timed Exam Diagnostic Report");
        
        // Trigger voice tutor summary if connected
        if (liveAPI.isConnected) {
          const scoreDisplay = `${formatScore(examScoreSum)}/${totalCount}`;
          const speechMsg = `[SYSTEM MESSAGE: The student has submitted their timed exam. They scored ${scoreDisplay} (${totalCount > 0 ? Math.round((examScoreSum/totalCount)*100) : 0}%). Speak a supportive, Socratic, brief 2-3 sentence overview of their diagnostic results. Keep it warm, and mention you've pushed their full studies guide directly to their Side Visualizer.]`;
          liveAPI.sendContext(speechMsg, { interrupt: true });
        }
      }

      // Refresh histories
      getSessionHistory().then(setHistories);
    } catch (e) {
      console.error("Failed to finish timed exam:", e);
    } finally {
      setIsDiagnosisLoading(false);
    }
  }

  // Invalidates a running generation loop when the session changes or ends, and clears a failure of the old session
  const sessionId = session?.id
  const sessionEnded = session?.status === 'completed' || session?.status === 'cancelled'
  useEffect(() => {
    return () => {
      generationRunRef.current += 1
      generationAbortRef.current?.abort()
      generationAbortRef.current = null
      generationStoppedRef.current = false
      generationLoopActiveRef.current = false
      setGenerationError(null)
    }
  }, [sessionId, sessionEnded])

  useEffect(() => {
    if (!sessionId || sessionEnded || missingCount <= 0 || generationError || generationLoopActiveRef.current || generationStoppedRef.current) return
    const runId = ++generationRunRef.current
    const controller = new AbortController()
    generationAbortRef.current = controller
    const cancelled = () => generationRunRef.current !== runId
    generationLoopActiveRef.current = true
    ;(async () => {
      try {
        let remaining = missingCount
        while (remaining > 0 && !cancelled()) {
          const outcome = await generateWithRetry(
            () => requestNextExercise<Record<string, unknown> & { id: string }>(sessionId, courseId ? { courseId } : {}, controller.signal),
            cancelled,
          )
          // A result that arrives after the session ended or changed is discarded, never appended
          if (outcome === 'cancelled' || cancelled()) return
          // The server says the session is over or already full (another tab or device filled it): no failure banner.
          // Show what the server has; if that changes nothing, do not ask again for this session.
          if ('stopped' in outcome) {
            const state = await refreshFromServer(sessionId).catch(() => null)
            if (!state || !stateDiffers(latestRef.current, state)) generationStoppedRef.current = true
            return
          }
          if ('error' in outcome) {
            // Stop here; the banner offers Retry. No timer restarts the loop.
            setGenerationError(outcome.error)
            return
          }
          remaining -= 1
          setExercises(prev => (prev.some((e: any) => e.id === outcome.exercise.id) ? prev : [...prev, outcome.exercise]))
          setMissingCount(prev => Math.max(0, prev - 1))
        }
      } finally {
        if (!cancelled()) generationLoopActiveRef.current = false
      }
    })()
  }, [sessionId, sessionEnded, missingCount, generationError, exercises]);

  useEffect(() => { finishExamRef.current = handleFinishExam })

  const handleCancelExam = async () => {
    if (!session) return
    const ok = window.confirm('Cancel this exam? Your answers will be discarded and no score will be recorded.')
    if (!ok) return
    stopGeneration()
    setIsLoading(true)
    try {
      // Queued drafts of the exam are dropped: a cancelled exam has no answers and no score
      writer.discard(`${session.id}:`)
      await cancelStudySession(session.id)
      setHistories(await getSessionHistory())
    } catch (e) {
      console.error('Failed to cancel exam:', e)
    } finally {
      setIsLoading(false)
    }
    clearSessionView()
  }

  /** Leaves the screen of a session that is already over (a submitted exam, a session reopened from History). */
  const handleCloseReview = () => {
    clearSessionView()
  }

  const handleFinishSession = async () => {
    stopGeneration()
    if (session) {
      setIsLoading(true)
      try {
        // Save final chat log and mark session as completed in DB
        await writer.flush()
        const messages = chat.snapshot(session.id)
        await Promise.all([
          messages ? saveChatLog(session.id, messages) : Promise.resolve(),
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

    clearSessionView()

    if (!session) {
      getSessionHistory().then(setHistories)
    }
  }

  const currentLog = session?.logs?.find((l: any) => l.exerciseId === currentExercise?.id)

  const handleAnswer = async (isCorrect: boolean, userAnswer: string) => {
    if (session && currentExercise) {
      if (session.mode === 'exam') {
        // A draft, not a commit: kept on screen and on the server (typing in a numeric field is sent after a pause)
        setDraftAnswers(prev => ({
          ...prev,
          [currentExercise.id]: userAnswer
        }));
        persistDraft(session.id, currentExercise.id, userAnswer === '' ? null : userAnswer, currentExercise.exerciseType === 'numeric')
      } else {
        // The server grades with the same gradeAnswer the flashcard just used; its result is what is stored
        const sid: string = session.id
        const exerciseId: string = currentExercise.id
        const graded = await logAnswer(sid, exerciseId, userAnswer, { duration: 30 }) // dummy duration until T18
        // null: the server did not record it (the session ended elsewhere or the question is not part of it)
        if (!graded) void refreshFromServer(sid, { force: true }).catch(() => {})

        setSession((prev: any) => (prev && prev.id === sid ? {
          ...prev,
          logs: [...(prev.logs || []), {
            exerciseId,
            isCorrect: graded ? graded.isCorrect : isCorrect,
            score: graded ? graded.score : (isCorrect ? 1 : 0),
            userAnswer
          }]
        } : prev))
      }
    }
  }

  const lastContextKeyRef = useRef<string | null>(null)

  // Prefetch the exercise context whether or not the voice tutor is connected,
  // so it is already cached when the connection comes up.
  const [cachedContext, setCachedContext] = useState<{ key: string; unitsText: string } | null>(null)
  const currentContextKey = session && currentExercise ? `${session.id}:${currentExercise.id}` : null

  useEffect(() => {
    if (!session?.id || !currentExercise?.id) return
    const key = `${session.id}:${currentExercise.id}`
    let cancelled = false
    getVoiceContextForExercise(currentExercise.id, session.mode)
      .then((unitsText) => {
        if (!cancelled) setCachedContext({ key, unitsText: unitsText ?? '' })
      })
      .catch((e) => console.error('Failed to load voice context', e))
    return () => {
      cancelled = true
    }
  }, [session?.id, currentExercise?.id, session?.mode])

  // A message the student typed while the tutor was disconnected (VoiceHub's text box, "explain why I am wrong").
  // The context effect below sends it right after the context, which goes out without asking for a response.
  const flushPendingMessage = () => {
    const text = pendingMessageRef.current
    if (text === null) return
    pendingMessageRef.current = null
    liveAPI.sendText(text)
  }

  // Context is sent once per (session, exercise) or per tab, never on every answer
  useEffect(() => {
    if (!liveAPI.isConnected) {
      // A new connection must receive the context again
      lastContextKeyRef.current = null
      return
    }
    // With a typed message pending the context only joins the conversation (respond:false); the message triggers the answer
    const respond = pendingMessageRef.current === null

    if (session && currentExercise) {
      const key = currentContextKey
      if (!key || lastContextKeyRef.current === key) {
        flushPendingMessage()
        return
      }
      // Not loaded yet: this effect runs again when the prefetch arrives (the timer below covers a failed prefetch)
      if (!cachedContext || cachedContext.key !== key) return
      lastContextKeyRef.current = key
      liveAPI.sendContext(
        voiceExerciseContextMessage(LEGACY_VOICE_PROFILE, {
          topicTitle: currentExercise.topic?.title,
          questionText: currentExercise.questionText,
          choices: parsedChoices,
          sessionMode: session.mode,
          unitsText: cachedContext.unitsText,
          // The mode in effect right now, read here (not a dependency) so a mode change never re-runs this effect
          chatMode: getChatMode(CHAT_MODE_SCOPE, LEGACY_VOICE_PROFILE.defaultChatMode),
        }),
        { interrupt: true, respond }
      )
    } else if (!session) {
      const key = `tab:${activeTab === 'plan' ? 'plan' : 'dashboard'}`
      if (lastContextKeyRef.current !== key) {
        lastContextKeyRef.current = key
        const contextMsg = activeTab === 'plan' ? voicePlannerContextMessage() : voiceDashboardContextMessage()
        liveAPI.sendContext(contextMsg, { interrupt: false, respond })
      }
    }
    flushPendingMessage()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveAPI.isConnected, currentContextKey, cachedContext, session?.mode, activeTab])

  // If the context prefetch never arrives, do not hold the student's message back: send it and skip this exercise's context
  useEffect(() => {
    if (!liveAPI.isConnected || pendingMessageRef.current === null) return
    if (!currentContextKey || (cachedContext && cachedContext.key === currentContextKey)) return
    const timer = setTimeout(() => {
      lastContextKeyRef.current = currentContextKey
      flushPendingMessage()
    }, CONTEXT_WAIT_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveAPI.isConnected, currentContextKey, cachedContext])

  const handleRequestExplanation = (userAnswer: string) => {
    if (!currentExercise) return
    const msg = `I selected "${userAnswer}", but the correct answer is "${currentExercise.correctAnswer}". Can you explain why I am wrong?`

    if (!liveAPI.isConnected) {
      // Connect first (text-only); the context effect sends the message right after the context
      pendingMessageRef.current = msg
      liveAPI.connect(false).catch(() => { pendingMessageRef.current = null })
    } else {
      liveAPI.sendText(msg)
    }
  }

  const handleLoadSession = async (id: string) => {
    setIsLoading(true)
    try {
      await writer.flush()
      const state = await getSessionState(id, courseId)
      if (state) {
        // applyState swaps the tutor conversation when the session changes; this session's own is loaded below
        applyState(state)
        await loadChatLog(id)
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
                  onClick={session.mode === 'exam' ? (session.status === 'active' ? handleCancelExam : handleCloseReview) : handleFinishSession}
                >
                  {session.mode === 'exam' ? (session.status === 'active' ? 'Cancel Exam' : 'Close') : 'End Session'}
                </Button>
              </div>

              {/* TIMERS: Timed Exam Countdown Timer vs Standard Study Session Timer */}
              {session.mode === 'exam' && session.status !== 'active' ? (
                /* The server says this exam is over: no clock, no Submit button */
                <div className="p-4 rounded-xl border shadow-md flex flex-wrap justify-between items-center gap-2 bg-card border-charcoal-graphite/10 text-charcoal-graphite font-sans">
                  <span className="text-sm font-bold">
                    {session.status === 'cancelled' ? 'Exam cancelled' : (() => {
                      const { scoreSum } = sessionScore(session.logs || [])
                      return `Exam submitted - score ${formatScore(scoreSum)}/${exercises.length}`
                    })()}
                  </span>
                  <span className="text-xs text-charcoal-graphite/60">Reviewing your answers</span>
                </div>
              ) : session.mode === 'exam' ? (
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
                <SessionTimer durationSeconds={session.timeLimit ?? sessionDuration} startTime={session.startTime} endTime={session.endTime} active={session.status === 'active'} serverOffsetMs={clockOffsetMs} />
              )}

              {/* EXAM HUD: Complete Navigation Map Grid */}
              {session.mode === 'exam' && session.status === 'active' && exercises.length > 0 && (
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
                          onClick={() => goToIndex(idx)}
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
                      The professor is evaluating your exam answers and generating your customized study diagnostic plan. This usually takes 5-15 seconds.
                    </p>
                  </div>
                </div>
              )}

              {generationError && missingCount > 0 && !isDiagnosisLoading && (
                <div role="alert" className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-amber-50 border border-amber-300 text-amber-900 p-3 rounded-lg text-sm font-sans">
                  <div>
                    <p className="font-semibold">{missingCount} of {exercises.length + missingCount} questions could not be generated.</p>
                    <p className="text-xs">{generationError}</p>
                  </div>
                  <Button type="button" size="sm" variant="outline" onClick={() => setGenerationError(null)} className="shrink-0 border-amber-400 bg-white">
                    Retry
                  </Button>
                </div>
              )}

              {!isDiagnosisLoading && currentExercise ? (
                <div className="space-y-4">
                  <div className="flex justify-between items-center text-sm font-medium text-charcoal-graphite bg-card p-3 rounded-lg border border-charcoal-graphite/10 shadow-sm">
                    <div className="flex items-center gap-4">
                      <span>Question {currentIndex + 1} of {exercises.length + missingCount}</span>
                      {stillGenerating && (
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
                      onClick={() => goToIndex(Math.max(0, currentIndex - 1))}
                      disabled={currentIndex === 0}
                      className="flex-1 max-w-[120px] h-9 gap-1 font-semibold text-xs border border-charcoal-graphite/10 hover:bg-muted rounded-lg shrink-0"
                    >
                      <ChevronLeft className="w-3.5 h-3.5" />
                      Prev
                    </Button>

                    {/* Socratic Sibling Toggle: Flag for Review Toggle (Exam Mode only) */}
                    {session.mode === 'exam' && session.status === 'active' ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => toggleFlag(currentExercise.id)}
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
                        if (currentIndex === exercises.length - 1 && !stillGenerating) {
                          if (session.mode === 'exam' && session.status !== 'active') {
                            handleCloseReview()
                          } else if (session.mode === 'exam') {
                            const totalQs = exercises.length;
                            const answeredQs = Object.keys(draftAnswers).length;
                            const ok = window.confirm(`You have reached the end of the exam.\n\nProgress: ${answeredQs} of ${totalQs} questions answered. Submit now?`);
                            if (ok) handleFinishExam();
                          } else {
                            handleFinishSession()
                          }
                        } else {
                          goToIndex(Math.min(exercises.length - 1, currentIndex + 1))
                        }
                      }}
                      disabled={currentIndex === exercises.length - 1 && stillGenerating}
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
                    initialSelectedChoice={session.mode === 'exam' && session.status === 'active' ? draftAnswers[currentExercise.id] : currentLog?.userAnswer}
                    hasBeenAnswered={session.status !== 'active' ? true : (session.mode === 'exam' ? false : !!currentLog)}
                    isExamMode={session.mode === 'exam' && session.status === 'active'}
                    onAnswer={handleAnswer}
                    onRequestExplanation={handleRequestExplanation}
                    reported={currentExercise.status === 'reported'}
                    onReport={async (reason) => {
                      const ok = await reportExercise(currentExercise.id, reason)
                      // Stays in this session's list (already seen); only future sessions skip it
                      if (ok) setExercises(prev => prev.map(e => (e.id === currentExercise.id ? { ...e, status: 'reported' } : e)))
                      return ok
                    }}
                  />

                  <div className="flex justify-between pt-6">
                    <Button
                      variant="outline"
                      onClick={() => goToIndex(Math.max(0, currentIndex - 1))}
                      disabled={currentIndex === 0}
                    >
                      <ChevronLeft className="w-4 h-4 mr-2" />
                      Previous
                    </Button>
                    <Button
                      variant={currentIndex === exercises.length - 1 && !stillGenerating ? "default" : "outline"}
                      disabled={currentIndex === exercises.length - 1 && stillGenerating}
                      onClick={() => {
                        if (currentIndex === exercises.length - 1 && !stillGenerating) {
                          if (session.mode === 'exam' && session.status !== 'active') {
                            handleCloseReview()
                          } else if (session.mode === 'exam') {
                            const totalQs = exercises.length;
                            const answeredQs = Object.keys(draftAnswers).length;
                            const ok = window.confirm(`Ready to submit exam?\n\nProgress: ${answeredQs} of ${totalQs} questions answered.`);
                            if (ok) handleFinishExam();
                          } else {
                            handleFinishSession()
                          }
                        } else {
                          goToIndex(Math.min(exercises.length - 1, currentIndex + 1))
                        }
                      }}
                    >
                      {currentIndex === exercises.length - 1 && stillGenerating ? (
                        <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Generating...</>
                      ) : currentIndex === exercises.length - 1 && !stillGenerating ? (
                        session.mode === 'exam' ? (session.status === 'active' ? 'Submit Exam' : 'Close') : 'Finish Session'
                      ) : (
                        <>Next <ChevronRight className="w-4 h-4 ml-2" /></>
                      )}
                    </Button>
                  </div>
                </div>
              ) : isDiagnosisLoading ? null /* the grading panel above is the state while the exam is graded */ : (
                stillGenerating ? (
                  <div className="flex flex-col items-center gap-3 text-center text-muted-foreground py-12">
                    <Loader2 className="w-8 h-8 animate-spin text-lecture-red" />
                    <p className="font-medium text-charcoal-graphite">Writing your first question…</p>
                    <p className="text-sm max-w-sm">Each question is generated from your material and checked before you see it. This usually takes under a minute.</p>
                  </div>
                ) : (
                  <div className="text-center text-muted-foreground py-12">No exercises found for this selection.</div>
                )
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
                    const isCancelled = s.status === 'cancelled';
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
                            ) : isCancelled ? (
                              <span className="text-[10px] font-semibold text-muted-foreground">
                                Cancelled
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
                          
                          {!isCompleted && !isCancelled && (
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
            chatMode={chatMode}
            onChatModeChange={handleChatModeChange}
            chatModeProfile={LEGACY_VOICE_PROFILE}
            sessionMode={session?.mode}
            pendingMessageRef={pendingMessageRef}
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
          <ResourcesDashboard onViewFile={handleViewFile} onStartWeekSession={handleStartWeekSession} startingSession={isLoading} />
        </TabsContent>

        <TabsContent value="analytics" className="flex-1 overflow-y-auto m-0 p-4 sm:p-8 min-w-0">
          <AnalyticsDashboard onViewFile={handleViewFile} />
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
            activeFileKind={activeFileKind}
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
            chatMode={chatMode}
            onChatModeChange={handleChatModeChange}
            chatModeProfile={LEGACY_VOICE_PROFILE}
            sessionMode={session?.mode}
            pendingMessageRef={pendingMessageRef}
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
