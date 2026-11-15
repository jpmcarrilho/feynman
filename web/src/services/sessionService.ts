import { prisma } from '@/lib/db'
import { gradeAnswer, logScore } from '@/lib/grading'
import { parseKeyPoints, parseOpenFeedback, type GradedBy, type OpenFeedback } from '@/lib/openAnswer'
import { parseProfile } from '@/lib/studyspace/profile'

const MAX_ANSWER_LENGTH = 20_000
/** Most seconds one save may add to a question's time. */
const MAX_SECONDS_PER_SAVE = 3600
/**
 * Most seconds one log may record as its duration. Logs written before the visible time was measured (T18) all hold
 * 30 as a placeholder; from T18 on the value is the question's accumulated visible time (0 when none was recorded).
 */
export const MAX_LOG_DURATION_SEC = 3600

/**
 * How many of `deltaSec` visible seconds may be added to a question that already holds `currentSec`: the delta is
 * rounded, a negative or non-finite one counts as 0, one save adds at most an hour, and the question's total never
 * exceeds the wall-clock time since the session started.
 */
export function boundedIncrement(deltaSec: unknown, currentSec: number, startTime: Date | null | undefined, now: Date): number {
  if (typeof deltaSec !== 'number' || !Number.isFinite(deltaSec)) return 0
  let delta = Math.max(0, Math.min(MAX_SECONDS_PER_SAVE, Math.round(deltaSec)))
  if (startTime instanceof Date && !Number.isNaN(startTime.getTime())) {
    const wallClockSec = Math.max(0, Math.floor((now.getTime() - startTime.getTime()) / 1000))
    delta = Math.min(delta, Math.max(0, wallClockSec - Math.max(0, currentSec)))
  }
  return delta
}

/**
 * How long after an exam's deadline the server still accepts the student's last draft saves and flags (a save that
 * left the browser just before the clock ran out can arrive late). Past deadline + grace, stored drafts are final:
 * answers passed to a submit are ignored, saves are rejected, and any read finalizes the exam with the stored drafts.
 */
export const EXAM_GRACE_MS = 30_000

/** Most overdue exams one read finalizes (a backlog is worked off over several reads). */
const MAX_FINALIZE_PER_CALL = 20

export interface ExamSubmission {
  /** Sum of per-question scores (partial credit), 0..total. */
  scoreSum: number
  /** Number of questions in the exam, answered or not. */
  total: number
  /** Questions answered fully correctly. */
  correctCount: number
}

// Every exercise column plus the topic without its (up to 830k chars) content.
export const EXERCISE_CLIENT_SELECT = {
  id: true,
  topicId: true,
  questionText: true,
  exerciseType: true,
  choices: true,
  correctAnswer: true,
  explanation: true,
  isGraded: true,
  origin: true,
  status: true,
  promptVersion: true,
  originalQuestionText: true,
  enrichedAt: true,
  reportedReason: true,
  keyPoints: true,
  createdAt: true,
  groupId: true,
  groupPosition: true,
  group: { select: { id: true, title: true, stem: true } },
  topic: {
    select: {
      id: true,
      courseId: true,
      title: true,
      week: true,
      className: true,
      unit: true,
      resourceType: true,
      isQuantitative: true,
      course: { select: { id: true, code: true, title: true } },
    },
  },
} as const

const GRADING_SELECT = {
  id: true,
  exerciseType: true,
  choices: true,
  correctAnswer: true,
  questionText: true,
} as const

