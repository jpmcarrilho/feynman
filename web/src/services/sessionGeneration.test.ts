import { describe, it, expect, vi, beforeEach } from 'vitest'
import { generateObject } from 'ai'
import { prisma } from '@/lib/db'
import { generateNextForSession } from './sessionGeneration'

vi.mock('ai', () => ({ generateText: vi.fn(), generateObject: vi.fn() }))
vi.mock('@ai-sdk/google', () => ({ google: vi.fn(() => 'mocked-google-model') }))
vi.mock('@/lib/db', () => ({
  prisma: {
    course: { findUnique: vi.fn() },
    topic: { findUnique: vi.fn(), findMany: vi.fn() },
    $queryRaw: vi.fn().mockResolvedValue([]),
    exercise: { findMany: vi.fn(), create: vi.fn(), count: vi.fn() },
    studySession: { findUnique: vi.fn(), update: vi.fn() },
  },
}))

const topic = (id: string) => ({ id, title: id, courseId: 'c1', week: 'W1', content: 'body', order: 1, summary: null, isQuantitative: false })
const gen = { newExercise: { contentKind: 'subject_matter', logisticsReason: '', questionText: 'Q?', exerciseType: 'single_choice', choices: ['A', 'B', 'C', 'D'], correctAnswer: 'A', explanation: 'E' } }
const logistics = { newExercise: { contentKind: 'logistics', logisticsReason: 'Exam rules.', questionText: '', exerciseType: 'single_choice', choices: [], correctAnswer: '', explanation: '' } }
const solved = { answerable: true, issue: '', answer: ['A'] }

function setupTopics(ids: string[]) {
  vi.mocked(prisma.topic.findUnique).mockImplementation((async (a: { where: { id: string } }) => topic(a.where.id)) as never)
  vi.mocked(prisma.topic.findMany).mockResolvedValue(ids.map(topic) as never)
  vi.mocked(prisma.exercise.findMany).mockResolvedValue([] as never)
  vi.mocked(prisma.exercise.count).mockResolvedValue(0 as never)
  vi.mocked(prisma.course.findUnique).mockResolvedValue(null as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(Math, 'random').mockReturnValue(0.9)
})

describe('generateNextForSession: ended sessions', () => {
  it('returns stopped, with no model call and nothing appended, for a missing session', async () => {
    vi.mocked(prisma.studySession.findUnique).mockResolvedValue(null as never)
    expect(await generateNextForSession('gone', ['t1'], [])).toEqual({ stopped: true })
    expect(generateObject).not.toHaveBeenCalled()
    expect(prisma.exercise.create).not.toHaveBeenCalled()
    expect(prisma.studySession.update).not.toHaveBeenCalled()
  })

  it.each(['completed', 'cancelled'])('returns stopped for a %s session', async (status) => {
    vi.mocked(prisma.studySession.findUnique).mockResolvedValue({ id: 's', status, startTime: new Date(), exerciseIds: '[]' } as never)
    expect(await generateNextForSession('s', ['t1'], [])).toEqual({ stopped: true })
    expect(generateObject).not.toHaveBeenCalled()
    expect(prisma.studySession.update).not.toHaveBeenCalled()
  })

  it('discards the question when the session ended during the generation', async () => {
    setupTopics(['t1'])
    vi.mocked(prisma.studySession.findUnique)
      .mockResolvedValueOnce({ id: 's', status: 'active', startTime: new Date(), exerciseIds: '["a","b"]' } as never)
      .mockResolvedValueOnce({ id: 's', status: 'completed', startTime: new Date(), exerciseIds: '["a","b"]' } as never)
    vi.mocked(generateObject)
      .mockResolvedValueOnce({ object: gen } as never)
      .mockResolvedValueOnce({ object: solved } as never)
    vi.mocked(prisma.exercise.create).mockResolvedValue({ id: 'late' } as never)
    expect(await generateNextForSession('s', ['t1'], ['a', 'b'])).toEqual({ stopped: true })
    expect(prisma.studySession.update).not.toHaveBeenCalled()
  })

  it('appends to an active session and strips the topic content from the result', async () => {
    setupTopics(['t1'])
    vi.mocked(prisma.studySession.findUnique).mockResolvedValue({ id: 's', status: 'active', startTime: new Date(), exerciseIds: '["a"]' } as never)
    vi.mocked(generateObject).mockResolvedValueOnce({ object: gen } as never).mockResolvedValueOnce({ object: solved } as never)
    vi.mocked(prisma.exercise.create).mockResolvedValue({ id: 'new', topic: { id: 't1', content: 'x'.repeat(100) } } as never)
    const res = await generateNextForSession('s', ['t1'], ['a'])
    expect(res).toEqual({ exercise: { id: 'new', topic: { id: 't1', content: null } } })
    expect(prisma.studySession.update).toHaveBeenCalledWith({ where: { id: 's' }, data: { exerciseIds: '["a","new"]' } })
  })
})

describe('generateNextForSession: logistics topics', () => {
  it('moves on to another topic in the same request when the model flags the first one', async () => {
    setupTopics(['welcome', 'lecture'])
    vi.mocked(prisma.studySession.findUnique).mockResolvedValue({ id: 's', status: 'active', startTime: new Date(), exerciseIds: '[]' } as never)
    vi.mocked(generateObject).mockImplementation((async (args: { prompt: string }) => {
      if (args.prompt.includes('You are a student taking a quiz')) return { object: solved }
      return { object: args.prompt.includes('Unit/Topic: welcome') ? logistics : gen }
    }) as never)
    vi.mocked(prisma.exercise.create).mockImplementation((async (a: { data: Record<string, unknown> }) => ({ ...a.data, topic: { id: a.data.topicId } })) as never)

    const res = await generateNextForSession('s', ['welcome', 'lecture'], [])

    expect(res).toMatchObject({ exercise: { topicId: 'lecture', status: 'active' } })
    const markers = vi.mocked(prisma.exercise.create).mock.calls.map((c) => c[0].data as Record<string, unknown>).filter((d) => d.status === 'rejected')
    expect(markers).toHaveLength(1)
    expect(markers[0]).toMatchObject({ topicId: 'welcome', reportedReason: 'not_study_material: Exam rules.' })
  })

  it('gives a plain error when every selected topic is logistics', async () => {
    setupTopics(['welcome'])
    vi.mocked(prisma.studySession.findUnique).mockResolvedValue({ id: 's', status: 'active', startTime: new Date(), exerciseIds: '[]' } as never)
    vi.mocked(generateObject).mockResolvedValue({ object: logistics } as never)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await generateNextForSession('s', ['welcome'], [])
    expect(res).toEqual({ error: expect.stringContaining('rules or administration') })
    expect(generateObject).toHaveBeenCalledTimes(1)
    expect(prisma.studySession.update).not.toHaveBeenCalled()
  })
})
