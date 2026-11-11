import { describe, it, expect, vi, beforeEach } from 'vitest'
import { generateObject } from 'ai'
import { prisma } from '@/lib/db'
import { generateNextForSession, appendToSession, resolveSessionTopicIds } from './sessionGeneration'

vi.mock('ai', () => ({ generateText: vi.fn(), generateObject: vi.fn() }))
vi.mock('@ai-sdk/google', () => ({ google: vi.fn(() => 'mocked-google-model') }))
vi.mock('@/lib/db', () => ({
  prisma: {
    course: { findUnique: vi.fn() },
    topic: { findUnique: vi.fn(), findMany: vi.fn() },
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(),
    exercise: { findMany: vi.fn(), create: vi.fn(), count: vi.fn() },
    studySession: { findUnique: vi.fn(), update: vi.fn() },
    sessionExercise: { findMany: vi.fn(), aggregate: vi.fn(), create: vi.fn() },
  },
}))

// The transaction body runs against the same mocked client
const tx = prisma as unknown as { $transaction: ReturnType<typeof vi.fn> }

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

const SESSION = { id: 's', status: 'active', courseId: 'c1', startTime: new Date(), topicIds: '["t1"]', targetCount: 5 }

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(Math, 'random').mockReturnValue(0.9)
  tx.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(prisma))
  vi.mocked(prisma.sessionExercise.findMany).mockResolvedValue([] as never)
  vi.mocked(prisma.sessionExercise.aggregate).mockResolvedValue({ _max: { position: 1 }, _count: { _all: 2 } } as never)
  vi.mocked(prisma.sessionExercise.create).mockResolvedValue({} as never)
})

describe('generateNextForSession: ended sessions', () => {
  it('returns stopped, with no model call and nothing appended, for a missing session', async () => {
    vi.mocked(prisma.studySession.findUnique).mockResolvedValue(null as never)
    expect(await generateNextForSession('gone')).toEqual({ stopped: true })
    expect(generateObject).not.toHaveBeenCalled()
    expect(prisma.exercise.create).not.toHaveBeenCalled()
    expect(prisma.sessionExercise.create).not.toHaveBeenCalled()
  })

  it.each(['completed', 'cancelled'])('returns stopped for a %s session', async (status) => {
    vi.mocked(prisma.studySession.findUnique).mockResolvedValue({ ...SESSION, status } as never)
    expect(await generateNextForSession('s')).toEqual({ stopped: true })
    expect(generateObject).not.toHaveBeenCalled()
    expect(prisma.sessionExercise.create).not.toHaveBeenCalled()
  })

  it('discards the question when the session ended during the generation (checked inside the append transaction)', async () => {
    setupTopics(['t1'])
    vi.mocked(prisma.studySession.findUnique)
      .mockResolvedValueOnce(SESSION as never)
      .mockResolvedValueOnce({ status: 'completed', targetCount: 5 } as never)
    vi.mocked(generateObject)
      .mockResolvedValueOnce({ object: gen } as never)
      .mockResolvedValueOnce({ object: solved } as never)
    vi.mocked(prisma.exercise.create).mockResolvedValue({ id: 'late' } as never)
    expect(await generateNextForSession('s')).toEqual({ stopped: true })
    expect(prisma.sessionExercise.create).not.toHaveBeenCalled()
  })

  it('appends a positional SessionExercise to an active session, strips the topic content, and never writes exerciseIds', async () => {
    setupTopics(['t1'])
    vi.mocked(prisma.studySession.findUnique).mockResolvedValue(SESSION as never)
    vi.mocked(prisma.sessionExercise.findMany).mockResolvedValue([{ exerciseId: 'a' }, { exerciseId: 'b' }] as never)
    vi.mocked(generateObject).mockResolvedValueOnce({ object: gen } as never).mockResolvedValueOnce({ object: solved } as never)
    vi.mocked(prisma.exercise.create).mockResolvedValue({ id: 'new', topic: { id: 't1', content: 'x'.repeat(100) } } as never)
    const res = await generateNextForSession('s')
    expect(res).toEqual({ exercise: { id: 'new', topic: { id: 't1', content: null } } })
    expect(prisma.sessionExercise.create).toHaveBeenCalledWith({ data: { sessionId: 's', exerciseId: 'new', position: 2 } })
    expect(prisma.studySession.update).not.toHaveBeenCalled()
  })

  it('reads the pool and the questions already in the session from the server, not from the caller', async () => {
    setupTopics(['t1'])
    vi.mocked(prisma.studySession.findUnique).mockResolvedValue({ ...SESSION, topicIds: '["t1"]' } as never)
    vi.mocked(prisma.sessionExercise.findMany).mockResolvedValue([{ exerciseId: 'a' }] as never)
    vi.mocked(generateObject).mockResolvedValueOnce({ object: gen } as never).mockResolvedValueOnce({ object: solved } as never)
    vi.mocked(prisma.exercise.create).mockResolvedValue({ id: 'new' } as never)
    await generateNextForSession('s')
    expect(prisma.sessionExercise.findMany).toHaveBeenCalledWith({ where: { sessionId: 's' }, select: { exerciseId: true } })
    expect(vi.mocked(prisma.exercise.create).mock.calls[0][0].data).toMatchObject({ topicId: 't1' })
  })
})

