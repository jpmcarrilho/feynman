import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { explainMistake, generateNextExercise, getSessionHistory, getSessionDetail, getSessionWithExercises, getStudyPlans, createStudySession, needsContextEnrichment, enrichExerciseWithContext, getPreviousLectureTranscripts, deleteStudySession, saveChatLog } from './actions'
import { generateText, generateObject } from 'ai'
import { prisma } from '@/lib/db'

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
      findMany: vi.fn(),
    },
    exercise: {
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    studyPlan: {
      findMany: vi.fn(),
    },
    studySession: {
      findMany: vi.fn(),
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    exerciseLog: {
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}))

// Mock fs to simulate outlines on disk
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn(() => JSON.stringify([
      {
        sectionTitle: 'Section 1',
        links: [
          { text: 'Previous Lecture Topic' },
          { text: 'Current Exercise Topic' }
        ]
      }
    ])),
  }
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

    const mockGeneratedObject = {
      newExercise: {
        questionText: 'Test generated question?',
        exerciseType: 'single_choice',
        choices: ['A', 'B'],
        correctAnswer: 'A',
        explanation: 'Because it is correct.'
      }
    }
    vi.mocked(generateObject).mockResolvedValueOnce({ object: mockGeneratedObject } as any)

    const mockCreatedExercise = {
      id: 'ex-new',
      topicId: 'topic-1',
      questionText: 'Test generated question?',
      exerciseType: 'single_choice',
      choices: JSON.stringify(['A', 'B']),
      correctAnswer: 'A',
      explanation: 'Because it is correct.'
    }
    vi.mocked(prisma.exercise.create).mockResolvedValueOnce(mockCreatedExercise as any)

    const mockSession = { id: 'session-1', exerciseIds: JSON.stringify(['ex-old']) }
    vi.mocked(prisma.studySession.findUnique).mockResolvedValueOnce(mockSession as any)

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
        choices: JSON.stringify(['A', 'B']),
        correctAnswer: 'A',
        explanation: 'Because it is correct.'
      },
      include: { topic: true }
    })

    // Verify studySession.update was called
    expect(prisma.studySession.update).toHaveBeenCalledWith({
      where: { id: 'session-1' },
      data: { exerciseIds: JSON.stringify(['ex-old', 'ex-new']) }
    })

    expect(result).toEqual(mockCreatedExercise)
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
  it('searches backwards in outline and returns preceding transcript text', async () => {
    vi.mocked(prisma.course.findUnique).mockResolvedValueOnce({ code: 'JPAL102x' } as any)
    vi.mocked(prisma.topic.findMany).mockResolvedValueOnce([
      { id: 't-prev', title: 'Prev Video Title', content: 'Here is the transcript for context.' }
    ] as any)

    const result = await getPreviousLectureTranscripts('course-1', 'Current Exercise Topic')

    expect(prisma.course.findUnique).toHaveBeenCalledWith({ where: { id: 'course-1' } })
    expect(prisma.topic.findMany).toHaveBeenCalledWith({
      where: {
        courseId: 'course-1',
        className: 'Previous Lecture Topic',
        resourceType: 'Transcript .txt'
      }
    })

    expect(result).toContain('Here is the transcript for context.')
  })
})

describe('enrichExerciseWithContext action', () => {
  it('calls generateObject and updates exercise with enriched marker', async () => {
    const mockTopic = { id: 'topic-1', title: 'Current Topic', courseId: 'course-1', week: 'week-1', className: 'Current Exercise Topic' }
    const mockExercise = {
      id: 'ex-1',
      topicId: 'topic-1',
      questionText: 'Which step is missing in the process described in the above figure?',
      topic: mockTopic
    }

    vi.mocked(prisma.course.findUnique).mockResolvedValueOnce({ code: 'JPAL102x' } as any)
    vi.mocked(prisma.topic.findMany).mockResolvedValueOnce([
      { id: 't-prev', title: 'Prev Video Title', content: 'Here is the transcript for context.' }
    ] as any)

    const mockEnrichedText = 'Which step is missing in the data entry double entry verification process?'
    vi.mocked(generateObject).mockResolvedValueOnce({
      object: { enrichedQuestionText: mockEnrichedText }
    } as any)

    const result = await enrichExerciseWithContext(mockExercise)

    expect(generateObject).toHaveBeenCalledTimes(1)
    expect(prisma.exercise.update).toHaveBeenCalledWith({
      where: { id: 'ex-1' },
      data: { questionText: `<!-- enriched -->\n${mockEnrichedText}` }
    })

    expect(result.questionText).toBe(`<!-- enriched -->\n${mockEnrichedText}`)
  })

  it('gracefully falls back on errors', async () => {
    const mockExercise = {
      id: 'ex-1',
      topicId: 'topic-1',
      questionText: 'What is above?',
      topic: { id: 'topic-1', courseId: 'course-1', className: 'Current Exercise Topic' }
    }

    vi.mocked(prisma.course.findUnique).mockRejectedValueOnce(new Error('DB Error'))

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
