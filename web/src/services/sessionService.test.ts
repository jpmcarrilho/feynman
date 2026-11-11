import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  submitExamForSession,
  finalizeOverdueExams,
  createSessionWithItems,
  endPreviousActiveSessions,
  completeSession,
  cancelSession,
  buildSessionState,
  getSessionStateFor,
  getActiveSessionFor,
  saveDraftFor,
  setFlaggedFor,
  setCurrentPositionFor,
  logAnswerForSession,
  getSessionResultsFor,
  EXAM_GRACE_MS,
} from './sessionService'

const tx = vi.hoisted(() => ({
  studySession: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
  sessionExercise: { findMany: vi.fn(), findUnique: vi.fn(), createMany: vi.fn() },
  exercise: { findMany: vi.fn() },
  exerciseLog: { findMany: vi.fn(), createMany: vi.fn(), create: vi.fn() },
}))
const db = vi.hoisted(() => ({
  $transaction: vi.fn(),
  studySession: { findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
  sessionExercise: { findMany: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn() },
  exerciseLog: { findMany: vi.fn(), findUnique: vi.fn() },
}))

vi.mock('@/lib/db', () => ({ prisma: db }))

const NOW = new Date('2026-11-11T10:00:00.000Z')
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs)

const ex = (id: string, correctAnswer: string, extra: Record<string, unknown> = {}) => ({
  id,
  exerciseType: 'single_choice',
  choices: '["A","B"]',
  correctAnswer,
  questionText: 'Q',
  ...extra,
})

const items3 = [
  { exerciseId: 'e1', draftAnswer: null },
  { exerciseId: 'e2', draftAnswer: null },
  { exerciseId: 'e3', draftAnswer: null },
]

beforeEach(() => {
  vi.resetAllMocks()
  db.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx))
  tx.studySession.findUnique.mockResolvedValue({ id: 's1', mode: 'exam', status: 'active', deadline: null })
  tx.sessionExercise.findMany.mockResolvedValue(items3)
  tx.exercise.findMany.mockResolvedValue([
    ex('e1', 'A'),
    ex('e2', '["X","Y"]', { exerciseType: 'multiple_choice', choices: '["X","Y","Z"]' }),
    ex('e3', 'A'),
  ])
  tx.exerciseLog.findMany.mockResolvedValue([])
})

