import { prisma } from '@/lib/db'
import { filterGeneratableTopicIds } from '@/services/exerciseGenerator'

export const NOT_STARTABLE_MESSAGE =
  'Nothing can be generated from the selected topics: they have no graded questions and hold no study material to write questions from (for example course logistics). Choose other topics.'

export type StartCheck = { startable: true } | { startable: false; message: string }

/** Thrown by startSession when the check fails, so a session that could never show a question is not created. */
export class SessionNotStartableError extends Error {
  constructor(message = NOT_STARTABLE_MESSAGE) {
    super(message)
    this.name = 'SessionNotStartableError'
  }
}

/**
 * Can a session over this pool show at least one question? No model call is made, only database reads:
 *  1. stored questions: graded, active ones in the pool, usable when the sourcing mix leaves room for them
 *     (the same `floor(count * (1 - aiShare))` that startSession uses);
 *  2. otherwise generation: at least one topic of the pool must be eligible (has study content, is not ungraded-only,
 *     was not already judged to be logistics) — the same filter the generator applies.
 * A topic that only turns out to be logistics when the model reads it is not known here; generation reports that
 * as a terminal failure (see sessionGeneration).
 * The pool is `topicIds`, or every topic of the course (of the database when unscoped) when none are given.
 */
export async function checkSessionStartable(input: {
  courseId?: string
  topicIds: string[]
  count: number
  sourcingMix: number
}): Promise<StartCheck> {
  const { courseId, topicIds } = input
  const existingRoom = Math.floor(input.count * (1 - input.sourcingMix / 100)) > 0
  if (existingRoom) {
    const stored = await prisma.exercise.findFirst({
      where: topicIds.length > 0
        ? { topicId: { in: topicIds }, isGraded: true, status: 'active' }
        : { ...(courseId ? { topic: { courseId } } : {}), isGraded: true, status: 'active' },
      select: { id: true },
    })
    if (stored) return { startable: true }
  }
  const pool = topicIds.length > 0
    ? topicIds
    : (await prisma.topic.findMany({ where: courseId ? { courseId } : undefined, select: { id: true } })).map((t) => t.id)
  if (pool.length > 0 && (await filterGeneratableTopicIds(pool)).length > 0) return { startable: true }
  return { startable: false, message: NOT_STARTABLE_MESSAGE }
}
