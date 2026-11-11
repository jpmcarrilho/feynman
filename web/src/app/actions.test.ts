import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { explainMistake, generateNextExercise, getTopics, getTopicsWithPerformance, getAnalyticsData, generateGlobalDiagnosis, saveAndDeployStudyPlan, generateStructuredStudyPlan, generatePlannerResponse, generateSessionSummary, getCourseArtifacts, getSessionHistory, getSessionDetail, getStudyPlans, startSession, checkSessionStartable, getPreviousLectureTranscripts, deleteStudySession, saveChatLog, deleteStudyPlan, logAnswer, recordCardTime, cancelStudySession, finishStudySession, saveDraft, setFlagged, setCurrentPosition, getActiveSession, getSessionState, reportExercise } from './actions'
import { generateText, generateObject } from 'ai'
import { prisma } from '@/lib/db'
import { defaultProfile } from '@/lib/studyspace/profile'
import { GENERATE_EXERCISE_PROMPT_VERSION } from '@/lib/prompts'
import { enrichInBackground } from '@/services/enrichment'
import { createSessionSummary } from '@/services/summaryService'
import { getCourseArtifactsService } from '@/services/artifactsService'
import { createSessionWithItems, endPreviousActiveSessions, getSessionStateFor, finalizeOverdueExams, logAnswerForSession, completeSession, cancelSession, saveDraftFor, recordStudyTimeFor, setCurrentPositionFor, getActiveSessionFor } from '@/services/sessionService'

/** startSession input with the defaults the old positional createStudySession had. */
const si = (over: Partial<Parameters<typeof startSession>[0]> = {}): Parameters<typeof startSession>[0] => ({
  topicIds: [], count: 1, mode: 'study', timeLimit: null, sourcingMix: 0, weakPct: 60, unstudiedPct: 20, expertPct: 20, ...over,
})

// Auth: requireAuth always resolves in these tests
vi.mock('@/server/auth', () => ({
  requireAuth: vi.fn(async () => {}),
}))

// Enrichment runs in the background after session start; its own tests are in services/enrichment.test.ts
vi.mock('@/services/enrichment', () => ({
  enrichInBackground: vi.fn(),
  isBackgroundEnrichmentEnabled: vi.fn(() => process.env.ENRICH_IN_BACKGROUND === '1'),
}))

// Mock the AI SDK
vi.mock('ai', () => ({
  generateText: vi.fn(),
  generateObject: vi.fn(),
}))

// The session store is covered by services/sessionService.test.ts; here only what the actions pass to it matters.
// Reads that would add queries to the mocked client (overdue-exam finalization) are stubbed so call indexes stay put.
vi.mock('@/services/sessionService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/sessionService')>()
  return {
    ...actual,
    finalizeOverdueExams: vi.fn(async () => 0),
    endPreviousActiveSessions: vi.fn(async () => []),
    createSessionWithItems: vi.fn(async (input: Record<string, unknown>) => ({ id: 's1', ...input })),
    getSessionStateFor: vi.fn(async (id: string) => ({ session: { id }, items: [], missingCount: 0, serverNow: 'now' })),
    getActiveSessionFor: vi.fn(async () => null),
    saveDraftFor: vi.fn(async () => ({ ok: true })),
    recordStudyTimeFor: vi.fn(async () => ({ ok: true })),
    setFlaggedFor: vi.fn(async () => ({ ok: true })),
    setCurrentPositionFor: vi.fn(async () => ({ ok: true })),
    logAnswerForSession: vi.fn(async () => null),
    completeSession: vi.fn(async () => true),
    cancelSession: vi.fn(async () => true),
  }
})

// startSession's "can anything be shown" check is covered in sessionStartCheck.test.ts; here it passes unless a test says otherwise
const { startCheck } = vi.hoisted(() => ({ startCheck: vi.fn(async () => ({ startable: true })) }))
vi.mock('@/services/sessionStartCheck', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/sessionStartCheck')>()),
  checkSessionStartable: startCheck,
}))
vi.mock('@/services/summaryService', () => ({ createSessionSummary: vi.fn() }))
vi.mock('@/services/artifactsService', () => ({ getCourseArtifactsService: vi.fn(async () => []), generateWeekSummaryService: vi.fn() }))

vi.mock('@ai-sdk/google', () => ({
  google: vi.fn(() => 'mocked-google-model'),
}))

// Mock the database client
vi.mock('@/lib/db', () => {
  const prisma: Record<string, unknown> = {
    course: {
      findUnique: vi.fn(),
    },
    topic: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    $queryRaw: vi.fn().mockResolvedValue([]),
    exercise: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    studyPlan: {
      findMany: vi.fn(),
      delete: vi.fn(),
      create: vi.fn(),
    },
    sessionExercise: {
      deleteMany: vi.fn(),
      findMany: vi.fn(),
      aggregate: vi.fn(),
      create: vi.fn(),
    },
    studySession: {
      deleteMany: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    exerciseLog: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
  }
  // interactive transactions run against the same mocked client; array transactions resolve their operations
  prisma.$transaction = vi.fn(async (ops: unknown) => (typeof ops === 'function' ? (ops as (t: unknown) => unknown)(prisma) : Promise.all(ops as Promise<unknown>[])))
  return { prisma }
})

let randomSpy: any;

beforeEach(() => {
  vi.clearAllMocks();
  startCheck.mockResolvedValue({ startable: true })
  randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.9); // stable random
})

afterEach(() => {
  randomSpy.mockRestore();
})

describe('explainMistake action', () => {
  it('calls generateText with the constructed prompt and returns text', async () => {
    const mockExplanation = 'This is the AI explanation.'
    vi.mocked(generateText).mockResolvedValueOnce({ text: mockExplanation } as any)

    const result = await explainMistake({
      questionText: 'What is 2+2?',
      choices: ['3', '4', '5'],
      correctAnswer: '4',
      userAnswer: '5',
      explanation: 'Basic math.',
      topicTitle: 'Math 101'
    })

    expect(generateText).toHaveBeenCalledTimes(1)

    const callArgs = vi.mocked(generateText).mock.calls[0][0]
    expect(callArgs.prompt).toContain('What is 2+2?')
    expect(callArgs.prompt).toContain('Student\'s Answer: 5')

    expect(result).toBe(mockExplanation)
  })

  it('builds the persona from the profile of the topic course when topicId is given', async () => {
    vi.mocked(generateText).mockResolvedValueOnce({ text: 'ok' } as never)
    vi.mocked(prisma.topic.findUnique).mockResolvedValueOnce({ courseId: 'course-x' } as never)
    vi.mocked(prisma.course.findUnique).mockResolvedValueOnce({
      id: 'course-x',
      code: 'chem1',
      title: 'Organic chemistry',
      profile: null,
    } as never)

    await explainMistake({ questionText: 'Q?', choices: ['a'], correctAnswer: 'a', userAnswer: 'b', topicId: 'topic-x' })

    const prompt = vi.mocked(generateText).mock.calls[0][0].prompt as string
    // No stored profile and not a legacy code: the neutral default for the course title
    expect(prompt).toContain('You are a patient and rigorous tutor for Organic chemistry.')
    expect(prompt).not.toContain('MIT')
  })

  it('handles errors gracefully', async () => {
    vi.mocked(generateText).mockRejectedValueOnce(new Error('API Error'))

    const result = await explainMistake({
      questionText: 'What is 2+2?',
      choices: ['3', '4', '5'],
      correctAnswer: '4',
      userAnswer: '5'
    })

    expect(result).toContain('Sorry, I encountered an error')
  })
})

