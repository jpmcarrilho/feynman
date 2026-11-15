import { describe, it, expect, vi, beforeEach } from 'vitest'

const { prismaMock, finalize } = vi.hoisted(() => ({
  prismaMock: {
    $queryRaw: vi.fn(),
    course: { findMany: vi.fn(), updateMany: vi.fn() },
    studySession: { findMany: vi.fn(), findFirst: vi.fn() },
  },
  finalize: vi.fn(),
}))
vi.mock('@/lib/db', () => ({ prisma: prismaMock }))
vi.mock('@/services/sessionService', () => ({ finalizeOverdueExams: finalize }))

import { listSpaceSummaries, getOverallDiagnosis, renameCourse } from './spaceSummaries'

const course = (id: string, over: Record<string, unknown> = {}) => ({
  id, code: id, title: `Title ${id}`, goal: null, description: 'Auto-generated course for X', createdAt: new Date('2026-08-01T00:00:00Z'), ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  prismaMock.course.findMany.mockResolvedValue([course('A'), course('B', { goal: ' Learn B ' })])
  // topics, questions, logs, in the order the service issues them
  prismaMock.$queryRaw
    .mockResolvedValueOnce([{ courseId: 'A', topics: BigInt(376), modules: BigInt(16) }, { courseId: 'B', topics: 946, modules: 18 }])
    .mockResolvedValueOnce([{ courseId: 'A', n: BigInt(700) }])
    .mockResolvedValueOnce([{ courseId: 'A', n: BigInt(4), points: 3, lastStart: '2026-11-10T12:00:00.000+00:00' }])
  prismaMock.studySession.findMany.mockResolvedValue([])
})

describe('listSpaceSummaries', () => {
  it('computes every card from four aggregate queries, whatever the number of topics', async () => {
    const result = await listSpaceSummaries()
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(3)
    expect(prismaMock.course.findMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.studySession.findMany).toHaveBeenCalledTimes(1)
    const [a, b] = result
    expect(a).toMatchObject({ id: 'A', topicCount: 376, moduleCount: 16, questionCount: 700, answeredCount: 4, accuracy: 75, lastStudiedAt: '2026-11-10T12:00:00.000Z', goal: null, hasActiveSession: false })
    // a studyspace with no questions, answers or sessions yet
    expect(b).toMatchObject({ id: 'B', topicCount: 946, moduleCount: 18, questionCount: 0, answeredCount: 0, accuracy: null, lastStudiedAt: null, goal: 'Learn B' })
  })

  it('finalizes overdue exams first so "in progress" is not claimed for a dead exam', async () => {
    await listSpaceSummaries()
    expect(finalize).toHaveBeenCalledTimes(1)
    expect(finalize.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.course.findMany.mock.invocationCallOrder[0])
  })

  it('flags a studyspace with a session getActiveSession would resume, not an untouched plan slot', async () => {
    prismaMock.studySession.findMany.mockResolvedValue([
      { courseId: 'A', studyPlanId: 'plan', deadline: null, currentPosition: 0, _count: { logs: 0 }, items: [] },
      { courseId: 'B', studyPlanId: null, deadline: null, currentPosition: 0, _count: { logs: 0 }, items: [] },
    ])
    const result = await listSpaceSummaries()
    expect(result.map((s) => [s.id, s.hasActiveSession])).toEqual([['A', false], ['B', true]])
  })

  it('does not present the auto-generated description as a goal but keeps a real one', async () => {
    prismaMock.course.findMany.mockResolvedValue([course('A'), course('B', { description: 'About B' })])
    const result = await listSpaceSummaries()
    expect(result.map((s) => s.goal)).toEqual([null, 'About B'])
  })
})

describe('other helpers', () => {
  it('getOverallDiagnosis reads only the course-less diagnosis row', async () => {
    prismaMock.studySession.findFirst.mockResolvedValue({ diagnosis: '# Report' })
    expect(await getOverallDiagnosis()).toBe('# Report')
    expect(prismaMock.studySession.findFirst).toHaveBeenCalledWith({ where: { mode: 'global_diagnosis', courseId: null }, select: { diagnosis: true } })
    prismaMock.studySession.findFirst.mockResolvedValue(null)
    expect(await getOverallDiagnosis()).toBeNull()
  })

  it('renameCourse reports whether a row was changed', async () => {
    prismaMock.course.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 })
    expect(await renameCourse('A', 'New')).toBe(true)
    expect(await renameCourse('zzz', 'New')).toBe(false)
  })
})
