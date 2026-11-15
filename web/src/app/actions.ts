'use server'

import { expandGroupSelection } from '@/lib/exerciseGroups'
import { transcriptForSave } from '@/lib/tutorText'
import { buildSessionTitle } from '@/lib/sessionTitle';
import { generateText, generateObject } from 'ai'
import { textModel } from '@/lib/ai'
import { prisma } from '@/lib/db'
import { createSessionSummary } from '@/services/summaryService'
import { getCourseArtifactsService, generateWeekSummaryService } from '@/services/artifactsService'
import { z } from 'zod'
import { requireAuth } from '@/server/auth'
import { buildVoiceContext } from '@/services/voiceContext'
import { getCourseWithProfile, getProfileForTopic, getProfileForCourse, getProfileForCourses } from '@/services/studyspaceService'
import { cleanCourseId, dominantCourseId, CourseScopeError } from '@/services/courseScope'
import { getGlobalContext, getPrecedingTopicsContext } from '@/services/contextSearch'
import { generateNextForSession, type NextExerciseResult } from '@/services/sessionGeneration'
import {
  submitExamForSession,
  finalizeOverdueExams,
  createSessionWithItems,
  endPreviousActiveSessions,
  completeSession,
  cancelSession,
  getSessionStateFor,
  getActiveSessionFor,
  saveDraftFor,
  recordStudyTimeFor,
  setFlaggedFor,
  setCurrentPositionFor,
  logAnswerForSession,
  getSessionResultsFor,
  type SessionResultItem,
  type ExamSubmission,
  type SessionState,
  type MutationResult,
} from '@/services/sessionService'
import { enrichInBackground, isBackgroundEnrichmentEnabled, type EnrichableRow } from '@/services/enrichment'
import { gradeAnswer, logScore } from '@/lib/grading'
import { checkSessionStartable as checkSessionStartableFor, SessionNotStartableError, type StartCheck } from '@/services/sessionStartCheck'
import { isListableSession } from '@/lib/sessionList'
import { LEGACY_VOICE_PROFILE } from '@/lib/studyspace/legacyProfiles'
import {
  explainMistakePrompt,
  examDiagnosisPrompt,
  examWrongAnswerBlock,
  globalDiagnosisPrompt,
  plannerChatPrompt,
  studyPlanPrompt,
} from '@/lib/prompts'

const round2 = (n: number) => Math.round(n * 100) / 100

/** Profile and identity of one course, in the shape getProfileForCourses returns for the unscoped actions. */
async function getScopedProfile(courseId: string) {
  const course = await getCourseWithProfile(courseId)
  if (!course) return { profile: await getProfileForCourse(courseId), courses: [] as { id: string; code: string; title: string; calibrationModule: string | null }[] }
  return {
    profile: course.profile,
    courses: [{ id: course.id, code: course.code, title: course.title, calibrationModule: course.profile.calibrationModule }],
  }
}

// Fields the session list, results dialog and plan view read. No chatLog, diagnosis, draftAnswers or flaggedIds.
// The session's SessionExercise rows are selected only so the server can order the logs by question position and turn
// them into exerciseCount (see withItemInfo); the id list itself never reaches the client.
const SESSION_LIST_SELECT = {
  id: true,
  title: true,
  startTime: true,
  endTime: true,
  status: true,
  mode: true,
  timeLimit: true,
  sourcingMix: true,
  studyPlanId: true,
  courseId: true,
  items: { select: { exerciseId: true, position: true } },
  logs: {
    select: {
      id: true,
      exerciseId: true,
      isCorrect: true,
      score: true,
      userAnswer: true,
      gradedBy: true,
      timestamp: true,
      exercise: {
        select: { id: true, questionText: true, correctAnswer: true, exerciseType: true },
      },
    },
  },
} as const

/**
 * Replaces the session's item rows with exerciseCount (its number of questions) and puts each log at the position of
 * its question: logs are returned in question order and carry `position`. A log without an item (cannot happen for
 * sessions written by this app) sorts last, in the order it was read.
 */