const sessionRow = (topicIds: string[] | null, extra: Record<string, unknown> = {}) =>
  ({ id: 'session-1', status: 'active', courseId: 'course-1', startTime: new Date('2026-11-11T10:00:00Z'), topicIds: topicIds === null ? null : JSON.stringify(topicIds), targetCount: 5, ...extra })

describe('generateNextExercise action', () => {
  beforeEach(() => {
    vi.mocked(prisma.sessionExercise.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.sessionExercise.aggregate).mockResolvedValue({ _max: { position: 0 }, _count: { _all: 1 } } as never)
    vi.mocked(prisma.sessionExercise.create).mockResolvedValue({} as never)
  })

  it('successfully generates next exercise and updates study session with targetTopicId', async () => {
    const mockTopic = { id: 'topic-1', title: 'Target Topic', courseId: 'course-1', week: 'week-1', content: 'Some content' }
    vi.mocked(prisma.topic.findUnique).mockResolvedValueOnce(mockTopic as any)
    vi.mocked(prisma.topic.findMany).mockResolvedValue([mockTopic] as any)
    vi.mocked(prisma.exercise.findMany).mockResolvedValue([] as any)
    vi.mocked(prisma.exercise.count).mockResolvedValue(0 as never)

    const mockGeneratedObject = {
      newExercise: {
        contentKind: 'subject_matter',
        logisticsReason: '',
        questionText: 'Test generated question?',
        exerciseType: 'single_choice',
        choices: ['A', 'B', 'C', 'D'],
        correctChoiceIndexes: [0],
        correctAnswer: '',
        explanation: 'Because it is correct.'
      }
    }
    vi.mocked(generateObject).mockResolvedValueOnce({ object: mockGeneratedObject } as any)
    // the blind solve (second call) answers correctly
    vi.mocked(generateObject).mockResolvedValueOnce({ object: { answerable: true, issue: '', answer: ['A'] } } as never)

    const mockCreatedExercise = {
      id: 'ex-new',
      topicId: 'topic-1',
      questionText: 'Test generated question?',
      exerciseType: 'single_choice',
      choices: JSON.stringify(['A', 'B', 'C', 'D']),
      correctAnswer: 'A',
      explanation: 'Because it is correct.'
    }
    vi.mocked(prisma.exercise.create).mockResolvedValueOnce(mockCreatedExercise as any)

    vi.mocked(prisma.studySession.findUnique).mockResolvedValue(sessionRow(['topic-1']) as never)
    vi.mocked(prisma.sessionExercise.findMany).mockResolvedValue([{ exerciseId: 'ex-old' }] as never)

    const result = await generateNextExercise('session-1')

    // Verify it picked the correct target topic ID (topic-1)
    expect(prisma.topic.findUnique).toHaveBeenCalledWith({
      where: { id: 'topic-1' }
    })

    // Verify prisma.exercise.create was called with targetTopicId
    expect(prisma.exercise.create).toHaveBeenCalledWith({
      data: {
        id: expect.stringMatching(/^gen-/),
        topicId: 'topic-1',
        questionText: 'Test generated question?',
        exerciseType: 'single_choice',
        choices: JSON.stringify(['A', 'B', 'C', 'D']),
        correctAnswer: 'A',
        explanation: 'Because it is correct.',
        origin: 'generated',
        status: 'active',
        promptVersion: GENERATE_EXERCISE_PROMPT_VERSION,
      },
      include: { topic: true }
    })

    // The question is appended as the next positional item; the legacy exerciseIds column is not written
    expect(prisma.sessionExercise.create).toHaveBeenCalledWith({ data: { sessionId: 'session-1', exerciseId: 'ex-new', position: 1 } })
    expect(prisma.studySession.update).not.toHaveBeenCalled()

    expect(result).toEqual({ exercise: mockCreatedExercise })
  })

  it('stops targeting a topic once 3 of its questions were rejected in this session, without calling the model', async () => {
    const mockTopic = { id: 'topic-1', title: 'Target Topic', courseId: 'course-1', week: 'week-1', content: 'Some content' }
    vi.mocked(prisma.topic.findUnique).mockResolvedValue(mockTopic as never)
    vi.mocked(prisma.topic.findMany).mockResolvedValue([mockTopic] as never)
    vi.mocked(prisma.studySession.findUnique).mockResolvedValue(sessionRow(['topic-1']) as never)
    vi.mocked(prisma.exercise.findMany).mockImplementation((async (args: { where?: { status?: unknown } }) =>
      args?.where?.status === 'rejected' && !(args.where as Record<string, unknown>).reportedReason ? [{ topicId: 'topic-1' }, { topicId: 'topic-1' }, { topicId: 'topic-1' }] : []) as never)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await generateNextExercise('session-1')

    expect(result).toEqual({ error: expect.stringContaining('quality checks'), retryable: false })
    expect(generateObject).not.toHaveBeenCalled()
    // Only rejected rows created since the session started are counted
    expect(prisma.exercise.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: 'rejected', createdAt: { gte: new Date('2026-11-11T10:00:00Z') } }),
    }))
  })

  it('still targets the other topics when one topic reached the rejection limit', async () => {
    const t1 = { id: 'topic-1', title: 'Bad', courseId: 'course-1', week: 'week-1', content: 'x' }
    const t2 = { id: 'topic-2', title: 'Good', courseId: 'course-1', week: 'week-1', content: 'y' }
    vi.mocked(prisma.topic.findUnique).mockImplementation((async (args: { where: { id: string } }) => (args.where.id === 'topic-1' ? t1 : t2)) as never)
    vi.mocked(prisma.topic.findMany).mockResolvedValue([t1, t2] as never)
    vi.mocked(prisma.studySession.findUnique).mockResolvedValue(sessionRow(['topic-1', 'topic-2']) as never)
    vi.mocked(prisma.exercise.findMany).mockImplementation((async (args: { where?: { status?: unknown } }) =>
      args?.where?.status === 'rejected' && !(args.where as Record<string, unknown>).reportedReason ? [{ topicId: 'topic-1' }, { topicId: 'topic-1' }, { topicId: 'topic-1' }] : []) as never)
    vi.mocked(prisma.exercise.count).mockResolvedValue(0 as never)
    vi.mocked(generateObject)
      .mockResolvedValueOnce({ object: { newExercise: { contentKind: 'subject_matter', logisticsReason: '', questionText: 'Q?', exerciseType: 'single_choice', choices: ['A', 'B', 'C', 'D'], correctChoiceIndexes: [0], correctAnswer: '', explanation: 'E' } } } as never)
      .mockResolvedValueOnce({ object: { answerable: true, issue: '', answer: ['A'] } } as never)
    vi.mocked(prisma.exercise.create).mockResolvedValue({ id: 'ex-new' } as never)

    const result = await generateNextExercise('session-1')

    expect(result).toEqual({ exercise: { id: 'ex-new' } })
    expect(vi.mocked(prisma.exercise.create).mock.calls[0][0].data).toMatchObject({ topicId: 'topic-2' })
  })

  it('stops generating for the whole session after 9 rejected questions', async () => {
    const mockTopic = { id: 'topic-1', title: 'T', courseId: 'course-1', week: 'week-1', content: 'c' }
    const mockTopic2 = { ...mockTopic, id: 'topic-2' }
    vi.mocked(prisma.topic.findUnique).mockResolvedValue(mockTopic as never)
    vi.mocked(prisma.topic.findMany).mockResolvedValue([mockTopic, mockTopic2] as never)
    vi.mocked(prisma.studySession.findUnique).mockResolvedValue(sessionRow(['topic-1', 'topic-2']) as never)
    const rows = [...Array(2).fill({ topicId: 'topic-1' }), ...Array(2).fill({ topicId: 'topic-2' })]
    vi.mocked(prisma.exercise.findMany).mockImplementation((async (args: { where?: { status?: unknown } }) =>
      args?.where?.status === 'rejected' && !(args.where as Record<string, unknown>).reportedReason ? [...rows, ...rows, { topicId: 'topic-1' }] : []) as never)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await generateNextExercise('session-1')

    expect(result).toEqual({ error: expect.stringContaining('Too many'), retryable: false })
    expect(generateObject).not.toHaveBeenCalled()
  })

  it('returns a plain error, and logs the full error, when the model fails (no key or payload reaches the student)', async () => {
    const mockTopic = { id: 'topic-1', title: 'Target Topic', courseId: 'course-1', week: 'week-1', content: 'Some content' }
    vi.mocked(prisma.topic.findUnique).mockResolvedValueOnce(mockTopic as never)
    vi.mocked(prisma.topic.findMany).mockResolvedValue([mockTopic] as never)
    vi.mocked(prisma.exercise.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.exercise.count).mockResolvedValue(0 as never)
    const providerError = Object.assign(new Error('API key not valid. key=AIzaSyFAKEKEY123 url=https://generativelanguage.googleapis.com/v1beta/models/x'), {
      requestBodyValues: { prompt: 'secret prompt' },
      stack: 'Error: boom\n    at node_modules/ai/dist/index.js:1:1',
    })
    vi.mocked(prisma.studySession.findUnique).mockResolvedValue(sessionRow(['topic-1']) as never)
    vi.mocked(generateObject).mockRejectedValueOnce(providerError)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await generateNextExercise('session-1')

    expect(result).toEqual({ error: expect.any(String) })
    const message = (result as { error: string }).error
    expect(message).not.toMatch(/AIza|key|googleapis|prompt|node_modules|\bat /i)
    expect(message.length).toBeLessThan(120)
    expect(logged).toHaveBeenCalledWith('Failed to generate next exercise:', providerError)
    expect(prisma.exercise.create).not.toHaveBeenCalled()
    expect(prisma.sessionExercise.create).not.toHaveBeenCalled()
    logged.mockRestore()
  })

  it('returns an error without calling the model when no topic has graded content to generate from', async () => {
    vi.mocked(prisma.topic.findMany).mockResolvedValue([] as never) // no topic with content
    vi.mocked(prisma.exercise.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.studySession.findUnique).mockResolvedValue(sessionRow(['empty-1', 'empty-2']) as never)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await generateNextExercise('session-1')
    expect(result).toEqual({ error: expect.stringContaining('graded study material'), retryable: false })
    expect(generateObject).not.toHaveBeenCalled()
    logged.mockRestore()
  })

  it('skips topics that only hold ungraded exercises', async () => {
    vi.mocked(prisma.topic.findMany).mockResolvedValue([{ id: 'survey' }] as never) // has content
    vi.mocked(prisma.exercise.findMany).mockResolvedValue([{ topicId: 'survey', isGraded: false }] as never)
    vi.mocked(prisma.studySession.findUnique).mockResolvedValue(sessionRow(['survey']) as never)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await generateNextExercise('session-1')
    expect(result).toEqual({ error: expect.any(String), retryable: false })
    expect(generateObject).not.toHaveBeenCalled()
    logged.mockRestore()
  })

  it('never sends more than 300 ids in one query, whatever the session size', async () => {
    const mockTopic = { id: 'topic-1', title: 'T', courseId: 'course-1', week: 'w', content: 'c' }
    vi.mocked(prisma.topic.findUnique).mockResolvedValueOnce(mockTopic as never)
    vi.mocked(prisma.topic.findMany).mockResolvedValue([mockTopic] as never)
    vi.mocked(prisma.exercise.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.exercise.count).mockResolvedValue(0 as never)
    vi.mocked(generateObject).mockRejectedValueOnce(new Error('stop here'))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const manyTopics = Array.from({ length: 1322 }, (_, i) => `topic-${i}`)
    vi.mocked(prisma.studySession.findUnique).mockResolvedValue(sessionRow(manyTopics) as never)
    vi.mocked(prisma.sessionExercise.findMany).mockResolvedValue(Array.from({ length: 700 }, (_, i) => ({ exerciseId: `ex-${i}` })) as never)
    await generateNextExercise('session-1')
    const lists = [...vi.mocked(prisma.exercise.findMany).mock.calls, ...vi.mocked(prisma.topic.findMany).mock.calls].map((c) => {
      const where = (c[0] as { where?: Record<string, { in?: string[] } | undefined> })?.where ?? {}
      return Math.max(0, ...Object.values(where).map((v) => v?.in?.length ?? 0))
    })
    expect(Math.max(...lists)).toBeLessThanOrEqual(300)
    logged.mockRestore()
  })

  it('returns an error for a session with an empty pool (a legacy session with no questions), never drawing from the whole database', async () => {
    vi.mocked(prisma.studySession.findUnique).mockResolvedValue(sessionRow(null) as never)
    expect(await generateNextExercise('session-1')).toEqual({ error: expect.any(String), retryable: false })
    expect(generateObject).not.toHaveBeenCalled()
  })

  it('the pool is the session\'s own topics: a resumed session cannot generate from other topics', async () => {
    const t1 = { id: 'topic-1', title: 'Mine', courseId: 'course-1', week: 'w', content: 'c' }
    vi.mocked(prisma.studySession.findUnique).mockResolvedValue(sessionRow(['topic-1']) as never)
    vi.mocked(prisma.topic.findUnique).mockResolvedValue(t1 as never)
    vi.mocked(prisma.topic.findMany).mockResolvedValue([t1] as never)
    vi.mocked(prisma.exercise.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.exercise.count).mockResolvedValue(0 as never)
    vi.mocked(generateObject).mockRejectedValueOnce(new Error('stop here'))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    await generateNextExercise('session-1')
    // every topic query is restricted to the session's topics
    for (const c of vi.mocked(prisma.topic.findMany).mock.calls) {
      const where = (c[0] as { where?: { id?: { in?: string[] } } })?.where
      if (where?.id?.in) expect(where.id.in).toEqual(['topic-1'])
    }
    logged.mockRestore()
  })
})

