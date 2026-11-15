/**
 * Remembers which session the tutor conversation held in memory belongs to, so a save can never write one session's
 * messages into another. The conversation lives in React state (the live-API hook), which updates a render after the
 * code that replaces it; this buffer is updated at the same moment as the replacement and ignores the stale list that
 * is still rendered until the replacement has been committed.
 *
 *  - `replace(owner, messages)` is called whenever the session on screen changes (start, load, resume, end, cancel):
 *    the same array is then given to the state setter.
 *  - `observe(current)` is called with the state's list after every render.
 *  - `snapshot(sessionId)` is the only way to get messages to save: it returns them only for the owner.
 */
export class ChatBuffer<T = unknown> {
  private owner: string | null = null
  private messages: T[] = []
  /** The list handed to the state setter by the last replace, until a render has shown it. */
  private pending: T[] | null = null
  private lastSavedKey = ''

  replace(owner: string | null, messages: T[]): T[] {
    this.owner = owner
    this.messages = messages
    this.pending = messages
    this.lastSavedKey = ''
    return messages
  }

  observe(current: T[]): void {
    if (this.pending) {
      // still the list of the previous session (stale render): ignore it
      if (current !== this.pending) return
      this.pending = null
    }
    this.messages = current
  }

  ownerId(): string | null {
    return this.owner
  }

  /** The messages that may be saved to `sessionId`, or null when they belong to another session (or there are none). */
  snapshot(sessionId: string): T[] | null {
    if (this.owner !== sessionId || this.messages.length === 0) return null
    return this.messages
  }

  /** Like snapshot, but null too when nothing changed since the last `markSaved`. */
  changedSnapshot(sessionId: string): T[] | null {
    const messages = this.snapshot(sessionId)
    if (!messages) return null
    return this.keyOf(sessionId, messages) === this.lastSavedKey ? null : messages
  }

  markSaved(sessionId: string, messages: T[]): void {
    this.lastSavedKey = this.keyOf(sessionId, messages)
  }

  private keyOf(sessionId: string, messages: T[]): string {
    const last = messages[messages.length - 1]
    return `${sessionId}:${messages.length}:${JSON.stringify(last ?? '').length}`
  }
}
