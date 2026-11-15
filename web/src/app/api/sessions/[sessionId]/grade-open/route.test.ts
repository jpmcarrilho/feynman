import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const auth = vi.hoisted(() => ({ ok: true }))
vi.mock('@/app/auth-actions', () => ({ checkIsAuthenticated: vi.fn(async () => auth.ok) }))
vi.mock('@/services/openGrading', () => ({ gradePendingOpenLogs: vi.fn() }))

import { gradePendingOpenLogs } from '@/services/openGrading'
import { POST, runtime, dynamic } from './route'

const call = (id = 'session-1') =>
  POST(new NextRequest(`http://localhost:3000/api/sessions/${id}/grade-open`, { method: 'POST' }), { params: Promise.resolve({ sessionId: id }) })

beforeEach(() => {
  vi.clearAllMocks()
  auth.ok = true
})

describe('POST /api/sessions/[sessionId]/grade-open', () => {
  it('returns 401 with an empty body before anything else when unauthenticated', async () => {
    auth.ok = false
    const res = await call()
    expect(res.status).toBe(401)
    expect(await res.text()).toBe('')
    expect(gradePendingOpenLogs).not.toHaveBeenCalled()
  })

  it('returns 400 for a bad session id without grading', async () => {
    expect((await call('..')).status).toBe(400)
    expect(gradePendingOpenLogs).not.toHaveBeenCalled()
  })

  it('returns the counts of the check, uncached', async () => {
    vi.mocked(gradePendingOpenLogs).mockResolvedValue({ graded: 2, failed: 1, pending: 1 })
    const res = await call()
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(await res.json()).toEqual({ graded: 2, failed: 1, pending: 1 })
    expect(gradePendingOpenLogs).toHaveBeenCalledWith('session-1')
  })

  it('returns 409 for an unknown session or one that is not completed', async () => {
    vi.mocked(gradePendingOpenLogs).mockResolvedValue(null)
    expect((await call()).status).toBe(409)
  })

  it('runs on Node and is never prerendered', () => {
    expect(runtime).toBe('nodejs')
    expect(dynamic).toBe('force-dynamic')
  })
})