describe('getPreviousLectureTranscripts action', () => {
  it('walks back from the first topic of the class (by order) and returns the preceding transcript text', async () => {
    vi.mocked(prisma.topic.findFirst).mockResolvedValueOnce({ id: 't-cur', courseId: 'course-1', week: 'W1', order: 50, className: 'Current Exercise Topic' } as any)
    vi.mocked(prisma.topic.findMany).mockResolvedValueOnce([
      { id: 't-prev', title: 'Prev Video Title', content: 'Here is the transcript for context.', week: 'W1', className: 'Previous Lecture Topic', order: 40 }
    ] as any)

    const result = await getPreviousLectureTranscripts('course-1', 'Current Exercise Topic')

    expect(prisma.topic.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { courseId: 'course-1', className: 'Current Exercise Topic' },
      orderBy: { order: 'asc' },
    }))
    expect(result).toBe('Topic: Prev Video Title\nTranscript:\nHere is the transcript for context.')
  })

  it('returns null when the class is unknown', async () => {
    vi.mocked(prisma.topic.findFirst).mockResolvedValueOnce(null)
    expect(await getPreviousLectureTranscripts('course-1', 'Nope')).toBeNull()
  })
})

describe('deleteStudySession action', () => {
  it('deletes logs first and then deletes studySession and returns true', async () => {
    vi.mocked(prisma.exerciseLog.deleteMany).mockResolvedValueOnce({ count: 2 } as any)
    vi.mocked(prisma.studySession.delete).mockResolvedValueOnce({ id: 'session-1' } as any)

    const result = await deleteStudySession('session-1')

    expect(prisma.exerciseLog.deleteMany).toHaveBeenCalledWith({
      where: { sessionId: 'session-1' }
    })
    expect(prisma.sessionExercise.deleteMany).toHaveBeenCalledWith({
      where: { sessionId: 'session-1' }
    })
    expect(prisma.studySession.delete).toHaveBeenCalledWith({
      where: { id: 'session-1' }
    })
    expect(result).toBe(true)
  })

  it('handles error and returns false', async () => {
    vi.mocked(prisma.exerciseLog.deleteMany).mockRejectedValueOnce(new Error('Prisma error'))

    const result = await deleteStudySession('session-1')
    expect(result).toBe(false)
  })
})