describe('submitExamForSession', () => {
  it('grades every item, logs unanswered ones with score 0 and completes the session in one transaction', async () => {
    const r = await submitExamForSession('s1', { e1: 'A', e2: '["X"]' })

    expect(db.$transaction).toHaveBeenCalledTimes(1)
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

  it('reads the questions from SessionExercise rows in position order', async () => {
    await submitExamForSession('s1', {})
    expect(tx.sessionExercise.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { sessionId: 's1' }, orderBy: { position: 'asc' } }))
  })

  it('uses the stored drafts when no answers are passed', async () => {
    tx.sessionExercise.findMany.mockResolvedValue([
      { exerciseId: 'e1', draftAnswer: 'A' },
      { exerciseId: 'e2', draftAnswer: null },
      { exerciseId: 'e3', draftAnswer: 'B' },
    ])
    const r = await submitExamForSession('s1')
    const rows = (tx.exerciseLog.createMany.mock.calls[0][0] as { data: Record<string, unknown>[] }).data
    expect(rows.map((x) => [x.exerciseId, x.userAnswer, x.score])).toEqual([['e1', 'A', 1], ['e2', '', 0], ['e3', 'B', 0]])
    expect(r).toEqual({ scoreSum: 1, total: 3, correctCount: 1 })
  })

  it('lets a passed answer override a stored draft for that question only', async () => {
    tx.sessionExercise.findMany.mockResolvedValue([
      { exerciseId: 'e1', draftAnswer: 'B' },
      { exerciseId: 'e2', draftAnswer: null },
      { exerciseId: 'e3', draftAnswer: 'A' },
    ])
    await submitExamForSession('s1', { e1: 'A' })
    const rows = (tx.exerciseLog.createMany.mock.calls[0][0] as { data: Record<string, unknown>[] }).data
    expect(rows.map((x) => x.userAnswer)).toEqual(['A', '', 'A'])
  })

  it('ignores passed answers after the deadline plus the grace period and uses the stored drafts', async () => {
    tx.studySession.findUnique.mockResolvedValue({ id: 's1', mode: 'exam', status: 'active', deadline: NOW })
    tx.sessionExercise.findMany.mockResolvedValue([
      { exerciseId: 'e1', draftAnswer: 'B' },
      { exerciseId: 'e2', draftAnswer: null },
      { exerciseId: 'e3', draftAnswer: null },
    ])
    await submitExamForSession('s1', { e1: 'A', e3: 'A' }, at(EXAM_GRACE_MS + 1000))
    const rows = (tx.exerciseLog.createMany.mock.calls[0][0] as { data: Record<string, unknown>[] }).data
    expect(rows.map((x) => x.userAnswer)).toEqual(['B', '', ''])
  })

  it('still honors passed answers within the grace period', async () => {
    tx.studySession.findUnique.mockResolvedValue({ id: 's1', mode: 'exam', status: 'active', deadline: NOW })
    await submitExamForSession('s1', { e1: 'A' }, at(EXAM_GRACE_MS - 1000))
    const rows = (tx.exerciseLog.createMany.mock.calls[0][0] as { data: Record<string, unknown>[] }).data
    expect(rows[0]).toMatchObject({ exerciseId: 'e1', userAnswer: 'A', score: 1 })
  })

  it('a repeated submit creates no logs, does not touch a completed session and returns the same totals', async () => {
    tx.studySession.findUnique.mockResolvedValue({ id: 's1', mode: 'exam', status: 'completed', deadline: null })
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
    db.$transaction
      .mockImplementationOnce(async () => {
        throw Object.assign(new Error('Unique constraint'), { code: 'P2002' })
      })
      .mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx))
    const r = await submitExamForSession('s1', { e1: 'A' })
    expect(db.$transaction).toHaveBeenCalledTimes(2)
    expect(r?.total).toBe(3)
  })

  it('rethrows other database errors', async () => {
    db.$transaction.mockImplementationOnce(async () => {
      throw Object.assign(new Error('disk full'), { code: 'P1000' })
    })
    await expect(submitExamForSession('s1', {})).rejects.toThrow('disk full')
  })

  it('refuses a cancelled exam, a study session and an unknown session without writing', async () => {
    for (const row of [{ id: 's1', mode: 'exam', status: 'cancelled' }, { id: 's1', mode: 'study', status: 'active' }, null]) {
      tx.studySession.findUnique.mockResolvedValueOnce(row)
      await expect(submitExamForSession('s1', {})).resolves.toBeNull()
    }
    expect(tx.exerciseLog.createMany).not.toHaveBeenCalled()
    expect(tx.studySession.update).not.toHaveBeenCalled()
  })

  it('ignores answers for exercises that are not items of the session and non-string answers', async () => {
    await submitExamForSession('s1', { other: 'A', e1: 5 as unknown as string })
    const rows = (tx.exerciseLog.createMany.mock.calls[0][0] as { data: Record<string, unknown>[] }).data
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.exerciseId)).not.toContain('other')
    expect(rows[0]).toMatchObject({ exerciseId: 'e1', userAnswer: '', score: 0 })
  })
})

