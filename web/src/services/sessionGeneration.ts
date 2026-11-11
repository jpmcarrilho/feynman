import type { Exercise, Topic } from '@prisma/client'
import { prisma } from '@/lib/db'
import {
  generateExerciseForTopic,
  filterGeneratableTopicIds,
  chunkIds,
  GenerationError,
  countRejectedSince,
  TOPIC_REJECTION_LIMIT,
  SESSION_REJECTION_LIMIT,
} from '@/services/exerciseGenerator'
import { CourseScopeError } from '@/services/courseScope'
import { parseIdList } from '@/services/sessionService'

/**
 * What one request for "the next question of a session" returns:
 * `exercise` (appended to the session), `error` (a plain sentence for the student) or `stopped` (the session does not
 * exist or is no longer active: the client stops asking and shows nothing).
 */
export type NextExerciseResult =
  | { exercise: Exercise & { topic: Topic } }
  | { error: string; /** false: asking again cannot succeed (the client stops and shows the message without a Retry). Absent: transient, retry. */ retryable?: false }
  | { stopped: true }

/** Topics judged to be course logistics that one request skips over before giving up. */
export const MAX_LOGISTICS_SKIPS = 2

/** What the student sees when generation fails for a reason that is not one of the known GenerationErrors. */
export const GENERATION_FAILED_MESSAGE = 'The question generator is not available right now. Please try again in a moment.'

/**
 * The topics a session may generate from, read from the session itself so the client cannot widen the pool:
 * the stored selection; an empty selection means every topic of the session's course (every topic when the session
 * has no course); a session from before topicIds existed uses the topics of its own questions. Never the whole
 * database unless the session was started unscoped with no selection at all.
 */
export async function resolveSessionTopicIds(session: { id: string; courseId: string | null; topicIds: string | null }): Promise<string[]> {
  if (session.topicIds !== null) {
    const stored = parseIdList(session.topicIds)
    if (stored.length > 0) return stored
    const all = await prisma.topic.findMany({ where: session.courseId ? { courseId: session.courseId } : undefined, select: { id: true } })
    return all.map((t) => t.id)
  }
  const own = await prisma.sessionExercise.findMany({ where: { sessionId: session.id }, select: { exercise: { select: { topicId: true } } } })
  return [...new Set(own.map((i) => i.exercise.topicId))]
}

/**
 * Generates one more question for the session and appends it as the next positional SessionExercise. The topics and
 * the questions already in the session are read from the server; the caller passes only the session (and the course
 * the page is scoped to). With a courseId the session must belong to that course (a foreign session gives `stopped`).
 * Never returns provider errors: the failure is logged here and the student gets a short fixed sentence. The caller
 * authenticates first.
 *
 * A session that is missing or not `active` gets no model call and nothing appended. The status is read again after the
 * (slow) generation, inside the append transaction, so a session that ended meanwhile does not receive the question
 * either, and a session that already holds its target number of questions (another tab or device filled it) gets none.
 */
