import { NextRequest, NextResponse } from 'next/server'
import { checkIsAuthenticated } from '@/app/auth-actions'
import { isValidFileId } from '@/lib/fileLinks'
import { gradePendingOpenLogs } from '@/services/openGrading'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }

/**
 * Checks the written answers of a completed exam that are still waiting for the model (three at a time, two attempts
 * each). No body. Safe to call again (Check again, or the background check when a finished exam is opened): only answers
 * still `pending` are touched.
 * Responses: 200 { graded, failed, pending } | 400 invalid session id | 401 not signed in (empty body) | 409 the session
 * does not exist or is not completed.
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
  if (!(await checkIsAuthenticated())) return new NextResponse(null, { status: 401, headers: NO_STORE })

  const { sessionId } = await params
  if (!isValidFileId(sessionId)) return NextResponse.json({ error: 'Invalid session.' }, { status: 400, headers: NO_STORE })

  const result = await gradePendingOpenLogs(sessionId)
  if (!result) return NextResponse.json({ error: 'The session is not a completed exam.' }, { status: 409, headers: NO_STORE })
  return NextResponse.json(result, { headers: NO_STORE })
}
