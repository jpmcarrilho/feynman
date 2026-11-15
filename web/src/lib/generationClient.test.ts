import { describe, it, expect, vi } from 'vitest'
import { requestNextExercise } from './generationClient'

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response
const body = { courseId: 'c1' }

describe('requestNextExercise', () => {
  it('POSTs to the session route with the JSON body and the abort signal', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ exercise: { id: 'x' } }))
    const ctl = new AbortController()
    expect(await requestNextExercise('s/1', body, ctl.signal, fetchImpl)).toEqual({ exercise: { id: 'x' } })
    expect(fetchImpl).toHaveBeenCalledWith('/api/sessions/s%2F1/generate-next', expect.objectContaining({ method: 'POST', body: JSON.stringify(body), signal: ctl.signal }))
  })

  it('passes a stopped session through', async () => {
    expect(await requestNextExercise('s', body, new AbortController().signal, vi.fn().mockResolvedValue(json({ stopped: true })))).toEqual({ stopped: true })
  })

  it('turns HTTP failures and unreadable bodies into plain errors', async () => {
    const sig = new AbortController().signal
    expect(await requestNextExercise('s', body, sig, vi.fn().mockResolvedValue(json('Unauthorized', 401)))).toEqual({ error: expect.stringContaining('sign in'), retryable: false })
    expect(await requestNextExercise('s', body, sig, vi.fn().mockResolvedValue(json({ error: 'x' }, 500)))).toEqual({ error: expect.stringContaining('not available') })
    const bad = { ok: true, status: 200, json: async () => { throw new Error('x') } } as unknown as Response
    expect(await requestNextExercise('s', body, sig, vi.fn().mockResolvedValue(bad))).toEqual({ error: expect.any(String) })
  })

  it('rejects when the request is aborted', async () => {
    const ctl = new AbortController()
    const fetchImpl = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))))
    const p = requestNextExercise('s', body, ctl.signal, fetchImpl as never)
    ctl.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
  })
})
