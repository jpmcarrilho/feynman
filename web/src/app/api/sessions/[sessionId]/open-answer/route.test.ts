import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { OpenFeedback } from '@/lib/openAnswer'

const auth = vi.hoisted(() => ({ ok: true }))
vi.mock('@/app/auth-actions', () => ({ checkIsAuthenticated: vi.fn(async () => auth.ok) }))
vi.mock('@/services/openGrading', () => ({ gradeOpenAnswer: vi.fn(), STUDY_GRADE_ATTEMPTS: 1 }))
vi.mock('@/services/sessionService', () => ({ openAnswerPreconditions: vi.fn(), logOpenAnswerForSession: vi.fn() }))

import { gradeOpenAnswer } from '@/services/openGrading'
import { logOpenAnswerForSession, openAnswerPreconditions } from '@/services/sessionService'
import { POST, runtime, dynamic } from './route'

const ANSWER = 'It subtracts the unit mean from every variable.'
const feedback: OpenFeedback = { v: 1, keyPoints: [{ point: 'p', status: 'covered' }], misconceptions: [], text: 'Good.' }
const call = (body: unknown, id = 'session-1', raw?: string) =>
  POST(
    new NextRequest(`http://localhost:3000/api/sessions/${id}/open-answer`, { method: 'POST', body: raw ?? JSON.stringify(body) }),
    { params: Promise.resolve({ sessionId: id }) },
  )
const pre = { ok: true as const, existing: null, exercise: { questionText: 'Q?', modelAnswer: 'M.', keyPoints: ['a', 'b'] }, language: 'pt-BR' }
const graded = { score: 0.5, isCorrect: false, offTask: false, feedback, ms: 1200 }

beforeEach(() => {
  vi.clearAllMocks()
  auth.ok = true
  vi.mocked(openAnswerPreconditions).mockResolvedValue(pre)
  vi.mocked(gradeOpenAnswer).mockResolvedValue(graded)
  vi.mocked(logOpenAnswerForSession).mockImplementation(async (_s, _e, _a, g) => ({ score: g.score, isCorrect: g.isCorrect, gradedBy: g.gradedBy, feedback: g.feedback }))
})

describe('POST /api/sessions/[sessionId]/open-answer', () => {
  it('returns 401 with an empty body before reading the request when unauthenticated', async () => {
    auth.ok = false
    const res = await call({ exerciseId: 'e1', answer: ANSWER })
    expect(res.status).toBe(401)
    expect(await res.text()).toBe('')
    expect(openAnswerPreconditions).not.toHaveBeenCalled()
    expect(gradeOpenAnswer).not.toHaveBeenCalled()
  })

  it.each([
    ['a bad session id', { exerciseId: 'e1', answer: ANSWER }, '..', undefined],
    ['a body that is not JSON', null, 'session-1', 'nope'],
    ['an empty body', null, 'session-1', ''],
    ['a bad question id', { exerciseId: '../x', answer: ANSWER }, 'session-1', undefined],
    ['a missing question id', { answer: ANSWER }, 'session-1', undefined],
    ['an answer that is not text', { exerciseId: 'e1', answer: 5 }, 'session-1', undefined],
    ['a too short answer', { exerciseId: 'e1', answer: 'too short' }, 'session-1', undefined],
    ['an answer of spaces', { exerciseId: 'e1', answer: ' '.repeat(40) }, 'session-1', undefined],
    ['a too long answer', { exerciseId: 'e1', answer: 'a'.repeat(2001) }, 'session-1', undefined],
    ['an invalid self-assessment', { exerciseId: 'e1', answer: ANSWER, selfScore: 0.7 }, 'session-1', undefined],
  ])('returns 400 for %s, before any check or model call', async (_name, body, id, raw) => {
    expect((await call(body, id, raw)).status).toBe(400)
    expect(openAnswerPreconditions).not.toHaveBeenCalled()
    expect(gradeOpenAnswer).not.toHaveBeenCalled()
  })

  it('returns 409 when the question cannot be answered in this session', async () => {
    vi.mocked(openAnswerPreconditions).mockResolvedValue({ ok: false, reason: 'not_open' })
    const res = await call({ exerciseId: 'e1', answer: ANSWER })
    expect(res.status).toBe(409)
    expect(gradeOpenAnswer).not.toHaveBeenCalled()
    expect(logOpenAnswerForSession).not.toHaveBeenCalled()
  })

  it('grades with the question, model answer, key points and language, logs the result and returns it uncached', async () => {
    const res = await call({ exerciseId: 'e1', answer: `  ${ANSWER}  `, durationSec: 12, assisted: true })
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(await res.json()).toEqual({ status: 'stored', score: 0.5, isCorrect: false, gradedBy: 'model', feedback })
    expect(gradeOpenAnswer).toHaveBeenCalledWith(
      { questionText: 'Q?', modelAnswer: 'M.', keyPoints: ['a', 'b'], studentAnswer: ANSWER, language: 'pt-BR' },
      { attempts: 1 },
    )
    expect(logOpenAnswerForSession).toHaveBeenCalledWith(
      'session-1',
      'e1',
      ANSWER,
      { score: 0.5, isCorrect: false, gradedBy: 'model', feedback },
      { durationSec: 12, assisted: true },
    )
  })

  it('a repeat returns the stored result without a model call or a write', async () => {
    const existing = { score: 1, isCorrect: true, gradedBy: 'model' as const, feedback }
    vi.mocked(openAnswerPreconditions).mockResolvedValue({ ok: true, existing, exercise: null, language: 'en' })
    const res = await call({ exerciseId: 'e1', answer: ANSWER })
    expect(await res.json()).toEqual({ status: 'stored', ...existing })
    expect(gradeOpenAnswer).not.toHaveBeenCalled()
    expect(logOpenAnswerForSession).not.toHaveBeenCalled()
  })

  it('answers unchecked and writes nothing when the model could not check the answer', async () => {
    vi.mocked(gradeOpenAnswer).mockResolvedValue(null)
    const res = await call({ exerciseId: 'e1', answer: ANSWER })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'unchecked' })
    expect(logOpenAnswerForSession).not.toHaveBeenCalled()
  })

  it('stores the student\'s own assessment without a model call', async () => {
    const res = await call({ exerciseId: 'e1', answer: ANSWER, selfScore: 0.5 })
    expect(await res.json()).toMatchObject({ status: 'stored', score: 0.5, isCorrect: false, gradedBy: 'self', feedback: { selfScore: 0.5, text: '' } })
    expect(gradeOpenAnswer).not.toHaveBeenCalled()
    expect(vi.mocked(logOpenAnswerForSession).mock.calls[0][3]).toMatchObject({ score: 0.5, gradedBy: 'self' })
    const full = await call({ exerciseId: 'e1', answer: ANSWER, selfScore: 1 })
    expect(await full.json()).toMatchObject({ gradedBy: 'self', score: 1, isCorrect: true })
  })

  it('returns 409 when the session ended while the model was checking', async () => {
    vi.mocked(logOpenAnswerForSession).mockResolvedValue(null)
    expect((await call({ exerciseId: 'e1', answer: ANSWER })).status).toBe(409)
  })

  it('never returns the model answer or the key points of an unchecked question', async () => {
    vi.mocked(gradeOpenAnswer).mockResolvedValue(null)
    const text = await (await call({ exerciseId: 'e1', answer: ANSWER })).text()
    expect(text).not.toContain('M.')
    expect(text).not.toContain('keyPoints')
  })

  it('runs on Node and is never prerendered', () => {
    expect(runtime).toBe('nodejs')
    expect(dynamic).toBe('force-dynamic')
  })
})
