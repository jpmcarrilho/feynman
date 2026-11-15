import { describe, it, expect, vi } from 'vitest'
import { examDiagnosisDue, checkOpenAnswer, checkPendingOpenAnswers, gradePendingOpen, pendingOpenInState, openDraftStorageKey } from './openAnswerClient'
import type { SessionState } from '@/services/sessionService'

const res = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const body = { exerciseId: 'e1', answer: 'a long enough written answer' }

describe('checkOpenAnswer', () => {
  it('posts the body to the open-answer route and returns the stored result', async () => {
    const f = vi.fn().mockResolvedValue(res(200, { status: 'stored', score: 0.5, isCorrect: false, gradedBy: 'model', feedback: { v: 1, keyPoints: [], misconceptions: [], text: 'ok' } }))
    const out = await checkOpenAnswer('s 1', { ...body, durationSec: 12, assisted: true }, f as unknown as typeof fetch)
    expect(f.mock.calls[0][0]).toBe('/api/sessions/s%201/open-answer')
    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ ...body, durationSec: 12, assisted: true })
    expect(out).toMatchObject({ status: 'stored', score: 0.5, gradedBy: 'model' })
  })
  it('maps 401, 5xx, a network error and a malformed body to unchecked', async () => {
    for (const f of [vi.fn().mockResolvedValue(res(401)), vi.fn().mockResolvedValue(res(500, {})), vi.fn().mockRejectedValue(new Error('net')), vi.fn().mockResolvedValue(res(200, { nope: 1 }))]) {
      expect(await checkOpenAnswer('s', body, f as unknown as typeof fetch)).toEqual({ status: 'unchecked' })
    }
  })
  it('passes an unchecked answer of the server through', async () => {
    expect(await checkOpenAnswer('s', body, vi.fn().mockResolvedValue(res(200, { status: 'unchecked' })) as unknown as typeof fetch)).toEqual({ status: 'unchecked' })
  })
  it('maps 400 and 409 to rejected', async () => {
    expect(await checkOpenAnswer('s', body, vi.fn().mockResolvedValue(res(409, {})) as unknown as typeof fetch)).toEqual({ status: 'rejected' })
    expect(await checkOpenAnswer('s', body, vi.fn().mockResolvedValue(res(400, {})) as unknown as typeof fetch)).toEqual({ status: 'rejected' })
  })
})

const stateWith = (gradedBy: (string | null)[]): SessionState => ({
  session: {} as SessionState['session'],
  serverNow: '',
  missingCount: 0,
  items: gradedBy.map((g, i) => ({ position: i, exercise: {} as never, draftAnswer: null, flagged: false, log: { isCorrect: false, score: 0, userAnswer: 'x', ...(g ? { gradedBy: g as 'pending' } : {}) } })),
})

describe('exam checking of written answers (pending -> graded)', () => {
  it('gradePendingOpen returns the counts, or null on any failure', async () => {
    expect(await gradePendingOpen('s', vi.fn().mockResolvedValue(res(200, { graded: 1, failed: 1, pending: 1 })) as unknown as typeof fetch)).toEqual({ graded: 1, failed: 1, pending: 1 })
    expect(await gradePendingOpen('s', vi.fn().mockResolvedValue(res(409, {})) as unknown as typeof fetch)).toBeNull()
    expect(await gradePendingOpen('s', vi.fn().mockRejectedValue(new Error('x')) as unknown as typeof fetch)).toBeNull()
  })
  it('counts pending logs of a state', () => {
    expect(pendingOpenInState(stateWith(['pending', 'model', null, 'pending']))).toBe(2)
    expect(pendingOpenInState(null)).toBe(0)
  })
  it('first round leaves one pending (banner + Check again), the second finds none (diagnosis may run)', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(res(200, { graded: 1, failed: 1, pending: 1 }))
      .mockResolvedValueOnce(res(200, { graded: 1, failed: 0, pending: 0 }))
    const refresh = vi.fn()
      .mockResolvedValueOnce(stateWith(['model', 'pending']))
      .mockResolvedValueOnce(stateWith(['model', 'model']))
    const first = await checkPendingOpenAnswers('s', { refresh, fetchImpl: f as unknown as typeof fetch })
    expect(first.pending).toBe(1)
    const second = await checkPendingOpenAnswers('s', { refresh, fetchImpl: f as unknown as typeof fetch })
    expect(second.pending).toBe(0)
    expect(f).toHaveBeenCalledTimes(2)
  })
  it('stays pending when the grade call fails and the state cannot be read', async () => {
    const out = await checkPendingOpenAnswers('s', { refresh: async () => null, fetchImpl: vi.fn().mockRejectedValue(new Error('x')) as unknown as typeof fetch })
    expect(out.pending).toBeNull()
  })
  it('trusts the stored state over the route count', async () => {
    const out = await checkPendingOpenAnswers('s', { refresh: async () => stateWith(['pending']), fetchImpl: vi.fn().mockResolvedValue(res(200, { graded: 1, failed: 0, pending: 0 })) as unknown as typeof fetch })
    expect(out.pending).toBe(1)
  })
})

it('draft key', () => expect(openDraftStorageKey('s', 'e')).toBe('feynman_open_draft_s_e'))

describe('examDiagnosisDue', () => {
  const base = { mode: 'exam', status: 'completed', pending: 0, hasDiagnosis: false }
  it('is due only for a completed exam with nothing pending and no diagnosis', () => {
    expect(examDiagnosisDue(base)).toBe(true)
    expect(examDiagnosisDue({ ...base, pending: 1 })).toBe(false)
    expect(examDiagnosisDue({ ...base, pending: null })).toBe(false)
    expect(examDiagnosisDue({ ...base, hasDiagnosis: true })).toBe(false)
    expect(examDiagnosisDue({ ...base, mode: 'study' })).toBe(false)
    expect(examDiagnosisDue({ ...base, status: 'active' })).toBe(false)
  })
})