describe('payload trimming', () => {
  const callArg = (fn: unknown, n = 0): unknown =>
    (fn as { mock: { calls: unknown[][] } }).mock.calls[n][0]

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('getSessionHistory selects list fields only (no chatLog, diagnosis, topic content) and returns exerciseCount', async () => {
    vi.mocked(prisma.studySession.findMany).mockResolvedValueOnce([
      { id: 's1', mode: 'exam', status: 'active', items: [{ exerciseId: 'a', position: 0 }, { exerciseId: 'b', position: 1 }, { exerciseId: 'c', position: 2 }], logs: [] },
      { id: 's2', mode: 'study', status: 'active', items: [], logs: [] },
    ] as never)

    const result = await getSessionHistory()

    const args = callArg(prisma.studySession.findMany)
    expect(args).not.toHaveProperty('include')
    expect(args).toHaveProperty('select.id', true)
    expect(args).not.toHaveProperty('select.chatLog')
    expect(args).not.toHaveProperty('select.diagnosis')
    expect(args).not.toHaveProperty('select.draftAnswers')
    expect(args).toHaveProperty('select.logs.select.exercise.select', {
      id: true, questionText: true, correctAnswer: true, exerciseType: true,
    })
    expect(args).toHaveProperty('select.items.select', { exerciseId: true, position: true })
    expect(args).not.toHaveProperty('select.exerciseIds')
    expect(result[0].exerciseCount).toBe(3)
    // the id list is used on the server only; it never reaches the client
    expect(result[0]).not.toHaveProperty('exerciseIds')
    expect(result[0]).not.toHaveProperty('items')
    expect(result[1].exerciseCount).toBe(0)
  })

  it('getSessionHistory lists a session\'s answers in question order (SessionExercise.position), with the position on each log', async () => {
    vi.mocked(prisma.studySession.findMany).mockResolvedValueOnce([
      {
        id: 's1', mode: 'study',
        items: [{ exerciseId: 'a', position: 0 }, { exerciseId: 'b', position: 1 }, { exerciseId: 'c', position: 2 }],
        // answered in a different order than the question order
        logs: [{ id: 'l1', exerciseId: 'c' }, { id: 'l2', exerciseId: 'a' }, { id: 'l3', exerciseId: 'zzz' }],
      },
    ] as never)
    const [s1] = await getSessionHistory()
    expect(s1.logs.map((l) => [l.exerciseId, l.position])).toEqual([['a', 0], ['c', 2], ['zzz', null]])
  })

  it('getSessionHistory leaves out finished sessions without answers, keeping running sessions, cancelled exams and answered ones', async () => {
    vi.mocked(prisma.studySession.findMany).mockResolvedValueOnce([
      { id: 'leftover', mode: 'study', status: 'completed', items: [{ exerciseId: 'a', position: 0 }], logs: [] },
      { id: 'running', mode: 'study', status: 'active', items: [], logs: [] },
      { id: 'cancelled', mode: 'exam', status: 'cancelled', items: [], logs: [] },
      { id: 'answered', mode: 'study', status: 'completed', items: [{ exerciseId: 'a', position: 0 }], logs: [{ id: 'l1', exerciseId: 'a' }] },
    ] as never)
    const result = await getSessionHistory('cA')
    expect(result.map((s) => s.id)).toEqual(['running', 'cancelled', 'answered'])
  })

  it('getSessionHistory finalizes overdue exams before listing', async () => {
    vi.mocked(prisma.studySession.findMany).mockResolvedValueOnce([] as never)
    await getSessionHistory('cA')
    expect(finalizeOverdueExams).toHaveBeenCalledWith({ courseId: 'cA' })
    expect(vi.mocked(finalizeOverdueExams).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(prisma.studySession.findMany).mock.invocationCallOrder[0])
  })

  it('getStudyPlans selects sessions with the list select (no chatLog)', async () => {
    vi.mocked(prisma.studyPlan.findMany).mockResolvedValueOnce([
      { id: 'p1', sessions: [{ id: 's1', items: [{ exerciseId: 'a', position: 0 }], logs: [] }] },
    ] as never)

    const plans = await getStudyPlans()

    const args = callArg(prisma.studyPlan.findMany)
    expect(args).toHaveProperty('include.sessions.select.id', true)
    expect(args).not.toHaveProperty('include.sessions.select.chatLog')
    expect(plans[0].sessions[0].exerciseCount).toBe(1)
  })

  it('getSessionDetail returns the chat log and diagnosis', async () => {
    vi.mocked(prisma.studySession.findUnique).mockResolvedValueOnce(
      { chatLog: '[{"role":"user","text":"hi"}]', diagnosis: 'd' } as never
    )

    const detail = await getSessionDetail('s1')

    expect(prisma.studySession.findUnique).toHaveBeenCalledWith({
      where: { id: 's1' },
      select: { chatLog: true, diagnosis: true },
    })
    expect(detail).toEqual({ chatLog: '[{"role":"user","text":"hi"}]', diagnosis: 'd' })
  })

  it('startSession returns the session state read back from the server (questions without topic content)', async () => {
    const candidate = {
      id: 'e1', topicId: 't1', questionText: 'Q', enrichedAt: new Date(),
      topic: { id: 't1', title: 'T', courseId: 'c1', content: 'HUGE' },
    }
    vi.mocked(prisma.exercise.findMany).mockResolvedValueOnce([candidate] as never)
    vi.mocked(prisma.topic.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.exerciseLog.findMany).mockResolvedValue([] as never)

    const res = await startSession(si())

    expect(getSessionStateFor).toHaveBeenCalledWith('s1')
    expect(res.session.id).toBe('s1')
    // the candidate pool is the only exercise query: the client payload is built by the session service
    expect(prisma.exercise.findMany).toHaveBeenCalledTimes(1)
  })

  it('startSession stores the selection, the target and the drawn questions as positional items, and no exerciseIds', async () => {
    vi.mocked(prisma.exercise.findMany).mockResolvedValueOnce([
      { id: 'e1', topicId: 't1', topic: { id: 't1', courseId: 'c1' } },
      { id: 'e2', topicId: 't1', topic: { id: 't1', courseId: 'c1' } },
    ] as never)
    vi.mocked(prisma.topic.findMany).mockResolvedValue([{ id: 't1', courseId: 'c1', week: 'W', course: { code: 'x' } }] as never)
    vi.mocked(prisma.exerciseLog.findMany).mockResolvedValue([] as never)
    await startSession(si({ topicIds: ['t1', 't1'], count: 4, mode: 'exam', timeLimit: 900, sourcingMix: 0 }))
    const input = vi.mocked(createSessionWithItems).mock.calls[0][0]
    expect(input).toMatchObject({ topicIds: ['t1'], targetCount: 4, mode: 'exam', timeLimit: 900 })
    expect(input.exerciseIds.length).toBe(2)
    expect(input).not.toHaveProperty('exercises')
  })

  it('startSession ends the previous active session of the scope before the new one is stored', async () => {
    vi.mocked(prisma.exercise.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.topic.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.exerciseLog.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.course.findUnique).mockResolvedValue({ id: 'cA' } as never)
    await startSession(si({ courseId: 'cA' }))
    expect(endPreviousActiveSessions).toHaveBeenCalledWith({ courseId: 'cA' })
    expect(vi.mocked(endPreviousActiveSessions).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(createSessionWithItems).mock.invocationCallOrder[0])
    await startSession(si())
    expect(endPreviousActiveSessions).toHaveBeenLastCalledWith({})
  })

  it('startSession creates no session when no stored question was drawn and nothing can be generated either', async () => {
    vi.mocked(prisma.exercise.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.topic.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.course.findUnique).mockResolvedValue({ id: 'cA' } as never)
    startCheck.mockResolvedValueOnce({ startable: false, message: 'Nothing can be generated.' } as never)
    await expect(startSession(si({ courseId: 'cA', topicIds: [] }))).rejects.toThrow('Nothing can be generated.')
    expect(startCheck).toHaveBeenCalledWith(expect.objectContaining({ courseId: 'cA', topicIds: [], sourcingMix: 0 }))
    expect(endPreviousActiveSessions).not.toHaveBeenCalled()
    expect(createSessionWithItems).not.toHaveBeenCalled()
  })

  it('checkSessionStartable cleans its input and delegates to the check', async () => {
    startCheck.mockResolvedValueOnce({ startable: true } as never)
    const res = await checkSessionStartable({ courseId: ' cA ', topicIds: ['t1', 't1', 5 as unknown as string], count: 9999, sourcingMix: 150 })
    expect(res).toEqual({ startable: true })
    expect(startCheck).toHaveBeenCalledWith({ courseId: 'cA', topicIds: ['t1'], count: 500, sourcingMix: 100 })
  })

  it('startSession cleans odd input: duplicate and non-string topic ids, absurd counts, an unknown mode', async () => {
    vi.mocked(prisma.exercise.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.topic.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.exerciseLog.findMany).mockResolvedValue([] as never)
    await startSession({ ...si({ topicIds: ['a', 'a', 7 as unknown as string], count: 99999, mode: 'weird' as 'study', timeLimit: -5 }) })
    expect(vi.mocked(createSessionWithItems).mock.calls[0][0]).toMatchObject({ topicIds: ['a'], targetCount: 500, mode: 'study', timeLimit: null })
  })
})