describe('finalizeOverdueExams', () => {
  it('finalizes only exams whose deadline is older than the grace period, in their own submissions', async () => {
    db.studySession.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }])
    const n = await finalizeOverdueExams({}, NOW)
    expect(n).toBe(2)
    const where = db.studySession.findMany.mock.calls[0][0].where
    expect(where).toMatchObject({ status: 'active', mode: 'exam' })
    expect(where.deadline.lt).toEqual(at(-EXAM_GRACE_MS))
    expect(db.$transaction).toHaveBeenCalledTimes(2)
  })

  it('can be limited to one session or one course', async () => {
    db.studySession.findMany.mockResolvedValue([])
    await finalizeOverdueExams({ sessionId: 's9' }, NOW)
    expect(db.studySession.findMany.mock.calls[0][0].where).toMatchObject({ id: 's9' })
    await finalizeOverdueExams({ courseId: 'c1' }, NOW)
    expect(db.studySession.findMany.mock.calls[1][0].where).toMatchObject({ courseId: 'c1' })
  })

  it('never throws into the read that triggered it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    db.studySession.findMany.mockRejectedValue(new Error('locked'))
    await expect(finalizeOverdueExams({}, NOW)).resolves.toBe(0)
    db.studySession.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }])
    db.$transaction.mockRejectedValueOnce(new Error('boom')).mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx))
    await expect(finalizeOverdueExams({}, NOW)).resolves.toBe(1)
  })
})

describe('createSessionWithItems', () => {
  it('creates the session with topics, target and an exam deadline, plus items at positions 0..n-1, in one transaction', async () => {
    tx.studySession.create.mockResolvedValue({ id: 'new' })
    await createSessionWithItems({
      courseId: 'c1', title: 't', mode: 'exam', timeLimit: 600, sourcingMix: 50, topicIds: ['t1', 't2'], targetCount: 5, exerciseIds: ['x', 'y', 'z'], now: NOW,
    })
    expect(db.$transaction).toHaveBeenCalledTimes(1)
    const data = tx.studySession.create.mock.calls[0][0].data
    expect(data).toMatchObject({ status: 'active', courseId: 'c1', mode: 'exam', timeLimit: 600, topicIds: '["t1","t2"]', targetCount: 5, currentPosition: 0 })
    expect(data.deadline).toEqual(at(600_000))
    expect(data).not.toHaveProperty('exerciseIds')
    expect(tx.sessionExercise.createMany.mock.calls[0][0].data).toEqual([
      { sessionId: 'new', exerciseId: 'x', position: 0 },
      { sessionId: 'new', exerciseId: 'y', position: 1 },
      { sessionId: 'new', exerciseId: 'z', position: 2 },
    ])
  })

  it('has no deadline for a study session (even with a practice duration) or an exam without a limit', async () => {
    tx.studySession.create.mockResolvedValue({ id: 'new' })
    await createSessionWithItems({ courseId: null, title: 't', mode: 'study', timeLimit: 300, sourcingMix: 50, topicIds: [], targetCount: 5, exerciseIds: [], now: NOW })
    expect(tx.studySession.create.mock.calls[0][0].data.deadline).toBeNull()
    await createSessionWithItems({ courseId: null, title: 't', mode: 'exam', timeLimit: null, sourcingMix: 50, topicIds: [], targetCount: 5, exerciseIds: [], now: NOW })
    expect(tx.studySession.create.mock.calls[1][0].data.deadline).toBeNull()
    expect(tx.sessionExercise.createMany).not.toHaveBeenCalled()
  })
})

describe('endPreviousActiveSessions', () => {
  it('completes active study sessions, submits active exams, and leaves study-plan sessions alone', async () => {
    db.studySession.findMany.mockResolvedValue([{ id: 'st', mode: 'study' }, { id: 'ex', mode: 'exam' }])
    const ended = await endPreviousActiveSessions({ courseId: 'c1' }, NOW)
    expect(ended).toEqual(['st', 'ex'])
    expect(db.studySession.findMany.mock.calls[0][0].where).toMatchObject({ status: 'active', studyPlanId: null, courseId: 'c1' })
    expect(db.studySession.updateMany).toHaveBeenCalledWith({ where: { id: 'st', status: 'active' }, data: { status: 'completed', endTime: NOW } })
    // the exam goes through the grading submission (stored drafts kept as answers), not a bare status change
    expect(tx.exerciseLog.createMany).toHaveBeenCalled()
    expect(tx.studySession.update).toHaveBeenCalledWith({ where: { id: 'ex' }, data: { status: 'completed', endTime: NOW } })
  })

  it('without a course it covers the whole scope', async () => {
    db.studySession.findMany.mockResolvedValue([])
    await endPreviousActiveSessions({}, NOW)
    expect(db.studySession.findMany.mock.calls[0][0].where).not.toHaveProperty('courseId')
  })
})

