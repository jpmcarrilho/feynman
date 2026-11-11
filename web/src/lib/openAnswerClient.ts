import type { SessionState } from '@/services/sessionService'
import { countPendingOpen, type OpenFeedback, type SelfScore } from '@/lib/openAnswer'

/** What the check of one written answer came back with. */
export type OpenCheckOutcome =
  | { status: 'stored'; score: number; isCorrect: boolean; gradedBy: 'model' | 'self'; feedback: OpenFeedback | null }
  /** The model could not check it (or the server could not be reached or the sign-in expired): nothing was written; the student can assess the answer themselves. */
  | { status: 'unchecked' }
  /** The server refused the answer (session over, question not part of it, answer too short or too long). */
  | { status: 'rejected' }

export type OpenCheckBody = { exerciseId: string; answer: string; durationSec?: number; assisted?: boolean; selfScore?: SelfScore }

/**
 * Sends one written answer of a study session to the route handler (a route, not a server action: a multi-second check
 * must not queue with drafts and timers). Never throws: a network error, a 401 or a 5xx answers `unchecked`, so the card
 * offers the model answer and self-assessment instead of losing what was typed; a 400 or 409 answers `rejected`.
 */
export async function checkOpenAnswer(
  sessionId: string,
  body: OpenCheckBody,
  fetchImpl: typeof fetch = fetch,
): Promise<OpenCheckOutcome> {
  let res: Response
  try {
    res = await fetchImpl(`/api/sessions/${encodeURIComponent(sessionId)}/open-answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    return { status: 'unchecked' }
  }
  if (res.status === 400 || res.status === 409) return { status: 'rejected' }
  if (!res.ok) return { status: 'unchecked' }
  const json = (await res.json().catch(() => null)) as Partial<Extract<OpenCheckOutcome, { status: 'stored' }>> & { status?: string } | null
  if (json && json.status === 'stored' && typeof json.score === 'number') {
    return {
      status: 'stored',
      score: json.score,
      isCorrect: json.isCorrect === true,
      gradedBy: json.gradedBy === 'self' ? 'self' : 'model',
      feedback: json.feedback ?? null,
    }
  }
  return { status: 'unchecked' }
}

export type GradeOpenResult = { graded: number; failed: number; pending: number }

/** Asks the server to check the written answers of a submitted exam that are still pending. Null when the call failed (the answers stay pending). */
export async function gradePendingOpen(sessionId: string, fetchImpl: typeof fetch = fetch): Promise<GradeOpenResult | null> {
  try {
    const res = await fetchImpl(`/api/sessions/${encodeURIComponent(sessionId)}/grade-open`, { method: 'POST' })
    if (!res.ok) return null
    const json = (await res.json()) as Partial<GradeOpenResult> | null
    if (!json || typeof json.pending !== 'number') return null
    return { graded: Number(json.graded) || 0, failed: Number(json.failed) || 0, pending: json.pending }
  } catch {
    return null
  }
}

/** Written answers of a session state that are still pending. */
export function pendingOpenInState(state: SessionState | null | undefined): number {
  return state ? countPendingOpen(state.items.flatMap((i) => (i.log ? [i.log] : []))) : 0
}

/**
 * One round of checking a submitted exam's written answers: call the grade route, then re-read the session so the screen
 * shows what is stored. `pending` is what the stored state still has pending (the route's own count when the state could
 * not be read); null when neither is known (the answers are then treated as still pending by the caller).
 */
export async function checkPendingOpenAnswers(
  sessionId: string,
  deps: { refresh: () => Promise<SessionState | null>; fetchImpl?: typeof fetch },
): Promise<{ pending: number | null; state: SessionState | null }> {
  const result = await gradePendingOpen(sessionId, deps.fetchImpl)
  let state: SessionState | null = null
  try {
    state = await deps.refresh()
  } catch {
    state = null
  }
  if (state) return { pending: pendingOpenInState(state), state }
  return { pending: result ? result.pending : null, state: null }
}

/** localStorage key of the unsent draft of a written answer in a study session (removed when the answer is committed). */
export const openDraftStorageKey = (sessionId: string, exerciseId: string) => `feynman_open_draft_${sessionId}_${exerciseId}`

/**
 * Whether the diagnosis of an exam should be written now: a completed exam whose written answers are all checked
 * (`pending` is 0, not null) and that has no diagnosis yet. Study sessions never get one.
 */
export function examDiagnosisDue(s: { mode: string | null | undefined; status: string | null | undefined; pending: number | null; hasDiagnosis: boolean }): boolean {
  return s.mode === 'exam' && s.status === 'completed' && s.pending === 0 && !s.hasDiagnosis
}
