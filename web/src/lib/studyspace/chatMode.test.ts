import { describe, it, expect, vi, afterEach } from 'vitest'
import { chatModeStorageKey, readStoredChatMode, writeStoredChatMode, getChatMode, setChatMode, subscribeChatMode, resetChatModeMemory } from './chatMode'

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
