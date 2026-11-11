import { ChatModeEnum, type TutorChatMode } from './profile'

// Client-side store for the student's chat mode, one key per studyspace.
// Until spaces exist in the UI the key is "legacy". The choice is kept in memory first so the UI works
// even when localStorage is blocked; localStorage only makes it survive a reload.
export function chatModeStorageKey(courseId: string): string {
  return `feynman_chat_mode_${courseId}`
}

/** Stored mode or null. Never throws (storage can be blocked, full or missing). */
export function readStoredChatMode(courseId: string): TutorChatMode | null {
  try {
    if (typeof window === 'undefined') return null
    const parsed = ChatModeEnum.safeParse(window.localStorage.getItem(chatModeStorageKey(courseId)))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** Best effort; a storage failure must not break the UI. */
export function writeStoredChatMode(courseId: string, mode: TutorChatMode): void {
  try {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(chatModeStorageKey(courseId), mode)
  } catch {
    // ignore
  }
}

const memory = new Map<string, TutorChatMode>()
const listeners = new Set<() => void>()

/** Mode in effect: this session's choice, else the stored one, else the persona default. */
export function getChatMode(courseId: string, fallback: TutorChatMode): TutorChatMode {
  return memory.get(courseId) ?? readStoredChatMode(courseId) ?? fallback
}

export function setChatMode(courseId: string, mode: TutorChatMode): void {
  memory.set(courseId, mode)
  writeStoredChatMode(courseId, mode)
  listeners.forEach((l) => l())
}

/** For useSyncExternalStore. */
export function subscribeChatMode(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test helper. */
export function resetChatModeMemory(): void {
  memory.clear()
}
