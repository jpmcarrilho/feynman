'use client'

import { useState, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import { Flashcard } from './Flashcard'
import { SessionTimer } from './SessionTimer'
import { generateWithRetry } from '@/lib/generationRetry'
import { requestNextExercise } from '@/lib/generationClient'
import { VoiceHub } from './VoiceHub'
import { TutorSheet } from './TutorSheet'
import Link from 'next/link'
import { Dialog } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  startSession,
  checkSessionStartable,
  getActiveSession,
  getSessionState,
  saveDraft,
  setFlagged,
  setCurrentPosition,
  getTopicsWithPerformance,
  getSessionHistory,
  logAnswer,
  recordCardTime,
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
  ChevronDown,
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
  PanelRightOpen,
  MessageCircle
} from 'lucide-react'
import { useLiveAPI } from '@/hooks/useLiveAPI'
import {
  voiceSystemInstruction,
  voiceExerciseContextMessage,
  voicePlannerContextMessage,
  voiceDashboardContextMessage,
} from '@/lib/prompts'
import { formatScore, sessionScore, logScore, answerDisplayLines } from '@/lib/grading'
import { topicSourceLabel } from '@/lib/topicLabel'
import { plannerSuggestions, moduleLabelsOf } from '@/lib/plannerSuggestions'
import type { TutorChatMode, TutorProfile } from '@/lib/studyspace/profile'
import { getChatMode, setChatMode, subscribeChatMode, migrateLegacyChatMode } from '@/lib/studyspace/chatMode'
import { AnalyticsDashboard } from './AnalyticsDashboard'
import { FeynmanLogo } from './FeynmanLogo'
import { ConfigureSessionDialog } from './ConfigureSessionDialog'
import { SessionResultsDialog } from './SessionResultsDialog'
import { SessionHistoryList } from './SessionHistoryList'
import { SideVisualizer, type ActiveFileKind } from './SideVisualizer'
import { parseFileLink } from '@/lib/fileLinks'
import { DebouncedWriter } from '@/lib/debouncedWriter'
import { speechCountsForCard, type SpeechSource } from '@/lib/speechDetector'
import { CardTimer, cardKey, runningCardKey } from '@/lib/cardTimer'
import { ChatBuffer } from '@/lib/chatBuffer'
import {
  viewFromState,
  remainingSeconds,
  activeSessionHintKey,
  legacySessionId,
  routeLegacySession,
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

// How long a typed first message waits for the exercise context prefetch before it is sent without it
const CONTEXT_WAIT_MS = 5000

/** How long typing in a numeric field waits before the draft is sent, and the same for moving between questions. */
const DRAFT_DEBOUNCE_MS = 500
/** The tutor conversation is saved to the session this often while it changes. */
const CHAT_SAVE_INTERVAL_MS = 15_000
const LEGACY_SESSION_KEY = 'dedp_active_session'
/** Visible time not yet on the server is saved this often, so a crash or a server-side finalization loses little. */
const CARD_TIME_SAVE_INTERVAL_MS = 15_000
/** Tailwind's `xl` breakpoint: from here the tutor is a sidebar and the file viewer a side drawer, below it both cover the card. */
const WIDE_LAYOUT_QUERY = '(min-width: 1280px)'
const subscribeWideLayout = (cb: () => void) => {
  const mq = window.matchMedia(WIDE_LAYOUT_QUERY)
  mq.addEventListener('change', cb)
  return () => mq.removeEventListener('change', cb)
}
const getWideLayout = () => window.matchMedia(WIDE_LAYOUT_QUERY).matches
/** Exercises of a session the student asked the tutor about before answering them (survives a reload; dropped when the session ends). */
const assistedStorageKey = (sessionId: string) => `feynman_assisted_${sessionId}`
const readAssisted = (sessionId: string): string[] => {
  try {
    const parsed = JSON.parse(safeGetItem(assistedStorageKey(sessionId)) || '[]')
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/**
 * The study screen. The state of the running session (question, drafts, flags, answers, deadline, questions still to
 * be generated, topics) lives on the server; this component renders what `getSessionState` / `getActiveSession`
 * return. The only thing the browser keeps is a hint: the id of the session this browser had open
 * (`feynman_active_session_<courseId>`). `courseId` scopes every server call to one studyspace, and `profile` (the
 * studyspace's stored tutor profile) is the only persona the tutor uses. The page mounts this with `key={courseId}`, so
 * nothing in memory (planner chat, plan draft, selection) can carry over from another studyspace.
 */
export function StudyInterface({ courseId, courseTitle, profile }: { courseId: string; courseTitle: string; profile: TutorProfile }) {
  const [topics, setTopics] = useState<any[]>([])
  // The Create Session dialog's selection only
  const [selectedTopics, setSelectedTopics] = useState<string[]>([])
  const [histories, setHistories] = useState<any[]>([])
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [sessionDuration, setSessionDuration] = useState<number>(300) // Default 5 mins
  const [questionCount, setQuestionCount] = useState<number>(10)
  // A plain-language message for a failed start/save (shown in the session dialog while it is open, else as a banner)
  const [notice, setNotice] = useState<string | null>(null)

  const [session, setSession] = useState<any>(null)
  const [exercises, setExercises] = useState<any[]>([])
  const [missingCount, setMissingCount] = useState(0)
  // Set when one question slot failed 3 times in a row; holds the message to show. Generation stops until Retry.
  const [generationError, setGenerationError] = useState<string | null>(null)
  // false when the server said asking again cannot succeed: the banner then has no Retry button
  const [generationRetryable, setGenerationRetryable] = useState(true)
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
  // Below xl the tutor is a bottom sheet opened by a floating button. Open/closed is only a view state: the connection, the
  // chat and the mode live in this component (liveAPI, chat, the mode store), so none of them depends on the sheet.
  const [tutorOpen, setTutorOpen] = useState(false)
  const tutorButtonRef = useRef<HTMLButtonElement>(null)
  // Below xl the active exam shows one compact row (time, answered count, Submit); the question map and the secondary actions open on request
  const [examPanelOpen, setExamPanelOpen] = useState(false)
  // The same for a study session: one compact row, everything else behind a toggle (collapsed by default)
  const [studyPanelOpen, setStudyPanelOpen] = useState(false)
  // The message being typed in the tutor's text box, kept here so it survives the panel being re-created (sheet closed, window resized across xl)
  const [tutorDraft, setTutorDraft] = useState('')

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

  // The tutor is the studyspace's persona. Speech heard from the student is forwarded to markAssisted (a ref, because that function is defined further down)
  const speechHeardRef = useRef<(source: SpeechSource) => void>(() => {})
  const voiceInstruction = useMemo(() => voiceSystemInstruction(profile), [profile])
  const liveAPI = useLiveAPI(voiceInstruction, (source) => speechHeardRef.current(source))
  // always the latest connection, for the cleanup that runs when the student leaves the studyspace
  const liveRef = useRef(liveAPI)

  // The mode lives in a small external store (memory + localStorage `feynman_chat_mode_<courseId>`). The exercise-context
  // effect reads it with getChatMode() instead of depending on it, so a mode change never re-sends the exercise context.
  // The pre-studyspace choice (`feynman_chat_mode_legacy`) moves once into the first studyspace opened (idempotent).
  useState(() => { migrateLegacyChatMode(courseId) })
  const chatMode = useSyncExternalStore(
    subscribeChatMode,
    () => getChatMode(courseId, profile.defaultChatMode),
    () => profile.defaultChatMode
  )
  const handleChatModeChange = (mode: TutorChatMode) => setChatMode(courseId, mode)
  const refreshHistories = () => getSessionHistory(courseId).then(setHistories)

  // ---------------------------------------------------------------------------------------------------------------
  // Server-owned session state. The screen renders what the server returns; the browser keeps only a hint (session id).
  // ---------------------------------------------------------------------------------------------------------------
  // One serial, debounced queue for the small writes (drafts, flags, current question): they reach the server in the
  // order they were made, each carrying the session it belongs to, and are flushed before submitting or switching.
  const [writer] = useState(() => new DebouncedWriter())
  const hintKey = activeSessionHintKey(courseId)
  // Visible time per question (this file decides when a card is on screen; src/lib/cardTimer.ts does the counting)
  const [cardTimer] = useState(() => new CardTimer())
  // true from the xl breakpoint up; below it the tutor tab and the file viewer take the whole screen
  const wideLayout = useSyncExternalStore(subscribeWideLayout, getWideLayout, () => true)
  const [pageVisible, setPageVisible] = useState(true)
  // The sheet exists only below xl; crossing to the sidebar layout closes it (the sidebar then holds the one VoiceHub)
  const tutorSheetOpen = tutorOpen && !wideLayout
  const [layoutWasWide, setLayoutWasWide] = useState(wideLayout)
  if (layoutWasWide !== wideLayout) {
    setLayoutWasWide(wideLayout)
    if (wideLayout) setTutorOpen(false)
  }
  // study cards answered at the click (the clock stays stopped even before the log reaches the screen)
  const closedCardsRef = useRef(new Set<string>())
  // the card the tutor's help would count for right now (null: nothing to record), kept current by an effect
  const helpTargetRef = useRef<{ sid: string; exerciseId: string } | null>(null)
  const sessionModeRef = useRef<string | null>(null)
  // when the question that tutor help would count for became current (for the speech settling window)
  const targetSinceRef = useRef(0)
  const targetKeyRef = useRef<string | null>(null)
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
    if (sessionIdRef.current !== state.session.id) {
      // the question being left keeps the time it counted
      cardTimer.run(null)
      saveAllCardTimes()
      switchChat(state.session.id)
    }
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
      if (statusChanged) void refreshHistories()
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

  // An exam draft carries the visible seconds not yet saved. They are taken when the write RUNS, not when it is queued:
  // the writer keeps only the newest write per key, so seconds captured in a replaced closure would be lost. A write that
  // throws gives its seconds back; one the server rejects (session over) needs none.
  const persistDraft = (sid: string, exerciseId: string, value: string | null, debounce: boolean) => {
    writer.schedule(`${sid}:draft:${exerciseId}`, async () => {
      const key = cardKey(sid, exerciseId)
      const seconds = cardTimer.take(key)
      try {
        syncAfterRejection(sid, await saveDraft(sid, exerciseId, value, seconds))
      } catch (e) {
        cardTimer.restore(key, seconds)
        throw e
      }
    }, debounce ? DRAFT_DEBOUNCE_MS : 0)
  }

  /** Saves the visible seconds of one question on their own (exam: a draft write with no draft; study: recordCardTime). Own writer key, so it never replaces a pending draft. */
  const persistTime = (sid: string, exerciseId: string, mode: string | null) => {
    writer.schedule(`${sid}:time:${exerciseId}`, async () => {
      const key = cardKey(sid, exerciseId)
      const seconds = cardTimer.take(key)
      if (seconds <= 0) return
      try {
        syncAfterRejection(sid, mode === 'exam' ? await saveDraft(sid, exerciseId, undefined, seconds) : await recordCardTime(sid, exerciseId, seconds))
      } catch (e) {
        cardTimer.restore(key, seconds)
        throw e
      }
    }, 0)
  }

  /** Stops the clock and queues the unsaved time of every question of the session on screen. */
  const saveAllCardTimes = () => {
    const sid = sessionIdRef.current
    if (!sid || latestRef.current.status !== 'active') return
    for (const key of cardTimer.keysWithUnsent(`${sid}:`)) persistTime(sid, key.slice(sid.length + 1), sessionModeRef.current)
  }

  /**
   * The student asked the tutor about the question on screen (typed, switched mode, used a control, or was heard
   * speaking). Counts only for a study question that is current and not answered yet; an exam records nothing
   * (the proctor gives no help), and a question answered already is never changed.
   * `speech` is set for signals that come from the student's audio: they are ignored for a short settling window after
   * the question changed (see SPEECH_SETTLE_MS), so audio spoken on the previous question is not credited to this one.
   * A typed message or a mode switch is an action on the current question and is attributed to it immediately,
   * whenever the tutor's reply arrives.
   */
  const markAssisted = (speech?: SpeechSource) => {
    const target = helpTargetRef.current
    if (!target) return
    if (speech && !speechCountsForCard(speech, Date.now() - targetSinceRef.current)) return
    const stored = readAssisted(target.sid)
    if (stored.includes(target.exerciseId)) return
    safeSetItem(assistedStorageKey(target.sid), JSON.stringify([...stored, target.exerciseId]))
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
    // The card being left stops counting now and its time is queued (its own key, so a pending draft is not replaced)
    if (session?.status === 'active' && currentExercise) {
      cardTimer.run(null)
      persistTime(session.id, currentExercise.id, session.mode)
      // A draft still waiting out its debounce (a number being typed) is sent now, before the position write
      void writer.flush()
    }
    setCurrentIndex(index)
    if (session?.status === 'active') {
      const sid = session.id
      writer.schedule(`${sid}:pos`, async () => syncAfterRejection(sid, await setCurrentPosition(sid, index)), DRAFT_DEBOUNCE_MS)
    }
  }

  const loadActivePlan = async () => {
    try {
      const plans = await getStudyPlans(courseId);
      const active = plans.find((p: any) => p.status === 'active');
      setActivePlan(active || null);

      // Initialize the planner workspace chat list with a highly personalized Socratic greeting if empty
      if (!active && plannerChat.length === 0) {
        setPlannerChat([
          {
            role: 'assistant',
            content: "Welcome to your AI Curriculum Planner Workspace! I am your Socratic Academic Advisor.\n\nHow should we structure your timeline? Tell me your available daily hours (e.g. 'I want 3 sessions a day, 2 hours each, from Tuesday to Friday'), or use one of the suggested pre-ideas below, if there are any, to design your curriculum!"
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
      const analytics = await getAnalyticsData(courseId)
      
      // Prioritize the planner workspace chat messages first, falling back to general liveAPI history if empty
      const activeMessages = plannerChat.length > 1 ? plannerChat.map(m => ({
        role: m.role,
        text: m.content
      })) : liveAPI.messages;

      const plan = await generateStructuredStudyPlan(activeMessages, analytics, courseId)
      if (plan) {
        setDraftPlan(plan)
        setActiveTab('plan') // Programmatically switch to Plan tab where the draft widget renders!
      } else {
        alert("Failed to compile study plan. Please write more detail in the chat and try again.")
      }
    } catch (e) {
      console.error(e)
      setNotice('The study plan could not be compiled. Check your connection and try again.')
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
      const analytics = await getAnalyticsData(courseId)
      const response = await generatePlannerResponse(updatedMessages, analytics, courseId)
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
      const plan = await saveAndDeployStudyPlan(finalPlan, courseId)
      if (plan) {
        setDraftPlan(null)
        await loadActivePlan()
        refreshHistories()
      } else {
        // null: the plan named topics of another studyspace, or it could not be stored; nothing was written
        setNotice('The study plan could not be saved. It may name topics that are not part of this studyspace; the draft is kept, so you can adjust it and deploy again.')
      }
    } catch (e) {
      console.error(e)
      setNotice('The study plan could not be saved. The draft is kept; try again in a moment.')
    }
    setIsDeployingPlan(false)
  }

  const handleDeletePlan = async (planId: string) => {
    if (typeof window !== 'undefined') {
      const ok = window.confirm("Are you sure you want to delete this study plan curriculum? This will delete all of its pre-created study sessions.")
      if (ok) {
        await deleteStudyPlan(planId)
        await loadActivePlan()
        refreshHistories()
      }
    }
  }

  /**
   * The pre-studyspace client kept a snapshot under `dedp_active_session`. Its session id is used once: for this
   * studyspace if the session is its own, handed to the studyspace that owns it otherwise (it resumes there), dropped
   * when the session is over or gone. This is the one call that asks for a session without the studyspace scope: it is
   * how the owning studyspace is found. The key is removed only after the decision, so a network failure retries later.
   */
  const resolveLegacySession = async () => {
    const raw = safeGetItem(LEGACY_SESSION_KEY)
    if (raw === null) return
    const legacyId = legacySessionId(raw)
    if (legacyId) {
      let found: { courseId: string | null; status: string } | null
      try {
        const state = await getSessionState(legacyId)
        found = state ? { courseId: state.session.courseId, status: state.session.status } : null
      } catch {
        return
      }
      const route = routeLegacySession(found, courseId)
      if (route.action === 'adopt' && !safeGetItem(hintKey)) safeSetItem(hintKey, legacyId)
      if (route.action === 'forward' && !safeGetItem(activeSessionHintKey(route.courseId))) safeSetItem(activeSessionHintKey(route.courseId), legacyId)
    }
    safeRemoveItem(LEGACY_SESSION_KEY)
  }

  useEffect(() => {
    // Load initial data (including performance coverage metrics), all of this studyspace
    getTopicsWithPerformance(courseId).then(setTopics)
    refreshHistories()
    loadActivePlan()

    // Resume the running session from the server. The hint (session id this browser had open in this studyspace) is
    // preferred while that session is still active; otherwise the latest active session of the studyspace.
    // An empty localStorage works too.
    let cancelled = false
    ;(async () => {
      try {
        await resolveLegacySession()
        const hint = safeGetItem(hintKey)
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
    else {
      if (safeGetItem(hintKey) === session.id) safeRemoveItem(hintKey)
      safeRemoveItem(assistedStorageKey(session.id))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, session?.status])

  // What the generation loop and the visibility handler compare the server's state against
  useEffect(() => {
    liveRef.current = liveAPI
    latestRef.current = { status: session?.status, itemCount: exercises.length, missingCount }
    sessionModeRef.current = session?.mode ?? null
    chat.observe(liveAPI.messages)
  })

  // Pending drafts are sent when the page is hidden or closed; coming back re-reads the session (clock, status)
  useEffect(() => {
    const onVisibility = () => {
      const visible = document.visibilityState !== 'hidden'
      setPageVisible(visible)
      if (!visible) {
        // stop the clock at once (before any re-render) and queue what it counted
        cardTimer.run(null)
        saveAllCardTimes()
      }
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
    const onPageHide = () => { cardTimer.run(null); saveAllCardTimes(); void writer.flush() }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onPageHide)
      // Leaving for another page of the app (the "Studyspaces" link) does not fire pagehide: save what is pending, and
      // release the microphone and the tutor connection, which no longer have a screen
      onPageHide()
      const sid = sessionIdRef.current
      const messages = sid && latestRef.current.status === 'active' ? chat.changedSnapshot(sid) : null
      if (sid && messages) {
        chat.markSaved(sid, messages)
        void saveChatLog(sid, messages).catch(() => {})
      }
      liveRef.current.disconnect()
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
    // The viewer covers the screen below xl: put the tutor sheet away so the file is what the student sees
    setTutorOpen(false)
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
      const result = await generateSessionSummary(session.id, courseId)
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
      // Cheap database-only check: a start that could never show a question creates no session and says why
      const check = await checkSessionStartable({ courseId, topicIds: input.topicIds, count: input.count, sourcingMix: input.sourcingMix })
      if (!check.startable) {
        setNotice(check.message)
        return
      }
      // Drafts and flags still queued belong to the session that is about to end: send them first
      await writer.flush()
      const state = await startSession({ ...input, courseId })
      applyState(state)
      setNotice(null)
      setIsModalOpen(false)
      setActiveTab('study') // Ensure active tab shifts to 'study' immediately to reveal the active cards!
      refreshHistories()
    } catch (e) {
      console.error('Failed to start the session', e)
      // Server messages are hidden from the browser in production, so the text is fixed: it covers the two known causes
      setNotice('The session could not be started. The selected topics may not belong to this studyspace, or the studyspace no longer exists. Reload the page and try again.')
      // The previous session may or may not have been ended: show what the server has
      if (sessionIdRef.current) void refreshFromServer(sessionIdRef.current, { force: true }).catch(() => {})
    } finally {
      startingRef.current = false
      setIsLoading(false)
    }
  }

  const openSessionDialog = () => {
    setNotice(null)
    setIsModalOpen(true)
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
      cardTimer.run(null);
      saveAllCardTimes();
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
      refreshHistories();

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
      refreshHistories();
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
      setGenerationRetryable(true)
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
        // Questions the session holds, counting those this loop appended
        let held = latestRef.current.itemCount
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
            // A session that can never get a question and has none: nothing to lose, so end it and say why on the start screen
            if (outcome.retryable === false && held === 0) {
              void endEmptySession(sessionId, outcome.error)
              return
            }
            // Stop here; the banner offers Retry. No timer restarts the loop.
            setGenerationError(outcome.error)
            setGenerationRetryable(outcome.retryable !== false)
            return
          }
          remaining -= 1
          held += 1
          setExercises(prev => (prev.some((e: any) => e.id === outcome.exercise.id) ? prev : [...prev, outcome.exercise]))
          setMissingCount(prev => Math.max(0, prev - 1))
        }
      } finally {
        if (!cancelled()) generationLoopActiveRef.current = false
      }
    })()
  }, [sessionId, sessionEnded, missingCount, generationError, exercises]);

  useEffect(() => { finishExamRef.current = handleFinishExam })

  /**
   * Generation ended with an error that asking again cannot fix and the session has no questions at all: end it on the
   * server (a study session is completed, an exam cancelled; with no answers neither loses anything and an empty one is
   * not listed in History), go back to the start screen and show the message there. If the server could not end it, the
   * banner of a session with missing questions is shown instead.
   */
  const endEmptySession = async (sid: string, message: string) => {
    let ended = false
    try {
      await writer.flush()
      ended = sessionModeRef.current === 'exam' ? await cancelStudySession(sid) : await finishStudySession(sid)
    } catch (e) {
      console.error('Failed to end the empty session:', e)
    }
    if (sessionIdRef.current !== sid) return
    if (!ended) {
      setGenerationError(message)
      setGenerationRetryable(false)
      return
    }
    clearSessionView()
    setActiveTab('study')
    setNotice(`${message} The session was closed because it had no questions.`)
    void refreshHistories()
  }

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
      setHistories(await getSessionHistory(courseId))
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
        cardTimer.run(null)
        saveAllCardTimes()
        await writer.flush()
        const messages = chat.snapshot(session.id)
        await Promise.all([
          messages ? saveChatLog(session.id, messages) : Promise.resolve(),
          finishStudySession(session.id)
        ])

        // Fetch updated history so we can show results immediately!
        const updatedHistories = await getSessionHistory(courseId)
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
      refreshHistories()
    }
  }

  const currentLog = session?.logs?.find((l: any) => l.exerciseId === currentExercise?.id)
  // Exam questions with a saved (non-empty) draft
  const answeredCount = Object.values(draftAnswers).filter(Boolean).length
  const suggestions = useMemo(() => plannerSuggestions(moduleLabelsOf(topics)), [topics])

  // --- Visible time and tutor help for the question on screen ---------------------------------------------------
  // The clock of a question runs only while ALL of these hold: its session is active, the Study tab is showing, the
  // page is visible, no dialog (new session, results) or file viewer covers it, no diagnosis is loading, it is the
  // current question, and (study mode) it has not been answered. Below xl the file viewer covers the card; from xl up
  // it only does when it is in full-width mode.
  const currentCardKey = session && currentExercise ? cardKey(session.id, currentExercise.id) : null
  const viewerCoversCard = !!activeFile && (!wideLayout || isVisualizerFullWidth)
  // The tutor sheet counts as leaving the card: time spent in the tutor is not time on the card (T18)
  const cardCovered = isDiagnosisLoading || isModalOpen || !!selectedHistory || viewerCoversCard || tutorSheetOpen
  const examCard = session?.mode === 'exam'
  const cardSessionActive = session?.status === 'active'
  useEffect(() => {
    cardTimer.run(runningCardKey({
      key: currentCardKey,
      sessionActive: !!cardSessionActive,
      examMode: !!examCard,
      answered: !!currentLog,
      studyTabShowing: activeTab === 'study',
      pageVisible,
      covered: cardCovered,
      closed: closedCardsRef.current,
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentCardKey, cardSessionActive, examCard, !!currentLog, activeTab, pageVisible, cardCovered])

  // Unsaved time goes to the server regularly while a session is active
  useEffect(() => {
    if (!session?.id || session.status !== 'active') return
    const interval = setInterval(saveAllCardTimes, CARD_TIME_SAVE_INTERVAL_MS)
    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, session?.status])

  // Tutor help counts for the current study question until it is answered (an exam records no help)
  useEffect(() => {
    helpTargetRef.current =
      session && currentExercise && session.status === 'active' && session.mode !== 'exam' && !currentLog &&
      !closedCardsRef.current.has(cardKey(session.id, currentExercise.id))
        ? { sid: session.id, exerciseId: currentExercise.id }
        : null
    const nowKey = helpTargetRef.current ? cardKey(helpTargetRef.current.sid, helpTargetRef.current.exerciseId) : null
    if (nowKey !== targetKeyRef.current) {
      targetKeyRef.current = nowKey
      targetSinceRef.current = Date.now()
    }
    speechHeardRef.current = markAssisted
  })

  const handleAnswer = async (isCorrect: boolean, userAnswer: string) => {
    if (session && currentExercise) {
      if (session.mode === 'exam') {
        // A draft, not a commit: kept on screen and on the server (typing in a numeric field is sent after a pause)
        // An empty answer (everything unticked, field emptied) clears the draft, so it no longer counts as answered
        const draftExerciseId: string = currentExercise.id
        setDraftAnswers(prev => {
          if (userAnswer === '') return Object.fromEntries(Object.entries(prev).filter(([id]) => id !== draftExerciseId))
          return { ...prev, [draftExerciseId]: userAnswer }
        });
        persistDraft(session.id, currentExercise.id, userAnswer === '' ? null : userAnswer, currentExercise.exerciseType === 'numeric')
      } else {
        // The server grades with the same gradeAnswer the flashcard just used; its result is what is stored
        const sid: string = session.id
        const exerciseId: string = currentExercise.id
        const key = cardKey(sid, exerciseId)
        // The clock stops at the click. Time saved earlier is flushed first so it reaches the server before the log;
        // the seconds still held here travel with the answer, and the server adds them to what it stored.
        closedCardsRef.current.add(key)
        cardTimer.run(null)
        const assisted = readAssisted(sid).includes(exerciseId)
        await writer.flush()
        const seconds = cardTimer.take(key)
        let graded: Awaited<ReturnType<typeof logAnswer>>
        try {
          graded = await logAnswer(sid, exerciseId, userAnswer, { durationSec: seconds, assisted })
        } catch (e) {
          cardTimer.restore(key, seconds)
          closedCardsRef.current.delete(key)
          throw e
        }
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
        voiceExerciseContextMessage(profile, {
          topicTitle: currentExercise.topic?.title,
          questionText: currentExercise.questionText,
          choices: parsedChoices,
          sessionMode: session.mode,
          unitsText: cachedContext.unitsText,
          // The mode in effect right now, read here (not a dependency) so a mode change never re-runs this effect
          chatMode: getChatMode(courseId, profile.defaultChatMode),
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
    if (!wideLayout) setTutorOpen(true) // the reply shows in the tutor sheet
    markAssisted() // (the control appears after the answer, when nothing is recorded any more; kept for any earlier use)
    // The answers as a person reads them (not the stored JSON)
    const shape = { exerciseType: currentExercise.exerciseType || 'single_choice', choices: parsedChoices, questionText: currentExercise.questionText }
    const chosen = answerDisplayLines(shape, userAnswer).join('; ') || userAnswer
    const key = answerDisplayLines(shape, currentExercise.correctAnswer).join('; ') || currentExercise.correctAnswer
    const msg = `I selected "${chosen}", but the correct answer is "${key}". Can you explain why I am wrong?`

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
    <div className="flex w-full h-dvh overflow-hidden bg-background font-sans relative">

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
              <Link href="/spaces" title="Studyspaces" className="cursor-pointer flex items-center gap-2 select-none">
                <FeynmanLogo variant="mini" size={40} className="stroke-charcoal-graphite transition-transform duration-200 hover:scale-105 animate-sketch-draw" />
                <span className="font-display text-xl sm:text-2xl italic font-bold tracking-tight text-charcoal-graphite transition-colors duration-200 hover:text-fountain-ink">Feynman</span>
              </Link>
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
                <Button type="button" onClick={openSessionDialog} className="w-full flex gap-2 bg-lecture-red hover:bg-lecture-red/90 text-white border-0 shadow-sm font-semibold h-11 shrink-0">
                    <PlusCircle className="w-4 h-4" />
                    Create Session
                  </Button>

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
        className={`flex-1 flex flex-col min-w-0 max-xl:pb-[calc(4.5rem+env(safe-area-inset-bottom))] transition-all duration-300 ease-in-out bg-background w-full ${getMainWidthClass()}`}
      >
        <div className="pt-4 pb-4 px-4 sm:px-8 border-b border-charcoal-graphite/10 transition-all duration-300 flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 xl:pl-8">
          {/* Way back to the list, and which studyspace this is */}
          <div className="flex items-center gap-3 min-w-0 select-none">
            <Link href="/spaces" className="shrink-0 inline-flex items-center max-xl:min-h-11 text-xs sm:text-sm font-semibold text-fountain-ink hover:underline">&larr; Studyspaces</Link>
            <span className="font-display text-lg sm:text-xl italic font-bold tracking-tight text-charcoal-graphite truncate" title={courseTitle}>{courseTitle}</span>
          </div>

          {/* Tabs row */}
          <div className="flex items-center gap-4 w-full sm:w-auto sm:shrink-0 min-w-0 max-w-full">
            {/* Five tabs below xl: they fit, or the strip scrolls sideways; no label is clipped (whitespace-nowrap, never narrower than its text) */}
            <TabsList className="bg-muted border border-charcoal-graphite/5 p-1 rounded-lg w-full sm:w-auto max-w-full flex justify-around overflow-x-auto xl:overflow-visible max-xl:h-12! max-xl:p-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <TabsTrigger value="study" className="max-xl:h-11! max-xl:px-3.5 flex-1 sm:flex-initial data-[state=active]:bg-sketchbook-cream data-[state=active]:text-charcoal-graphite font-semibold text-xs sm:text-sm">Study</TabsTrigger>
              <TabsTrigger value="plan" className="max-xl:h-11! max-xl:px-3.5 flex-1 sm:flex-initial data-[state=active]:bg-sketchbook-cream data-[state=active]:text-charcoal-graphite font-semibold text-xs sm:text-sm">Study Plan</TabsTrigger>
              <TabsTrigger value="resources" className="max-xl:h-11! max-xl:px-3.5 flex-1 sm:flex-initial data-[state=active]:bg-sketchbook-cream data-[state=active]:text-charcoal-graphite font-semibold text-xs sm:text-sm">Resources</TabsTrigger>
              <TabsTrigger value="history" className="max-xl:h-11! max-xl:px-3.5 xl:hidden flex-1 sm:flex-initial data-[state=active]:bg-sketchbook-cream data-[state=active]:text-charcoal-graphite font-semibold text-xs sm:text-sm">History</TabsTrigger>
              <TabsTrigger value="analytics" className="max-xl:h-11! max-xl:px-3.5 flex-1 sm:flex-initial data-[state=active]:bg-sketchbook-cream data-[state=active]:text-charcoal-graphite font-semibold text-xs sm:text-sm">Analytics</TabsTrigger>
            </TabsList>
          </div>
        </div>

        {notice && !isModalOpen && (
          <div role="alert" className="mx-4 sm:mx-8 mt-3 flex items-start justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 font-sans">
            <p>{notice}</p>
            <Button type="button" size="sm" variant="outline" onClick={() => setNotice(null)} className="shrink-0 border-amber-400 bg-white">Dismiss</Button>
          </div>
        )}

        <TabsContent value="study" className="flex-1 overflow-y-auto p-4 sm:p-8 m-0 min-w-0">
          {session ? (
            <div className="w-full max-w-3xl mx-auto space-y-3 xl:space-y-6 pb-12 min-w-0">

              {/* STUDY, below xl: one compact row (question n of m, where it comes from, elapsed time) and a toggle for the rest */}
              {session.mode !== 'exam' && (
                <div data-testid="study-compact-row" className="xl:hidden flex min-h-11 items-center gap-2 rounded-xl border border-charcoal-graphite/10 bg-card pl-3 pr-1 shadow-sm">
                  <span className="shrink-0 text-sm font-semibold text-charcoal-graphite">
                    <span className="sr-only">Question {currentIndex + 1} of {exercises.length + missingCount}</span>
                    <span aria-hidden="true">{currentIndex + 1}/{exercises.length + missingCount}</span>
                  </span>
                  {stillGenerating && <span className="shrink-0 animate-pulse" role="img" aria-label="Generating more questions"><FeynmanLogo variant="thinking" size={14} /></span>}
                  <span className="min-w-0 flex-1 truncate text-xs font-semibold text-fountain-ink" title={currentExercise ? topicSourceLabel(currentExercise.topic) : undefined}>
                    {currentExercise ? topicSourceLabel(currentExercise.topic) : ''}
                  </span>
                  <SessionTimer compact durationSeconds={session.timeLimit ?? sessionDuration} startTime={session.startTime} endTime={session.endTime} active={session.status === 'active'} serverOffsetMs={clockOffsetMs} />
                  <button
                    type="button"
                    onClick={() => setStudyPanelOpen((o) => !o)}
                    aria-expanded={studyPanelOpen}
                    aria-controls="study-panel"
                    aria-label={studyPanelOpen ? 'Hide session options' : 'Session options'}
                    className="flex size-11 shrink-0 items-center justify-center rounded-lg text-charcoal-graphite/70 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    <ChevronDown className={`size-5 transition-transform ${studyPanelOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
                  </button>
                </div>
              )}
              {session.mode !== 'exam' && studyPanelOpen && (
                <div id="study-panel" className="xl:hidden space-y-1 rounded-xl border border-charcoal-graphite/10 bg-card p-3 text-xs text-charcoal-graphite/80 shadow-sm">
                  {currentExercise && <p className="font-semibold text-fountain-ink break-words">{topicSourceLabel(currentExercise.topic)}</p>}
                  <p>Question {currentIndex + 1} of {exercises.length + missingCount}{stillGenerating ? ` - generating ${missingCount} more...` : ''}</p>
                </div>
              )}

              {/* Actions Row: Create Session, Session Summary, and End Session (Above elapsed time) */}
              <div className={`flex flex-wrap items-center gap-3 bg-card p-4 rounded-xl border border-charcoal-graphite/10 shadow-sm justify-between ${(session.mode === 'exam' ? session.status === 'active' && !examPanelOpen : !studyPanelOpen) ? 'max-xl:hidden' : ''}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="button" onClick={openSessionDialog} className="flex gap-1.5 bg-lecture-red hover:bg-lecture-red/90 text-white border-0 shadow-sm font-semibold h-9 max-xl:h-11 px-3 text-xs rounded-lg animate-sketch-draw">
                      <PlusCircle className="w-4 h-4" />
                      <span>New Session</span>
                    </Button>

                  {session.mode !== 'exam' && (
                    <Button
                      variant="outline"
                      className="text-fountain-ink border-fountain-ink/30 hover:bg-fountain-ink/5 font-medium flex items-center gap-1.5 shadow-sm h-9 max-xl:h-11 px-3 text-xs rounded-lg"
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
                  className="text-lecture-red hover:text-lecture-red hover:bg-lecture-red/10 border border-transparent hover:border-lecture-red/20 font-medium h-9 max-xl:h-11 px-3 text-xs rounded-lg"
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
                <div className={`p-4 max-xl:p-3 rounded-xl border shadow-md flex max-xl:flex-wrap justify-between items-center max-xl:gap-y-2 transition-all duration-300 font-sans ${
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
                        const answeredQs = answeredCount;
                        const ok = window.confirm(`Are you sure you want to submit your exam paper?\n\nProgress: ${answeredQs} of ${totalQs} questions answered.`);
                        if (ok) {
                          handleFinishExam();
                        }
                      }
                    }}
                    className="bg-lecture-red hover:bg-lecture-red/90 text-white font-semibold text-sm shadow-sm h-10 max-xl:h-11 px-4 rounded-lg"
                  >
                    Submit Exam Paper
                  </Button>
                  {/* Below xl: how far along, and the way to the question map and the secondary actions (collapsed by default) */}
                  <div className="xl:hidden w-full flex items-center justify-between gap-2 text-xs font-semibold text-charcoal-graphite/70">
                    <span aria-live="polite">{answeredCount} of {exercises.length} answered</span>
                    <button
                      type="button"
                      onClick={() => setExamPanelOpen((o) => !o)}
                      aria-expanded={examPanelOpen}
                      aria-controls="exam-panel"
                      className="min-h-11 rounded-md px-3 text-xs font-semibold text-fountain-ink hover:bg-fountain-ink/10 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      {examPanelOpen ? 'Hide question map' : 'Question map & actions'}
                    </button>
                  </div>
                </div>
              ) : (
                <div className={studyPanelOpen ? '' : 'max-xl:hidden'}>
                  <SessionTimer durationSeconds={session.timeLimit ?? sessionDuration} startTime={session.startTime} endTime={session.endTime} active={session.status === 'active'} serverOffsetMs={clockOffsetMs} />
                </div>
              )}

              {/* EXAM HUD: Complete Navigation Map Grid */}
              {session.mode === 'exam' && session.status === 'active' && exercises.length > 0 && (
                <div id="exam-panel" className={`bg-card p-4 sm:p-5 rounded-xl border border-charcoal-graphite/10 shadow-sm space-y-4 font-sans ${examPanelOpen ? '' : 'max-xl:hidden'}`}>
                  <div className="flex justify-between items-center text-xs font-semibold text-charcoal-graphite/60 uppercase tracking-wider pb-2 border-b border-charcoal-graphite/10">
                    <span>Exam Navigation Map</span>
                    <span className="text-fountain-ink font-bold">{answeredCount} of {exercises.length} Answered</span>
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
                          className={`w-10 h-10 max-xl:w-11 max-xl:h-11 p-0 text-sm font-medium rounded-md transition-all duration-200 relative ${btnClass}`}
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
                    {!generationRetryable && <p className="text-xs">Trying again will not help. Start a new session with other topics.</p>}
                  </div>
                  {generationRetryable && (
                    <Button type="button" size="sm" variant="outline" onClick={() => setGenerationError(null)} className="shrink-0 border-amber-400 bg-white">
                      Retry
                    </Button>
                  )}
                </div>
              )}

              {!isDiagnosisLoading && currentExercise ? (
                <div className="space-y-4">
                  <div className={`flex flex-wrap justify-between items-center gap-x-4 gap-y-1 text-sm font-medium text-charcoal-graphite bg-card p-3 rounded-lg border border-charcoal-graphite/10 shadow-sm ${session.mode !== 'exam' ? 'max-xl:hidden' : ''}`}>
                    <div className="flex items-center gap-4">
                      <span>Question {currentIndex + 1} of {exercises.length + missingCount}</span>
                      {stillGenerating && (
                        <span className="flex items-center text-fountain-ink text-xs font-semibold animate-pulse">
                          <FeynmanLogo variant="thinking" size={14} className="mr-1" />
                          Generating {missingCount} more...
                        </span>
                      )}
                    </div>
                    {/* Where the question comes from (module and class or lecture), not the source topic title ("Question 6") */}
                    <span className="font-semibold text-fountain-ink min-w-0 break-words" title={topicSourceLabel(currentExercise.topic)}>{topicSourceLabel(currentExercise.topic)}</span>
                  </div>

                  {/* Interactive Arrow Navigation Bar */}
                  <div data-testid="top-nav" className={`flex justify-between items-center w-full select-none gap-2 ${session.mode !== 'exam' ? 'max-xl:hidden' : ''}`}>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => goToIndex(Math.max(0, currentIndex - 1))}
                      disabled={currentIndex === 0}
                      className="flex-1 max-w-[120px] h-9 max-xl:h-11 gap-1 font-semibold text-xs border border-charcoal-graphite/10 hover:bg-muted rounded-lg shrink-0"
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
                        className={`h-9 max-xl:h-11 px-4 gap-1.5 font-semibold text-xs border rounded-lg shrink-0 transition-all duration-200 ${
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
                            const answeredQs = answeredCount;
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
                      className="flex-1 max-w-[120px] h-9 max-xl:h-11 gap-1 font-semibold text-xs border border-charcoal-graphite/10 hover:bg-muted rounded-lg shrink-0"
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
                    result={currentLog ? { score: logScore(currentLog), isCorrect: !!currentLog.isCorrect } : null}
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
                      className="max-xl:h-11"
                      onClick={() => goToIndex(Math.max(0, currentIndex - 1))}
                      disabled={currentIndex === 0}
                    >
                      <ChevronLeft className="w-4 h-4 mr-2" />
                      Previous
                    </Button>
                    <Button
                      className="max-xl:h-11"
                      variant={currentIndex === exercises.length - 1 && !stillGenerating ? "default" : "outline"}
                      disabled={currentIndex === exercises.length - 1 && stillGenerating}
                      onClick={() => {
                        if (currentIndex === exercises.length - 1 && !stillGenerating) {
                          if (session.mode === 'exam' && session.status !== 'active') {
                            handleCloseReview()
                          } else if (session.mode === 'exam') {
                            const totalQs = exercises.length;
                            const answeredQs = answeredCount;
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
                  <Button type="button" onClick={openSessionDialog} className="w-full max-w-[240px] flex gap-2 bg-lecture-red hover:bg-lecture-red/90 text-white border-0 shadow-md font-semibold h-11 mx-auto rounded-lg shadow-sm">
                      <PlusCircle className="w-5 h-5" />
                      Create Study Session
                    </Button>
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
                  Design a personalized, multi-day Socratic Study Syllabus based on your exact strengths, weaknesses, and preferred available hours. Discuss with the professor below, or use a suggested pre-idea to start your study timeline.
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

                {/* Pre-ideas: generic study-planning starters filled with module names of this studyspace (none without modules) */}
                {suggestions.length > 0 && (
                  <div className="space-y-2 shrink-0 pt-2 border-t border-charcoal-graphite/5">
                    <span className="text-[10px] font-bold text-charcoal-graphite/50 uppercase tracking-wider block">Suggested Pre-Ideas:</span>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      {suggestions.map((sg) => (
                        <button
                          key={sg.id}
                          type="button"
                          disabled={isPlannerChatLoading}
                          onClick={() => handleSendPlannerMessage(sg.prompt)}
                          className="text-left min-h-11 min-w-0 break-words p-2.5 rounded-lg border border-bongo-gold/25 bg-bongo-gold/5 hover:bg-bongo-gold/15 text-[10px] sm:text-xs leading-snug font-medium text-charcoal-graphite transition-colors duration-150"
                        >
                          {sg.icon} <strong>{sg.title}</strong><br />
                          {sg.focus}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

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
                    className="flex-1 rounded-md border border-charcoal-graphite/15 bg-background text-charcoal-graphite px-3 py-2 max-xl:h-11 text-base sm:text-sm placeholder:text-charcoal-graphite/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-fountain-ink outline-none"
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
          <ResourcesDashboard courseId={courseId} onViewFile={handleViewFile} onStartWeekSession={handleStartWeekSession} startingSession={isLoading} subject={profile.subject} />
        </TabsContent>

        <TabsContent value="analytics" className="flex-1 overflow-y-auto m-0 p-4 sm:p-8 min-w-0">
          <AnalyticsDashboard courseId={courseId} onViewFile={handleViewFile} />
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

      {/* RIGHT SIDEBAR - 20vw / 64px / 0px. Mounted only from xl up: below it the tutor is the bottom sheet, so there is
          never more than one VoiceHub (one chat box, one mode selector, one set of connection controls). */}
      {wideLayout && (
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
            draft={tutorDraft}
            onDraftChange={setTutorDraft}
            chatMode={chatMode}
            onChatModeChange={handleChatModeChange}
            chatModeProfile={profile}
            sessionMode={session?.mode}
            pendingMessageRef={pendingMessageRef}
            onHelpRequested={markAssisted}
          />
        )}
      </div>
      )}

      {/* Below xl: floating Tutor button and the bottom sheet that holds the same VoiceHub. The button stays mounted while the
          sheet is open (focus returns to it); the sheet's content is mounted only while it is open. */}
      {!wideLayout && (
        <button
          ref={tutorButtonRef}
          type="button"
          onClick={() => setTutorOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={tutorSheetOpen}
          aria-label={`Tutor, ${liveAPI.isConnected ? 'connected' : liveAPI.isConnecting ? 'connecting' : 'not connected'}`}
          className="fixed bottom-4 right-4 z-40 inline-flex h-12 min-w-11 items-center gap-2 rounded-full bg-lecture-red px-5 text-sm font-semibold text-white shadow-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50 active:translate-y-px"
        >
          <MessageCircle className="size-5" aria-hidden="true" />
          Tutor
          {/* Connection state while the sheet is closed: green = connected, pulsing amber = connecting */}
          {(liveAPI.isConnected || liveAPI.isConnecting) && (
            <span
              data-testid="tutor-connection-dot"
              aria-hidden="true"
              className={`absolute -top-0.5 -right-0.5 size-3.5 rounded-full border-2 border-white ${liveAPI.isConnected ? 'bg-green-500' : 'bg-amber-400 animate-pulse'}`}
            />
          )}
        </button>
      )}
      <TutorSheet open={tutorSheetOpen} onOpenChange={setTutorOpen} returnFocusRef={tutorButtonRef}>
        <VoiceHub
          liveAPI={liveAPI}
          onViewFile={handleViewFile}
          onGeneratePlan={handleGeneratePlan}
          isGeneratingPlan={isGeneratingPlan}
          onClose={() => setTutorOpen(false)}
          draft={tutorDraft}
          onDraftChange={setTutorDraft}
          chatMode={chatMode}
          onChatModeChange={handleChatModeChange}
          chatModeProfile={profile}
          sessionMode={session?.mode}
          pendingMessageRef={pendingMessageRef}
          onHelpRequested={markAssisted}
        />
      </TutorSheet>

      {/* NEW SESSION DIALOG: mounted once; every "new session" button opens it through openSessionDialog */}
      <Dialog open={isModalOpen} onOpenChange={setIsModalOpen}>
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
          examPreset={profile.examPreset}
          errorMessage={notice}
        />
      </Dialog>

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
