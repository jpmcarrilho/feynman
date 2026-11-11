import { NextRequest, NextResponse } from 'next/server'
import { checkIsAuthenticated } from '@/app/auth-actions'
import { isValidFileId } from '@/lib/fileLinks'
import { generateNextForSession } from '@/services/sessionGeneration'

/**
 * Background generation of the next question of a session. A route handler instead of a server action because Next.js
 * runs server actions one at a time per client: a 20-40 s generation would hold up saving drafts and ending the session.
 * Body (optional): { courseId?: string } (the studyspace the page is scoped to). The topics the question is drawn from
 * and the questions already in the session are read from the session on the server; the client cannot widen the pool.
 * Returns `{ exercise } | { error } | { stopped: true }`.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
  if (!(await checkIsAuthenticated())) return new NextResponse('Unauthorized', { status: 401 })

  const { sessionId } = await params
  if (!isValidFileId(sessionId)) return NextResponse.json({ error: 'Invalid session.' }, { status: 400 })

  let body: unknown = {}
  try {
    const text = await request.text()
    if (text.trim()) body = JSON.parse(text)
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }
  const { courseId } = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  if (courseId !== undefined && !(typeof courseId === 'string' && isValidFileId(courseId))) {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }

  return NextResponse.json(
    courseId === undefined ? await generateNextForSession(sessionId) : await generateNextForSession(sessionId, courseId),
  )
}