describe('complete and cancel', () => {
  it('completeSession completes an active study session once and submits an exam', async () => {
    db.studySession.findUnique.mockResolvedValueOnce({ mode: 'study', status: 'active' })
    expect(await completeSession('s', NOW)).toBe(true)
    expect(db.studySession.updateMany).toHaveBeenCalledWith({ where: { id: 's', status: 'active' }, data: { status: 'completed', endTime: NOW } })
    db.studySession.findUnique.mockResolvedValueOnce({ mode: 'study', status: 'completed' })
    db.studySession.updateMany.mockClear()
    expect(await completeSession('s', NOW)).toBe(true)
    expect(db.studySession.updateMany).not.toHaveBeenCalled()
    db.studySession.findUnique.mockResolvedValueOnce({ mode: 'exam', status: 'active' })
    expect(await completeSession('s1', NOW)).toBe(true)
    expect(tx.exerciseLog.createMany).toHaveBeenCalled()
  })

  it('cancelSession only touches an active session: a completed or cancelled one stays as it is', async () => {
    db.studySession.updateMany.mockResolvedValue({ count: 0 })
    expect(await cancelSession('s', NOW)).toBe(false)
    expect(db.studySession.updateMany).toHaveBeenCalledWith({ where: { id: 's', status: 'active' }, data: { status: 'cancelled', endTime: NOW } })
    expect(tx.exerciseLog.createMany).not.toHaveBeenCalled()
  })
})

describe('buildSessionState', () => {
  const sessionRow = {
    id: 's', courseId: 'c1', title: 'T', mode: 'study', status: 'active', timeLimit: null, deadline: null, targetCount: 4,
    topicIds: '["t1"]', currentPosition: 1, sourcingMix: 50, startTime: NOW, endTime: null, studyPlanId: null,
  }
  const exRow = (id: string, topicId = 't1') => ({ id, topicId, questionText: 'Q', exerciseType: 'single_choice', choices: '[]', correctAnswer: 'A', explanation: null, status: 'active', topic: { id: topicId } })

  it('returns items in position order with drafts, flags and logs, and the questions still to generate', async () => {
    db.studySession.findUnique.mockResolvedValue(sessionRow)
    db.sessionExercise.findMany.mockResolvedValue([
      { position: 0, draftAnswer: 'A', flagged: true, exercise: exRow('a') },
      { position: 1, draftAnswer: null, flagged: false, exercise: exRow('b') },
    ])
    db.exerciseLog.findMany.mockResolvedValue([{ exerciseId: 'b', isCorrect: true, score: null, userAnswer: 'A' }])
    const st = await buildSessionState('s', undefined, NOW)
    expect(db.sessionExercise.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { sessionId: 's' }, orderBy: { position: 'asc' } }))
    expect(st?.items.map((i) => [i.position, i.exercise.id, i.draftAnswer, i.flagged, i.log])).toEqual([
      [0, 'a', 'A', true, null],
      [1, 'b', null, false, { isCorrect: true, score: 1, userAnswer: 'A' }], // legacy log without a score counts as 1
    ])
    expect(st?.missingCount).toBe(2)
    expect(st?.session).toMatchObject({ topicIds: ['t1'], currentPosition: 1, deadline: null, courseId: 'c1' })
    expect(st?.serverNow).toBe(NOW.toISOString())
  })

  it('derives the topics of a legacy session (topicIds null) from its own questions', async () => {
    db.studySession.findUnique.mockResolvedValue({ ...sessionRow, topicIds: null, targetCount: null })
    db.sessionExercise.findMany.mockResolvedValue([
      { position: 0, draftAnswer: null, flagged: false, exercise: exRow('a', 'tA') },
      { position: 1, draftAnswer: null, flagged: false, exercise: exRow('b', 'tB') },
      { position: 2, draftAnswer: null, flagged: false, exercise: exRow('c', 'tA') },
    ])
    db.exerciseLog.findMany.mockResolvedValue([])
    const st = await buildSessionState('s', undefined, NOW)
    expect(st?.session.topicIds).toEqual(['tA', 'tB'])
    expect(st?.missingCount).toBe(0) // no target: nothing more to generate
  })

  it('has nothing to generate once the session is over', async () => {
    db.studySession.findUnique.mockResolvedValue({ ...sessionRow, status: 'completed', targetCount: 9 })
    db.sessionExercise.findMany.mockResolvedValue([])
    db.exerciseLog.findMany.mockResolvedValue([])
    expect((await buildSessionState('s', undefined, NOW))?.missingCount).toBe(0)
  })

  it('reports an unknown session, or one of another course when scoped, as not found', async () => {
    db.studySession.findUnique.mockResolvedValue(null)
    expect(await buildSessionState('x')).toBeNull()
    db.studySession.findUnique.mockResolvedValue(sessionRow)
    expect(await buildSessionState('s', 'c2')).toBeNull()
    expect(db.sessionExercise.findMany).not.toHaveBeenCalled()
  })
})