describe('startSession background enrichment', () => {
  const row = (id: string, extra: Record<string, unknown> = {}) => ({ id, topicId: 't1', questionText: 'Q', enrichedAt: null, topic: { id: 't1', courseId: 'c1' }, ...extra })

  afterEach(() => {
    delete process.env.ENRICH_IN_BACKGROUND
  })

  it('schedules nothing by default (flag off)', async () => {
    vi.mocked(prisma.exercise.findMany).mockResolvedValueOnce([row('a'), row('b')] as never)
    vi.mocked(prisma.topic.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.exerciseLog.findMany).mockResolvedValue([] as never)

    await startSession(si({ weakPct: 0, unstudiedPct: 100, expertPct: 0 }))

    expect(enrichInBackground).not.toHaveBeenCalled()
    // only the candidate pool: no enrichment candidate query
    expect(prisma.exercise.findMany).toHaveBeenCalledTimes(1)
  })

  it('enriches only never-answered questions that are not in the new session, without waiting for the model (ENRICH_IN_BACKGROUND=1)', async () => {
    process.env.ENRICH_IN_BACKGROUND = '1'
    const pool = [row('a'), row('b'), row('c'), row('answered')]
    vi.mocked(prisma.exercise.findMany).mockResolvedValueOnce(pool as never)
    vi.mocked(prisma.topic.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.exerciseLog.findMany).mockResolvedValue([{ exerciseId: 'answered', isCorrect: false }] as never)

    await startSession(si({ weakPct: 0, unstudiedPct: 100, expertPct: 0 }))

    expect(generateObject).not.toHaveBeenCalled()
    const created = vi.mocked(createSessionWithItems).mock.calls[0][0].exerciseIds
    expect(created).toHaveLength(1)
    const queued = (vi.mocked(enrichInBackground).mock.calls[0][0] as { id: string }[]).map((e) => e.id).sort()
    expect(queued).toEqual(['a', 'b', 'c'].filter((id) => id !== created[0]))
    expect(queued).not.toContain('answered')
  })
})

describe('startSession calibration module', () => {
  const profileJson = (calibrationModule: string | null) => JSON.stringify({ ...defaultProfile({ title: 'C' }), calibrationModule })

  it('draws candidates from the whole course when a selected topic is in the profile calibrationModule', async () => {
    vi.mocked(prisma.topic.findMany).mockResolvedValue([{ id: 'cal', courseId: 'c1', week: 'Final review', course: { code: 'x' } }] as never)
    vi.mocked(prisma.course.findUnique).mockResolvedValue({ id: 'c1', code: 'x', title: 'C', profile: profileJson('Final review') } as never)
    vi.mocked(prisma.exercise.findMany).mockResolvedValue([] as never)

    await startSession(si({ topicIds: ['cal'], count: 5, sourcingMix: 50 }))

    expect(prisma.exercise.findMany).toHaveBeenCalledWith({
      where: { topic: { courseId: 'c1' }, isGraded: true, status: 'active' },
      include: { topic: true },
    })
  })

  it('keeps the selected topics when the profile has no calibrationModule, even for a week named like a review', async () => {
    vi.mocked(prisma.topic.findMany).mockResolvedValue([{ id: 't1', courseId: 'c1', week: 'Week_13_Comprehensive_Review', course: { code: 'x' } }] as never)
    vi.mocked(prisma.course.findUnique).mockResolvedValue({ id: 'c1', code: 'x', title: 'C', profile: profileJson(null) } as never)
    vi.mocked(prisma.exercise.findMany).mockResolvedValue([] as never)

    await startSession(si({ topicIds: ['t1'], count: 5, sourcingMix: 50 }))

    expect(prisma.exercise.findMany).toHaveBeenCalledWith({
      where: { topicId: { in: ['t1'] }, isGraded: true, status: 'active' },
      include: { topic: true },
    })
  })
})

