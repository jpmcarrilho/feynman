import { describe, it, expect, vi, beforeEach } from 'vitest'
import { prisma } from '@/lib/db'
import { createSessionSummary } from './summaryService'

vi.mock('ai', () => ({ generateText: vi.fn() }))
vi.mock('@ai-sdk/google', () => ({ google: vi.fn(() => 'mocked-google-model') }))
vi.mock('@/lib/db', () => ({
  prisma: {
    studySession: { findUnique: vi.fn() },
    exercise: { findMany: vi.fn() },
    sessionExercise: { findMany: vi.fn() },
    course: { findUnique: vi.fn() },
    topic: { findMany: vi.fn() },
  },
}))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('createSessionSummary course scope', () => {
  it('reports a session stored under another course as not found', async () => {
    vi.mocked(prisma.studySession.findUnique).mockResolvedValue({ id: 's1', courseId: 'c2', logs: [] } as never)
    await expect(createSessionSummary('s1', 'c1')).rejects.toThrow('Session not found')
    expect(prisma.exercise.findMany).not.toHaveBeenCalled()
  })

  it('covers only the exercises of the course when scoped, and all of them otherwise', async () => {
    vi.mocked(prisma.studySession.findUnique).mockResolvedValue({ id: 's1', courseId: 'c1', logs: [] } as never)
    vi.mocked(prisma.sessionExercise.findMany).mockResolvedValue([{ exerciseId: 'e1' }, { exerciseId: 'e2' }] as never)
    vi.mocked(prisma.exercise.findMany).mockResolvedValue([] as never)
    // no exercise has a module, so no guide is built; the queries are what matters here
    await createSessionSummary('s1', 'c1').catch(() => {})
    expect(vi.mocked(prisma.exercise.findMany).mock.calls[0][0]).toMatchObject({ where: { id: { in: ['e1', 'e2'] }, topic: { courseId: 'c1' } } })
    await createSessionSummary('s1').catch(() => {})
    expect(vi.mocked(prisma.exercise.findMany).mock.calls[1][0]).toMatchObject({ where: { id: { in: ['e1', 'e2'] } } })
    expect((vi.mocked(prisma.exercise.findMany).mock.calls[1][0] as { where: object }).where).not.toHaveProperty('topic')
  })

  it('reads the session questions from SessionExercise, not from the legacy exerciseIds column', async () => {
    vi.mocked(prisma.studySession.findUnique).mockResolvedValue({ id: 's1', courseId: 'c1', exerciseIds: '["old"]', logs: [] } as never)
    vi.mocked(prisma.sessionExercise.findMany).mockResolvedValue([{ exerciseId: 'new' }] as never)
    vi.mocked(prisma.exercise.findMany).mockResolvedValue([] as never)
    await createSessionSummary('s1').catch(() => {})
    expect(prisma.sessionExercise.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { sessionId: 's1' } }))
    expect(vi.mocked(prisma.exercise.findMany).mock.calls[0][0]).toMatchObject({ where: { id: { in: ['new'] } } })
  })

  it('reports a session without questions', async () => {
    vi.mocked(prisma.studySession.findUnique).mockResolvedValue({ id: 's1', courseId: null, logs: [] } as never)
    vi.mocked(prisma.sessionExercise.findMany).mockResolvedValue([] as never)
    await expect(createSessionSummary('s1')).rejects.toThrow('No exercises configured')
  })
})