function withItemInfo<T extends { items: { exerciseId: string; position: number }[]; logs: { exerciseId: string }[] }>(session: T) {
  const { items, logs, ...rest } = session
  const positionOf = new Map(items.map((i) => [i.exerciseId, i.position]))
  const ordered = logs
    .map((log, index) => ({ log, index, position: positionOf.get(log.exerciseId) ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.position - b.position || a.index - b.index)
    .map(({ log, position }) => ({ ...log, position: position === Number.MAX_SAFE_INTEGER ? null : position }))
  return { ...rest, logs: ordered, exerciseCount: items.length }
}

export async function explainMistake({
  questionText,
  choices,
  correctAnswer,
  userAnswer,
  explanation,
  topicTitle,
  topicId
}: {
  questionText: string,
  choices: string[],
  correctAnswer: string,
  userAnswer: string,
  explanation?: string | null,
  topicTitle?: string,
  topicId?: string
}) {
  await requireAuth()
  const profile = topicId ? await getProfileForTopic(topicId) : LEGACY_VOICE_PROFILE
  const prompt = explainMistakePrompt(profile, { questionText, choices, correctAnswer, userAnswer, explanation, topicTitle })

  try {
    const { text } = await generateText({
      model: textModel(),
      prompt,
    })
    return text
  } catch (error: any) {
    console.error('Error generating explanation:', error)
    return 'Sorry, I encountered an error while trying to explain this mistake. Please review the official explanation if available.'
  }
}

/**
 * Order of topics in every list: module label first, then the outline order inside the module. `week` leads because
 * the module labels sort in module sequence (legacy "Week_NN_...", new spaces "NN · ..."), whereas `order` alone is not
 * monotonic in the module for the two MIT courses (a few "R Code Solution" topics of weeks 2-10 sit in the week 1
 * outline section), which would change the sequence in which the UI lists the modules.
 */
const TOPIC_ORDER = [{ week: 'asc' }, { order: 'asc' }] as const

/** All topics, or only the topics of one course. */
export async function getTopics(courseId?: string) {
  await requireAuth()
  const scope = cleanCourseId(courseId)
  return prisma.topic.findMany({
    where: scope ? { courseId: scope } : undefined,
    orderBy: [...TOPIC_ORDER],
    include: { course: true }
  })
}

/** Transcript text that precedes a lecture/class, by class name. Thin wrapper over getPrecedingTopicsContext. */
export async function getPreviousLectureTranscripts(courseId: string, currentClassName: string): Promise<string | null> {
  await requireAuth()
  try {
    const anchor = await prisma.topic.findFirst({
      where: { courseId, className: currentClassName },
      orderBy: { order: 'asc' },
      select: { id: true, courseId: true, week: true, order: true, className: true },
    })
    if (!anchor) return null
    // Walk back from the start of the class, so the class itself is not part of its own "preceding" context
    return await getPrecedingTopicsContext(anchor)
  } catch (error) {
    console.error("Error fetching previous lecture transcripts:", error)
    return null
  }
}

/** Context from the topics of the course that match the text (see searchTopics); the calibration module is left out. */
export async function getGlobalCourseContext(courseId: string, text: string): Promise<string> {
  await requireAuth()
  return getGlobalContext(courseId, text)
}

export async function getGlobalCourseContextForExercises(courseId: string, exercises: any[]): Promise<string> {
  await requireAuth()
  const combinedText = exercises.map(ex => ex.questionText).join(' ');
  return getGlobalCourseContext(courseId, combinedText);
}

export type StartSessionInput = {
  courseId?: string
  topicIds: string[]
  count: number
  mode: 'study' | 'exam'
  timeLimit: number | null
  sourcingMix: number
  weakPct: number
  unstudiedPct: number
  expertPct: number
}

const clampPct = (n: unknown, fallback: number) => (typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : fallback)

/**
 * Starts a session: picks the questions (adaptive buckets, unchanged), ends the student's previous active session of
 * the same scope without destroying answers (a study session is completed, an exam is submitted with its stored
 * drafts; plan sessions are left alone), and stores the session with its topics, target count, exam deadline and
 * positional SessionExercise rows. Returns the full SessionState; `missingCount` (targetCount minus the questions
 * drawn from existing exercises) says how many the client must have generated.
 * With a courseId the course must exist and every selected topic must belong to it (T16).
 */
export async function startSession(input: StartSessionInput): Promise<SessionState> {
  await requireAuth()
  const safe = (input ?? {}) as Partial<StartSessionInput>
  const topicIds = Array.isArray(safe.topicIds) ? [...new Set(safe.topicIds.filter((id): id is string => typeof id === 'string' && id.length > 0))] : []
  const count = Math.max(1, Math.min(500, Math.floor(Number(safe.count) || 10)))
  const mode: 'study' | 'exam' = safe.mode === 'exam' ? 'exam' : 'study'
  const timeLimit = typeof safe.timeLimit === 'number' && safe.timeLimit > 0 ? Math.floor(safe.timeLimit) : null
  const sourcingMix = clampPct(safe.sourcingMix, 50)
  const weakPct = clampPct(safe.weakPct, 60)
  const unstudiedPct = clampPct(safe.unstudiedPct, 20)
  const expertPct = clampPct(safe.expertPct, 20)
  const scope = cleanCourseId(safe.courseId)
  if (scope) {
    const exists = await prisma.course.findUnique({ where: { id: scope }, select: { id: true } })
    if (!exists) throw new CourseScopeError('Studyspace not found.')
  }
  let selected: any[] = []
  // Candidates the student has never answered, kept for background enrichment (see below)
  let unstudiedCandidates: EnrichableRow[] = [];

  // Check if we are selecting from a calibration module (the profile's calibrationModule, e.g. a comprehensive review)
  let isComprehensiveReview = false;
  let comprehensiveCourseId: string | null = null;
  // Courses of the selected topics, in the order the caller listed them (used to derive the session's course)
  let selectedTopicCourseIds: string[] = [];
  if (topicIds.length > 0) {
    const selectedTopicsData = await prisma.topic.findMany({
      where: { id: { in: topicIds } }
    });
    // With a scope, topics of another course are rejected before anything is read or written
    if (scope && selectedTopicsData.some(t => t.courseId !== scope)) throw new CourseScopeError();
    const courseOfTopic = new Map(selectedTopicsData.map(t => [t.id, t.courseId]));
    selectedTopicCourseIds = topicIds.map(id => courseOfTopic.get(id)).filter((c): c is string => !!c);
    const { courses } = await getProfileForCourses(selectedTopicsData.map(t => t.courseId));
    const calibrationByCourse = new Map(courses.map(c => [c.id, c.calibrationModule]));
    const calibrationTopic = selectedTopicsData.find(t => {
      const module = calibrationByCourse.get(t.courseId);
      return !!module && t.week === module;
    });
    isComprehensiveReview = !!calibrationTopic;
    if (calibrationTopic) {
      comprehensiveCourseId = calibrationTopic.courseId;
    }
  }

  // Determine maximum existing questions to keep based on the selected sourcing mix ratio
  const aiRatio = sourcingMix / 100;
  const maxExistingRatio = 1.0 - aiRatio;
  const maxExistingToKeep = Math.floor(count * maxExistingRatio);

  // Fetch candidate exercises
  let candidateExercises: any[] = [];
  if (topicIds.length > 0) {
    if (isComprehensiveReview && comprehensiveCourseId) {
      // For a comprehensive review session, automatically expand the candidate pool 
      // to include ALL exercises from the entire course to prevent clustered, repetitive questions!
      candidateExercises = await prisma.exercise.findMany({
        where: { topic: { courseId: comprehensiveCourseId }, isGraded: true, status: 'active' },
        include: { topic: true }
      });
    } else {
      candidateExercises = await prisma.exercise.findMany({
        where: { topicId: { in: topicIds }, isGraded: true, status: 'active' },
        include: { topic: true }
      });
    }
  } else {
    candidateExercises = await prisma.exercise.findMany({
      where: scope
        ? { topic: { courseId: scope }, isGraded: true, status: 'active' }
        : { isGraded: true, status: 'active' },
      include: { topic: true }
    });
  }

  // Surveys, feedback forms and other ungraded items are excluded by `isGraded: true` in the queries above.

  if (candidateExercises.length > 0) {
    // 1. Fetch user accuracy and coverage stats per exercise to group candidates individually
    const logs = await prisma.exerciseLog.findMany({
      where: scope ? { exercise: { topic: { courseId: scope } } } : undefined,
      select: { exerciseId: true, isCorrect: true }
    });

    // 2. Separate candidate exercises into Expert, Worst, and Unstudied pools based on individual performance logs
    const expertPool: any[] = [];
    const worstPool: any[] = [];
    const unstudiedPool: any[] = [];

    for (const ex of candidateExercises) {
      const exerciseLogs = logs.filter(l => l.exerciseId === ex.id);

      if (exerciseLogs.length === 0) {
        unstudiedPool.push(ex);
      } else {
        const correctCount = exerciseLogs.filter(l => l.isCorrect).length;
        const accuracy = (correctCount / exerciseLogs.length) * 100;
        if (accuracy >= 70) {
          expertPool.push(ex);
        } else {
          worstPool.push(ex);
        }
      }
    }

    // Shuffle each pool individually to ensure maximum random retrieval within criteria
    const shuffle = (arr: any[]) => {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
    };
    shuffle(expertPool);
    shuffle(worstPool);
    shuffle(unstudiedPool);

    // 3. Compute target counts based on the custom proportions selected by the user
    const targetCount = Math.min(candidateExercises.length, maxExistingToKeep);
    
    // Normalize percentages to make sure they sum to 100%
    const totalPct = (weakPct + unstudiedPct + expertPct) || 100;
    const wRatio = weakPct / totalPct;
    const uRatio = unstudiedPct / totalPct;
    const eRatio = expertPct / totalPct;

    let targetWorst = Math.round(targetCount * wRatio);
    let targetUnstudied = Math.round(targetCount * uRatio);
    let targetExpert = Math.round(targetCount * eRatio);

    // Safeguard totals to equal exactly targetCount
    const diff = targetCount - (targetWorst + targetUnstudied + targetExpert);
    if (diff !== 0) {
      targetWorst += diff;
    }

    const selectedExercises: any[] = [];

    // Pull from each pool up to the targets
    const pullWorst = worstPool.slice(0, targetWorst);
    const pullUnstudied = unstudiedPool.slice(0, targetUnstudied);
    const pullExpert = expertPool.slice(0, targetExpert);

    selectedExercises.push(...pullWorst, ...pullUnstudied, ...pullExpert);

    // 4. Fallback/Fill Mechanism: if a pool was too small, fill remainder from remaining pools
    if (selectedExercises.length < targetCount) {
      const remainingCandidates = candidateExercises.filter(ex => 
        !selectedExercises.some(se => se.id === ex.id)
      );
      shuffle(remainingCandidates);
      const needed = targetCount - selectedExercises.length;
      selectedExercises.push(...remainingCandidates.slice(0, needed));
    }

    selected = selectedExercises;
    unstudiedCandidates = unstudiedPool;
  } else {
    selected = [];
  }

  // A multi-part problem is never split: the drawn sub-questions bring their group, in order, and the session may run over the
  // asked size by one group (standalone questions at the end make room first)
  const drawnGroupIds = [...new Set(selected.map((e: any) => e.groupId as string | null).filter((id): id is string => !!id))]
  if (drawnGroupIds.length > 0) {
    const members = await prisma.exercise.findMany({
      where: { groupId: { in: drawnGroupIds }, isGraded: true, status: 'active' },
      include: { topic: true },
    })
    const siblings = new Map<string, any[]>()
    for (const m of members) siblings.set(m.groupId as string, [...(siblings.get(m.groupId as string) ?? []), m])
    selected = expandGroupSelection(selected, siblings, count)
  }

  // Determine a descriptive title based on selected courses and weeks (the title of the studyspace for uploaded ones)
  const titleTopics = topicIds.length > 0
    ? await prisma.topic.findMany({
        where: { id: { in: topicIds } },
        select: { week: true, sourceId: true, course: { select: { code: true, title: true } } },
      })
    : [];
  const sessionTitle = buildSessionTitle(mode, titleTopics);

  // The session always stores a course. Scoped: that course. Unscoped: the course with most of the selected topics
  // (ties: the first selected topic's course); with no topics selected, the course with most of the drawn questions.
  const sessionCourseId = scope
    ?? dominantCourseId(topicIds.length > 0 ? selectedTopicCourseIds : selected.map((e: { topic?: { courseId?: string } | null }) => e.topic?.courseId));

  // No stored question was drawn: the session lives on generation alone. If nothing can be generated either (checked
  // from the database only, no model call), no session is created at all.
  if (selected.length === 0) {
    const check = await checkSessionStartableFor({ courseId: scope, topicIds, count, sourcingMix })
    if (!check.startable) throw new SessionNotStartableError(check.message)
  }

  // The previous active session of this scope ends first (answers are kept), then the new one is stored with its items
  await endPreviousActiveSessions(scope ? { courseId: scope } : {})
  const session = await createSessionWithItems({
    courseId: sessionCourseId,
    title: sessionTitle,
    mode,
    timeLimit,
    sourcingMix,
    topicIds,
    targetCount: count,
    exerciseIds: selected.map((e: any) => e.id as string),
  })

  // Optional context enrichment (off unless ENRICH_IN_BACKGROUND=1). It never delays session start and never rewrites a
  // question the student is about to see: it runs after the response, on never-answered questions that are not in this
  // session (their improved text is used by later sessions). At most ENRICH_MAX_PER_SESSION_START questions and
  // ENRICH_MAX_CALLS_PER_BATCH model calls.
  if (isBackgroundEnrichmentEnabled()) {
    const selectedIdSet = new Set(selected.map((e) => e.id as string))
    enrichInBackground(unstudiedCandidates.filter((e) => !selectedIdSet.has(e.id)))
  }

  const state = await getSessionStateFor(session.id)
  if (!state) throw new Error('The session could not be read back after it was created.')
  return state
}

/**
 * Asks, before startSession, whether a session over these topics could show any question (stored graded questions
 * that the sourcing mix leaves room for, or a topic the generator can use). Database reads only. The study screen calls
 * it first so that it can say why a start is impossible; startSession enforces the same rule.
 */
export async function checkSessionStartable(input: Pick<StartSessionInput, 'courseId' | 'topicIds' | 'count' | 'sourcingMix'>): Promise<StartCheck> {
  await requireAuth()
  const safe = (input ?? {}) as Partial<StartSessionInput>
  const topicIds = Array.isArray(safe.topicIds) ? [...new Set(safe.topicIds.filter((id): id is string => typeof id === 'string' && id.length > 0))] : []
  return checkSessionStartableFor({
    courseId: cleanCourseId(safe.courseId),
    topicIds,
    count: Math.max(1, Math.min(500, Math.floor(Number(safe.count) || 10))),
    sourcingMix: clampPct(safe.sourcingMix, 50),
  })
}

/** The latest active session of the studyspace (all courses when no courseId), or null. See getActiveSessionFor. */
export async function getActiveSession(courseId?: string): Promise<SessionState | null> {
  await requireAuth()
  return getActiveSessionFor(cleanCourseId(courseId))
}

/**
 * Full state of one session, read from the server (questions in order, drafts, flags, answers, remaining questions to
 * generate, deadline and server clock). An exam whose deadline passed more than 30 s ago is finalized with its stored
 * drafts first. Null when the session does not exist or, with a courseId, belongs to another course.
 */
export async function getSessionState(sessionId: string, courseId?: string): Promise<SessionState | null> {
  await requireAuth()
  if (typeof sessionId !== 'string' || !sessionId) return null
  return getSessionStateFor(sessionId, cleanCourseId(courseId))
}

/** Stores one exam draft (null clears it; undefined keeps the stored draft and only adds time). Does nothing and reports a reason for a non-item, an inactive session or after the deadline. */
export async function saveDraft(sessionId: string, exerciseId: string, draftAnswer: string | null | undefined, timeSpentDeltaSec: number = 0): Promise<MutationResult> {
  await requireAuth()
  return saveDraftFor(sessionId, exerciseId, draftAnswer, timeSpentDeltaSec)
}

/** Adds visible seconds to a question of an active study session (an exam adds its time through saveDraft). */
export async function recordCardTime(sessionId: string, exerciseId: string, deltaSec: number): Promise<MutationResult> {
  await requireAuth()
  return recordStudyTimeFor(sessionId, exerciseId, deltaSec)
}

export async function setFlagged(sessionId: string, exerciseId: string, flagged: boolean): Promise<MutationResult> {
  await requireAuth()
  return setFlaggedFor(sessionId, exerciseId, flagged)
}

export async function setCurrentPosition(sessionId: string, position: number): Promise<MutationResult> {
  await requireAuth()
  return setCurrentPositionFor(sessionId, position)
}

/**
 * Grades the answer on the server (gradeAnswer on the stored exercise) and logs it. The client no longer sends
 * correctness. First attempt wins: a repeat for the same (sessionId, exerciseId) returns the stored result.
 */
export async function logAnswer(
  sessionId: string,
  exerciseId: string,
  userAnswer: string,
  opts?: { durationSec?: number; assisted?: boolean }
): Promise<{ score: number; isCorrect: boolean } | null> {
  await requireAuth()
  // A stale browser tab running the old client would pass a boolean here. The service accepts the answer only for an
  // item of an active study session; anything else returns null and writes nothing.
  return logAnswerForSession(sessionId, exerciseId, userAnswer, opts)
}

/**
 * Submits a timed exam: grades every question of the session on the server (unanswered ones score 0), creates the
 * logs and completes the session in one transaction. Answers come from the drafts stored on the server; `answers` is
 * optional and overrides them per question until the deadline plus 30 s. Repeating the call changes nothing and
 * returns the same totals.
 */
export async function submitExam(sessionId: string, answers?: Record<string, string>): Promise<ExamSubmission | null> {
  await requireAuth()
  try {
    return await submitExamForSession(sessionId, answers)
  } catch (error) {
    console.error("Failed to submit exam:", error instanceof Error ? error.message : error)
    return null
  }
}

export async function saveChatLog(sessionId: string, messages: any[]) {
  await requireAuth()
  try {
    // Injected voice context and directive echoes are never part of the transcript (also cleans logs from older clients)
    const transcript = transcriptForSave(messages || [])
    await prisma.studySession.update({
      where: { id: sessionId },
      data: { chatLog: JSON.stringify(transcript) }
    })
  } catch (error: any) {
    console.error("Failed to save chat log (likely stale session):", error.message)
  }
}

export async function finishStudySession(sessionId: string) {
  await requireAuth()
  try {
    // Study session: marked completed (only while active). Exam: submitted with its stored drafts.
    return await completeSession(sessionId)
  } catch (error: any) {
    console.error("Failed to finish study session:", error.message)
    return false
  }
}

export async function cancelStudySession(sessionId: string) {
  await requireAuth()
  try {
    // No logs are written: a cancelled exam has no score. Only an active session can be cancelled.
    return await cancelSession(sessionId)
  } catch (error) {
    console.error("Failed to cancel study session:", error instanceof Error ? error.message : error)
    return false
  }
}

/**
 * Session list. With a courseId: the sessions stored under that course (a session belongs to the course it was started
 * in), without the course's diagnosis holder row (mode 'global_diagnosis', not a study session). Without: all rows.
 * Finished sessions that have no answers are left out (see isListableSession); running sessions and cancelled exams stay.
 */
export async function getSessionHistory(courseId?: string) {
  await requireAuth()
  const scope = cleanCourseId(courseId)
  // An exam whose deadline passed is never listed as active: it is finalized with its stored drafts first
  await finalizeOverdueExams(scope ? { courseId: scope } : {})
  const sessions = await prisma.studySession.findMany({
    where: scope ? { courseId: scope, mode: { not: 'global_diagnosis' } } : undefined,
    orderBy: { startTime: 'desc' },
    select: SESSION_LIST_SELECT
  })
  // Sessions without answers that are over (double-click leftovers, sessions ended at once) stay in the database but are not history
  return sessions.map(withItemInfo).filter((s) => isListableSession({ status: s.status, logCount: s.logs.length }))
}

/** Every question of a session in order, with its answer or null; what the results dialog lists. */
export async function getSessionResults(sessionId: string): Promise<SessionResultItem[]> {
  await requireAuth()
  if (typeof sessionId !== 'string' || !sessionId) return []
  return getSessionResultsFor(sessionId)
}

export async function getSessionDetail(sessionId: string) {
  await requireAuth()
  return prisma.studySession.findUnique({
    where: { id: sessionId },
    select: { chatLog: true, diagnosis: true }
  })
}

export async function getClassContextForTopic(topicId: string) {
  await requireAuth()
  const topic = await prisma.topic.findUnique({ where: { id: topicId } })
  if (!topic || !topic.className) return null
  
  const classTopics = await prisma.topic.findMany({
    where: {
      courseId: topic.courseId,
      week: topic.week,
      className: topic.className
    }
  })
  
  return classTopics.map(t => ({
    id: t.id,
    title: t.title,
    content: t.content,
  }))
}

export async function getVoiceContextForExercise(exerciseId: string, mode: string) {
  await requireAuth()
  return buildVoiceContext({ exerciseId, mode })
}

/**
 * Dashboard numbers. With a courseId every figure covers only that course: its sessions (not cancelled, not the
 * diagnosis holder), the logs of questions that belong to the course, its topics and its diagnosis. A session started
 * across courses (only possible before scoping) belongs to the course stored on it; its answers to the other course's
 * questions are not counted here.
 */
export async function getAnalyticsData(courseId?: string) {
  await requireAuth()
  const scope = cleanCourseId(courseId)
  await finalizeOverdueExams(scope ? { courseId: scope } : {})
  const sessions = await prisma.studySession.findMany({
    where: scope
      ? { status: { not: 'cancelled' }, courseId: scope, mode: { not: 'global_diagnosis' } }
      : { status: { not: 'cancelled' } },
    include: {
      logs: {
        where: scope ? { exercise: { topic: { courseId: scope } } } : undefined,
        include: { exercise: { include: { topic: { include: { course: true } } } } },
      },
    }
  });

  const totalSessions = sessions.length;
  let totalExercises = 0;
  let totalCorrect = 0;

  const courseStats: Record<string, { total: number, correct: number }> = {};
  const heatmapStats: Record<string, Record<string, { total: number, correct: number, classes: Record<string, any> }>> = {};

  // Last 7 days activity (by date)
  const activityByDate: Record<string, number> = {};
  const today = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    activityByDate[d.toISOString().split('T')[0]] = 0;
  }

  sessions.forEach(session => {
    const dateStr = new Date(session.startTime).toISOString().split('T')[0];
    if (activityByDate[dateStr] !== undefined) {
      activityByDate[dateStr] += 1;
    }

    session.logs.forEach(log => {
      if (log.userAnswer === null || log.userAnswer === undefined || log.userAnswer === '') return;

      // Partial credit: every aggregate below sums per-question scores (legacy logs count as 1 or 0)
      const pts = logScore(log);
      totalExercises++;
      totalCorrect += pts;

      const courseCode = log.exercise?.topic?.course?.code || 'Unknown';
      const week = log.exercise?.topic?.week || 'Unknown';
      const className = log.exercise?.topic?.className || 'Unknown Class';
      const unit = log.exercise?.topic?.unit || '';
      const subtopicTitle = log.exercise?.topic?.title || 'Unknown Subtopic';

      if (!courseStats[courseCode]) {
        courseStats[courseCode] = { total: 0, correct: 0 };
      }
      courseStats[courseCode].total++;
      courseStats[courseCode].correct += pts;

      if (!heatmapStats[courseCode]) {
        heatmapStats[courseCode] = {};
      }
      if (!heatmapStats[courseCode][week]) {
        heatmapStats[courseCode][week] = { total: 0, correct: 0, classes: {} };
      }
      heatmapStats[courseCode][week].total++;
      heatmapStats[courseCode][week].correct += pts;

      // Nest class/subtopic details
      const classKey = className;
      if (!heatmapStats[courseCode][week].classes[classKey]) {
        heatmapStats[courseCode][week].classes[classKey] = {
          className,
          total: 0,
          correct: 0,
          subtopics: {}
        };
      }
      heatmapStats[courseCode][week].classes[classKey].total++;
      heatmapStats[courseCode][week].classes[classKey].correct += pts;

      const subtopicKey = `${unit ? `Unit ${unit}: ` : ''}${subtopicTitle}`;
      if (!heatmapStats[courseCode][week].classes[classKey].subtopics[subtopicKey]) {
        heatmapStats[courseCode][week].classes[classKey].subtopics[subtopicKey] = {
          unit,
          title: subtopicTitle,
          total: 0,
          correct: 0
        };
      }
      heatmapStats[courseCode][week].classes[classKey].subtopics[subtopicKey].total++;
      heatmapStats[courseCode][week].classes[classKey].subtopics[subtopicKey].correct += pts;
    });
  });

  const courseAccuracy = Object.entries(courseStats).map(([name, stats]) => ({
    name,
    accuracy: stats.total > 0 ? Math.round((stats.correct / stats.total) * 100) : 0,
    total: stats.total
  }));

  const activityChartData = Object.entries(activityByDate).map(([date, count]) => ({
    date,
    sessions: count
  }));

  const heatmapData = Object.entries(heatmapStats).map(([course, weeksMap]) => {
    const weeks = Object.entries(weeksMap).map(([week, stats]) => {
      const classes = Object.values(stats.classes).map((cl: any) => {
        const subtopics = Object.values(cl.subtopics).map((sub: any) => ({
          unit: sub.unit,
          title: sub.title,
          accuracy: sub.total > 0 ? Math.round((sub.correct / sub.total) * 100) : 0,
          total: sub.total,
          correct: round2(sub.correct)
        }));
        
        return {
          className: cl.className,
          accuracy: cl.total > 0 ? Math.round((cl.correct / cl.total) * 100) : 0,
          total: cl.total,
          correct: round2(cl.correct),
          subtopics
        };
      });

      return {
        week,
        accuracy: stats.total > 0 ? Math.round((stats.correct / stats.total) * 100) : 0,
        total: stats.total,
        classes
      };
    });
    return { course, weeks };
  });

  const completedExams = sessions
    .filter(s => s.mode === 'exam' && s.status === 'completed')
    .map(s => {
      const totalQs = s.logs.length;
      const fullyCorrect = s.logs.filter(l => l.isCorrect).length;
      const scoreSum = s.logs.reduce((sum, l) => sum + logScore(l), 0);
      return {
        id: s.id,
        title: s.title || "Timed Exam",
        startTime: s.startTime,
        endTime: s.endTime,
        totalQuestions: totalQs,
        correctQuestions: fullyCorrect,
        scoreSum: round2(scoreSum),
        accuracy: totalQs > 0 ? Math.round((scoreSum / totalQs) * 100) : 0,
        diagnosis: s.diagnosis
      };
    })
    .sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());

  // Unscoped: the course-less row that has always held the global diagnosis. Scoped: the row of that course.
  const globalSession = await prisma.studySession.findFirst({
    where: { mode: 'global_diagnosis', courseId: scope ?? null }
  });

  const evolutionData = await getTopicEvolutionData(scope);

  return {
    totalSessions,
    totalExercises,
    overallAccuracy: totalExercises > 0 ? Math.round((totalCorrect / totalExercises) * 100) : 0,
    courseAccuracy,
    activityChartData,
    heatmapData,
    completedExams,
    globalDiagnosis: globalSession?.diagnosis || null,
    evolutionData
  };
}