describe('saveChatLog', () => {
  it('drops injected [SYSTEM MESSAGE user turns and keeps real messages', async () => {
    vi.mocked(prisma.studySession.update).mockResolvedValueOnce({} as never)
    await saveChatLog('s1', [
      { id: '1', role: 'user', text: '[SYSTEM MESSAGE: The student has navigated to a new exercise.' },
      { id: '2', role: 'user', text: 'What is the answer?' },
      { id: '3', role: 'model', text: '[SYSTEM MESSAGE is quoted by the tutor' },
      { id: '4', role: 'model', text: 'Think about incentives.' },
    ])
    const data = (vi.mocked(prisma.studySession.update).mock.calls[0][0] as any).data
    expect(JSON.parse(data.chatLog).map((m: any) => m.id)).toEqual(['2', '3', '4'])
  })
})

describe('deleteStudyPlan', () => {
  it('deletes logs, items, sessions and then the plan inside one transaction', async () => {
    vi.clearAllMocks()
    const order: string[] = []
    vi.mocked(prisma.exerciseLog.deleteMany).mockImplementationOnce((() => { order.push('logs'); return Promise.resolve({ count: 1 }) }) as never)
    vi.mocked(prisma.sessionExercise.deleteMany).mockImplementationOnce((() => { order.push('items'); return Promise.resolve({ count: 1 }) }) as never)
    vi.mocked(prisma.studySession.deleteMany).mockImplementationOnce((() => { order.push('sessions'); return Promise.resolve({ count: 1 }) }) as never)
    vi.mocked(prisma.studyPlan.delete).mockImplementationOnce((() => { order.push('plan'); return Promise.resolve({ id: 'p1' }) }) as never)

    expect(await deleteStudyPlan('p1')).toBe(true)

    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(vi.mocked(prisma.$transaction).mock.calls[0][0]).toHaveLength(4)
    expect(order).toEqual(['logs', 'items', 'sessions', 'plan'])
    expect(prisma.exerciseLog.deleteMany).toHaveBeenCalledWith({ where: { session: { studyPlanId: 'p1' } } })
    expect(prisma.studySession.deleteMany).toHaveBeenCalledWith({ where: { studyPlanId: 'p1' } })
    expect(prisma.studyPlan.delete).toHaveBeenCalledWith({ where: { id: 'p1' } })
  })
})

describe('startSession graded filter', () => {
  it('queries only graded, active exercises', async () => {
    vi.clearAllMocks()
    vi.mocked(prisma.exercise.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.topic.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.exerciseLog.findMany).mockResolvedValue([] as never)

    await startSession(si({ topicIds: ['t1'] }))
    await startSession(si())

    const first = vi.mocked(prisma.exercise.findMany).mock.calls[0][0] as { where: unknown }
    const second = vi.mocked(prisma.exercise.findMany).mock.calls[1][0] as { where?: unknown; data?: Record<string, unknown> }
    expect(first.where).toMatchObject({ topicId: { in: ['t1'] }, isGraded: true, status: 'active' })
    expect(second.where).toMatchObject({ isGraded: true, status: 'active' })
  })
})

describe('recordCardTime', () => {
  it('passes the seconds to the study-time service', async () => {
    expect(await recordCardTime('s1', 'e1', 9)).toEqual({ ok: true })
    expect(recordStudyTimeFor).toHaveBeenCalledWith('s1', 'e1', 9)
  })
  it('saveDraft passes undefined (time only) through to the service', async () => {
    await saveDraft('s1', 'e1', undefined, 4)
    expect(saveDraftFor).toHaveBeenCalledWith('s1', 'e1', undefined, 4)
  })
})

describe('logAnswer, finish and cancel (thin actions over the session service)', () => {
  it('logAnswer passes the call to the service, which grades on the server and checks membership and status', async () => {
    vi.mocked(logAnswerForSession).mockResolvedValueOnce({ score: 1, isCorrect: true })
    await expect(logAnswer('s1', 'e1', 'A', { durationSec: 12 })).resolves.toEqual({ score: 1, isCorrect: true })
    expect(logAnswerForSession).toHaveBeenCalledWith('s1', 'e1', 'A', { durationSec: 12 })
    vi.mocked(logAnswerForSession).mockResolvedValueOnce(null)
    await expect(logAnswer('s1', 'not-an-item', 'A')).resolves.toBeNull()
  })

  it('cancelStudySession cancels through the service (active sessions only) and writes no logs', async () => {
    vi.mocked(cancelSession).mockClear()
    expect(await cancelStudySession('s1')).toBe(true)
    expect(cancelSession).toHaveBeenCalledWith('s1')
    expect(prisma.exerciseLog.create).not.toHaveBeenCalled()
  })

  it('finishStudySession completes through the service (an exam is submitted with its stored drafts)', async () => {
    expect(await finishStudySession('s1')).toBe(true)
    expect(completeSession).toHaveBeenCalledWith('s1')
  })

  it('the small session actions authenticate and report the service result', async () => {
    vi.mocked(saveDraftFor).mockResolvedValueOnce({ ok: false, reason: 'deadline_passed' })
    expect(await saveDraft('s1', 'e1', 'A', 3)).toEqual({ ok: false, reason: 'deadline_passed' })
    expect(saveDraftFor).toHaveBeenCalledWith('s1', 'e1', 'A', 3)
    expect(await setFlagged('s1', 'e1', true)).toEqual({ ok: true })
    expect(await setCurrentPosition('s1', 2)).toEqual({ ok: true })
    expect(setCurrentPositionFor).toHaveBeenCalledWith('s1', 2)
  })

  it('getActiveSession and getSessionState apply the course scope the same way as the other reads', async () => {
    await getActiveSession('cA')
    expect(getActiveSessionFor).toHaveBeenLastCalledWith('cA')
    await getActiveSession('')
    expect(getActiveSessionFor).toHaveBeenLastCalledWith(undefined)
    await getSessionState('s1', 'cA')
    expect(getSessionStateFor).toHaveBeenLastCalledWith('s1', 'cA')
    await getSessionState('s1')
    expect(getSessionStateFor).toHaveBeenLastCalledWith('s1', undefined)
  })
})

describe('reportExercise', () => {
  it('marks an active or already reported question as reported with the reason', async () => {
    vi.mocked(prisma.exercise.updateMany).mockResolvedValue({ count: 1 } as never)
    expect(await reportExercise('ex-1', 'wrong_answer')).toBe(true)
    expect(prisma.exercise.updateMany).toHaveBeenCalledWith({
      where: { id: 'ex-1', status: { in: ['active', 'reported'] } },
      data: { status: 'reported', reportedReason: 'wrong_answer' },
    })
  })

  it('does not touch logs or sessions, so the question stays in the current session', async () => {
    vi.mocked(prisma.exercise.updateMany).mockResolvedValue({ count: 1 } as never)
    await reportExercise('ex-1', 'unclear')
    expect(prisma.exerciseLog.deleteMany).not.toHaveBeenCalled()
    expect(prisma.studySession.update).not.toHaveBeenCalled()
  })

  it('returns false for an unknown reason, an unknown or never-shown question, and on database errors', async () => {
    expect(await reportExercise('ex-1', 'because')).toBe(false)
    expect(prisma.exercise.updateMany).not.toHaveBeenCalled()
    vi.mocked(prisma.exercise.updateMany).mockResolvedValueOnce({ count: 0 } as never)
    expect(await reportExercise('rejected-or-missing', 'other')).toBe(false)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(prisma.exercise.updateMany).mockRejectedValueOnce(new Error('db'))
    expect(await reportExercise('ex-1', 'other')).toBe(false)
  })
})


