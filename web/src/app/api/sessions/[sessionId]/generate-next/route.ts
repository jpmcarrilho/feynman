import { NextRequest, NextResponse } from 'next/server'
import { checkIsAuthenticated } from '@/app/auth-actions'
import { isValidFileId } from '@/lib/fileLinks'
import { generateNextForSession } from '@/services/sessionGeneration'

/** Longest id lists accepted (a session can cover the whole course). */
const MAX_IDS = 5000

function isIdList(v: unknown): v is string[] {
  return Array.isArray(v) && v.length <= MAX_IDS && v.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 200)
}

/**
 * Background generation of the next question of a session. A route handler instead of a server action because Next.js
 * runs server actions one at a time per client: a 20-40 s generation would hold up logging answers and ending the session.
 * Body: { topicIds: string[], existingExerciseIds: string[], courseId?: string } (courseId: the studyspace the page is scoped to). Returns `{ exercise } | { error } | { stopped: true }`.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
  if (!(await checkIsAuthenticated())) return new NextResponse('Unauthorized', { status: 401 })

  const { sessionId } = await params
  if (!isValidFileId(sessionId)) return NextResponse.json({ error: 'Invalid session.' }, { status: 400 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }
  const { topicIds, existingExerciseIds, courseId } = (body ?? {}) as Record<string, unknown>
  if (!isIdList(topicIds) || !isIdList(existingExerciseIds)) {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }
  if (courseId !== undefined && !(typeof courseId === 'string' && isValidFileId(courseId))) {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }

  return NextResponse.json(
    courseId === undefined
      ? await generateNextForSession(sessionId, topicIds, existingExerciseIds)
      : await generateNextForSession(sessionId, topicIds, existingExerciseIds, courseId),
  )
}
