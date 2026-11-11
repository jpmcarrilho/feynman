import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { explainMistake, generateNextExercise, getSessionHistory, getSessionDetail, getSessionWithExercises, getStudyPlans, createStudySession, needsContextEnrichment, enrichExerciseWithContext, getPreviousLectureTranscripts, deleteStudySession, saveChatLog, deleteStudyPlan, logAnswer, cancelStudySession, reportExercise } from './actions'
import { generateText, generateObject } from 'ai'
import { prisma } from '@/lib/db'
import { defaultProfile } from '@/lib/studyspace/profile'
import { GENERATE_EXERCISE_PROMPT_VERSION } from '@/lib/prompts'

// Auth: requireAuth always resolves in these tests
vi.mock('@/server/auth', () => ({
  requireAuth: vi.fn(async () => {}),
}))

// Mock the AI SDK
vi.mock('ai', () => ({
  generateText: vi.fn(),
  generateObject: vi.fn(),
}))

vi.mock('@ai-sdk/google', () => ({
  google: vi.fn(() => 'mocked-google-model'),
}))

// Mock the database client
vi.mock('@/lib/db', () => ({
  prisma: {
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
    },
    sessionExercise: {
      deleteMany: vi.fn(),
    },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    studySession: {
      deleteMany: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    exerciseLog: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}))

let randomSpy: any;

beforeEach(() => {
  vi.clearAllMocks();
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

describe('generateNextExercise action', () => {
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
        correctAnswer: 'A',
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

    const mockSession = { id: 'session-1', status: 'active', exerciseIds: JSON.stringify(['ex-old']) }
    vi.mocked(prisma.studySession.findUnique).mockResolvedValue(mockSession as any)

    const result = await generateNextExercise('session-1', ['topic-1'], ['ex-old'])

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

    // Verify studySession.update was called
    expect(prisma.studySession.update).toHaveBeenCalledWith({
      where: { id: 'session-1' },
      data: { exerciseIds: JSON.stringify(['ex-old', 'ex-new']) }
    })

    expect(result).toEqual({ exercise: mockCreatedExercise })
  })

  it('stops targeting a topic once 3 of its questions were rejected in this session, without calling the model', async () => {
    const mockTopic = { id: 'topic-1', title: 'Target Topic', courseId: 'course-1', week: 'week-1', content: 'Some content' }
    vi.mocked(prisma.topic.findUnique).mockResolvedValue(mockTopic as never)
    vi.mocked(prisma.topic.findMany).mockResolvedValue([mockTopic] as never)
    vi.mocked(prisma.studySession.findUnique).mockResolvedValue({ id: 'session-1', status: 'active', startTime: new Date('2026-11-11T10:00:00Z'), exerciseIds: '[]' } as never)
    vi.mocked(prisma.exercise.findMany).mockImplementation((async (args: { where?: { status?: unknown } }) =>
      args?.where?.status === 'rejected' && !(args.where as Record<string, unknown>).reportedReason ? [{ topicId: 'topic-1' }, { topicId: 'topic-1' }, { topicId: 'topic-1' }] : []) as never)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await generateNextExercise('session-1', ['topic-1'], [])

    expect(result).toEqual({ error: expect.stringContaining('quality checks') })
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
    vi.mocked(prisma.studySession.findUnique).mockResolvedValue({ id: 'session-1', status: 'active', startTime: new Date(), exerciseIds: '[]' } as never)
    vi.mocked(prisma.exercise.findMany).mockImplementation((async (args: { where?: { status?: unknown } }) =>
      args?.where?.status === 'rejected' && !(args.where as Record<string, unknown>).reportedReason ? [{ topicId: 'topic-1' }, { topicId: 'topic-1' }, { topicId: 'topic-1' }] : []) as never)
    vi.mocked(prisma.exercise.count).mockResolvedValue(0 as never)
    vi.mocked(generateObject)
      .mockResolvedValueOnce({ object: { newExercise: { contentKind: 'subject_matter', logisticsReason: '', questionText: 'Q?', exerciseType: 'single_choice', choices: ['A', 'B', 'C', 'D'], correctAnswer: 'A', explanation: 'E' } } } as never)
      .mockResolvedValueOnce({ object: { answerable: true, issue: '', answer: ['A'] } } as never)
    vi.mocked(prisma.exercise.create).mockResolvedValue({ id: 'ex-new' } as never)

    const result = await generateNextExercise('session-1', ['topic-1', 'topic-2'], [])

    expect(result).toEqual({ exercise: { id: 'ex-new' } })
    expect(vi.mocked(prisma.exercise.create).mock.calls[0][0].data).toMatchObject({ topicId: 'topic-2' })
  })

  it('stops generating for the whole session after 9 rejected questions', async () => {
    const mockTopic = { id: 'topic-1', title: 'T', courseId: 'course-1', week: 'week-1', content: 'c' }
    const mockTopic2 = { ...mockTopic, id: 'topic-2' }
    vi.mocked(prisma.topic.findUnique).mockResolvedValue(mockTopic as never)
    vi.mocked(prisma.topic.findMany).mockResolvedValue([mockTopic, mockTopic2] as never)
    vi.mocked(prisma.studySession.findUnique).mockResolvedValue({ id: 'session-1', status: 'active', startTime: new Date(), exerciseIds: '[]' } as never)
    const rows = [...Array(2).fill({ topicId: 'topic-1' }), ...Array(2).fill({ topicId: 'topic-2' })]
    vi.mocked(prisma.exercise.findMany).mockImplementation((async (args: { where?: { status?: unknown } }) =>
      args?.where?.status === 'rejected' && !(args.where as Record<string, unknown>).reportedReason ? [...rows, ...rows, { topicId: 'topic-1' }] : []) as never)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await generateNextExercise('session-1', ['topic-1', 'topic-2'], [])

    expect(result).toEqual({ error: expect.stringContaining('Too many') })
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
    vi.mocked(generateObject).mockRejectedValueOnce(providerError)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await generateNextExercise('session-1', ['topic-1'], [])

    expect(result).toEqual({ error: expect.any(String) })
    const message = (result as { error: string }).error
    expect(message).not.toMatch(/AIza|key|googleapis|prompt|node_modules|\bat /i)
    expect(message.length).toBeLessThan(120)
    expect(logged).toHaveBeenCalledWith('Failed to generate next exercise:', providerError)
    expect(prisma.exercise.create).not.toHaveBeenCalled()
    expect(prisma.studySession.update).not.toHaveBeenCalled()
    logged.mockRestore()
  })

  it('returns an error without calling the model when no topic has graded content to generate from', async () => {
    vi.mocked(prisma.topic.findMany).mockResolvedValue([] as never) // no topic with content
    vi.mocked(prisma.exercise.findMany).mockResolvedValue([] as never)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await generateNextExercise('session-1', ['empty-1', 'empty-2'], [])
    expect(result).toEqual({ error: expect.stringContaining('graded study material') })
    expect(generateObject).not.toHaveBeenCalled()
    logged.mockRestore()
  })

  it('skips topics that only hold ungraded exercises', async () => {
    vi.mocked(prisma.topic.findMany).mockResolvedValue([{ id: 'survey' }] as never) // has content
    vi.mocked(prisma.exercise.findMany).mockResolvedValue([{ topicId: 'survey', isGraded: false }] as never)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await generateNextExercise('session-1', ['survey'], [])
    expect(result).toEqual({ error: expect.any(String) })
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
    await generateNextExercise('session-1', manyTopics, Array.from({ length: 700 }, (_, i) => `ex-${i}`))
    const lists = [...vi.mocked(prisma.exercise.findMany).mock.calls, ...vi.mocked(prisma.topic.findMany).mock.calls].map((c) => {
      const where = (c[0] as { where?: Record<string, { in?: string[] } | undefined> })?.where ?? {}
      return Math.max(0, ...Object.values(where).map((v) => v?.in?.length ?? 0))
    })
    expect(Math.max(...lists)).toBeLessThanOrEqual(300)
    logged.mockRestore()
  })

  it('returns an error for an empty topic list', async () => {
    expect(await generateNextExercise('session-1', [], [])).toEqual({ error: expect.any(String) })
  })
})

describe('needsContextEnrichment helper', () => {
  it('returns true for any non-enriched text', async () => {
    expect(await needsContextEnrichment('What is the difference between NPV and IRR?')).toBe(true)
  })

  it('returns false if already enriched', async () => {
    expect(await needsContextEnrichment('<!-- enriched -->\nWhat is described in the video above?')).toBe(false)
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

describe('enrichExerciseWithContext action', () => {
  it('calls generateObject and updates exercise with enriched marker', async () => {
    const mockTopic = { id: 'topic-1', title: 'Current Topic', courseId: 'course-1', week: 'week-1', className: 'Current Exercise Topic', order: 5 }
    const mockExercise = {
      id: 'ex-1',
      topicId: 'topic-1',
      questionText: 'Which step is missing in the process described in the above figure?',
      topic: mockTopic
    }

    vi.mocked(prisma.topic.findMany).mockResolvedValueOnce([
      { id: 't-prev', title: 'Prev Video Title', content: 'Here is the transcript for context.', week: 'week-1', className: 'Previous Lecture Topic', order: 1 }
    ] as any)
    vi.mocked(prisma.course.findUnique).mockResolvedValueOnce({ id: 'course-1', code: 'JPAL102x', title: 'JPAL', profile: null } as any)

    const mockEnrichedText = 'Which step is missing in the data entry double entry verification process?'
    vi.mocked(generateObject).mockResolvedValueOnce({
      object: { enrichedQuestionText: mockEnrichedText }
    } as any)

    const result = await enrichExerciseWithContext(mockExercise)

    expect(generateObject).toHaveBeenCalledTimes(1)
    expect(vi.mocked(generateObject).mock.calls[0][0].prompt).toContain('Here is the transcript for context.')
    expect(prisma.exercise.update).toHaveBeenCalledWith({
      where: { id: 'ex-1' },
      data: {
        questionText: mockEnrichedText,
        enrichedAt: expect.any(Date),
        originalQuestionText: mockExercise.questionText
      }
    })

    // No in-band marker: enrichment is tracked by the enrichedAt column
    expect(result.questionText).toBe(mockEnrichedText)
    expect(result.originalQuestionText).toBe(mockExercise.questionText)
  })

  it('gracefully falls back on errors', async () => {
    const mockExercise = {
      id: 'ex-1',
      topicId: 'topic-1',
      questionText: 'What is above?',
      topic: { id: 'topic-1', courseId: 'course-1', className: 'Current Exercise Topic' }
    }

    vi.mocked(prisma.topic.findMany).mockRejectedValueOnce(new Error('DB Error'))

    const result = await enrichExerciseWithContext(mockExercise)
    expect(result).toEqual(mockExercise)
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
      { id: 's1', mode: 'exam', exerciseIds: '["a","b","c"]', logs: [] },
      { id: 's2', mode: 'study', exerciseIds: null, logs: [] },
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
    expect(result[0].exerciseCount).toBe(3)
    expect(result[0]).not.toHaveProperty('exerciseIds')
    expect(result[1].exerciseCount).toBeNull()
  })

  it('getStudyPlans selects sessions with the list select (no chatLog)', async () => {
    vi.mocked(prisma.studyPlan.findMany).mockResolvedValueOnce([
      { id: 'p1', sessions: [{ id: 's1', exerciseIds: '["a"]', logs: [] }] },
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

  it('getSessionWithExercises loads exercises with a topic select that has no content', async () => {
    vi.mocked(prisma.studySession.findUnique).mockResolvedValueOnce(
      { id: 's1', exerciseIds: '["e2","e1"]', logs: [] } as never
    )
    vi.mocked(prisma.exercise.findMany).mockResolvedValueOnce([{ id: 'e1' }, { id: 'e2' }] as never)

    const data = await getSessionWithExercises('s1')

    expect(callArg(prisma.studySession.findUnique)).not.toHaveProperty('select.chatLog')
    const exArgs = callArg(prisma.exercise.findMany)
    expect(exArgs).not.toHaveProperty('include')
    expect(exArgs).not.toHaveProperty('select.topic.select.content')
    expect(exArgs).toHaveProperty('select.topic.select.course.select.code', true)
    expect(data?.exercises.map(e => e?.id)).toEqual(['e2', 'e1'])
    expect(data?.session).not.toHaveProperty('exerciseIds')
    expect(data?.session.exerciseCount).toBe(2)
  })

  it('createStudySession returns exercises re-read without topic content', async () => {
    const candidate = {
      id: 'e1', topicId: 't1', questionText: 'Q', enrichedAt: new Date(),
      topic: { id: 't1', title: 'T', courseId: 'c1', content: 'HUGE' },
    }
    vi.mocked(prisma.exercise.findMany)
      .mockResolvedValueOnce([candidate] as never) // candidate pool
      .mockResolvedValueOnce([{ id: 'e1', topic: { id: 't1' } }] as never) // client select
    vi.mocked(prisma.topic.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.exerciseLog.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.studySession.create).mockResolvedValueOnce({ id: 's1' } as never)

    const res = await createStudySession([], 1, 'study', null, 0)

    const clientArgs = callArg(prisma.exercise.findMany, 1)
    expect(clientArgs).not.toHaveProperty('select.topic.select.content')
    expect(clientArgs).toHaveProperty('select.questionText', true)
    expect(res.exercises).toEqual([{ id: 'e1', topic: { id: 't1' } }])
  })
})

describe('createStudySession calibration module', () => {
  const profileJson = (calibrationModule: string | null) => JSON.stringify({ ...defaultProfile({ title: 'C' }), calibrationModule })

  it('draws candidates from the whole course when a selected topic is in the profile calibrationModule', async () => {
    vi.mocked(prisma.topic.findMany).mockResolvedValue([{ id: 'cal', courseId: 'c1', week: 'Final review', course: { code: 'x' } }] as never)
    vi.mocked(prisma.course.findUnique).mockResolvedValue({ id: 'c1', code: 'x', title: 'C', profile: profileJson('Final review') } as never)
    vi.mocked(prisma.exercise.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.studySession.create).mockResolvedValueOnce({ id: 's1' } as never)

    await createStudySession(['cal'], 5, 'study', null, 50)

    expect(prisma.exercise.findMany).toHaveBeenCalledWith({
      where: { topic: { courseId: 'c1' }, isGraded: true, status: 'active' },
      include: { topic: true },
    })
  })

  it('keeps the selected topics when the profile has no calibrationModule, even for a week named like a review', async () => {
    vi.mocked(prisma.topic.findMany).mockResolvedValue([{ id: 't1', courseId: 'c1', week: 'Week_13_Comprehensive_Review', course: { code: 'x' } }] as never)
    vi.mocked(prisma.course.findUnique).mockResolvedValue({ id: 'c1', code: 'x', title: 'C', profile: profileJson(null) } as never)
    vi.mocked(prisma.exercise.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.studySession.create).mockResolvedValueOnce({ id: 's1' } as never)

    await createStudySession(['t1'], 5, 'study', null, 50)

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

describe('createStudySession graded filter', () => {
  it('queries only graded, active exercises', async () => {
    vi.clearAllMocks()
    vi.mocked(prisma.exercise.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.topic.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.exerciseLog.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.studySession.create).mockResolvedValue({ id: 's1' } as never)

    await createStudySession(['t1'], 1, 'study', null, 0)
    await createStudySession([], 1, 'study', null, 0)

    const first = vi.mocked(prisma.exercise.findMany).mock.calls[0][0] as { where: unknown }
    const second = vi.mocked(prisma.exercise.findMany).mock.calls[1][0] as { where?: unknown; data?: Record<string, unknown> }
    expect(first.where).toMatchObject({ topicId: { in: ['t1'] }, isGraded: true, status: 'active' })
    expect(second.where).toMatchObject({ isGraded: true, status: 'active' })
  })
})

describe('logAnswer', () => {
  const exercise = { exerciseType: 'single_choice', choices: '["A","B"]', correctAnswer: 'A', questionText: 'Q?' }

  it('grades on the server and stores isCorrect and score (the client sends no correctness)', async () => {
    vi.mocked(prisma.exercise.findUnique).mockResolvedValueOnce(exercise as never)
    const r = await logAnswer('s1', 'e1', 'A', { duration: 12 })
    expect(r).toEqual({ score: 1, isCorrect: true })
    const data = (vi.mocked(prisma.exerciseLog.create).mock.calls[0][0] as { data: Record<string, unknown> }).data
    expect(data).toMatchObject({ sessionId: 's1', exerciseId: 'e1', isCorrect: true, score: 1, userAnswer: 'A', duration: 12, assisted: false })
  })

  it('stores a wrong answer as score 0 whatever the caller believes', async () => {
    vi.mocked(prisma.exercise.findUnique).mockResolvedValueOnce(exercise as never)
    const r = await logAnswer('s1', 'e1', 'B')
    expect(r).toEqual({ score: 0, isCorrect: false })
    expect((vi.mocked(prisma.exerciseLog.create).mock.calls[0][0] as { data: Record<string, unknown> }).data).toMatchObject({ isCorrect: false, score: 0, duration: 30 })
  })

  it('ignores a non-string answer (stale client passing the old boolean argument)', async () => {
    await expect(logAnswer('s1', 'e1', true as unknown as string)).resolves.toBeNull()
    expect(prisma.exerciseLog.create).not.toHaveBeenCalled()
  })

  it('returns null for an unknown exercise without logging', async () => {
    vi.mocked(prisma.exercise.findUnique).mockResolvedValueOnce(null as never)
    await expect(logAnswer('s1', 'nope', 'A')).resolves.toBeNull()
    expect(prisma.exerciseLog.create).not.toHaveBeenCalled()
  })

  it('swallows a unique violation (P2002) so the first attempt wins, and returns the stored result', async () => {
    vi.mocked(prisma.exercise.findUnique).mockResolvedValueOnce(exercise as never)
    vi.mocked(prisma.exerciseLog.create).mockRejectedValueOnce(Object.assign(new Error('Unique constraint'), { code: 'P2002' }))
    vi.mocked(prisma.exerciseLog.findUnique).mockResolvedValueOnce({ score: 0, isCorrect: false } as never)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(logAnswer('s1', 'e1', 'A')).resolves.toEqual({ score: 0, isCorrect: false })
    expect(err).not.toHaveBeenCalled()
    err.mockRestore()
  })

  it('still reports other errors (logged, not thrown)', async () => {
    vi.mocked(prisma.exercise.findUnique).mockResolvedValueOnce(exercise as never)
    vi.mocked(prisma.exerciseLog.create).mockRejectedValueOnce(Object.assign(new Error('FK failed'), { code: 'P2003' }))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(logAnswer('s1', 'e1', 'A')).resolves.toBeNull()
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })
})

describe('cancelStudySession', () => {
  it('marks the session cancelled with an end time and writes no logs', async () => {
    vi.clearAllMocks()
    vi.mocked(prisma.studySession.update).mockResolvedValueOnce({ id: 's1', status: 'cancelled' } as never)
    await cancelStudySession('s1')
    const arg = vi.mocked(prisma.studySession.update).mock.calls[0][0] as { where: unknown; data: Record<string, unknown> }
    expect(arg.where).toEqual({ id: 's1' })
    expect(arg.data.status).toBe('cancelled')
    expect(arg.data.endTime).toBeInstanceOf(Date)
    expect(prisma.exerciseLog.create).not.toHaveBeenCalled()
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