/** Parses a JSON string[] column defensively. */
export function parseIdList(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Types returned to the client
// ---------------------------------------------------------------------------------------------------------------

/**
 * Written-answer details of a log. Present only on logs that have a `gradedBy` (open answers); logs of the four
 * key-graded types, and every log written before open questions, carry neither field.
 */
export type OpenLogExtras = { gradedBy?: GradedBy; feedback?: OpenFeedback | null }

/** The extras of a stored log row (nothing for a key-graded or older log). */
function openLogExtras(log: { gradedBy?: string | null; feedback?: string | null }): OpenLogExtras {
  return log.gradedBy ? { gradedBy: log.gradedBy as GradedBy, feedback: parseOpenFeedback(log.feedback) } : {}
}

export type ClientExercise = {
  id: string
  topicId: string
  questionText: string
  exerciseType: string
  choices: string | null
  correctAnswer: string
  explanation: string | null
  status: string
  topic: { id: string; courseId: string; title: string; week: string | null; course: { id: string; code: string; title: string } | null } & Record<string, unknown>
} & Record<string, unknown>

export type SessionStateItem = {
  position: number
  exercise: ClientExercise
  draftAnswer: string | null
  flagged: boolean
  log: ({ isCorrect: boolean; score: number; userAnswer: string | null } & OpenLogExtras) | null
}

export type SessionState = {
  session: {
    id: string
    courseId: string | null
    title: string | null
    mode: string
    status: string
    timeLimit: number | null
    /** ISO time the exam ends (server clock); null for study sessions and for sessions without a limit. */
    deadline: string | null
    targetCount: number | null
    /** The topics the session draws from. Empty = every topic of the session's course. */
    topicIds: string[]
    currentPosition: number
    sourcingMix: number
    startTime: string
    endTime: string | null
    studyPlanId: string | null
  }
  items: SessionStateItem[]
  /** Questions still to be generated (targetCount - items); 0 once the session is over. */
  missingCount: number
  /** Server clock when this state was read (ISO). Clients derive their offset from it. */
  serverNow: string
}

/** Why a small session action did nothing. */
export type RejectReason = 'invalid' | 'not_found' | 'not_active' | 'not_item' | 'not_exam' | 'deadline_passed'
export type MutationResult = { ok: true } | { ok: false; reason: RejectReason }

// ---------------------------------------------------------------------------------------------------------------
// Exam submission
// ---------------------------------------------------------------------------------------------------------------

/** The duration a log records: accumulated visible seconds, never negative, never above an hour or the session's wall-clock age. */
function logDuration(accumulatedSec: number | null | undefined, startTime: Date | null | undefined, now: Date): number {
  const sec = typeof accumulatedSec === 'number' && Number.isFinite(accumulatedSec) ? Math.max(0, Math.round(accumulatedSec)) : 0
  const capped = Math.min(MAX_LOG_DURATION_SEC, sec)
  if (startTime instanceof Date && !Number.isNaN(startTime.getTime())) {
    return Math.min(capped, Math.max(0, Math.floor((now.getTime() - startTime.getTime()) / 1000)))
  }
  return capped
}

async function submitOnce(sessionId: string, answers: Record<string, string> | undefined, now: Date): Promise<ExamSubmission | null> {
  return prisma.$transaction(async (tx) => {
    const session = await tx.studySession.findUnique({
      where: { id: sessionId },
      select: { id: true, mode: true, status: true, deadline: true, startTime: true },
    })
    if (!session || session.mode !== 'exam' || session.status === 'cancelled') return null

    const items = await tx.sessionExercise.findMany({
      where: { sessionId },
      orderBy: { position: 'asc' },
      select: { exerciseId: true, draftAnswer: true, timeSpentSec: true },
    })
    const ids = items.map((i) => i.exerciseId)
    const rows = ids.length > 0 ? await tx.exercise.findMany({ where: { id: { in: ids } }, select: GRADING_SELECT }) : []
    const byId = new Map(rows.map((r) => [r.id, r]))
    const draftById = new Map(items.map((i) => [i.exerciseId, i.draftAnswer]))
    // Visible seconds the student spent on each question (saved with the drafts), also for questions never answered
    const timeById = new Map(items.map((i) => [i.exerciseId, i.timeSpentSec]))
    const exercises = ids.map((id) => byId.get(id)).filter((e): e is (typeof rows)[number] => !!e)

    // Answers passed by the caller count only until deadline + grace; they never add answers for non-items (the loop
    // walks the session's own items). Everything else uses the drafts stored on the server.
    const passed = answers && (!session.deadline || now.getTime() <= session.deadline.getTime() + EXAM_GRACE_MS) ? answers : {}

    const existing = await tx.exerciseLog.findMany({
      where: { sessionId },
      select: { exerciseId: true, score: true, isCorrect: true },
    })
    const have = new Map(existing.map((l) => [l.exerciseId, l]))

    const created: { exerciseId: string; score: number; isCorrect: boolean }[] = []
    const data: {
      sessionId: string
      exerciseId: string
      isCorrect: boolean
      score: number | null
      userAnswer: string
      duration: number
      gradedBy?: GradedBy
    }[] = []
    for (const ex of exercises) {
      if (have.has(ex.id)) continue
      const raw = Object.prototype.hasOwnProperty.call(passed, ex.id) ? passed[ex.id] : draftById.get(ex.id)
      // Unanswered questions are logged too, with an empty answer (the same value the exam flow has always stored)
      const userAnswer = typeof raw === 'string' ? raw.slice(0, MAX_ANSWER_LENGTH) : ''
      // A written answer is checked by the model after the exam is submitted: until then it is `pending` with no score
      // (logScore counts it 0 everywhere). An empty one is simply 0 (gradedBy stays null). The other types grade here.
      const isOpen = ex.exerciseType === 'open'
      const pendingOpen = isOpen && userAnswer.trim() !== ''
      const g = pendingOpen ? { score: 0, isCorrect: false } : gradeAnswer(ex, userAnswer)
      created.push({ exerciseId: ex.id, score: g.score, isCorrect: g.isCorrect })
      data.push({
        sessionId,
        exerciseId: ex.id,
        isCorrect: g.isCorrect,
        score: pendingOpen ? null : g.score,
        userAnswer,
        duration: logDuration(timeById.get(ex.id), session.startTime, now),
        // The proctor gives no help in an exam, so there is nothing to record: the default (false) stays
        ...(pendingOpen ? { gradedBy: 'pending' as const } : {}),
      })
    }
    if (data.length > 0) await tx.exerciseLog.createMany({ data })

    if (session.status !== 'completed') {
      await tx.studySession.update({ where: { id: sessionId }, data: { status: 'completed', endTime: now } })
    }

    const examIds = new Set(exercises.map((e) => e.id))
    const all = [...existing.filter((l) => examIds.has(l.exerciseId)), ...created]
    let scoreSum = 0
    let correctCount = 0
    for (const l of all) {
      scoreSum += logScore(l)
      if (l.isCorrect) correctCount++
    }
    return { scoreSum, total: exercises.length, correctCount }
  })
}

/**
 * Grades every item of the exam on the server, creates the logs and completes the session in one transaction.
 * Answers come from the drafts stored on the server; `answers` (optional) overrides them per exercise until the
 * deadline plus the grace period. Safe to repeat: existing logs are kept, a completed session stays as it is, and a
 * unique-constraint race between two simultaneous submits is retried once (the second pass finds the rows and only reads).
 * Returns null for an unknown session, a non-exam session or a cancelled exam.
 */
export async function submitExamForSession(
  sessionId: string,
  answers?: Record<string, string>,
  now: Date = new Date(),
): Promise<ExamSubmission | null> {
  const safeAnswers = answers && typeof answers === 'object' ? answers : undefined
  try {
    return await submitOnce(sessionId, safeAnswers, now)
  } catch (error) {
    if ((error as { code?: string })?.code === 'P2002') return submitOnce(sessionId, safeAnswers, now)
    throw error
  }
}

/**
 * Finalizes active exams whose deadline passed more than the grace period ago, with the drafts stored on the server.
 * Every exam runs in its own idempotent transaction, so concurrent callers (two tabs, a list read and a state read)
 * are harmless: the loser finds the work done. Failures are logged and never fail the read that triggered this.
 * Scope: one session, one course, or (neither) all.
 */
export async function finalizeOverdueExams(
  scope: { sessionId?: string; courseId?: string } = {},
  now: Date = new Date(),
): Promise<number> {
  let done = 0
  try {
    const rows = await prisma.studySession.findMany({
      where: {
        status: 'active',
        mode: 'exam',
        deadline: { lt: new Date(now.getTime() - EXAM_GRACE_MS) },
        ...(scope.sessionId ? { id: scope.sessionId } : {}),
        ...(scope.courseId ? { courseId: scope.courseId } : {}),
      },
      select: { id: true },
      take: MAX_FINALIZE_PER_CALL,
    })
    for (const row of rows) {
      try {
        if (await submitExamForSession(row.id, undefined, now)) done++
      } catch (e) {
        console.error('Failed to finalize overdue exam:', e instanceof Error ? e.message : e)
      }
    }
  } catch (e) {
    console.error('Failed to look for overdue exams:', e instanceof Error ? e.message : e)
  }
  return done
}

// ---------------------------------------------------------------------------------------------------------------
// Creating, ending and reading sessions
// ---------------------------------------------------------------------------------------------------------------

export interface NewSessionInput {
  courseId: string | null
  title: string
  mode: 'study' | 'exam'
  timeLimit: number | null
  sourcingMix: number
  topicIds: string[]
  targetCount: number
  exerciseIds: string[]
  now?: Date
}

/** Creates the session and its positional items (0..n-1) in one transaction. exerciseIds is no longer written. */
export async function createSessionWithItems(input: NewSessionInput) {
  const now = input.now ?? new Date()
  const deadline = input.mode === 'exam' && input.timeLimit ? new Date(now.getTime() + input.timeLimit * 1000) : null
  return prisma.$transaction(async (tx) => {
    const session = await tx.studySession.create({
      data: {
        status: 'active',
        courseId: input.courseId,
        title: input.title,
        mode: input.mode,
        timeLimit: input.timeLimit,
        sourcingMix: input.sourcingMix,
        topicIds: JSON.stringify(input.topicIds),
        targetCount: input.targetCount,
        deadline,
        currentPosition: 0,
        startTime: now,
      },
    })
    if (input.exerciseIds.length > 0) {
      await tx.sessionExercise.createMany({
        data: input.exerciseIds.map((exerciseId, position) => ({ sessionId: session.id, exerciseId, position })),
      })
    }
    return session
  })
}

/**
 * Ends the student's previous active session(s) in a scope before a new one starts, without destroying answers:
 * a study session is marked completed (its logs and chat stay), an exam is submitted with the drafts stored on the
 * server (graded, so nothing is lost). Sessions that belong to a study plan are plan items waiting to be studied and
 * are left alone. Returns the ids that were ended.
 */
export async function endPreviousActiveSessions(scope: { courseId?: string }, now: Date = new Date()): Promise<string[]> {
  const rows = await prisma.studySession.findMany({
    where: {
      status: 'active',
      studyPlanId: null,
      mode: { not: 'global_diagnosis' },
      ...(scope.courseId ? { courseId: scope.courseId } : {}),
    },
    select: { id: true, mode: true },
  })
  const ended: string[] = []
  for (const row of rows) {
    if (row.mode === 'exam') {
      await submitExamForSession(row.id, undefined, now)
    } else {
      await prisma.studySession.updateMany({ where: { id: row.id, status: 'active' }, data: { status: 'completed', endTime: now } })
    }
    ended.push(row.id)
  }
  return ended
}

/** Marks an active study session completed. An exam is submitted instead (graded with its stored drafts). */
export async function completeSession(sessionId: string, now: Date = new Date()): Promise<boolean> {
  const session = await prisma.studySession.findUnique({ where: { id: sessionId }, select: { mode: true, status: true } })
  if (!session) return false
  if (session.mode === 'exam') return (await submitExamForSession(sessionId, undefined, now)) !== null
  if (session.status !== 'active') return true
  await prisma.studySession.updateMany({ where: { id: sessionId, status: 'active' }, data: { status: 'completed', endTime: now } })
  return true
}

/** Cancels an active session. A completed or already cancelled session is left as it is. */
export async function cancelSession(sessionId: string, now: Date = new Date()): Promise<boolean> {
  const res = await prisma.studySession.updateMany({ where: { id: sessionId, status: 'active' }, data: { status: 'cancelled', endTime: now } })
  return res.count > 0
}

/**
 * A timed exam that has no deadline yet (pre-created by a study plan) gets its clock the first time it is opened.
 * Conditional write: two simultaneous opens set it once.
 */
async function startClockIfNeeded(sessionId: string, now: Date): Promise<void> {
  const s = await prisma.studySession.findUnique({ where: { id: sessionId }, select: { mode: true, status: true, deadline: true, timeLimit: true } })
  if (!s || s.mode !== 'exam' || s.status !== 'active' || s.deadline || !s.timeLimit) return
  await prisma.studySession.updateMany({
    where: { id: sessionId, status: 'active', deadline: null },
    data: { deadline: new Date(now.getTime() + s.timeLimit * 1000) },
  })
}

const SESSION_STATE_SELECT = {
  id: true,
  courseId: true,
  title: true,
  mode: true,
  status: true,
  timeLimit: true,
  deadline: true,
  targetCount: true,
  topicIds: true,
  currentPosition: true,
  sourcingMix: true,
  startTime: true,
  endTime: true,
  studyPlanId: true,
} as const

/** Builds the full state of one session from SessionExercise rows. Null when it does not exist (or, scoped, is another course's). */
export async function buildSessionState(sessionId: string, courseId?: string, now: Date = new Date()): Promise<SessionState | null> {
  const session = await prisma.studySession.findUnique({ where: { id: sessionId }, select: SESSION_STATE_SELECT })
  if (!session || (courseId && session.courseId !== courseId)) return null

  const [items, logs] = await Promise.all([
    prisma.sessionExercise.findMany({
      where: { sessionId },
      orderBy: { position: 'asc' },
      select: { position: true, draftAnswer: true, flagged: true, exercise: { select: EXERCISE_CLIENT_SELECT } },
    }),
    prisma.exerciseLog.findMany({
      where: { sessionId },
      select: { exerciseId: true, isCorrect: true, score: true, userAnswer: true, gradedBy: true, feedback: true },
    }),
  ])
  const logByExercise = new Map(logs.map((l) => [l.exerciseId, l]))

  // Sessions from before topicIds existed: the pool is the topics of the session's own questions, never the whole database
  const stored = session.topicIds === null ? null : parseIdList(session.topicIds)
  const topicIds = stored ?? [...new Set(items.map((i) => i.exercise.topicId))]

  const stateItems: SessionStateItem[] = items.map((i) => {
    const log = logByExercise.get(i.exercise.id)
    return {
      position: i.position,
      exercise: i.exercise as unknown as ClientExercise,
      draftAnswer: i.draftAnswer,
      flagged: i.flagged,
      log: log ? { isCorrect: log.isCorrect, score: logScore(log), userAnswer: log.userAnswer, ...openLogExtras(log) } : null,
    }
  })

  const target = session.targetCount ?? items.length
  return {
    session: {
      id: session.id,
      courseId: session.courseId,
      title: session.title,
      mode: session.mode,
      status: session.status,
      timeLimit: session.timeLimit,
      deadline: session.deadline ? session.deadline.toISOString() : null,
      targetCount: session.targetCount,
      topicIds,
      currentPosition: session.currentPosition,
      sourcingMix: session.sourcingMix,
      startTime: session.startTime.toISOString(),
      endTime: session.endTime ? session.endTime.toISOString() : null,
      studyPlanId: session.studyPlanId,
    },
    items: stateItems,
    missingCount: session.status === 'active' ? Math.max(0, target - items.length) : 0,
    serverNow: now.toISOString(),
  }
}

/** State of one session. An overdue exam is finalized first (stored drafts), a plan exam gets its clock on first open. */
export async function getSessionStateFor(sessionId: string, courseId?: string, now: Date = new Date()): Promise<SessionState | null> {
  await finalizeOverdueExams({ sessionId }, now)
  await startClockIfNeeded(sessionId, now)
  return buildSessionState(sessionId, courseId, now)
}

/**
 * The latest active session of a scope (one course, or all courses when none is given). A session pre-created by a
 * study plan counts only once the student touched it (an answer, draft, flag, a move, or a started clock).
 */
export async function getActiveSessionFor(courseId?: string, now: Date = new Date()): Promise<SessionState | null> {
  await finalizeOverdueExams(courseId ? { courseId } : {}, now)
  const candidates = await prisma.studySession.findMany({
    where: { status: 'active', mode: { not: 'global_diagnosis' }, ...(courseId ? { courseId } : {}) },
    orderBy: { startTime: 'desc' },
    take: 25,
    select: {
      id: true,
      studyPlanId: true,
      deadline: true,
      currentPosition: true,
      _count: { select: { logs: true } },
      items: { where: { OR: [{ draftAnswer: { not: null } }, { flagged: true }] }, select: { id: true }, take: 1 },
    },
  })
  const pick = candidates.find((c) => !c.studyPlanId || c._count.logs > 0 || c.items.length > 0 || c.deadline !== null || c.currentPosition > 0)
  if (!pick) return null
  return buildSessionState(pick.id, courseId, now)
}

// ---------------------------------------------------------------------------------------------------------------
// Small writes: drafts, flags, position, answers
// ---------------------------------------------------------------------------------------------------------------

/** Row filter shared by the writes: the session must be active and, for exams, not past deadline + grace. */
function openSessionFilter(now: Date) {
  const cutoff = new Date(now.getTime() - EXAM_GRACE_MS)
  return { status: 'active', OR: [{ deadline: null }, { deadline: { gte: cutoff } }] }
}

/** Explains why a write that matched no item did nothing. */
async function whyRejected(sessionId: string, exerciseId: string, now: Date): Promise<RejectReason> {
  const s = await prisma.studySession.findUnique({ where: { id: sessionId }, select: { status: true, deadline: true } })
  if (!s) return 'not_found'
  if (s.status !== 'active') return 'not_active'
  if (s.deadline && now.getTime() > s.deadline.getTime() + EXAM_GRACE_MS) return 'deadline_passed'
  const item = await prisma.sessionExercise.findUnique({ where: { sessionId_exerciseId: { sessionId, exerciseId } }, select: { id: true } })
  return item ? 'not_active' : 'not_item'
}

/**
 * Stores the exam draft of one question (null clears it; undefined leaves the stored draft alone, for a save that only
 * carries time) and adds the visible seconds spent since the last save. The delta is bounded (see boundedIncrement).
 * Accepted only for an item of an active exam and until deadline + grace; otherwise nothing changes.
 * The status and deadline are checked inside the same write, so a draft cannot land after the exam was submitted.
 */
export async function saveDraftFor(
  sessionId: string,
  exerciseId: string,
  draftAnswer: string | null | undefined,
  timeSpentDeltaSec: number,
  now: Date = new Date(),
): Promise<MutationResult> {
  if (typeof sessionId !== 'string' || typeof exerciseId !== 'string') return { ok: false, reason: 'invalid' }
  if (draftAnswer !== null && draftAnswer !== undefined && typeof draftAnswer !== 'string') return { ok: false, reason: 'invalid' }
  const where = { sessionId, exerciseId, session: { mode: 'exam', ...openSessionFilter(now) } }
  let delta = typeof timeSpentDeltaSec === 'number' && Number.isFinite(timeSpentDeltaSec) ? Math.max(0, Math.min(MAX_SECONDS_PER_SAVE, Math.round(timeSpentDeltaSec))) : 0
  if (delta > 0) {
    const row = await prisma.sessionExercise.findFirst({ where, select: { timeSpentSec: true, session: { select: { startTime: true } } } })
    delta = row ? boundedIncrement(delta, row.timeSpentSec, row.session.startTime, now) : delta
  }
  const data: { draftAnswer?: string | null; timeSpentSec?: { increment: number } } = {}
  if (draftAnswer !== undefined) data.draftAnswer = draftAnswer === null || draftAnswer === '' ? null : draftAnswer.slice(0, MAX_ANSWER_LENGTH)
  if (delta > 0) data.timeSpentSec = { increment: delta }
  const res = await prisma.sessionExercise.updateMany({ where, data })
  if (res.count > 0) return { ok: true }
  const reason = await whyRejected(sessionId, exerciseId, now)
  if (reason === 'not_active') {
    const s = await prisma.studySession.findUnique({ where: { id: sessionId }, select: { mode: true, status: true } })
    if (s && s.status === 'active' && s.mode !== 'exam') return { ok: false, reason: 'not_exam' }
  }
  return { ok: false, reason }
}

/**
 * Adds visible seconds to a question of an active study session (the exam equivalent rides on saveDraftFor). Study
 * sessions have no deadline. The delta is bounded like in saveDraftFor. A question that already has its log keeps the
 * duration it was logged with, so time arriving after the answer is ignored.
 */
export async function recordStudyTimeFor(sessionId: string, exerciseId: string, deltaSec: number, now: Date = new Date()): Promise<MutationResult> {
  if (typeof sessionId !== 'string' || typeof exerciseId !== 'string') return { ok: false, reason: 'invalid' }
  const row = await prisma.sessionExercise.findUnique({
    where: { sessionId_exerciseId: { sessionId, exerciseId } },
    select: { timeSpentSec: true, session: { select: { mode: true, status: true, startTime: true } } },
  })
  if (!row) {
    const s = await prisma.studySession.findUnique({ where: { id: sessionId }, select: { id: true } })
    return { ok: false, reason: s ? 'not_item' : 'not_found' }
  }
  if (row.session.status !== 'active') return { ok: false, reason: 'not_active' }
  if (row.session.mode === 'exam') return { ok: false, reason: 'not_exam' }
  const delta = boundedIncrement(deltaSec, row.timeSpentSec, row.session.startTime, now)
  if (delta > 0) {
    const logged = await prisma.exerciseLog.findUnique({ where: { sessionId_exerciseId: { sessionId, exerciseId } }, select: { id: true } })
    if (logged) return { ok: true }
    await prisma.sessionExercise.updateMany({
      where: { sessionId, exerciseId, session: { status: 'active', mode: { not: 'exam' } } },
      data: { timeSpentSec: { increment: delta } },
    })
  }
  return { ok: true }
}

/** Flags or unflags one question of an active session (an exam until deadline + grace). */
export async function setFlaggedFor(sessionId: string, exerciseId: string, flagged: boolean, now: Date = new Date()): Promise<MutationResult> {
  if (typeof sessionId !== 'string' || typeof exerciseId !== 'string' || typeof flagged !== 'boolean') return { ok: false, reason: 'invalid' }
  const res = await prisma.sessionExercise.updateMany({
    where: { sessionId, exerciseId, session: openSessionFilter(now) },
    data: { flagged },
  })
  return res.count > 0 ? { ok: true } : { ok: false, reason: await whyRejected(sessionId, exerciseId, now) }
}

/** Remembers which question the student is on. Clamped to the session's questions; active sessions only. */
export async function setCurrentPositionFor(sessionId: string, position: number, now: Date = new Date()): Promise<MutationResult> {
  if (typeof sessionId !== 'string' || !Number.isFinite(position)) return { ok: false, reason: 'invalid' }
  const s = await prisma.studySession.findUnique({
    where: { id: sessionId },
    select: { status: true, targetCount: true, _count: { select: { items: true } } },
  })
  if (!s) return { ok: false, reason: 'not_found' }
  if (s.status !== 'active') return { ok: false, reason: 'not_active' }
  const last = Math.max(0, Math.max(s.targetCount ?? 0, s._count.items) - 1)
  const clamped = Math.max(0, Math.min(last, Math.floor(position)))
  const res = await prisma.studySession.updateMany({ where: { id: sessionId, ...openSessionFilter(now) }, data: { currentPosition: clamped } })
  return res.count > 0 ? { ok: true } : { ok: false, reason: 'not_active' }
}

/** What a study answer is stored as: the grade, and for a written answer who graded it and the feedback. */
type StudyLogDecision = { score: number; isCorrect: boolean; gradedBy?: GradedBy; feedback?: OpenFeedback }
type StudyLogExercise = { exerciseType: string; choices: string; correctAnswer: string; questionText: string }

/**
 * Writes the log of one answer of an active study session in one transaction, first attempt wins. `decide` sees the
 * session item's exercise and returns what to store, or null to refuse (nothing is written). A repeat for the same
 * (sessionId, exerciseId) returns the stored result. Shared by logAnswerForSession and logOpenAnswerForSession so the
 * duration and `assisted` handling cannot differ.
 */
async function writeStudyLog(
  sessionId: string,
  exerciseId: string,
  userAnswer: string,
  opts: { durationSec?: number; assisted?: boolean } | undefined,
  decide: (exercise: StudyLogExercise) => StudyLogDecision | null,
): Promise<StudyLogDecision | null> {
  if (typeof userAnswer !== 'string' || typeof sessionId !== 'string' || typeof exerciseId !== 'string') return null
  try {
    return await prisma.$transaction(async (tx) => {
      const session = await tx.studySession.findUnique({ where: { id: sessionId }, select: { status: true, mode: true, startTime: true } })
      if (!session || session.status !== 'active' || session.mode === 'exam') return null
      const item = await tx.sessionExercise.findUnique({
        where: { sessionId_exerciseId: { sessionId, exerciseId } },
        select: { timeSpentSec: true, exercise: { select: { exerciseType: true, choices: true, correctAnswer: true, questionText: true } } },
      })
      if (!item) return null
      const decision = decide(item.exercise)
      if (!decision) return null
      const stored = Math.max(0, item.timeSpentSec ?? 0)
      const duration = Math.min(MAX_LOG_DURATION_SEC, stored + boundedIncrement(opts?.durationSec, stored, session.startTime, new Date()))
      await tx.exerciseLog.create({
        data: {
          sessionId,
          exerciseId,
          isCorrect: decision.isCorrect,
          score: decision.score,
          assisted: opts?.assisted === true,
          userAnswer,
          duration,
          ...(decision.gradedBy ? { gradedBy: decision.gradedBy, feedback: JSON.stringify(decision.feedback ?? null) } : {}),
        },
      })
      if (duration !== stored) await tx.sessionExercise.update({ where: { sessionId_exerciseId: { sessionId, exerciseId } }, data: { timeSpentSec: duration } })
      return decision
    })
  } catch (error) {
    // First attempt wins: a second log for the same (sessionId, exerciseId) violates the unique index
    if ((error as { code?: string })?.code === 'P2002') {
      const existing = await prisma.exerciseLog.findUnique({
        where: { sessionId_exerciseId: { sessionId, exerciseId } },
        select: { score: true, isCorrect: true, gradedBy: true, feedback: true },
      })
      return existing ? storedDecision(existing) : null
    }
    console.error('Failed to log answer (likely stale session):', error instanceof Error ? error.message : error)
    return null
  }
}

function storedDecision(log: { score: number | null; isCorrect: boolean; gradedBy?: string | null; feedback?: string | null }): StudyLogDecision {
  return {
    score: logScore(log),
    isCorrect: log.isCorrect,
    ...(log.gradedBy ? { gradedBy: log.gradedBy as GradedBy, feedback: parseOpenFeedback(log.feedback) ?? undefined } : {}),
  }
}

/**
 * Grades and logs one answer of a study session on the server. Accepted only for an item of an active study session
 * (an exam collects drafts and is graded by the submit); anything else returns null and writes nothing. A written
 * ("open") question is refused here too: it is checked by the model through logOpenAnswerForSession.
 * First attempt wins: a repeat for the same (sessionId, exerciseId) returns the stored result.
 *
 * `opts.durationSec` is the visible seconds not yet saved with recordStudyTimeFor (the client sends what it still
 * holds). The log's duration is the time already stored on the question plus that, bounded (see boundedIncrement and
 * MAX_LOG_DURATION_SEC). Without it (an older client, a test) the log gets the stored time, which is 0 when nothing
 * was ever recorded: the column cannot be null, and 0 means "not measured" rather than a made-up number.
 * `opts.assisted` is stored only when it is exactly true.
 */
export async function logAnswerForSession(
  sessionId: string,
  exerciseId: string,
  userAnswer: string,
  opts?: { durationSec?: number; assisted?: boolean },
): Promise<{ score: number; isCorrect: boolean } | null> {
  const decision = await writeStudyLog(sessionId, exerciseId, userAnswer, opts, (exercise) =>
    exercise.exerciseType === 'open' ? null : gradeAnswer(exercise, userAnswer),
  )
  return decision ? { score: decision.score, isCorrect: decision.isCorrect } : null
}

/** A written answer's stored result, as the answer route returns it. */
export type OpenAnswerResult = { score: number; isCorrect: boolean; gradedBy: GradedBy; feedback: OpenFeedback | null }

function toOpenAnswerResult(log: { score: number | null; isCorrect: boolean; gradedBy?: string | null; feedback?: string | null }): OpenAnswerResult {
  return {
    score: logScore(log),
    isCorrect: log.isCorrect,
    gradedBy: (log.gradedBy ?? 'model') as GradedBy,
    feedback: parseOpenFeedback(log.feedback),
  }
}

/**
 * Logs a written answer of an active study session together with its grade (`model`, or `self` when the student scored
 * it after the model could not check it). Same rules as logAnswerForSession (first attempt wins, duration, `assisted`);
 * refuses anything that is not an `open` exercise. Returns null (nothing written) for a session that ended meanwhile.
 */
export async function logOpenAnswerForSession(
  sessionId: string,
  exerciseId: string,
  userAnswer: string,
  grade: { score: number; isCorrect: boolean; gradedBy: Exclude<GradedBy, 'pending'>; feedback: OpenFeedback },
  opts?: { durationSec?: number; assisted?: boolean },
): Promise<OpenAnswerResult | null> {
  const decision = await writeStudyLog(sessionId, exerciseId, userAnswer, opts, (exercise) =>
    exercise.exerciseType === 'open' ? grade : null,
  )
  return decision
    ? { score: decision.score, isCorrect: decision.isCorrect, gradedBy: decision.gradedBy ?? grade.gradedBy, feedback: decision.feedback ?? null }
    : null
}

export type OpenAnswerPreconditions =
  | { ok: false; reason: 'not_found' | 'not_active' | 'not_item' | 'not_open' }
  | {
      ok: true
      /** The stored result when this question was already answered (no model call is made then); the session may have ended since. */
      existing: OpenAnswerResult | null
      /** What the grader needs; read only for a question that is still to be answered. */
      exercise: { questionText: string; modelAnswer: string; keyPoints: string[] } | null
      language: string | null
    }

/**
 * Everything the answer route checks before it calls the model: the question is an `open` item of the session; if it
 * already has a log, that log; otherwise the session must be an active study session. Reads only.
 */
export async function openAnswerPreconditions(sessionId: string, exerciseId: string): Promise<OpenAnswerPreconditions> {
  const session = await prisma.studySession.findUnique({ where: { id: sessionId }, select: { status: true, mode: true } })
  if (!session) return { ok: false, reason: 'not_found' }
  const item = await prisma.sessionExercise.findUnique({
    where: { sessionId_exerciseId: { sessionId, exerciseId } },
    select: {
      exercise: {
        select: { exerciseType: true, questionText: true, correctAnswer: true, keyPoints: true, topic: { select: { course: { select: { profile: true } } } } },
      },
    },
  })
  if (!item) return { ok: false, reason: 'not_item' }
  if (item.exercise.exerciseType !== 'open') return { ok: false, reason: 'not_open' }
  const language = parseProfile(item.exercise.topic.course?.profile)?.contentLanguage ?? null
  const log = await prisma.exerciseLog.findUnique({
    where: { sessionId_exerciseId: { sessionId, exerciseId } },
    select: { score: true, isCorrect: true, gradedBy: true, feedback: true },
  })
  if (log) return { ok: true, existing: toOpenAnswerResult(log), exercise: null, language }
  if (session.status !== 'active' || session.mode === 'exam') return { ok: false, reason: 'not_active' }
  return {
    ok: true,
    existing: null,
    exercise: { questionText: item.exercise.questionText, modelAnswer: item.exercise.correctAnswer, keyPoints: parseKeyPoints(item.exercise.keyPoints) },
    language,
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Results dialog
// ---------------------------------------------------------------------------------------------------------------

export type SessionResultItem = {
  position: number
  exerciseId: string
  questionText: string
  /** Type and choices, so an answer can be shown the way the card shows it (see answerDisplayLines). */
  exerciseType: string
  choices: string
  correctAnswer: string
  /** null: the question was never answered (no log). */
  log: ({ isCorrect: boolean; score: number; userAnswer: string | null } & OpenLogExtras) | null
}

/**
 * Every question of a session in position order with its answer, for the results dialog (loaded when the dialog opens,
 * so the history list itself carries no question text). Unanswered questions have `log: null`.
 */
export async function getSessionResultsFor(sessionId: string): Promise<SessionResultItem[]> {
  const [items, logs] = await Promise.all([
    prisma.sessionExercise.findMany({
      where: { sessionId },
      orderBy: { position: 'asc' },
      select: { position: true, exercise: { select: { id: true, questionText: true, exerciseType: true, choices: true, correctAnswer: true } } },
    }),
    prisma.exerciseLog.findMany({ where: { sessionId }, select: { exerciseId: true, isCorrect: true, score: true, userAnswer: true, gradedBy: true, feedback: true } }),
  ])
  const logByExercise = new Map(logs.map((l) => [l.exerciseId, l]))
  return items.map((i) => {
    const log = logByExercise.get(i.exercise.id)
    return {
      position: i.position,
      exerciseId: i.exercise.id,
      questionText: i.exercise.questionText,
      exerciseType: i.exercise.exerciseType,
      choices: i.exercise.choices,
      correctAnswer: i.exercise.correctAnswer,
      log: log ? { isCorrect: log.isCorrect, score: logScore(log), userAnswer: log.userAnswer, ...openLogExtras(log) } : null,
    }
  })
}
