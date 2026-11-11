import { describe, it, expect, vi } from 'vitest'
import { generateWithRetry, RETRY_DELAYS_MS } from './generationRetry'

const ok = { exercise: { id: 'e1' } }
const fail = { error: 'Not available.' }

describe('generateWithRetry', () => {
  it('waits 2 s then 5 s and succeeds on the third attempt', async () => {
    const attempt = vi.fn().mockResolvedValueOnce(fail).mockResolvedValueOnce(fail).mockResolvedValueOnce(ok)
    const sleep = vi.fn().mockResolvedValue(undefined)
    expect(await generateWithRetry(attempt, () => false, { sleep })).toEqual(ok)
    expect(attempt).toHaveBeenCalledTimes(3)
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([2000, 5000])
    expect(RETRY_DELAYS_MS).toEqual([2000, 5000])
  })

  it('returns the last error after 3 failed attempts and does not call a 4th time', async () => {
    const attempt = vi.fn().mockResolvedValue(fail)
    const sleep = vi.fn().mockResolvedValue(undefined)
    expect(await generateWithRetry(attempt, () => false, { sleep })).toEqual(fail)
    expect(attempt).toHaveBeenCalledTimes(3)
  })

  it('treats a rejected call as a failure with a fixed message that does not echo the thrown error', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const attempt = vi.fn().mockRejectedValue(new Error('secret key=AIza123'))
    const result = await generateWithRetry(attempt, () => false, { sleep: async () => {} })
    expect(result).toEqual({ error: expect.not.stringContaining('AIza') })
    expect(attempt).toHaveBeenCalledTimes(3)
    err.mockRestore()
  })

  it('stops with "cancelled" when the session changed, without further attempts', async () => {
    let cancelled = false
    const attempt = vi.fn().mockResolvedValue(fail)
    const sleep = vi.fn(async () => { cancelled = true })
    expect(await generateWithRetry(attempt, () => cancelled, { sleep })).toBe('cancelled')
    expect(attempt).toHaveBeenCalledTimes(1)
  })
})
