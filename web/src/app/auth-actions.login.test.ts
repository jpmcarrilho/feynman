import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const set = vi.fn()
vi.mock('next/headers', () => ({ cookies: async () => ({ set, get: () => undefined, delete: vi.fn() }) }))
vi.mock('@/services/liveToken', () => ({ mintLiveToken: vi.fn() }))

import { loginWithPasscode } from './auth-actions'

describe('loginWithPasscode', () => {
  const original = process.env.APP_PASSCODE
  beforeEach(() => {
    set.mockClear()
    process.env.APP_PASSCODE = 'correct-horse-battery'
  })
  afterEach(() => {
    if (original === undefined) delete process.env.APP_PASSCODE
    else process.env.APP_PASSCODE = original
  })

  it('accepts the exact passcode and sets the session cookie', async () => {
    expect(await loginWithPasscode('correct-horse-battery')).toEqual({ success: true })
    expect(set).toHaveBeenCalledWith('feynman_session', 'correct-horse-battery', expect.objectContaining({ httpOnly: true, sameSite: 'strict' }))
  })

  it('accepts a pasted passcode with surrounding whitespace or a newline', async () => {
    for (const pasted of ['correct-horse-battery ', ' correct-horse-battery', 'correct-horse-battery\n', '\tcorrect-horse-battery \r\n']) {
      set.mockClear()
      expect(await loginWithPasscode(pasted)).toEqual({ success: true })
      expect(set).toHaveBeenCalledTimes(1)
    }
  })

  it('stores the configured passcode in the cookie, never the submitted text', async () => {
    await loginWithPasscode('correct-horse-battery ')
    expect(set.mock.calls[0][1]).toBe('correct-horse-battery')
  })

  it('still refuses wrong, partial, prefixed and empty input', async () => {
    for (const bad of ['', '   ', 'wrong', 'correct-horse', 'APP_PASSCODE=correct-horse-battery', 'correct horse battery']) {
      set.mockClear()
      const res = await loginWithPasscode(bad)
      expect(res.success).toBe(false)
      expect(set).not.toHaveBeenCalled()
    }
  })

  it('refuses everything when no passcode is configured', async () => {
    delete process.env.APP_PASSCODE
    expect((await loginWithPasscode('anything')).success).toBe(false)
    expect((await loginWithPasscode('')).success).toBe(false)
  })
})
