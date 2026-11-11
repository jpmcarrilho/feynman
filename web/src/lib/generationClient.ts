import type { GenerationOutcome } from '@/lib/generationRetry'

/**
 * Asks the server for the next question of a session through the route handler (not a server action, which would queue
 * behind or in front of the student's other actions). Resolves to the route's `{ exercise } | { error } | { stopped }`.
 * Rejects with an AbortError when `signal` is aborted.
 */
export async function requestNextExercise<T>(
  sessionId: string,
  body: { topicIds: string[]; existingExerciseIds: string[] },
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<GenerationOutcome<T>> {
  const res = await fetchImpl(`/api/sessions/${encodeURIComponent(sessionId)}/generate-next`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (res.status === 401) return { error: 'Your session has expired. Please sign in again.' }
  const json = (await res.json().catch(() => null)) as GenerationOutcome<T> | null
  if (!res.ok || !json || typeof json !== 'object') return { error: 'The question generator is not available right now. Please try again in a moment.' }
  return json
}