/**
 * Generates one more question for the session. The work lives in `generateNextForSession` (also used by the
 * `POST /api/sessions/[sessionId]/generate-next` route, which the study interface calls so that a 20-40 second
 * generation does not block the other server actions: Next.js dispatches server actions one at a time per client).
 */
export async function generateNextExercise(sessionId: string, courseId?: string): Promise<NextExerciseResult> {
  await requireAuth()
  const scope = cleanCourseId(courseId)
  return scope ? generateNextForSession(sessionId, scope) : generateNextForSession(sessionId)
}

/** Reasons the student can give when reporting a question. */
const REPORT_REASONS = ['wrong_answer', 'unclear', 'off_topic', 'other'] as const

/**
 * Marks a question as reported: it is no longer selected for future sessions. Logs and the sessions that already
 * contain it are untouched, so the student still sees it (and its result) in the current and past sessions.
 * Works for any origin. Returns false when the reason is unknown or the question cannot be reported.
 */
export async function reportExercise(exerciseId: string, reason: string): Promise<boolean> {
  await requireAuth()
  const cleaned = typeof reason === 'string' ? reason.trim() : ''
  if (!exerciseId || !(REPORT_REASONS as readonly string[]).includes(cleaned)) return false
  try {
    const res = await prisma.exercise.updateMany({
      // 'rejected' and 'retired' rows are never shown, so there is nothing to report on them
      where: { id: exerciseId, status: { in: ['active', 'reported'] } },
      data: { status: 'reported', reportedReason: cleaned },
    })
    return res.count > 0
  } catch (error) {
    console.error('Failed to report exercise:', error)
    return false
  }
}

