/**
 * Serial, debounced writes to the server for state the student changes quickly (exam drafts, current question).
 *  - Writes run one at a time in the order they were queued, so an older value never overtakes a newer one.
 *  - Scheduling a key again replaces the value that has not been sent yet (typing in a numeric field sends once).
 *  - A write carries the session id it was created for (the closure), so it can never apply to another session.
 *  - `flush()` sends everything pending now and resolves when the queue is empty: call it before submitting an exam,
 *    switching sessions, or when the page is hidden, so no draft is lost.
 */
export class DebouncedWriter {
  private pending = new Map<string, () => Promise<unknown>>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private tail: Promise<unknown> = Promise.resolve()

  constructor(private readonly onError: (e: unknown) => void = (e) => console.error('Failed to save session state:', e)) {}

  /** Queues `run` under `key`. delayMs 0 sends it right away (still after earlier writes). */
  schedule(key: string, run: () => Promise<unknown>, delayMs: number): void {
    const timer = this.timers.get(key)
    if (timer) clearTimeout(timer)
    this.timers.delete(key)
    this.pending.set(key, run)
    if (delayMs <= 0) {
      this.sendKey(key)
      return
    }
    this.timers.set(key, setTimeout(() => this.sendKey(key), delayMs))
  }

  private sendKey(key: string): void {
    const timer = this.timers.get(key)
    if (timer) clearTimeout(timer)
    this.timers.delete(key)
    const run = this.pending.get(key)
    if (!run) return
    this.pending.delete(key)
    this.tail = this.tail.then(run).catch(this.onError)
  }

  /** Sends everything pending and waits for every write queued so far. */
  async flush(): Promise<void> {
    for (const key of [...this.pending.keys()]) this.sendKey(key)
    await this.tail
  }

  /** Drops the writes of keys starting with `prefix` that have not been sent. */
  discard(prefix: string): void {
    for (const key of [...this.pending.keys()]) {
      if (!key.startsWith(prefix)) continue
      const timer = this.timers.get(key)
      if (timer) clearTimeout(timer)
      this.timers.delete(key)
      this.pending.delete(key)
    }
  }
}
