/**
 * Which sessions appear in the History list. A session with no answers that is no longer running is a leftover
 * (a double click that started two sessions, a session ended immediately); it stays in the database but is not listed.
 * Running sessions are listed (a studyspace session the student can resume, a pre-created plan slot), and a cancelled
 * exam is listed as "Cancelled".
 */
export function isListableSession(session: { status: string; logCount: number }): boolean {
  return session.logCount > 0 || session.status === 'active' || session.status === 'cancelled'
}