export async function deleteStudySession(sessionId: string) {
  await requireAuth()
  try {
    // Delete dependents first, explicitly, so this works whether or not foreign keys are enforced
    await prisma.$transaction([
      prisma.exerciseLog.deleteMany({ where: { sessionId } }),
      prisma.sessionExercise.deleteMany({ where: { sessionId } }),
      prisma.studySession.delete({ where: { id: sessionId } }),
    ]);
    return true;
  } catch (error) {
    console.error("Failed to delete study session:", error);
    return false;
  }
}

export async function generateExamDiagnosis(sessionId: string) {
  await requireAuth()
  try {
    // 1. Fetch StudySession with logs, exercises and topics
    const session = await prisma.studySession.findUnique({
      where: { id: sessionId },
      include: {
        logs: {
          include: {
            exercise: {
              include: { topic: true }
            }
          }
        }
      }
    });

    if (!session || session.logs.length === 0) return null;

    // 2. Compute metrics from the stored per-question scores (partial credit)
    const totalCount = session.logs.length;
    let examScoreSum = 0;

    const topicPerformance: Record<string, { correct: number, total: number, topicId: string, week: string }> = {};
    const wrongAnswers: any[] = [];

    for (const log of session.logs) {
      const ex = log.exercise;
      const topic = ex.topic;
      const tTitle = topic?.title || "General";
      const topicId = topic?.id || "";
      const week = topic?.week || "";

      // The stored score is the source of truth; logs written before scores existed are graded now
      const partialScore = typeof log.score === 'number' ? log.score : gradeAnswer(ex, log.userAnswer).score;

      examScoreSum += partialScore;

      if (!topicPerformance[tTitle]) {
        topicPerformance[tTitle] = { correct: 0, total: 0, topicId, week };
      }
      topicPerformance[tTitle].total += 1;
      topicPerformance[tTitle].correct += partialScore; // Use precise proportional score

      if (partialScore < 1.0) {
        wrongAnswers.push({
          question: ex.questionText,
          userAnswer: log.userAnswer,
          correctAnswer: ex.correctAnswer,
          explanation: ex.explanation,
          topicTitle: tTitle,
          topicId,
          week,
          partialScore,
          exerciseType: ex.exerciseType,
          gradedBy: log.gradedBy,
          feedback: log.feedback,
          keyPoints: ex.keyPoints,
        });
      }
    }

    const scorePct = Math.round((examScoreSum / totalCount) * 100);

    // Format metrics and data for the Gemini model to synthesize
    const topicSummaryString = Object.entries(topicPerformance).map(([title, stats]) => {
      const accuracy = Math.round((stats.correct / stats.total) * 100);
      return `- **${title}** (${stats.week}): ${stats.correct.toFixed(2)}/${stats.total} Correct (${accuracy}%). Topic ID: ${stats.topicId || 'none'}`;
    }).join('\n');

    const wrongAnswersString = wrongAnswers.map((w, idx) => examWrongAnswerBlock(idx + 1, w)).join('\n\n');

    const examCourse = await getCourseWithProfile(
      session.courseId ?? session.logs.find((l) => l.exercise?.topic?.courseId)?.exercise.topic?.courseId ?? ''
    );
    const prompt = examDiagnosisPrompt(examCourse?.profile ?? LEGACY_VOICE_PROFILE, {
      courseCode: examCourse?.code,
      scoreSum: examScoreSum,
      totalCount,
      scorePct,
      sessionMode: session.mode,
      topicSummary: topicSummaryString,
      wrongAnswers: wrongAnswersString,
    });

    const { text } = await generateText({
      model: textModel(),
      prompt
    });

    // Save diagnosis to session
    await prisma.studySession.update({
      where: { id: sessionId },
      data: { diagnosis: text }
    });

    return text;
  } catch (error) {
    console.error("Failed to generate exam diagnosis:", error);
    return null;
  }
}

