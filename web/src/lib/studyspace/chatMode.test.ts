import { describe, it, expect, vi, afterEach } from 'vitest'
import { chatModeStorageKey, readStoredChatMode, writeStoredChatMode, getChatMode, setChatMode, subscribeChatMode, resetChatModeMemory, migrateLegacyChatMode } from './chatMode'

afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
  resetChatModeMemory()
})

describe('chat mode storage', () => {
  it('uses the per-space key', () => {
    expect(chatModeStorageKey('legacy')).toBe('feynman_chat_mode_legacy')
  })

  it('round-trips a valid mode and ignores invalid stored values', () => {
    expect(readStoredChatMode('legacy')).toBeNull()
    writeStoredChatMode('legacy', 'explain')
    expect(window.localStorage.getItem('feynman_chat_mode_legacy')).toBe('explain')
    expect(readStoredChatMode('legacy')).toBe('explain')
    window.localStorage.setItem('feynman_chat_mode_legacy', 'nonsense')
    expect(readStoredChatMode('legacy')).toBeNull()
  })

  it('never throws when storage fails', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    expect(readStoredChatMode('legacy')).toBeNull()
    expect(() => writeStoredChatMode('legacy', 'guide')).not.toThrow()
  })

  it('store: falls back to the default, notifies subscribers and keeps working when storage is blocked', () => {
    expect(getChatMode('legacy', 'probe')).toBe('probe')
    const listener = vi.fn()
    const unsubscribe = subscribeChatMode(listener)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    setChatMode('legacy', 'guide')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(getChatMode('legacy', 'probe')).toBe('guide')
    unsubscribe()
    setChatMode('legacy', 'explain')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('store: reads a stored choice after a reload', () => {
    window.localStorage.setItem('feynman_chat_mode_legacy', 'explain')
    expect(getChatMode('legacy', 'probe')).toBe('explain')
  })
})

describe('legacy chat mode migration', () => {
  it('moves the legacy choice into the first studyspace opened and removes the legacy key', () => {
    window.localStorage.setItem('feynman_chat_mode_legacy', 'guide')
    migrateLegacyChatMode('space-a')
    expect(window.localStorage.getItem('feynman_chat_mode_space-a')).toBe('guide')
    expect(window.localStorage.getItem('feynman_chat_mode_legacy')).toBeNull()
    // the next studyspace does not inherit it: it starts from its persona default
    migrateLegacyChatMode('space-b')
    expect(readStoredChatMode('space-b')).toBeNull()
    expect(getChatMode('space-b', 'probe')).toBe('probe')
    expect(getChatMode('space-a', 'probe')).toBe('guide')
  })

  it('keeps a studyspace choice that already exists and still removes the legacy key', () => {
    window.localStorage.setItem('feynman_chat_mode_legacy', 'guide')
    window.localStorage.setItem('feynman_chat_mode_space-a', 'explain')
    migrateLegacyChatMode('space-a')
    expect(readStoredChatMode('space-a')).toBe('explain')
    expect(window.localStorage.getItem('feynman_chat_mode_legacy')).toBeNull()
  })

  it('does nothing without a legacy choice, ignores a junk legacy value, and never throws', () => {
    migrateLegacyChatMode('space-a')
    expect(readStoredChatMode('space-a')).toBeNull()
    window.localStorage.setItem('feynman_chat_mode_legacy', 'nonsense')
    migrateLegacyChatMode('space-a')
    expect(readStoredChatMode('space-a')).toBeNull()
    window.localStorage.setItem('feynman_chat_mode_legacy', 'guide')
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(() => migrateLegacyChatMode('space-a')).not.toThrow()
  })
})