describe('resolveSessionTopicIds', () => {
  it('uses the stored selection', async () => {
    expect(await resolveSessionTopicIds({ id: 's', courseId: 'c1', topicIds: '["a","b"]' })).toEqual(['a', 'b'])
    expect(prisma.topic.findMany).not.toHaveBeenCalled()
  })

  it('an empty selection means every topic of the session course', async () => {
    vi.mocked(prisma.topic.findMany).mockResolvedValue([{ id: 'x' }, { id: 'y' }] as never)
    expect(await resolveSessionTopicIds({ id: 's', courseId: 'c1', topicIds: '[]' })).toEqual(['x', 'y'])
    expect(prisma.topic.findMany).toHaveBeenCalledWith({ where: { courseId: 'c1' }, select: { id: true } })
  })

  it('a legacy session without topicIds uses the topics of its own questions, never the whole database', async () => {
    vi.mocked(prisma.sessionExercise.findMany).mockResolvedValue([
      { exercise: { topicId: 't1' } }, { exercise: { topicId: 't2' } }, { exercise: { topicId: 't1' } },
    ] as never)
    expect(await resolveSessionTopicIds({ id: 's', courseId: 'c1', topicIds: null })).toEqual(['t1', 't2'])
    expect(prisma.topic.findMany).not.toHaveBeenCalled()
  })

  it('a legacy session with no questions has an empty pool (generation reports an error)', async () => {
    expect(await resolveSessionTopicIds({ id: 's', courseId: null, topicIds: null })).toEqual([])
    vi.mocked(prisma.studySession.findUnique).mockResolvedValue({ ...SESSION, topicIds: null } as never)
    expect(await generateNextForSession('s')).toEqual({ error: expect.stringContaining('No topics') })
    expect(generateObject).not.toHaveBeenCalled()
  })
})

describe('appendToSession', () => {
  it('uses position max + 1', async () => {
    vi.mocked(prisma.studySession.findUnique).mockResolvedValue({ status: 'active', targetCount: 5 } as never)
    vi.mocked(prisma.sessionExercise.aggregate).mockResolvedValue({ _max: { position: 6 }, _count: { _all: 3 } } as never)
    expect(await appendToSession('s', 'e')).toBe(true)
    expect(prisma.sessionExercise.create).toHaveBeenCalledWith({ data: { sessionId: 's', exerciseId: 'e', position: 7 } })
  })

  it('starts at position 0 for a session without questions', async () => {
    vi.mocked(prisma.studySession.findUnique).mockResolvedValue({ status: 'active', targetCount: 5 } as never)
    vi.mocked(prisma.sessionExercise.aggregate).mockResolvedValue({ _max: { position: null }, _count: { _all: 0 } } as never)
    await appendToSession('s', 'e')
    expect(prisma.sessionExercise.create).toHaveBeenCalledWith({ data: { sessionId: 's', exerciseId: 'e', position: 0 } })
  })

  it('retries once on a unique-constraint conflict and then appends after the other writer', async () => {
    vi.mocked(prisma.studySession.findUnique).mockResolvedValue({ status: 'active', targetCount: 9 } as never)
    vi.mocked(prisma.sessionExercise.aggregate)
      .mockResolvedValueOnce({ _max: { position: 1 }, _count: { _all: 2 } } as never)
      .mockResolvedValueOnce({ _max: { position: 2 }, _count: { _all: 3 } } as never)
    vi.mocked(prisma.sessionExercise.create)
      .mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }))
      .mockResolvedValueOnce({} as never)
    expect(await appendToSession('s', 'e')).toBe(true)
    expect(vi.mocked(prisma.sessionExercise.create).mock.calls.map((c) => (c[0] as { data: { position: number } }).data.position)).toEqual([2, 3])
  })

  it('gives up after a second conflict instead of looping', async () => {
    vi.mocked(prisma.studySession.findUnique).mockResolvedValue({ status: 'active', targetCount: 9 } as never)
    vi.mocked(prisma.sessionExercise.create).mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }))
    await expect(appendToSession('s', 'e')).rejects.toMatchObject({ code: 'P2002' })
    expect(prisma.sessionExercise.create).toHaveBeenCalledTimes(2)
  })

  it('appends nothing to a session that already holds its target number of questions', async () => {
    vi.mocked(prisma.studySession.findUnique).mockResolvedValue({ status: 'active', targetCount: 2 } as never)
    vi.mocked(prisma.sessionExercise.aggregate).mockResolvedValue({ _max: { position: 1 }, _count: { _all: 2 } } as never)
    expect(await appendToSession('s', 'e')).toBe(false)
    expect(prisma.sessionExercise.create).not.toHaveBeenCalled()
  })

  it('appends to a legacy session without a target', async () => {
    vi.mocked(prisma.studySession.findUnique).mockResolvedValue({ status: 'active', targetCount: null } as never)
    expect(await appendToSession('s', 'e')).toBe(true)
  })
})