/**
 * Diagnosis over all answers (or, with a courseId, over the answers to that course's questions, with that course's
 * profile and topics). The text is stored on the diagnosis holder row of the course; unscoped it is the course-less row.
 */
export async function generateGlobalDiagnosis(courseId?: string) {
  await requireAuth()
  const scope = cleanCourseId(courseId)
  try {
    // 1. Fetch all completed logs with exercises and topics
    const logs = await prisma.exerciseLog.findMany({
      where: scope ? { exercise: { topic: { courseId: scope } } } : undefined,
      include: {
        exercise: {
          include: { topic: true }
        }
      }
    });

    if (logs.length === 0) {
      return "No study session or exam logs found yet! Complete some exercises first so the professor can evaluate your performance.";
    }

    // 2. Group logs by topicId
    const topicStats: Record<string, { correct: number, total: number, title: string, course: string, week: string }> = {};
    for (const log of logs) {
      const ex = log.exercise;
      if (!ex || !ex.topic) continue;
      const topic = ex.topic;
      const tId = topic.id;

      if (!topicStats[tId]) {
        topicStats[tId] = {
          correct: 0,
          total: 0,
          title: topic.title || "General",
          course: topic.courseId || "General",
          week: topic.week || "",
        };
      }
      topicStats[tId].total += 1;
      topicStats[tId].correct += logScore(log);
    }

    // Sort topics by accuracy ascending
    const topicList = Object.entries(topicStats).map(([id, stats]) => {
      const accuracy = Math.round((stats.correct / stats.total) * 100);
      return { id, ...stats, accuracy };
    }).sort((a, b) => a.accuracy - b.accuracy);

    // Identify the top 4 weakest topics
    const weakTopics = topicList.filter(t => t.accuracy < 70).slice(0, 4);
    
    // Fetch detailed content for these weak topics to supply to the LLM
    const weakTopicIds = weakTopics.map(w => w.id);
    const detailedTopics = await prisma.topic.findMany({
      where: { id: { in: weakTopicIds } },
      include: { course: true }
    });

    const weakTopicsWithContent = weakTopics.map(wt => {
      const detail = detailedTopics.find(d => d.id === wt.id);
      let content = detail?.content || "No detailed content available.";
      if (content.length > 50000) {
        content = content.substring(0, 50000) + "...";
      }
      return {
        ...wt,
        courseCode: detail?.course?.code || "Unknown",
        content
      };
    });

    // Format stats and content summaries for prompt
    const allTopicsSummary = topicList.map(t => {
      return `- **${t.title}** (${t.course} - ${t.week}): ${round2(t.correct)}/${t.total} Correct (${t.accuracy}%). Topic ID: ${t.id}`;
    }).join('\n');

    const weakTopicsContext = weakTopicsWithContent.map((wt, idx) => {
      return `### Weak Area ${idx + 1}: ${wt.title}
Course: ${wt.courseCode} (${wt.week})
Your Accuracy Score: ${round2(wt.correct)}/${wt.total} (${wt.accuracy}%)
Topic ID: ${wt.id}
Lecture Material Content Summary:
${wt.content}`;
    }).join('\n\n');

    const profileScope = scope
      ? await getScopedProfile(scope)
      : await getProfileForCourses(Object.values(topicStats).map(t => t.course));
    const prompt = globalDiagnosisPrompt(profileScope.profile, {
      courseCodes: profileScope.courses.map(c => c.code),
      topicLines: allTopicsSummary,
      weakTopicContent: weakTopicsContext,
    });

    const { text } = await generateText({
      model: textModel(),
      prompt
    });

    // Create or update a special StudySession for the global diagnosis
    let globalSession = await prisma.studySession.findFirst({
      where: { mode: 'global_diagnosis', courseId: scope ?? null }
    });

    if (globalSession) {
      await prisma.studySession.update({
        where: { id: globalSession.id },
        data: { diagnosis: text, endTime: new Date() }
      });
    } else {
      await prisma.studySession.create({
        data: {
          title: "Global AI Learning Diagnosis",
          status: "completed",
          mode: "global_diagnosis",
          courseId: scope ?? null,
          diagnosis: text,
          endTime: new Date()
        }
      });
    }

    return text;
  } catch (error) {
    console.error("Failed to generate global diagnosis:", error);
    return null;
  }
}