describe('getSessionStateFor', () => {
  it('finalizes an overdue exam with the stored drafts before reading it', async () => {
    db.studySession.findMany.mockResolvedValue([{ id: 's1' }])
    db.studySession.findUnique.mockResolvedValue(null) // clock check and state read: nothing more needed here
    await getSessionStateFor('s1', undefined, NOW)
    expect(db.studySession.findMany.mock.calls[0][0].where).toMatchObject({ id: 's1', status: 'active', mode: 'exam' })
    expect(tx.studySession.update).toHaveBeenCalledWith({ where: { id: 's1' }, data: { status: 'completed', endTime: NOW } })
  })

  it('starts the clock of a plan exam (no deadline yet) on first open, conditionally', async () => {
    db.studySession.findMany.mockResolvedValue([])
    db.sessionExercise.findMany.mockResolvedValue([])
    db.exerciseLog.findMany.mockResolvedValue([])
    db.studySession.findUnique.mockResolvedValue({ mode: 'exam', status: 'active', deadline: null, timeLimit: 600, startTime: NOW })
    await getSessionStateFor('s1', undefined, NOW)
    expect(db.studySession.updateMany).toHaveBeenCalledWith({
      where: { id: 's1', status: 'active', deadline: null },
      data: { deadline: at(600_000) },
    })
  })

  it('leaves a running clock alone', async () => {
    db.studySession.findMany.mockResolvedValue([])
    db.sessionExercise.findMany.mockResolvedValue([])
    db.exerciseLog.findMany.mockResolvedValue([])
    db.studySession.findUnique.mockResolvedValue({ mode: 'exam', status: 'active', deadline: NOW, timeLimit: 600, startTime: NOW })
    await getSessionStateFor('s1', undefined, NOW)
    expect(db.studySession.updateMany).not.toHaveBeenCalled()
  })
})

