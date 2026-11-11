import { describe, it, expect, vi, beforeEach } from 'vitest'
import { submitExamForSession } from './sessionService'

const tx = vi.hoisted(() => ({
  studySession: { findUnique: vi.fn(), update: vi.fn() },
  exercise: { findMany: vi.fn() },
  exerciseLog: { findMany: vi.fn(), createMany: vi.fn() },
}))
const transaction = vi.hoisted(() => vi.fn())

vi.mock('@/lib/db', () => ({ prisma: { $transaction: transaction } }))

const ex = (id: string, correctAnswer: string, extra: Record<string, unknown> = {}) => ({
  id,
  exerciseType: 'single_choice',
  choices: '["A","B"]',
  correctAnswer,
  questionText: 'Q',
  ...extra,
})

beforeEach(() => {
  vi.clearAllMocks()
  transaction.mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx))
  tx.studySession.findUnique.mockResolvedValue({ id: 's1', mode: 'exam', status: 'active', exerciseIds: '["e1","e2","e3"]' })
  tx.exercise.findMany.mockResolvedValue([
    ex('e1', 'A'),
    ex('e2', '["X","Y"]', { exerciseType: 'multiple_choice', choices: '["X","Y","Z"]' }),
    ex('e3', 'A'),
  ])
  tx.exerciseLog.findMany.mockResolvedValue([])
})

describe('submitExamForSession', () => {
  it('grades every exercise, logs unanswered ones with score 0 and completes the session in one transaction', async () => {
    const r = await submitExamForSession('s1', { e1: 'A', e2: '["X"]' })

    expect(transaction).toHaveBeenCalledTimes(1)
    const rows = (tx.exerciseLog.createMany.mock.calls[0][0] as { data: Record<string, unknown>[] }).data
    expect(rows.map((x) => [x.exerciseId, x.isCorrect, x.score, x.userAnswer])).toEqual([
      ['e1', true, 1, 'A'],
      ['e2', false, 0.5, '["X"]'],
      ['e3', false, 0, ''],
    ])
    const upd = tx.studySession.update.mock.calls[0][0] as { data: Record<string, unknown> }
    expect(upd.data.status).toBe('completed')
    expect(upd.data.endTime).toBeInstanceOf(Date)
    expect(r).toEqual({ scoreSum: 1.5, total: 3, correctCount: 1 })
  })

  it('a repeated submit creates no logs, does not touch a completed session and returns the same totals', async () => {
    tx.studySession.findUnique.mockResolvedValue({ id: 's1', mode: 'exam', status: 'completed', exerciseIds: '["e1","e2","e3"]' })
    tx.exerciseLog.findMany.mockResolvedValue([
      { exerciseId: 'e1', score: 1, isCorrect: true },
      { exerciseId: 'e2', score: 0.5, isCorrect: false },
      { exerciseId: 'e3', score: 0, isCorrect: false },
    ])
    const r = await submitExamForSession('s1', { e1: 'B' })
    expect(tx.exerciseLog.createMany).not.toHaveBeenCalled()
    expect(tx.studySession.update).not.toHaveBeenCalled()
    expect(r).toEqual({ scoreSum: 1.5, total: 3, correctCount: 1 })
  })

  it('only creates the missing logs when some already exist and legacy logs count as 1 or 0', async () => {
    tx.exerciseLog.findMany.mockResolvedValue([{ exerciseId: 'e1', score: null, isCorrect: true }])
    const r = await submitExamForSession('s1', { e1: 'B', e3: 'A' })
    const rows = (tx.exerciseLog.createMany.mock.calls[0][0] as { data: Record<string, unknown>[] }).data
    expect(rows.map((x) => x.exerciseId)).toEqual(['e2', 'e3'])
    expect(r).toEqual({ scoreSum: 2, total: 3, correctCount: 2 })
  })

  it('retries once when two simultaneous submits collide on the unique index', async () => {
    transaction
      .mockImplementationOnce(async () => {
        throw Object.assign(new Error('Unique constraint'), { code: 'P2002' })
      })
      .mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx))
    const r = await submitExamForSession('s1', { e1: 'A' })
    expect(transaction).toHaveBeenCalledTimes(2)
    expect(r?.total).toBe(3)
  })

  it('rethrows other database errors', async () => {
    transaction.mockImplementationOnce(async () => {
      throw Object.assign(new Error('disk full'), { code: 'P1000' })
    })
    await expect(submitExamForSession('s1', {})).rejects.toThrow('disk full')
  })

  it('refuses a cancelled exam, a study session and an unknown session without writing', async () => {
    for (const row of [{ id: 's1', mode: 'exam', status: 'cancelled', exerciseIds: '[]' }, { id: 's1', mode: 'study', status: 'active', exerciseIds: '[]' }, null]) {
      tx.studySession.findUnique.mockResolvedValueOnce(row)
      await expect(submitExamForSession('s1', {})).resolves.toBeNull()
    }
    expect(tx.exerciseLog.createMany).not.toHaveBeenCalled()
    expect(tx.studySession.update).not.toHaveBeenCalled()
  })

  it('ignores answers for exercises outside the session and non-string answers', async () => {
    await submitExamForSession('s1', { other: 'A', e1: 5 as unknown as string })
    const rows = (tx.exerciseLog.createMany.mock.calls[0][0] as { data: Record<string, unknown>[] }).data
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ exerciseId: 'e1', userAnswer: '', score: 0 })
  })
})