export async function generateSessionSummary(sessionId: string, courseId?: string) {
  await requireAuth()
  try {
    return await createSessionSummary(sessionId, cleanCourseId(courseId));
  } catch (error) {
    console.error('Error in generateSessionSummary action:', error)
    throw error
  }
}

/** Planner chat. With a courseId only the persona changes: that course's profile instead of the legacy one. */
export async function generatePlannerResponse(messages: any[], accuracyStats: any, courseId?: string) {
  await requireAuth()
  const scope = cleanCourseId(courseId)
  try {
    const formattedHistory = messages.map(m => {
      return `${m.role === 'user' ? 'Student' : 'Professor (Planner)'}: ${m.content}`;
    }).join('\n');

    const prompt = plannerChatPrompt(scope ? await getProfileForCourse(scope) : LEGACY_VOICE_PROFILE, {
      history: formattedHistory,
      stats: JSON.stringify(accuracyStats),
    });

    const { text } = await generateText({
      model: textModel(),
      prompt
    });

    return text;
  } catch (error) {
    console.error("Failed to generate planner response:", error);
    return "I apologize, but I struggled to analyze your schedule feedback. Please try again!";
  }
}

// --- STRUCTURED STUDY PLAN PLANNERS ---

const StudyPlanSessionSchema = z.object({
  name: z.string(),
  day: z.string(),
  timeSlot: z.enum(['morning', 'afternoon', 'night', 'flexible']),
  durationMinutes: z.number(),
  mode: z.enum(['study', 'exam']),
  sourcingMix: z.number().min(0).max(100),
  focusDescription: z.string(),
  topicIds: z.array(z.string()), // Actual database Topic IDs mapped by Gemini
  questionCount: z.number()
});

const StudyPlanSchema = z.object({
  title: z.string(),
  executiveSummary: z.string(),
  sessions: z.array(StudyPlanSessionSchema)
});

/** Study plan from the planner chat. With a courseId the topic catalog, the profile and the calibration module are that course's. */
export async function generateStructuredStudyPlan(chatMessages: any[], accuracyStats: any, courseId?: string) {
  await requireAuth()
  const scope = cleanCourseId(courseId)
  try {
    // Fetch actual database Topic catalog so Gemini can map correct IDs
    const dbTopics = await prisma.topic.findMany({
      where: scope ? { courseId: scope } : undefined,
      ...(scope ? { orderBy: [...TOPIC_ORDER] } : {}),
      select: { id: true, title: true, week: true, courseId: true }
    });

    const topicsCatalog = dbTopics.map(t => 
      `ID: "${t.id}" | Course: "${t.courseId}" | Week: "${t.week}" | Title: "${t.title}"`
    ).join('\n');

    const profileScope = scope ? await getScopedProfile(scope) : await getProfileForCourses(dbTopics.map(t => t.courseId));
    const calibrationModules = [...new Set(profileScope.courses.map(c => c.calibrationModule).filter((m): m is string => !!m))];
    const prompt = studyPlanPrompt(profileScope.profile, {
      history: JSON.stringify(chatMessages),
      stats: JSON.stringify(accuracyStats),
      topicCatalog: topicsCatalog,
      calibrationModules,
    });

    const { object } = await generateObject({
      model: textModel(),
      schema: StudyPlanSchema,
      prompt
    });

    return object;
  } catch (error) {
    console.error("Failed to generate structured study plan:", error);
    return null;
  }
}

/**
 * Saves a plan and pre-creates its sessions. With a courseId the plan and every session store it, and a plan that
 * names topics of another course is rejected as a whole (returns null, nothing is written). Without: each session
 * stores the course of most of its topics (ties: the first topic), the plan the course of most topics overall.
 */
