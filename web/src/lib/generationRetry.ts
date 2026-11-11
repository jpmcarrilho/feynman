/** Waits before the 2nd and 3rd attempt of one question slot. */
export const RETRY_DELAYS_MS = [2000, 5000]

/** `stopped`: the session is over; the client stops without retrying and without a failure banner. */
export type GenerationOutcome<T> = { exercise: T } | { error: string } | { stopped: true }

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Runs `attempt` up to RETRY_DELAYS_MS.length + 1 times for one slot, waiting between failures.
 * A rejected promise counts as a failure with a fixed message (the thrown error is not shown to the student).
 * Returns 'cancelled' as soon as `isCancelled()` is true (before an attempt or after a wait).
 */
export async function generateWithRetry<T>(
  attempt: () => Promise<GenerationOutcome<T>>,
  isCancelled: () => boolean,
  options: { delays?: number[]; sleep?: (ms: number) => Promise<void> } = {},
): Promise<GenerationOutcome<T> | 'cancelled'> {
  const delays = options.delays ?? RETRY_DELAYS_MS
  const sleep = options.sleep ?? defaultSleep
  let last: { error: string } = { error: 'The question generator is not available right now. Please try again in a moment.' }
  for (let i = 0; i <= delays.length; i++) {
    if (isCancelled()) return 'cancelled'
    try {
      const outcome = await attempt()
      // A result that arrives after the run was cancelled (session ended or changed) is discarded
      if (isCancelled()) return 'cancelled'
      if ('exercise' in outcome || 'stopped' in outcome) return outcome
      last = outcome
    } catch (e) {
      // An aborted request is a cancellation, not a failure to retry or to log
      if (isCancelled()) return 'cancelled'
      console.error('Question generation call failed:', e)
    }
    if (i < delays.length) {
      await sleep(delays[i])
    }
  }
  return isCancelled() ? 'cancelled' : last
}