describe('getActiveSessionFor', () => {
  const cand = (over: Record<string, unknown>) => ({ id: 'x', studyPlanId: null, deadline: null, currentPosition: 0, _count: { logs: 0 }, items: [], ...over })

  it('returns null when there is no active session', async () => {
    db.studySession.findMany.mockResolvedValue([])
    expect(await getActiveSessionFor('c1', NOW)).toBeNull()
  })

  it('ignores an untouched plan session but takes one with a log, a draft/flag, a move or a clock', async () => {
    for (const touched of [{ _count: { logs: 1 } }, { items: [{ id: 'i' }] }, { currentPosition: 2 }, { deadline: NOW }]) {
      db.studySession.findMany.mockReset()
      db.studySession.findMany.mockResolvedValueOnce([]) // finalize
      db.studySession.findMany.mockResolvedValueOnce([cand({ id: 'plan', studyPlanId: 'p1', ...touched })])
      db.studySession.findUnique.mockResolvedValue(null)
      await getActiveSessionFor(undefined, NOW)
      expect(db.studySession.findUnique).toHaveBeenLastCalledWith(expect.objectContaining({ where: { id: 'plan' } }))
    }
    db.studySession.findMany.mockReset()
    db.studySession.findMany.mockResolvedValueOnce([])
    db.studySession.findMany.mockResolvedValueOnce([cand({ id: 'plan', studyPlanId: 'p1' })])
    expect(await getActiveSessionFor(undefined, NOW)).toBeNull()
  })

  it('takes the latest active non-plan session even when nothing was answered yet, and scopes by course', async () => {
    db.studySession.findMany.mockResolvedValueOnce([])
    db.studySession.findMany.mockResolvedValueOnce([cand({ id: 'plan', studyPlanId: 'p1' }), cand({ id: 'fresh' })])
    db.studySession.findUnique.mockResolvedValue(null)
    await getActiveSessionFor('c1', NOW)
    const q = db.studySession.findMany.mock.calls[1][0]
    expect(q.where).toMatchObject({ status: 'active', courseId: 'c1' })
    expect(q.orderBy).toEqual({ startTime: 'desc' })
    expect(db.studySession.findUnique).toHaveBeenLastCalledWith(expect.objectContaining({ where: { id: 'fresh' } }))
  })

  it('finalizes overdue exams of the scope first', async () => {
    db.studySession.findMany.mockResolvedValue([])
    await getActiveSessionFor('c1', NOW)
    expect(db.studySession.findMany.mock.calls[0][0].where).toMatchObject({ mode: 'exam', courseId: 'c1' })
  })
})

describe('saveDraftFor', () => {
  it('writes the draft only for an item of an active exam that is inside deadline + grace, in one conditional update', async () => {
    db.sessionExercise.updateMany.mockResolvedValue({ count: 1 })
    expect(await saveDraftFor('s', 'e', 'B', 4, NOW)).toEqual({ ok: true })
    const arg = db.sessionExercise.updateMany.mock.calls[0][0]
    expect(arg.where).toMatchObject({ sessionId: 's', exerciseId: 'e', session: { mode: 'exam', status: 'active' } })
    expect(arg.where.session.OR).toEqual([{ deadline: null }, { deadline: { gte: at(-EXAM_GRACE_MS) } }])
    expect(arg.data).toEqual({ draftAnswer: 'B', timeSpentSec: { increment: 4 } })
  })

  it('a draft that arrives just after the deadline is still saved; one after deadline + 30 s is rejected', async () => {
    // the DB filter is what decides; simulate its two outcomes
    db.sessionExercise.updateMany.mockResolvedValueOnce({ count: 1 })
    expect(await saveDraftFor('s', 'e', 'B', 0, NOW)).toEqual({ ok: true })
    db.sessionExercise.updateMany.mockResolvedValueOnce({ count: 0 })
    db.studySession.findUnique.mockResolvedValue({ status: 'active', mode: 'exam', deadline: NOW })
    expect(await saveDraftFor('s', 'e', 'B', 0, at(EXAM_GRACE_MS + 1))).toEqual({ ok: false, reason: 'deadline_passed' })
  })

  it('clears the draft with null or an empty string and does not touch time when the delta is 0', async () => {
    db.sessionExercise.updateMany.mockResolvedValue({ count: 1 })
    await saveDraftFor('s', 'e', null, 0, NOW)
    await saveDraftFor('s', 'e', '', 0, NOW)
    expect(db.sessionExercise.updateMany.mock.calls.map((c) => c[0].data)).toEqual([{ draftAnswer: null }, { draftAnswer: null }])
  })

  it('clamps the time delta', async () => {
    db.sessionExercise.updateMany.mockResolvedValue({ count: 1 })
    await saveDraftFor('s', 'e', 'x', 999_999, NOW)
    await saveDraftFor('s', 'e', 'x', -5, NOW)
    expect(db.sessionExercise.updateMany.mock.calls[0][0].data.timeSpentSec).toEqual({ increment: 3600 })
    expect(db.sessionExercise.updateMany.mock.calls[1][0].data).toEqual({ draftAnswer: 'x' })
  })

  it.each([
    ['not an item of the session', null, { status: 'active', mode: 'exam', deadline: null }, 'not_item'],
    ['session not found', null, null, 'not_found'],
    ['session completed', { id: 'i' }, { status: 'completed', mode: 'exam', deadline: null }, 'not_active'],
    ['session cancelled', { id: 'i' }, { status: 'cancelled', mode: 'exam', deadline: null }, 'not_active'],
    ['a study session', { id: 'i' }, { status: 'active', mode: 'study', deadline: null }, 'not_exam'],
  ])('does nothing and says why: %s', async (_name, item, session, reason) => {
    db.sessionExercise.updateMany.mockResolvedValue({ count: 0 })
    db.studySession.findUnique.mockResolvedValue(session)
    db.sessionExercise.findUnique.mockResolvedValue(item)
    expect(await saveDraftFor('s', 'e', 'A', 0, NOW)).toEqual({ ok: false, reason })
  })

  it('rejects malformed input without touching the database', async () => {
    expect(await saveDraftFor('s', 'e', 5 as unknown as string, 0, NOW)).toEqual({ ok: false, reason: 'invalid' })
    expect(await saveDraftFor(1 as unknown as string, 'e', 'A', 0, NOW)).toEqual({ ok: false, reason: 'invalid' })
    expect(db.sessionExercise.updateMany).not.toHaveBeenCalled()
  })
})