export async function saveAndDeployStudyPlan(planData: any, courseId?: string) {
  await requireAuth()
  const scope = cleanCourseId(courseId)
  try {
    if (!Array.isArray(planData.sessions)) throw new Error('A study plan needs a list of sessions.')
    const plannedSessions = planData.sessions as z.infer<typeof StudyPlanSessionSchema>[]
    const sessionTopicIds = (sd: { topicIds?: unknown } | null | undefined): string[] => (Array.isArray(sd?.topicIds) ? sd.topicIds.filter((id: unknown) => typeof id === 'string') : [])
    const allTopicIds = [...new Set(plannedSessions.flatMap(sessionTopicIds))]
    const topicRows = allTopicIds.length > 0
      ? await prisma.topic.findMany({ where: { id: { in: allTopicIds } }, select: { id: true, courseId: true } })
      : []
    if (scope && topicRows.some(t => t.courseId !== scope)) throw new CourseScopeError()
    const courseOfTopic = new Map(topicRows.map(t => [t.id, t.courseId]))
    const coursesOf = (ids: string[]) => ids.map(id => courseOfTopic.get(id))
    const planCourseId = scope ?? dominantCourseId(plannedSessions.flatMap(sd => coursesOf(sessionTopicIds(sd))))

    // 1. Create the StudyPlan record
    const plan = await prisma.studyPlan.create({
      data: {
        title: planData.title,
        executiveSummary: planData.executiveSummary,
        status: "active",
        courseId: planCourseId
      }
    });

    // 2. Loop over and pre-create each StudySession pre-populated
    for (const sessionData of plannedSessions) {
      // Find matching exercises in the database for the given topicIds to seed this session
      const exercises = await prisma.exercise.findMany({
        where: scope
          ? { topicId: { in: sessionData.topicIds }, topic: { courseId: scope }, status: 'active' }
          : { topicId: { in: sessionData.topicIds }, status: 'active' },
        take: sessionData.questionCount
      });

      const sessionTitle = `${sessionData.day} - ${sessionData.name}`;

      await prisma.studySession.create({
        data: {
          title: sessionTitle,
          status: "active",
          mode: sessionData.mode,
          timeLimit: sessionData.mode === 'exam' ? sessionData.durationMinutes * 60 : null,
          sourcingMix: sessionData.sourcingMix,
          topicIds: JSON.stringify(sessionTopicIds(sessionData)),
          targetCount: exercises.length,
          items: { create: exercises.map((e, position) => ({ exerciseId: e.id, position })) },
          studyPlanId: plan.id,
          courseId: scope ?? dominantCourseId(coursesOf(sessionTopicIds(sessionData))) ?? planCourseId
        }
      });
    }

    return plan;
  } catch (error) {
    console.error("Failed to save and deploy study plan:", error);
    return null;
  }
}

export async function getStudyPlans(courseId?: string) {
  await requireAuth()
  const scope = cleanCourseId(courseId)
  try {
    await finalizeOverdueExams(scope ? { courseId: scope } : {})
    const plans = await prisma.studyPlan.findMany({
      where: scope ? { courseId: scope } : undefined,
      orderBy: { createdAt: 'desc' },
      include: {
        sessions: {
          ...(scope ? { where: { courseId: scope } } : {}),
          select: SESSION_LIST_SELECT
        }
      }
    });
    return plans.map(plan => ({ ...plan, sessions: plan.sessions.map(withItemInfo) }));
  } catch (error) {
    console.error("Failed to fetch study plans:", error);
    return [];
  }
}

export async function deleteStudyPlan(planId: string) {
  await requireAuth()
  try {
    // Explicit order (logs and items, sessions, plan) so it works whether or not foreign keys are enforced
    await prisma.$transaction([
      prisma.exerciseLog.deleteMany({ where: { session: { studyPlanId: planId } } }),
      prisma.sessionExercise.deleteMany({ where: { session: { studyPlanId: planId } } }),
      prisma.studySession.deleteMany({ where: { studyPlanId: planId } }),
      prisma.studyPlan.delete({ where: { id: planId } }),
    ]);
    return true;
  } catch (error) {
    console.error("Failed to delete study plan:", error);
    return false;
  }
}

export async function getTopicsWithPerformance(courseId?: string) {
  await requireAuth()
  const scope = cleanCourseId(courseId)
  try {
    const topics = await prisma.topic.findMany({
      where: scope ? { courseId: scope } : undefined,
      orderBy: [...TOPIC_ORDER],
      include: { course: true }
    });

    // Rejected questions were never shown, so they are not part of any total. Reported ones stay for the accuracy of
    // what the student already answered, but are not part of the pool they can still cover.
    const exercises = await prisma.exercise.findMany({
      where: scope ? { status: { not: 'rejected' }, topic: { courseId: scope } } : { status: { not: 'rejected' } },
      select: { id: true, topicId: true, status: true, groupId: true }
    });

    const logs = await prisma.exerciseLog.findMany({
      where: scope ? { exercise: { topic: { courseId: scope } } } : undefined,
      select: { exerciseId: true, isCorrect: true, score: true }
    });

    // Compute metrics per topicId
    const topicMetrics = topics.map(t => {
      const topicExercises = exercises.filter(e => e.topicId === t.id);
      const activeIds = new Set(topicExercises.filter(e => e.status === 'active').map(e => e.id));
      const totalExercises = activeIds.size;
      // Multi-part problems among the questions that can still be covered: how many problems and how many parts
      const activeGrouped = topicExercises.filter((e) => e.status === 'active' && e.groupId)
      const groupedExercises = activeGrouped.length
      const groupCount = new Set(activeGrouped.map((e) => e.groupId)).size

      const exerciseIds = topicExercises.map(e => e.id);
      const topicLogs = logs.filter(l => exerciseIds.includes(l.exerciseId));
      
      const totalLogged = topicLogs.length;
      const correctCount = topicLogs.reduce((sum, l) => sum + logScore(l), 0);

      // Uniquely completed exercises of the pool that can still be covered
      const uniquelyCompleted = new Set(topicLogs.filter(l => activeIds.has(l.exerciseId)).map(l => l.exerciseId)).size;

      const accuracy = totalLogged > 0 ? Math.round((correctCount / totalLogged) * 100) : null;
      const coverage = totalExercises > 0 ? Math.round((uniquelyCompleted / totalExercises) * 100) : 0;

      return {
        id: t.id,
        title: t.title,
        week: t.week,
        className: t.className,
        unit: t.unit,
        courseCode: t.course?.code || "Unknown",
        course: t.course ? { id: t.course.id, code: t.course.code, title: t.course.title } : null,
        totalExercises,
        uniquelyCompleted,
        accuracy,
        coverage,
        groupedExercises,
        groupCount,
      };
    });

    return topicMetrics;
  } catch (error) {
    console.error("Failed to fetch topics with performance:", error);
    return [];
  }
}

