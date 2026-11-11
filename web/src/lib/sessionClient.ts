import type { SessionState, OpenLogExtras } from '@/services/sessionService'

/** What the study screen needs from a SessionState, in the shapes its components already use. */
export interface SessionView {
  /** The session row plus `logs` (answered questions) in the shape the screen reads. */
  session: SessionState['session'] & { logs: ({ exerciseId: string; isCorrect: boolean; score: number; userAnswer: string | null } & OpenLogExtras)[] }
  exercises: SessionState['items'][number]['exercise'][]
  draftAnswers: Record<string, string>
  flaggedIds: string[]
  missingCount: number
  currentIndex: number
  /** Exam end in server-clock milliseconds, or null (study session, or an exam without a time limit). */
  deadlineMs: number | null
  /** serverNow minus the client clock when the state was read: add it to Date.now() to get server time. */
  serverOffsetMs: number
}

export function viewFromState(state: SessionState, clientNowMs: number = Date.now()): SessionView {
  const items = state.items
  const draftAnswers: Record<string, string> = {}
  const flaggedIds: string[] = []
  const logs: SessionView['session']['logs'] = []
  for (const item of items) {
    if (item.draftAnswer) draftAnswers[item.exercise.id] = item.draftAnswer
    if (item.flagged) flaggedIds.push(item.exercise.id)
    if (item.log) logs.push({ exerciseId: item.exercise.id, ...item.log })
  }
  const deadlineMs = state.session.deadline && state.session.mode === 'exam' ? Date.parse(state.session.deadline) : null
  return {
    session: { ...state.session, logs },
    exercises: items.map((i) => i.exercise),
    draftAnswers,
    flaggedIds,
    missingCount: state.missingCount,
    currentIndex: Math.max(0, Math.min(state.session.currentPosition, Math.max(0, items.length - 1))),
    deadlineMs: Number.isFinite(deadlineMs) ? deadlineMs : null,
    serverOffsetMs: Date.parse(state.serverNow) - clientNowMs,
  }
}

/** Server clock minus client clock in milliseconds, as of now (add it to Date.now() to get server time). */
export function serverOffsetOf(state: SessionState, clientNowMs: number = Date.now()): number {
  return Date.parse(state.serverNow) - clientNowMs
}

/**
 * Seconds left until the server deadline, using the server's clock (client clock + offset), so a wrong client clock
 * does not change the countdown. Rounded up, never negative.
 */
export function remainingSeconds(deadlineMs: number, clientNowMs: number, serverOffsetMs: number): number {
  return Math.max(0, Math.ceil((deadlineMs - (clientNowMs + serverOffsetMs)) / 1000))
}

/** localStorage key of the only session hint the browser keeps: the id of the session this browser last had open. */
export function activeSessionHintKey(courseId?: string): string {
  return `feynman_active_session_${courseId || 'global'}`
}

/** The session id stored by the pre-T17 client under `dedp_active_session` (a whole snapshot), or null. */
export function legacySessionId(raw: string | null): string | null {
  if (!raw) return null
  try {
    const id = (JSON.parse(raw) as { session?: { id?: unknown } } | null)?.session?.id
    return typeof id === 'string' && id.length > 0 ? id : null
  } catch {
    return null
  }
}

/** True when the state the server returned differs from what the screen shows in a way that needs applying. */
export function stateDiffers(
  local: { status: string | undefined; itemCount: number; missingCount: number },
  state: SessionState,
): boolean {
  return local.status !== state.session.status || local.itemCount !== state.items.length || local.missingCount !== state.missingCount
}

/**
 * What to do with the id found under the pre-studyspace key `dedp_active_session` when a studyspace page opens.
 * `adopt`: the session belongs to this studyspace, use it as the hint. `forward`: it belongs to another studyspace,
 * hand it to that one's hint key so it resumes there. `drop`: it does not exist, has no studyspace, or is over.
 */
export function routeLegacySession(
  found: { courseId: string | null; status: string } | null,
  thisCourseId: string,
): { action: 'adopt' | 'drop' } | { action: 'forward'; courseId: string } {
  if (!found || !found.courseId || found.status !== 'active') return { action: 'drop' }
  return found.courseId === thisCourseId ? { action: 'adopt' } : { action: 'forward', courseId: found.courseId }
}
