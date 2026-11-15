import { describe, it, expect } from 'vitest'
import { isListableSession } from './sessionList'

describe('isListableSession', () => {
  it('lists a session that has answers, whatever its status', () => {
    expect(isListableSession({ status: 'completed', logCount: 3 })).toBe(true)
    expect(isListableSession({ status: 'active', logCount: 1 })).toBe(true)
  })

  it('lists a running session and a cancelled exam without answers', () => {
    expect(isListableSession({ status: 'active', logCount: 0 })).toBe(true)
    expect(isListableSession({ status: 'cancelled', logCount: 0 })).toBe(true)
  })

  it('hides a finished session that has no answers', () => {
    expect(isListableSession({ status: 'completed', logCount: 0 })).toBe(false)
  })
})