export async function getTopicEvolutionData(courseId?: string) {
  await requireAuth()
  const scope = cleanCourseId(courseId)
  try {
    // 1. Fetch all completed ExerciseLogs with timestamps and exercises details
    const logs = await prisma.exerciseLog.findMany({
      where: scope ? { exercise: { topic: { courseId: scope } } } : undefined,
      orderBy: { timestamp: 'asc' },
      include: {
        exercise: {
          include: {
            topic: {
              include: { course: true }
            }
          }
        }
      }
    });

    if (logs.length === 0) {
      return { 
        courseData: [], weekData: [], topicData: [],
        courseCoverageData: [], weekCoverageData: [], topicCoverageData: []
      };
    }

    // Fetch all available exercises in the DB to count total pools for coverage calculation
    const allExercises = await prisma.exercise.findMany({
      where: scope ? { status: 'active', topic: { courseId: scope } } : { status: 'active' },
      include: {
        topic: {
          include: { course: true }
        }
      }
    });

    const courseTotals: Record<string, number> = {};
    const weekTotals: Record<string, number> = {};
    const topicTotals: Record<string, number> = {};

    allExercises.forEach(e => {
      const cCode = e.topic?.course?.code || "Unknown";
      const wName = e.topic?.week || "General";
      const wTitle = `${cCode} - ${wName.replace(/_+/g, ' ').trim()}`;
      const tTitle = e.topic?.title || "General";

      courseTotals[cCode] = (courseTotals[cCode] || 0) + 1;
      weekTotals[wTitle] = (weekTotals[wTitle] || 0) + 1;
      topicTotals[tTitle] = (topicTotals[tTitle] || 0) + 1;
    });

    // 2. Identify unique dates (formatted as MM/DD)
    const datesSet = new Set<string>();
    const logsWithFormattedDate = logs.map(l => {
      const d = new Date(l.timestamp);
      const formattedDate = `${(d.getMonth() + 1).toString().padStart(2, '0')}/${d.getDate().toString().padStart(2, '0')}`;
      datesSet.add(formattedDate);
      
      const wName = l.exercise?.topic?.week || "General";
      const wCleaned = wName.replace(/_+/g, ' ').trim();
      
      return {
        ...l,
        formattedDate,
        courseCode: l.exercise?.topic?.course?.code || "Unknown",
        weekTitle: wCleaned,
        topicTitle: l.exercise?.topic?.title || "General"
      };
    });

    const sortedDates = Array.from(datesSet).sort();

    // Grouping buffers
    const courseGroup: Record<string, Record<string, { correct: number, total: number, exerciseIds: Set<string> }>> = {};
    const weekGroup: Record<string, Record<string, { correct: number, total: number, exerciseIds: Set<string> }>> = {};
    const topicGroup: Record<string, Record<string, { correct: number, total: number, exerciseIds: Set<string> }>> = {};

    for (const d of sortedDates) {
      courseGroup[d] = {};
      weekGroup[d] = {};
      topicGroup[d] = {};
    }

    // Accumulate scores
    for (const l of logsWithFormattedDate) {
      const d = l.formattedDate;
      const cCode = l.courseCode;
      const wTitle = `${cCode} - ${l.weekTitle}`;
      const tTitle = l.topicTitle;
      const exId = l.exerciseId;

      // Course Level (Macro)
      if (!courseGroup[d][cCode]) courseGroup[d][cCode] = { correct: 0, total: 0, exerciseIds: new Set() };
      courseGroup[d][cCode].total += 1;
      courseGroup[d][cCode].exerciseIds.add(exId);
      courseGroup[d][cCode].correct += logScore(l);

      // Week Level (Meso)
      if (!weekGroup[d][wTitle]) weekGroup[d][wTitle] = { correct: 0, total: 0, exerciseIds: new Set() };
      weekGroup[d][wTitle].total += 1;
      weekGroup[d][wTitle].exerciseIds.add(exId);
      weekGroup[d][wTitle].correct += logScore(l);

      // Topic Level (Micro)
      if (!topicGroup[d][tTitle]) topicGroup[d][tTitle] = { correct: 0, total: 0, exerciseIds: new Set() };
      topicGroup[d][tTitle].total += 1;
      topicGroup[d][tTitle].exerciseIds.add(exId);
      topicGroup[d][tTitle].correct += logScore(l);
    }

    // Compile into flat timelines with running cumulative averages and coverages
    const courseRunning: Record<string, { correct: number, total: number }> = {};
    const weekRunning: Record<string, { correct: number, total: number }> = {};
    const topicRunning: Record<string, { correct: number, total: number }> = {};

    const courseUniqueIds: Record<string, Set<string>> = {};
    const weekUniqueIds: Record<string, Set<string>> = {};
    const topicUniqueIds: Record<string, Set<string>> = {};

    const courseData: any[] = [];
    const weekData: any[] = [];
    const topicData: any[] = [];

    const courseCoverageData: any[] = [];
    const weekCoverageData: any[] = [];
    const topicCoverageData: any[] = [];

    for (const d of sortedDates) {
      // --- Course Level ---
      const courseObj: Record<string, any> = { date: d };
      const courseCovObj: Record<string, any> = { date: d };

      Object.entries(courseGroup[d]).forEach(([key, stats]) => {
        if (!courseRunning[key]) courseRunning[key] = { correct: 0, total: 0 };
        courseRunning[key].correct += stats.correct;
        courseRunning[key].total += stats.total;

        if (!courseUniqueIds[key]) courseUniqueIds[key] = new Set();
        stats.exerciseIds.forEach(id => courseUniqueIds[key].add(id));
      });

      Object.entries(courseRunning).forEach(([key, stats]) => {
        courseObj[key] = Math.round((stats.correct / stats.total) * 100);
      });
      courseData.push(courseObj);

      Object.entries(courseUniqueIds).forEach(([key, uniqueSet]) => {
        const totalPool = courseTotals[key] || 1;
        courseCovObj[key] = Math.round((uniqueSet.size / totalPool) * 100);
      });
      courseCoverageData.push(courseCovObj);

      // --- Week Level ---
      const weekObj: Record<string, any> = { date: d };
      const weekCovObj: Record<string, any> = { date: d };

      Object.entries(weekGroup[d]).forEach(([key, stats]) => {
        if (!weekRunning[key]) weekRunning[key] = { correct: 0, total: 0 };
        weekRunning[key].correct += stats.correct;
        weekRunning[key].total += stats.total;

        if (!weekUniqueIds[key]) weekUniqueIds[key] = new Set();
        stats.exerciseIds.forEach(id => weekUniqueIds[key].add(id));
      });

      Object.entries(weekRunning).forEach(([key, stats]) => {
        weekObj[key] = Math.round((stats.correct / stats.total) * 100);
      });
      weekData.push(weekObj);

      Object.entries(weekUniqueIds).forEach(([key, uniqueSet]) => {
        const totalPool = weekTotals[key] || 1;
        weekCovObj[key] = Math.round((uniqueSet.size / totalPool) * 100);
      });
      weekCoverageData.push(weekCovObj);

      // --- Topic Level ---
      const topicObj: Record<string, any> = { date: d };
      const topicCovObj: Record<string, any> = { date: d };

      Object.entries(topicGroup[d]).forEach(([key, stats]) => {
        if (!topicRunning[key]) topicRunning[key] = { correct: 0, total: 0 };
        topicRunning[key].correct += stats.correct;
        topicRunning[key].total += stats.total;

        if (!topicUniqueIds[key]) topicUniqueIds[key] = new Set();
        stats.exerciseIds.forEach(id => topicUniqueIds[key].add(id));
      });

      Object.entries(topicRunning).forEach(([key, stats]) => {
        topicObj[key] = Math.round((stats.correct / stats.total) * 100);
      });
      topicData.push(topicObj);

      Object.entries(topicUniqueIds).forEach(([key, uniqueSet]) => {
        const totalPool = topicTotals[key] || 1;
        topicCovObj[key] = Math.round((uniqueSet.size / totalPool) * 100);
      });
      topicCoverageData.push(topicCovObj);
    }

    return { 
      courseData, 
      weekData, 
      topicData,
      courseCoverageData,
      weekCoverageData,
      topicCoverageData
    };
  } catch (error) {
    console.error("Failed to generate topic evolution data:", error);
    return { 
      courseData: [], weekData: [], topicData: [],
      courseCoverageData: [], weekCoverageData: [], topicCoverageData: []
    };
  }
}

export async function getCourseArtifacts(courseId?: string) {
  await requireAuth()
  try {
    return await getCourseArtifactsService(cleanCourseId(courseId));
  } catch (error) {
    console.error("Failed to get course artifacts:", error);
    return [];
  }
}

export async function generateWeekSummaryAction(courseCode: string, weekName: string) {
  await requireAuth()
  try {
    return await generateWeekSummaryService(courseCode, weekName);
  } catch (error: any) {
    console.error(`Error generating week summary for ${courseCode} ${weekName}:`, error);
    throw error;
  }
}
