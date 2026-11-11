import { describe, it, expect, vi, beforeEach } from 'vitest'
import { generateObject } from 'ai'
import { prisma } from '@/lib/db'
import { generateExerciseForTopic, fetchRigorExamples } from './exerciseGenerator'
import { defaultProfile, type TutorProfile } from '@/lib/studyspace/profile'

vi.mock('ai', () => ({ generateText: vi.fn(), generateObject: vi.fn() }))
vi.mock('@ai-sdk/google', () => ({ google: vi.fn(() => 'mocked-google-model') }))
vi.mock('@/lib/db', () => ({
  prisma: {
    course: { findUnique: vi.fn() },
    topic: { findUnique: vi.fn(), findMany: vi.fn() },
    exercise: { findMany: vi.fn(), create: vi.fn() },
  },
}))

const generated = {
  newExercise: { questionText: 'Q?', exerciseType: 'single_choice', choices: ['A', 'B'], correctAnswer: 'A', explanation: 'E' },
}

function setup(topic: Record<string, unknown>, profile: TutorProfile, rigorExercises: unknown[] = []) {
  vi.mocked(prisma.topic.findUnique).mockResolvedValue({ id: 't1', courseId: 'c1', title: 'Topic', week: 'W1', content: 'body', isQuantitative: false, ...topic } as never)
  vi.mocked(prisma.topic.findMany).mockResolvedValue([{ id: 't1', title: 'Topic', content: 'body' }] as never)
  vi.mocked(prisma.course.findUnique).mockResolvedValue({ id: 'c1', code: 'x1', title: 'Course', profile: JSON.stringify(profile) } as never)
  vi.mocked(prisma.exercise.findMany).mockImplementation((async (args: { where?: { topicId?: unknown } }) =>
    args?.where?.topicId && typeof args.where.topicId === 'object' && 'in' in (args.where.topicId as object) && (args.where.topicId as { in: string[] }).in[0] === 'cal1' ? rigorExercises : []) as never)
  vi.mocked(generateObject).mockResolvedValue({ object: generated } as never)
  vi.mocked(prisma.exercise.create).mockResolvedValue({ id: 'gen-1' } as never)
}

const promptOf = () => vi.mocked(generateObject).mock.calls[0][0].prompt as string

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(Math, 'random').mockReturnValue(0.9)
})

describe('generateExerciseForTopic', () => {
  it('returns null when the primary topic does not exist', async () => {
    vi.mocked(prisma.topic.findUnique).mockResolvedValue(null)
    expect(await generateExerciseForTopic({ primaryTopicId: 'nope', poolTopicIds: [], existingExerciseIds: [] })).toBeNull()
    expect(generateObject).not.toHaveBeenCalled()
  })

  it('uses the quantitative mix for quantitative topics and the other mix otherwise, cycling by existing count', async () => {
    const profile = { ...defaultProfile({ title: 'Course' }), questionTypeMix: { single_choice: 1, multiple_choice: 0, numeric: 0, dropdown: 0 }, quantitativeQuestionTypeMix: { single_choice: 0, multiple_choice: 0, numeric: 1, dropdown: 0 } }
    setup({ isQuantitative: true }, profile)
    await generateExerciseForTopic({ primaryTopicId: 't1', poolTopicIds: ['t1'], existingExerciseIds: ['e1', 'e2', 'e3'] })
    expect(promptOf()).toContain('exercise of type: "numeric"')

    vi.mocked(generateObject).mockClear()
    setup({ isQuantitative: false }, profile)
    await generateExerciseForTopic({ primaryTopicId: 't1', poolTopicIds: ['t1'], existingExerciseIds: [] })
    expect(promptOf()).toContain('exercise of type: "single_choice"')
  })

  it('follows the legacy cycles override when the profile has one', async () => {
    const profile = { ...defaultProfile({ title: 'Course' }), questionTypeCycles: { quantitative: ['dropdown', 'numeric'] as never, qualitative: ['multiple_choice'] as never } }
    setup({ isQuantitative: true }, profile)
    await generateExerciseForTopic({ primaryTopicId: 't1', poolTopicIds: ['t1'], existingExerciseIds: ['e1'] })
    expect(promptOf()).toContain('exercise of type: "numeric"')
  })

  it('omits the calibration section when calibrationModule is null and includes it when examples exist', async () => {
    setup({}, { ...defaultProfile({ title: 'Course' }), calibrationModule: null }, [{ exerciseType: 'single_choice', questionText: 'Hard Q', choices: '[]', correctAnswer: 'A' }])
    await generateExerciseForTopic({ primaryTopicId: 't1', poolTopicIds: ['t1'], existingExerciseIds: [] })
    expect(promptOf()).not.toContain('CRITICAL DIFFICULTY & RIGOR CALIBRATION')

    vi.mocked(generateObject).mockClear()
    vi.mocked(prisma.topic.findMany).mockImplementation((async (args: { where?: { week?: string } }) =>
      args?.where?.week === 'Final' ? [{ id: 'cal1' }] : [{ id: 't1', title: 'Topic', content: 'body' }]) as never)
    vi.mocked(prisma.course.findUnique).mockResolvedValue({ id: 'c1', code: 'x1', title: 'Course', profile: JSON.stringify({ ...defaultProfile({ title: 'Course' }), calibrationModule: 'Final' }) } as never)
    await generateExerciseForTopic({ primaryTopicId: 't1', poolTopicIds: ['t1'], existingExerciseIds: [] })
    expect(promptOf()).toContain('CRITICAL DIFFICULTY & RIGOR CALIBRATION')
    expect(promptOf()).toContain('Question: Hard Q')
  })

  it('stores the exercise (choices pass through the shuffle) and does not touch sessions', async () => {
    setup({}, defaultProfile({ title: 'Course' }))
    const res = await generateExerciseForTopic({ primaryTopicId: 't1', poolTopicIds: ['t1'], existingExerciseIds: [] })
    expect(res).toEqual({ id: 'gen-1' })
    expect(prisma.exercise.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ id: expect.stringMatching(/^gen-/), topicId: 't1', questionText: 'Q?', correctAnswer: 'A', choices: JSON.stringify(['A', 'B']) }),
      include: { topic: true },
    })
  })
})

describe('fetchRigorExamples', () => {
  it('returns an empty string without a calibration module and does not query', async () => {
    expect(await fetchRigorExamples('c1', { ...defaultProfile({ title: 'C' }), calibrationModule: null })).toBe('')
    expect(prisma.topic.findMany).not.toHaveBeenCalled()
  })
})