describe('setFlaggedFor and setCurrentPositionFor', () => {
  it('setFlagged applies only to an item of an active session', async () => {
    db.sessionExercise.updateMany.mockResolvedValueOnce({ count: 1 })
    expect(await setFlaggedFor('s', 'e', true, NOW)).toEqual({ ok: true })
    expect(db.sessionExercise.updateMany.mock.calls[0][0].where).toMatchObject({ sessionId: 's', exerciseId: 'e', session: { status: 'active' } })
    db.sessionExercise.updateMany.mockResolvedValueOnce({ count: 0 })
    db.studySession.findUnique.mockResolvedValue({ status: 'active', deadline: null })
    db.sessionExercise.findUnique.mockResolvedValue(null)
    expect(await setFlaggedFor('s', 'zzz', true, NOW)).toEqual({ ok: false, reason: 'not_item' })
    expect(await setFlaggedFor('s', 'e', 'yes' as unknown as boolean, NOW)).toEqual({ ok: false, reason: 'invalid' })
  })

  it('setCurrentPosition clamps into the session and writes only while active', async () => {
    db.studySession.findUnique.mockResolvedValue({ status: 'active', targetCount: 5, _count: { items: 3 } })
    db.studySession.updateMany.mockResolvedValue({ count: 1 })
    expect(await setCurrentPositionFor('s', 99, NOW)).toEqual({ ok: true })
    expect(db.studySession.updateMany.mock.calls[0][0].data).toEqual({ currentPosition: 4 })
    await setCurrentPositionFor('s', -3, NOW)
    expect(db.studySession.updateMany.mock.calls[1][0].data).toEqual({ currentPosition: 0 })
    expect(db.studySession.updateMany.mock.calls[0][0].where).toMatchObject({ id: 's', status: 'active' })
  })

  it('setCurrentPosition does nothing for a finished or unknown session', async () => {
    db.studySession.findUnique.mockResolvedValueOnce({ status: 'completed', targetCount: 5, _count: { items: 5 } })
    expect(await setCurrentPositionFor('s', 1, NOW)).toEqual({ ok: false, reason: 'not_active' })
    db.studySession.findUnique.mockResolvedValueOnce(null)
    expect(await setCurrentPositionFor('s', 1, NOW)).toEqual({ ok: false, reason: 'not_found' })
    expect(db.studySession.updateMany).not.toHaveBeenCalled()
  })
})

