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

/**
 * What one request for "the next question of a session" returns:
 * `exercise` (appended to the session), `error` (a plain sentence for the student) or `stopped` (the session does not
 * exist or is no longer active: the client stops asking and shows nothing).
 */
export type NextExerciseResult =
  | { exercise: Exercise & { topic: Topic } }
  | { error: string }
  | { stopped: true }

/** Topics judged to be course logistics that one request skips over before giving up. */
export const MAX_LOGISTICS_SKIPS = 2

/** What the student sees when generation fails for a reason that is not one of the known GenerationErrors. */
export const GENERATION_FAILED_MESSAGE = 'The question generator is not available right now. Please try again in a moment.'

/**
 * Generates one more question for the session and appends it. Never returns provider errors: the failure is logged here
 * and the student gets a short fixed sentence. The caller authenticates first.
 *
 * A session that is missing or not `active` gets no model call and nothing appended. The status is read again after the
 * (slow) generation, so a session that ended meanwhile does not receive the question either.
 */
export async function generateNextForSession(
  sessionId: string,
  topicIds: string[],
  existingExerciseIds: string[],
): Promise<NextExerciseResult> {
  if (topicIds.length === 0) return { error: 'No topics are selected for this session.' }

  try {
    const session = await prisma.studySession.findUnique({ where: { id: sessionId } })
    if (!session || session.status !== 'active') return { stopped: true }

    // Never target topics without content or with only ungraded material (surveys, participation items)
    const eligibleTopicIds = await filterGeneratableTopicIds(topicIds)
    if (eligibleTopicIds.length === 0) {
      throw new GenerationError('no_eligible_topic', 'None of the selected topics has graded study material to generate questions from.')
    }

    // Stop targeting topics whose questions keep failing the quality checks in this session (rejected rows are kept for audit)
    const rejectedByTopic = await countRejectedSince(eligibleTopicIds, session.startTime)
    const rejectedInSession = [...rejectedByTopic.values()].reduce((a, b) => a + b, 0)
    if (rejectedInSession >= SESSION_REJECTION_LIMIT) {
      throw new GenerationError('validation_failed', 'Too many generated questions failed the quality checks in this session, so no more will be generated for it.')
    }
    const usableTopicIds = eligibleTopicIds.filter((id) => (rejectedByTopic.get(id) ?? 0) < TOPIC_REJECTION_LIMIT)
    if (usableTopicIds.length === 0) {
      throw new GenerationError('validation_failed', 'The remaining topics keep producing questions that fail the quality checks, so no more will be generated for them in this session.')
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
        if (e instanceof GenerationError && e.code === 'not_study_material' && skips < MAX_LOGISTICS_SKIPS) {
          skipped.add(shuffledTargetPool[0])
          continue
        }
        throw e
      }
    }

    // The session may have ended while the question was being generated
    const current = await prisma.studySession.findUnique({ where: { id: sessionId } })
    if (!current || current.status !== 'active') return { stopped: true }
    const currentIds: string[] = current.exerciseIds ? JSON.parse(current.exerciseIds) : []
    await prisma.studySession.update({
      where: { id: sessionId },
      data: { exerciseIds: JSON.stringify([...currentIds, newEx.id]) },
    })

    // The topic's content (up to 830k characters) is not needed by the client
    return { exercise: newEx.topic ? { ...newEx, topic: { ...newEx.topic, content: null } } : newEx }
  } catch (e) {
    // Full error on the server only; the provider message can contain request details
    console.error('Failed to generate next exercise:', e)
    return { error: e instanceof GenerationError ? e.userMessage : GENERATION_FAILED_MESSAGE }
  }
}
