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
    expect((await call({})).status).toBe(401)
    expect(generateNextForSession).not.toHaveBeenCalled()
  })

  it('returns 400 for a malformed body, a malformed courseId or a bad session id', async () => {
    expect((await call(null, 'session-1', 'not json')).status).toBe(400)
    expect((await call({ courseId: 5 })).status).toBe(400)
    expect((await call({ courseId: '../x' })).status).toBe(400)
    expect((await call({}, '..')).status).toBe(400)
    expect(generateNextForSession).not.toHaveBeenCalled()
  })

  it('takes only the session id (a Promise in params) from the request: the topics and questions are read on the server', async () => {
    vi.mocked(generateNextForSession).mockResolvedValue({ exercise: { id: 'e9' } } as never)
    // ids a client might still send are ignored, never passed on
    const res = await call({ topicIds: ['t1', 't2'], existingExerciseIds: ['e1'] })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ exercise: { id: 'e9' } })
    expect(generateNextForSession).toHaveBeenCalledWith('session-1')
  })

  it('accepts an empty body and passes an optional courseId on', async () => {
    vi.mocked(generateNextForSession).mockResolvedValue({ stopped: true } as never)
    expect((await call(null, 'session-1', '')).status).toBe(200)
    expect(generateNextForSession).toHaveBeenLastCalledWith('session-1')
    await call({ courseId: 'course-1' })
    expect(generateNextForSession).toHaveBeenLastCalledWith('session-1', 'course-1')
  })

  it.each([[{ error: 'plain sentence' }], [{ stopped: true }]])('returns %j unchanged', async (result) => {
    vi.mocked(generateNextForSession).mockResolvedValue(result as never)
    expect(await (await call({})).json()).toEqual(result)
  })
})
