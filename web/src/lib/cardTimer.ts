/**
 * Visible time per question card.
 *
 * One card at a time can have its clock running (`run(key)`; `run(null)` stops it). Elapsed milliseconds accumulate per
 * key. The part of the total that has not been sent to the server yet is handed out in whole seconds by `take(key)`;
 * `restore(key, sec)` puts seconds back when their save failed, so a failed or replaced save neither loses time nor
 * counts it twice. Sub-second remainders stay in the total and go out with a later take.
 *
 * The server writes are made by closures that the DebouncedWriter may replace before they run. Because the unsent
 * seconds live here and not in the closure, a replaced write loses nothing: whichever write runs next takes them.
 */
export class CardTimer {
  private ms = new Map<string, number>()
  private taken = new Map<string, number>()
  private runningKey: string | null = null
  private since = 0

  constructor(private readonly now: () => number = Date.now) {}

  /** Starts the clock of `key` (stopping the one that ran) or stops everything with null. Calling it with the same key is a no-op. */
  run(key: string | null): void {
    if (key === this.runningKey) return
    this.stop()
    if (key !== null) {
      this.runningKey = key
      this.since = this.now()
    }
  }

  private stop(): void {
    if (this.runningKey === null) return
    const elapsed = Math.max(0, this.now() - this.since)
    this.ms.set(this.runningKey, (this.ms.get(this.runningKey) ?? 0) + elapsed)
    this.runningKey = null
  }

  /** Accumulated milliseconds of `key`, including the running segment. */
  totalMs(key: string): number {
    const base = this.ms.get(key) ?? 0
    return this.runningKey === key ? base + Math.max(0, this.now() - this.since) : base
  }

  /** Whole seconds accumulated since the last take (or restore) of `key`. Marks them as taken. */
  take(key: string): number {
    const sec = Math.max(0, Math.floor(this.totalMs(key) / 1000) - (this.taken.get(key) ?? 0))
    if (sec > 0) this.taken.set(key, (this.taken.get(key) ?? 0) + sec)
    return sec
  }

  /** Gives back seconds that `take` handed out but that could not be saved. */
  restore(key: string, sec: number): void {
    if (!(sec > 0)) return
    this.taken.set(key, Math.max(0, (this.taken.get(key) ?? 0) - sec))
  }

  /** Keys with at least one whole second not yet taken. */
  keysWithUnsent(prefix = ''): string[] {
    const keys = new Set([...this.ms.keys(), ...(this.runningKey ? [this.runningKey] : [])])
    return [...keys].filter((k) => k.startsWith(prefix) && Math.floor(this.totalMs(k) / 1000) - (this.taken.get(k) ?? 0) > 0)
  }
}

/** Key of one question inside one session. */
export const cardKey = (sessionId: string, exerciseId: string) => `${sessionId}:${exerciseId}`

export interface CardClockInputs {
  /** Key of the current question, null when there is none. */
  key: string | null
  sessionActive: boolean
  examMode: boolean
  /** The current question already has its log (study mode). */
  answered: boolean
  /** The Study tab is the one showing. */
  studyTabShowing: boolean
  /** document.visibilityState is not 'hidden'. */
  pageVisible: boolean
  /** A dialog, the file viewer (full-screen below xl, full-width from xl up) or a loading diagnosis covers the card. */
  covered: boolean
  /** Study cards the student already answered at the click, before the log reached the screen. */
  closed: ReadonlySet<string>
}

/** The key whose clock should run, or null when the student is not looking at an open question. */
export function runningCardKey(i: CardClockInputs): string | null {
  if (!i.key || !i.sessionActive || !i.studyTabShowing || !i.pageVisible || i.covered) return null
  if (!i.examMode && (i.answered || i.closed.has(i.key))) return null
  return i.key
}