export async function generateNextForSession(sessionId: string, courseId?: string): Promise<NextExerciseResult> {
  try {
    const session = await prisma.studySession.findUnique({ where: { id: sessionId } })
    if (!session || session.status !== 'active') return { stopped: true }

    // Scoped call: a session stored under another course (or none) is "not found" for it
    if (courseId && session.courseId !== courseId) return { stopped: true }

    const topicIds = await resolveSessionTopicIds(session)
    if (topicIds.length === 0) return { error: 'No topics are selected for this session.', retryable: false }
    // Scoped call: every topic of the pool must belong to the course (the pool comes from the session, so this only
    // fails for a session that was stored with foreign topics)
    if (courseId) {
      const inCourse = new Set<string>()
      for (const chunk of chunkIds([...new Set(topicIds)])) {
        for (const t of await prisma.topic.findMany({ where: { id: { in: chunk }, courseId }, select: { id: true } })) inCourse.add(t.id)
      }
      if (new Set(topicIds).size !== inCourse.size) return { error: new CourseScopeError().message, retryable: false }
    }
    const existingExerciseIds = (await prisma.sessionExercise.findMany({ where: { sessionId }, select: { exerciseId: true } })).map((i) => i.exerciseId)

    // Never target topics without content or with only ungraded material (surveys, participation items)
    const eligibleTopicIds = await filterGeneratableTopicIds(topicIds)
    if (eligibleTopicIds.length === 0) {
      throw new GenerationError('no_eligible_topic', 'None of the selected topics has graded study material to generate questions from.')
    }

    // Stop targeting topics whose questions keep failing the quality checks in this session (rejected rows are kept for audit)
    const rejectedByTopic = await countRejectedSince(eligibleTopicIds, session.startTime)
    const rejectedInSession = [...rejectedByTopic.values()].reduce((a, b) => a + b, 0)
    if (rejectedInSession >= SESSION_REJECTION_LIMIT) {
      throw new GenerationError('validation_failed', 'Too many generated questions failed the quality checks in this session, so no more will be generated for it.', false)
    }
    const usableTopicIds = eligibleTopicIds.filter((id) => (rejectedByTopic.get(id) ?? 0) < TOPIC_REJECTION_LIMIT)
    if (usableTopicIds.length === 0) {
      throw new GenerationError('validation_failed', 'The remaining topics keep producing questions that fail the quality checks, so no more will be generated for them in this session.', false)
    }

    // Find current representation of selected topics in the session to keep the questions balanced
    const existingExercisesInSession: { topicId: string }[] = []
    for (const chunk of chunkIds(existingExerciseIds)) {
      existingExercisesInSession.push(...(await prisma.exercise.findMany({ where: { id: { in: chunk } }, select: { topicId: true } })))
    }
    const representedTopicIds = new Set(existingExercisesInSession.map((ex) => ex.topicId))

    // A topic the model judges to be course logistics is marked (see generateExerciseForTopic) and skipped here at once,
    // so the slot moves on to another topic instead of failing. At most MAX_LOGISTICS_SKIPS such topics per request.
    const skipped = new Set<string>()
    let newEx: Awaited<ReturnType<typeof generateExerciseForTopic>> | null = null
    for (let skips = 0; newEx === null; skips++) {
      const candidates = usableTopicIds.filter((id) => !skipped.has(id))
      if (candidates.length === 0) {
        if (skipped.size > 0) {
          throw new GenerationError('not_study_material', 'The selected topics hold course rules or administration rather than study material, so no question is generated from them.')
        }
        throw new GenerationError('no_eligible_topic', 'None of the selected topics has graded study material to generate questions from.')
      }
      const uncoveredTopicIds = candidates.filter((id) => !representedTopicIds.has(id))
      // If all selected topics are already represented, fall back to the full list of usable topics
      const targetPool = uncoveredTopicIds.length > 0 ? uncoveredTopicIds : candidates

      // Shuffle the pool to remove alphabetical or ordering bias in selection
      const shuffledTargetPool = [...targetPool]
      for (let i = shuffledTargetPool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[shuffledTargetPool[i], shuffledTargetPool[j]] = [shuffledTargetPool[j], shuffledTargetPool[i]]
      }

      try {
        newEx = await generateExerciseForTopic({
          primaryTopicId: shuffledTargetPool[0],
          poolTopicIds: targetPool,
          existingExerciseIds,
          styleTopicIds: topicIds,
        })
      } catch (e) {
        if (e instanceof GenerationError && e.code === 'not_study_material') {
          if (skips < MAX_LOGISTICS_SKIPS) {
            skipped.add(shuffledTargetPool[0])
            continue
          }
          // Skip budget of this request used up. Topics found so far stay marked, so another request goes on with the
          // rest: that is worth a retry as long as a candidate is left; with none left it cannot succeed.
          const left = candidates.filter((id) => id !== shuffledTargetPool[0]).length
          if (left > 0) throw new GenerationError('not_study_material', e.userMessage, true)
        }
        throw e
      }
    }

    // The session may have ended while the question was being generated; the append re-checks inside its transaction
    const appended = await appendToSession(sessionId, newEx.id)
    if (!appended) return { stopped: true }

    // The topic's content (up to 830k characters) is not needed by the client
    return { exercise: newEx.topic ? { ...newEx, topic: { ...newEx.topic, content: null } } : newEx }
  } catch (e) {
    // Full error on the server only; the provider message can contain request details
    console.error('Failed to generate next exercise:', e)
    if (e instanceof GenerationError) return e.retryable ? { error: e.userMessage } : { error: e.userMessage, retryable: false }
    return { error: GENERATION_FAILED_MESSAGE }
  }
}

/**
 * Appends an exercise as the next item of an active session that still has room: `position = max + 1` inside a
 * transaction that re-reads the status and the item count. A unique-constraint conflict on the position (another
 * request appended first) is retried once. Returns false when the session is no longer active or is already full.
 */
export async function appendToSession(sessionId: string, exerciseId: string): Promise<boolean> {
  const attempt = () =>
    prisma.$transaction(async (tx) => {
      const session = await tx.studySession.findUnique({ where: { id: sessionId }, select: { status: true, targetCount: true } })
      if (!session || session.status !== 'active') return false
      const agg = await tx.sessionExercise.aggregate({ where: { sessionId }, _max: { position: true }, _count: { _all: true } })
      if (session.targetCount !== null && agg._count._all >= session.targetCount) return false
      await tx.sessionExercise.create({ data: { sessionId, exerciseId, position: (agg._max.position ?? -1) + 1 } })
      return true
    })
  try {
    return await attempt()
  } catch (e) {
    if ((e as { code?: string })?.code === 'P2002') return attempt()
    throw e
  }
}