describe('generateNextForSession: logistics topics', () => {
  it('moves on to another topic in the same request when the model flags the first one', async () => {
    setupTopics(['welcome', 'lecture'])
    vi.mocked(prisma.studySession.findUnique).mockResolvedValue({ ...SESSION, topicIds: JSON.stringify(['welcome', 'lecture']) } as never)
    vi.mocked(generateObject).mockImplementation((async (args: { prompt: string }) => {
      if (args.prompt.includes('You are a student taking a quiz')) return { object: solved }
      return { object: args.prompt.includes('Unit/Topic: welcome') ? logistics : gen }
    }) as never)
    vi.mocked(prisma.exercise.create).mockImplementation((async (a: { data: Record<string, unknown> }) => ({ ...a.data, topic: { id: a.data.topicId } })) as never)

    const res = await generateNextForSession('s')

    expect(res).toMatchObject({ exercise: { topicId: 'lecture', status: 'active' } })
    const markers = vi.mocked(prisma.exercise.create).mock.calls.map((c) => c[0].data as Record<string, unknown>).filter((d) => d.status === 'rejected')
    expect(markers).toHaveLength(1)
    expect(markers[0]).toMatchObject({ topicId: 'welcome', reportedReason: 'not_study_material: Exam rules.' })
  })

  it('gives a plain error when every selected topic is logistics', async () => {
    setupTopics(['welcome'])
    vi.mocked(prisma.studySession.findUnique).mockResolvedValue({ ...SESSION, topicIds: JSON.stringify(['welcome']) } as never)
    vi.mocked(generateObject).mockResolvedValue({ object: logistics } as never)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await generateNextForSession('s')
    expect(res).toEqual({ error: expect.stringContaining('rules or administration') })
    expect(generateObject).toHaveBeenCalledTimes(1)
    expect(prisma.sessionExercise.create).not.toHaveBeenCalled()
  })
})

describe('generateNextForSession: course scope', () => {
  it('treats a session stored under another course (or none) as stopped, with no model call', async () => {
    for (const courseId of ['c2', null]) {
      vi.mocked(prisma.studySession.findUnique).mockResolvedValue({ ...SESSION, courseId } as never)
      expect(await generateNextForSession('s', 'c1')).toEqual({ stopped: true })
    }
    expect(generateObject).not.toHaveBeenCalled()
    expect(prisma.sessionExercise.create).not.toHaveBeenCalled()
  })

  it('rejects topics of another course with a plain error and no model call', async () => {
    vi.mocked(prisma.studySession.findUnique).mockResolvedValue({ ...SESSION, topicIds: '["t1","t2"]' } as never)
    vi.mocked(prisma.topic.findMany).mockResolvedValue([{ id: 't1' }] as never) // only t1 is in c1
    const res = await generateNextForSession('s', 'c1')
    expect(res).toEqual({ error: expect.stringMatching(/do not belong/) })
    expect(vi.mocked(prisma.topic.findMany).mock.calls[0][0]).toMatchObject({ where: { id: { in: ['t1', 't2'] }, courseId: 'c1' } })
    expect(generateObject).not.toHaveBeenCalled()
  })

  it('does not check anything extra without a scope', async () => {
    vi.mocked(prisma.studySession.findUnique).mockResolvedValue({ id: 's', status: 'completed', courseId: 'c9', startTime: new Date() } as never)
    expect(await generateNextForSession('s')).toEqual({ stopped: true })
    expect(prisma.topic.findMany).not.toHaveBeenCalled()
  })
})
