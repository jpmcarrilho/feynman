import { describe, it, expect, vi, beforeEach } from 'vitest'

const { prismaMock, eligible } = vi.hoisted(() => ({
  prismaMock: { exercise: { findFirst: vi.fn() }, topic: { findMany: vi.fn() } },
  eligible: vi.fn(),
}))
vi.mock('@/lib/db', () => ({ prisma: prismaMock }))
vi.mock('@/services/exerciseGenerator', () => ({ filterGeneratableTopicIds: eligible }))

import { checkSessionStartable, NOT_STARTABLE_MESSAGE } from './sessionStartCheck'

const input = { courseId: 'c1', topicIds: ['t1', 't2'], count: 10, sourcingMix: 50 }

beforeEach(() => {
  vi.clearAllMocks()
  prismaMock.exercise.findFirst.mockResolvedValue(null)
  prismaMock.topic.findMany.mockResolvedValue([{ id: 't1' }, { id: 't2' }])
  eligible.mockResolvedValue([])
})

describe('checkSessionStartable', () => {
  it('is startable when a stored graded, active question exists in the pool (no eligibility query)', async () => {
    prismaMock.exercise.findFirst.mockResolvedValue({ id: 'e1' })
    expect(await checkSessionStartable(input)).toEqual({ startable: true })
    expect(prismaMock.exercise.findFirst.mock.calls[0][0]).toMatchObject({ where: { topicId: { in: ['t1', 't2'] }, isGraded: true, status: 'active' } })
    expect(eligible).not.toHaveBeenCalled()
  })

  it('is startable by generation when some topic is eligible', async () => {
    eligible.mockResolvedValue(['t2'])
    expect(await checkSessionStartable(input)).toEqual({ startable: true })
    expect(eligible).toHaveBeenCalledWith(['t1', 't2'])
  })

  it('is not startable when there is nothing stored and no topic can be generated from (logistics, ungraded, no content)', async () => {
    expect(await checkSessionStartable(input)).toEqual({ startable: false, message: NOT_STARTABLE_MESSAGE })
  })

  it('does not count stored questions the sourcing mix leaves no room for (100% generated)', async () => {
    prismaMock.exercise.findFirst.mockResolvedValue({ id: 'e1' })
    expect(await checkSessionStartable({ ...input, sourcingMix: 100 })).toEqual({ startable: false, message: NOT_STARTABLE_MESSAGE })
    expect(prismaMock.exercise.findFirst).not.toHaveBeenCalled()
  })

  it('an empty selection means the whole course', async () => {
    eligible.mockResolvedValue(['t1'])
    expect(await checkSessionStartable({ ...input, topicIds: [] })).toEqual({ startable: true })
    expect(prismaMock.exercise.findFirst.mock.calls[0][0]).toMatchObject({ where: { topic: { courseId: 'c1' }, isGraded: true, status: 'active' } })
    expect(prismaMock.topic.findMany.mock.calls[0][0]).toMatchObject({ where: { courseId: 'c1' } })
  })

  it('a course with no topics at all is not startable', async () => {
    prismaMock.topic.findMany.mockResolvedValue([])
    expect(await checkSessionStartable({ ...input, topicIds: [] })).toMatchObject({ startable: false })
    expect(eligible).not.toHaveBeenCalled()
  })
})
