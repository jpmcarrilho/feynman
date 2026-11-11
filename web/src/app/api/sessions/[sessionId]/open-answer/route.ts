import { NextRequest, NextResponse } from 'next/server'
import { checkIsAuthenticated } from '@/app/auth-actions'
import { isValidFileId } from '@/lib/fileLinks'
import { OPEN_ANSWER_MAX_CHARS, SELF_SCORES, isOpenAnswerLongEnough, type OpenFeedback, type SelfScore } from '@/lib/openAnswer'
import { gradeOpenAnswer, STUDY_GRADE_ATTEMPTS } from '@/services/openGrading'
import { logOpenAnswerForSession, openAnswerPreconditions, type OpenAnswerResult } from '@/services/sessionService'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE })

/**
 * Answers and checks one written ("open") question of a study session. A route handler instead of a server action
 * because server actions run one at a time per client and a multi-second model check must not hold up drafts and timers.
 *
 * Body: { exerciseId: string, answer: string, durationSec?: number, assisted?: boolean, selfScore?: 0 | 0.5 | 1 }.
 * Responses:
 *   200 { status: 'stored', score, isCorrect, gradedBy: 'model' | 'self', feedback }  the answer is logged (a repeat
 *       returns the stored result without a model call: the first attempt wins);
 *   200 { status: 'unchecked' }  the model could not check it; nothing was written. Send the same request again with
 *       `selfScore` to store the student's own assessment (gradedBy 'self');
 *   400 invalid request (ids, body, answer shorter than 15 non-space characters or longer than 2,000 characters, selfScore);
 *   401 not signed in (empty body);
 *   409 the session or question does not accept this answer (unknown, not an open question of the session, session no longer active).
 * Nothing about the model answer or the key points is returned for a question that was not answered.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
  if (!(await checkIsAuthenticated())) return new NextResponse(null, { status: 401, headers: NO_STORE })

  const { sessionId } = await params
  if (!isValidFileId(sessionId)) return json({ error: 'Invalid session.' }, 400)

  let body: unknown
  try {
    body = JSON.parse(await request.text())
  } catch {
    return json({ error: 'Invalid request.' }, 400)
  }
  const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>
  const { exerciseId, answer, durationSec, assisted, selfScore } = b
  if (typeof exerciseId !== 'string' || !isValidFileId(exerciseId)) return json({ error: 'Invalid question.' }, 400)
  if (typeof answer !== 'string' || answer.length > OPEN_ANSWER_MAX_CHARS || !isOpenAnswerLongEnough(answer)) {
    return json({ error: 'The answer is too short or too long.' }, 400)
  }
  if (selfScore !== undefined && !(SELF_SCORES as readonly unknown[]).includes(selfScore)) return json({ error: 'Invalid self-assessment.' }, 400)
  const logOpts = {
    durationSec: typeof durationSec === 'number' ? durationSec : undefined,
    assisted: assisted === true,
  }
  const text = answer.trim()

  const pre = await openAnswerPreconditions(sessionId, exerciseId)
  if (!pre.ok) return json({ error: 'This question cannot be answered in this session.' }, 409)
  if (pre.existing) return json({ status: 'stored', ...pre.existing })
  if (!pre.exercise) return json({ error: 'This question cannot be answered in this session.' }, 409)

  let stored: OpenAnswerResult | null
  if (selfScore !== undefined) {
    const score = selfScore as SelfScore
    const feedback: OpenFeedback = { v: 1, keyPoints: [], misconceptions: [], text: '', selfScore: score }
    stored = await logOpenAnswerForSession(sessionId, exerciseId, text, { score, isCorrect: score === 1, gradedBy: 'self', feedback }, logOpts)
  } else {
    const graded = await gradeOpenAnswer(
      { ...pre.exercise, studentAnswer: text, language: pre.language },
      { attempts: STUDY_GRADE_ATTEMPTS },
    )
    if (!graded) return json({ status: 'unchecked' })
    stored = await logOpenAnswerForSession(
      sessionId,
      exerciseId,
      text,
      { score: graded.score, isCorrect: graded.isCorrect, gradedBy: 'model', feedback: graded.feedback },
      logOpts,
    )
  }
  if (!stored) return json({ error: 'The answer could not be saved. The session may have ended.' }, 409)
  return json({ status: 'stored', ...stored })
}