describe('course scope (T16)', () => {
  type Loose = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  const callArg = (fn: unknown, n = 0): Loose => (fn as { mock: { calls: unknown[][] } }).mock.calls[n][0] as Loose
  const rows = (...pairs: [string, string][]) => pairs.map(([id, courseId]) => ({ id, courseId, week: 'W', course: { code: courseId } }))

  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(prisma.exercise.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.topic.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.exerciseLog.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.studySession.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.course.findUnique).mockResolvedValue({ id: 'cA', code: 'A', title: 'A', profile: null } as never)
  })

  describe('startSession', () => {
    it('stores the course the session was started in and draws only that course when no topic is selected', async () => {
      vi.mocked(prisma.exercise.findMany).mockResolvedValueOnce([{ id: 'e1', topicId: 't1', topic: { id: 't1', courseId: 'cA' } }] as never).mockResolvedValue([] as never)
      await startSession(si({ count: 5, courseId: 'cA' }))

      expect(callArg(prisma.exercise.findMany).where).toEqual({ topic: { courseId: 'cA' }, isGraded: true, status: 'active' })
      expect(callArg(prisma.exerciseLog.findMany).where).toEqual({ exercise: { topic: { courseId: 'cA' } } })
      expect(vi.mocked(createSessionWithItems).mock.calls[0][0].courseId).toBe('cA')
    })

    it('rejects topics of another course before reading candidates or writing anything', async () => {
      vi.mocked(prisma.topic.findMany).mockResolvedValue(rows(['t1', 'cA'], ['t2', 'cB']) as never)

      await expect(startSession(si({ topicIds: ['t1', 't2'], count: 5, courseId: 'cA' }))).rejects.toThrow(/do not belong/)

      expect(prisma.exercise.findMany).not.toHaveBeenCalled()
      expect(createSessionWithItems).not.toHaveBeenCalled()
      expect(endPreviousActiveSessions).not.toHaveBeenCalled() // a rejected start must not end the running session
    })

    it('rejects an unknown studyspace', async () => {
      vi.mocked(prisma.course.findUnique).mockResolvedValue(null as never)
      await expect(startSession(si({ count: 5, courseId: 'nope' }))).rejects.toThrow(/not found/)
      expect(createSessionWithItems).not.toHaveBeenCalled()
      expect(endPreviousActiveSessions).not.toHaveBeenCalled()
    })

    it('treats an empty courseId as no scope', async () => {
      await startSession(si({ count: 5, courseId: '' }))
      expect(callArg(prisma.exercise.findMany).where).toEqual({ isGraded: true, status: 'active' })
      expect(prisma.course.findUnique).not.toHaveBeenCalled()
    })

    it('derives the course from the selected topics when unscoped: the course with most topics, a tie goes to the first topic', async () => {
      vi.mocked(prisma.topic.findMany).mockResolvedValue(rows(['t1', 'cA'], ['t2', 'cB'], ['t3', 'cB']) as never)
      await startSession(si({ topicIds: ['t1', 't2', 't3'], count: 5 }))
      expect(vi.mocked(createSessionWithItems).mock.calls[0][0].courseId).toBe('cB')

      vi.mocked(createSessionWithItems).mockClear()
      vi.mocked(prisma.topic.findMany).mockResolvedValue(rows(['t1', 'cA'], ['t2', 'cB']) as never)
      await startSession(si({ topicIds: ['t2', 't1'], count: 5 }))
      expect(vi.mocked(createSessionWithItems).mock.calls[0][0].courseId).toBe('cB')
    })

    it('derives the course from the drawn questions when unscoped and no topic is selected', async () => {
      vi.mocked(prisma.exercise.findMany).mockResolvedValueOnce([
        { id: 'e1', topicId: 't1', topic: { id: 't1', courseId: 'cA' } },
      ] as never).mockResolvedValue([] as never)
      await startSession(si({ weakPct: 0, unstudiedPct: 100, expertPct: 0 }))
      expect(vi.mocked(createSessionWithItems).mock.calls[0][0].courseId).toBe('cA')
    })

    it('stores null only when nothing at all identifies a course', async () => {
      await startSession(si())
      expect(vi.mocked(createSessionWithItems).mock.calls[0][0].courseId).toBeNull()
    })
  })

  describe('reads', () => {
    it('getTopics filters by course and orders by module label then outline order', async () => {
      await getTopics('cA')
      expect(callArg(prisma.topic.findMany)).toMatchObject({ where: { courseId: 'cA' }, orderBy: [{ week: 'asc' }, { order: 'asc' }] })
      await getTopics()
      expect(callArg(prisma.topic.findMany, 1).where).toBeUndefined()
    })

    it('getSessionHistory filters by course (and leaves the diagnosis holder out); unscoped it has no filter', async () => {
      await getSessionHistory('cA')
      expect(callArg(prisma.studySession.findMany).where).toEqual({ courseId: 'cA', mode: { not: 'global_diagnosis' } })
      await getSessionHistory()
      expect(callArg(prisma.studySession.findMany, 1).where).toBeUndefined()
    })

    it('getStudyPlans filters plans and their sessions by course', async () => {
      vi.mocked(prisma.studyPlan.findMany).mockResolvedValue([] as never)
      await getStudyPlans('cA')
      const args = callArg(prisma.studyPlan.findMany)
      expect(args.where).toEqual({ courseId: 'cA' })
      expect(args.include.sessions.where).toEqual({ courseId: 'cA' })
      await getStudyPlans()
      expect(callArg(prisma.studyPlan.findMany, 1).where).toBeUndefined()
      expect(callArg(prisma.studyPlan.findMany, 1).include.sessions).not.toHaveProperty('where')
    })

    it('getTopicsWithPerformance restricts topics, exercises and logs to the course', async () => {
      await getTopicsWithPerformance('cA')
      expect(callArg(prisma.topic.findMany)).toMatchObject({ where: { courseId: 'cA' }, orderBy: [{ week: 'asc' }, { order: 'asc' }] })
      expect(callArg(prisma.exercise.findMany).where).toEqual({ status: { not: 'rejected' }, topic: { courseId: 'cA' } })
      expect(callArg(prisma.exerciseLog.findMany).where).toEqual({ exercise: { topic: { courseId: 'cA' } } })
    })

    it('getAnalyticsData restricts sessions, logs, evolution and the diagnosis row to the course, keeping status filters', async () => {
      vi.mocked(prisma.studySession.findFirst).mockResolvedValue(null as never)
      await getAnalyticsData('cA')
      const sessions = callArg(prisma.studySession.findMany)
      expect(sessions.where).toEqual({ status: { not: 'cancelled' }, courseId: 'cA', mode: { not: 'global_diagnosis' } })
      expect(sessions.include.logs.where).toEqual({ exercise: { topic: { courseId: 'cA' } } })
      expect(callArg(prisma.studySession.findFirst).where).toEqual({ mode: 'global_diagnosis', courseId: 'cA' })
      expect(callArg(prisma.exerciseLog.findMany).where).toEqual({ exercise: { topic: { courseId: 'cA' } } })
    })

    it('getAnalyticsData unscoped keeps today\'s queries and reads the course-less diagnosis row', async () => {
      vi.mocked(prisma.studySession.findFirst).mockResolvedValue(null as never)
      await getAnalyticsData()
      const sessions = callArg(prisma.studySession.findMany)
      expect(sessions.where).toEqual({ status: { not: 'cancelled' } })
      expect(sessions.include.logs.where).toBeUndefined()
      expect(callArg(prisma.studySession.findFirst).where).toEqual({ mode: 'global_diagnosis', courseId: null })
      expect(callArg(prisma.exerciseLog.findMany).where).toBeUndefined()
    })

    it('getCourseArtifacts and generateSessionSummary pass the scope on', async () => {
      await getCourseArtifacts('cA')
      expect(getCourseArtifactsService).toHaveBeenCalledWith('cA')
      await getCourseArtifacts()
      expect(getCourseArtifactsService).toHaveBeenLastCalledWith(undefined)
      vi.mocked(createSessionSummary).mockResolvedValue({ link: 'l', content: 'c' } as never)
      await generateSessionSummary('s1', 'cA')
      expect(createSessionSummary).toHaveBeenCalledWith('s1', 'cA')
    })
  })

  describe('generateNextExercise', () => {
    it('treats a session of another course as stopped, without any model call', async () => {
      vi.mocked(prisma.studySession.findUnique).mockResolvedValue({ id: 's1', status: 'active', courseId: 'cB', startTime: new Date(), topicIds: '["t1"]' } as never)
      expect(await generateNextExercise('s1', 'cA')).toEqual({ stopped: true })
      expect(generateObject).not.toHaveBeenCalled()
    })
  })

  describe('global diagnosis', () => {
    const log = { score: 0, isCorrect: false, exercise: { id: 'e1', topic: { id: 't1', title: 'T', courseId: 'cA', week: 'W1', content: 'x' } } }

    it('uses only the course logs and profile, and stores the text on the course row', async () => {
      vi.mocked(prisma.exerciseLog.findMany).mockResolvedValue([log] as never)
      vi.mocked(prisma.topic.findMany).mockResolvedValue([{ id: 't1', content: 'x', course: { code: 'A' } }] as never)
      vi.mocked(prisma.studySession.findFirst).mockResolvedValue(null as never)
      vi.mocked(generateText).mockResolvedValue({ text: 'diag' } as never)

      expect(await generateGlobalDiagnosis('cA')).toBe('diag')

      expect(callArg(prisma.exerciseLog.findMany).where).toEqual({ exercise: { topic: { courseId: 'cA' } } })
      expect(callArg(prisma.studySession.findFirst).where).toEqual({ mode: 'global_diagnosis', courseId: 'cA' })
      expect(callArg(prisma.studySession.create).data).toMatchObject({ mode: 'global_diagnosis', courseId: 'cA', diagnosis: 'diag' })
      expect(prisma.course.findUnique).toHaveBeenCalledWith({ where: { id: 'cA' } })
    })

    it('updates the existing row of the course; unscoped it finds and keeps the course-less row', async () => {
      vi.mocked(prisma.exerciseLog.findMany).mockResolvedValue([log] as never)
      vi.mocked(prisma.topic.findMany).mockResolvedValue([] as never)
      vi.mocked(prisma.studySession.findFirst).mockResolvedValue({ id: 'g1' } as never)
      vi.mocked(prisma.studySession.update).mockResolvedValue({} as never)
      vi.mocked(generateText).mockResolvedValue({ text: 'diag' } as never)

      await generateGlobalDiagnosis()

      expect(callArg(prisma.exerciseLog.findMany).where).toBeUndefined()
      expect(callArg(prisma.studySession.findFirst).where).toEqual({ mode: 'global_diagnosis', courseId: null })
      expect(callArg(prisma.studySession.update).where).toEqual({ id: 'g1' })
      expect(prisma.studySession.create).not.toHaveBeenCalled()
    })
  })

  describe('study plans', () => {
    const plan = (...topicIds: string[][]) => ({
      title: 'P', executiveSummary: 'S',
      sessions: topicIds.map((ids, i) => ({ name: `n${i}`, day: 'Mon', mode: 'study', durationMinutes: 30, sourcingMix: 50, topicIds: ids, questionCount: 5 })),
    })

    beforeEach(() => {
      vi.mocked(prisma.studyPlan.create).mockResolvedValue({ id: 'p1' } as never)
    })

    it('stores the course on the plan and on every session, and seeds only from that course', async () => {
      vi.mocked(prisma.topic.findMany).mockResolvedValue(rows(['t1', 'cA'], ['t2', 'cA']) as never)

      await saveAndDeployStudyPlan(plan(['t1'], ['t2']), 'cA')

      expect(callArg(prisma.studyPlan.create).data.courseId).toBe('cA')
      expect(vi.mocked(prisma.studySession.create).mock.calls.map(c => (c[0] as Loose).data.courseId)).toEqual(['cA', 'cA'])
      expect(callArg(prisma.exercise.findMany).where).toEqual({ topicId: { in: ['t1'] }, topic: { courseId: 'cA' }, status: 'active' })
    })

    it('rejects a plan that names a topic of another course, writing nothing', async () => {
      vi.mocked(prisma.topic.findMany).mockResolvedValue(rows(['t1', 'cA'], ['t9', 'cB']) as never)

      expect(await saveAndDeployStudyPlan(plan(['t1', 't9']), 'cA')).toBeNull()

      expect(prisma.studyPlan.create).not.toHaveBeenCalled()
      expect(prisma.studySession.create).not.toHaveBeenCalled()
    })

    it('unscoped, derives the course of each session and of the plan from the topics', async () => {
      vi.mocked(prisma.topic.findMany).mockResolvedValue(rows(['t1', 'cA'], ['t2', 'cB'], ['t3', 'cB']) as never)

      await saveAndDeployStudyPlan(plan(['t1'], ['t2', 't3']))

      expect(callArg(prisma.studyPlan.create).data.courseId).toBe('cB')
      expect(vi.mocked(prisma.studySession.create).mock.calls.map(c => (c[0] as Loose).data.courseId)).toEqual(['cA', 'cB'])
      expect(callArg(prisma.exercise.findMany).where).toEqual({ topicId: { in: ['t1'] }, status: 'active' })
    })

    it('generateStructuredStudyPlan filters the catalog to the course and uses its profile', async () => {
      vi.mocked(prisma.topic.findMany).mockResolvedValue([{ id: 't1', title: 'T', week: 'W', courseId: 'cA' }] as never)
      vi.mocked(generateObject).mockResolvedValue({ object: { title: 'x', executiveSummary: 'y', sessions: [] } } as never)

      await generateStructuredStudyPlan([], {}, 'cA')

      expect(callArg(prisma.topic.findMany).where).toEqual({ courseId: 'cA' })
      expect(prisma.course.findUnique).toHaveBeenCalledWith({ where: { id: 'cA' } })
    })

    it('generatePlannerResponse uses the course profile only when scoped', async () => {
      vi.mocked(generateText).mockResolvedValue({ text: 'ok' } as never)
      vi.mocked(prisma.course.findUnique).mockResolvedValue({ id: 'cA', code: 'A', title: 'Organic chemistry', profile: null } as never)

      await generatePlannerResponse([], {}, 'cA')
      expect(vi.mocked(generateText).mock.calls[0][0].prompt as string).toContain('Organic chemistry')

      await generatePlannerResponse([], {})
      expect(vi.mocked(generateText).mock.calls[1][0].prompt as string).not.toContain('Organic chemistry')
    })
  })
})
