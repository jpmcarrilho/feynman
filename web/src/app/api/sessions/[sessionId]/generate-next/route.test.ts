import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const auth = vi.hoisted(() => ({ ok: true }))
vi.mock('@/app/auth-actions', () => ({ checkIsAuthenticated: vi.fn(async () => auth.ok) }))
vi.mock('@/services/sessionGeneration', () => ({ generateNextForSession: vi.fn() }))

import { generateNextForSession } from '@/services/sessionGeneration'
import { POST } from './route'

const call = (body: unknown, id = 'session-1', raw?: string) =>
  POST(
    new NextRequest(`http://localhost:3000/api/sessions/${id}/generate-next`, { method: 'POST', body: raw ?? JSON.stringify(body) }),
    { params: Promise.resolve({ sessionId: id }) },
  )

beforeEach(() => {
  vi.clearAllMocks()
  auth.ok = true
})

describe('POST /api/sessions/[sessionId]/generate-next', () => {
  it('returns 401 before reading the body or generating when unauthenticated', async () => {
    auth.ok = false
    expect((await call({ topicIds: ['t'], existingExerciseIds: [] })).status).toBe(401)
    expect(generateNextForSession).not.toHaveBeenCalled()
  })

  it('returns 400 for a malformed body, wrong types or a bad session id', async () => {
    expect((await call(null, 'session-1', 'not json')).status).toBe(400)
    expect((await call({ topicIds: 'x', existingExerciseIds: [] })).status).toBe(400)
    expect((await call({ topicIds: ['t'], existingExerciseIds: [1] })).status).toBe(400)
    expect((await call({ topicIds: ['t'] })).status).toBe(400)
    expect((await call({ topicIds: ['t'], existingExerciseIds: [] }, '..')).status).toBe(400)
    expect(generateNextForSession).not.toHaveBeenCalled()
  })

  it('passes the session id (a Promise in params) and the ids to the shared function and returns its result as JSON', async () => {
    vi.mocked(generateNextForSession).mockResolvedValue({ exercise: { id: 'e9' } } as never)
    const res = await call({ topicIds: ['t1', 't2'], existingExerciseIds: ['e1'] })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ exercise: { id: 'e9' } })
    expect(generateNextForSession).toHaveBeenCalledWith('session-1', ['t1', 't2'], ['e1'])
  })

  it.each([[{ error: 'plain sentence' }], [{ stopped: true }]])('returns %j unchanged', async (result) => {
    vi.mocked(generateNextForSession).mockResolvedValue(result as never)
    expect(await (await call({ topicIds: ['t1'], existingExerciseIds: [] })).json()).toEqual(result)
  })
})