describe('logAnswerForSession', () => {
  const exercise = ex('e1', 'A')
  beforeEach(() => {
    tx.studySession.findUnique.mockResolvedValue({ status: 'active', mode: 'study' })
    tx.sessionExercise.findUnique.mockResolvedValue({ exercise })
    tx.exerciseLog.create.mockResolvedValue({})
  })

  it('grades on the server and stores the log for an item of an active study session', async () => {
    expect(await logAnswerForSession('s', 'e1', 'A', { duration: 12 })).toEqual({ score: 1, isCorrect: true })
    expect(tx.exerciseLog.create.mock.calls[0][0].data).toMatchObject({ sessionId: 's', exerciseId: 'e1', isCorrect: true, score: 1, duration: 12 })
    expect(tx.sessionExercise.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { sessionId_exerciseId: { sessionId: 's', exerciseId: 'e1' } } }))
  })

  it('writes nothing for an exercise that is not an item, a finished session, an exam or an unknown session', async () => {
    tx.sessionExercise.findUnique.mockResolvedValueOnce(null)
    expect(await logAnswerForSession('s', 'other', 'A')).toBeNull()
    for (const row of [{ status: 'completed', mode: 'study' }, { status: 'cancelled', mode: 'study' }, { status: 'active', mode: 'exam' }, null]) {
      tx.studySession.findUnique.mockResolvedValueOnce(row)
      expect(await logAnswerForSession('s', 'e1', 'A')).toBeNull()
    }
    expect(tx.exerciseLog.create).not.toHaveBeenCalled()
  })

  it('rejects a non-string answer', async () => {
    expect(await logAnswerForSession('s', 'e1', true as unknown as string)).toBeNull()
    expect(db.$transaction).not.toHaveBeenCalled()
  })

  it('swallows a unique violation (P2002) so the first attempt wins, and returns the stored result', async () => {
    db.$transaction.mockRejectedValueOnce(Object.assign(new Error('Unique'), { code: 'P2002' }))
    db.exerciseLog.findUnique.mockResolvedValue({ score: 0.5, isCorrect: false })
    expect(await logAnswerForSession('s', 'e1', 'B')).toEqual({ score: 0.5, isCorrect: false })
  })

  it('logs and returns null for any other error', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    db.$transaction.mockRejectedValueOnce(new Error('disk'))
    expect(await logAnswerForSession('s', 'e1', 'A')).toBeNull()
    expect(err).toHaveBeenCalled()
  })
})

describe('getSessionResultsFor', () => {
  it('returns every question in position order, with null for the unanswered one and no topic content', async () => {
    db.sessionExercise.findMany.mockResolvedValue([
      { position: 0, exercise: { id: 'a', questionText: 'QA', correctAnswer: 'A' } },
      { position: 1, exercise: { id: 'b', questionText: 'QB', correctAnswer: 'B' } },
    ])
    db.exerciseLog.findMany.mockResolvedValue([{ exerciseId: 'a', isCorrect: false, score: 0.5, userAnswer: 'X' }])
    const r = await getSessionResultsFor('s')
    expect(r.map((i) => [i.position, i.exerciseId, i.log])).toEqual([
      [0, 'a', { isCorrect: false, score: 0.5, userAnswer: 'X' }],
      [1, 'b', null],
    ])
    const sel = db.sessionExercise.findMany.mock.calls[0][0]
    expect(sel.orderBy).toEqual({ position: 'asc' })
    expect(sel.select.exercise.select).toEqual({ id: true, questionText: true, correctAnswer: true })
  })
})
