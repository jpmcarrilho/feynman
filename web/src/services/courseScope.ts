/**
 * Helpers for the optional course scope of server actions (T16). No database access here.
 * Scope rules, in one place:
 *  - `courseId` undefined/empty = global (the behavior before studyspaces).
 *  - Reads that take a scope return only that course's data.
 *  - A write or a read that takes both a scope and ids of other rows never touches rows of another course:
 *    creating a session or plan with foreign topics is rejected, reading or generating for a session of another
 *    course behaves as "not found".
 */

/** A usable scope: a non-empty string, trimmed. Anything else means "no scope". */
export function cleanCourseId(courseId: unknown): string | undefined {
  if (typeof courseId !== 'string') return undefined
  const trimmed = courseId.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * The course a new session or plan is stored under when no scope was passed: the course with the most entries,
 * ties going to the course that appears first. Entries without a course are ignored. null when there is none.
 * Pass the courses of the selected topics in the order the caller selected them (so "first topic" wins ties).
 */
export function dominantCourseId(courseIds: (string | null | undefined)[]): string | null {
  const counts = new Map<string, number>()
  for (const id of courseIds) {
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  let best: string | null = null
  let bestCount = 0
  for (const [id, n] of counts) {
    if (n > bestCount) {
      best = id
      bestCount = n
    }
  }
  return best
}

/** Error thrown by actions that reject ids of another course. The message is safe to show. */
export class CourseScopeError extends Error {
  constructor(message = 'Some of the selected topics do not belong to this studyspace.') {
    super(message)
    this.name = 'CourseScopeError'
  }
}
