import { describe, it, expect, vi, beforeEach } from 'vitest'
import { generateObject } from 'ai'
import { prisma } from '@/lib/db'
import {
  generateExerciseForTopic,
  buildGenerationPrompt,
  fetchRigorExamples,
  selectContentWindow,
  describeSibling,
  buildBucketContext,
  classifyTopics,
  GenerationError,
  looksLikeBinary,
  chunkIds,
  fetchLocalStyleExamples,
  ID_CHUNK_SIZE,
  TARGET_CONTENT_CAP,
  SIBLING_LIMIT,
  SIBLING_EXCERPT_CHARS,
  CALIBRATION_CONTEXT_CAP,
  MAX_GENERATION_ATTEMPTS,
  ALREADY_ASKED_LIMIT,
  ALREADY_ASKED_CHARS,
  NOT_STUDY_MATERIAL_PREFIX,
  filterGeneratableTopicIds,
  generatedExerciseSchema,
} from './exerciseGenerator'
import { GENERATE_EXERCISE_PROMPT_VERSION } from '@/lib/prompts'
import { validateExerciseStructure } from '@/lib/exerciseValidation'
import { gradeAnswer } from '@/lib/grading'
import { defaultProfile, type TutorProfile } from '@/lib/studyspace/profile'

vi.mock('ai', () => ({ generateText: vi.fn(), generateObject: vi.fn() }))
vi.mock('@ai-sdk/google', () => ({ google: vi.fn(() => 'mocked-google-model') }))
vi.mock('@/lib/db', () => ({
  prisma: {
    course: { findUnique: vi.fn() },
    topic: { findUnique: vi.fn(), findMany: vi.fn() },
    $queryRaw: vi.fn(),
    exercise: { findMany: vi.fn(), create: vi.fn(), count: vi.fn() },
  },
}))

const generated = {
  newExercise: { contentKind: 'subject_matter', logisticsReason: '', questionText: 'Q?', exerciseType: 'single_choice', choices: ['A', 'B', 'C', 'D'], correctChoiceIndexes: [0], correctAnswer: '', explanation: 'E' },
}
const solvedRight = { answerable: true, issue: '', answer: ['A'] }

/** Generation prompts get `gen`, the blind-solve prompt (a different call) gets `solve`. */
function mockModel(gen: unknown = generated, solve: unknown = solvedRight) {
  vi.mocked(generateObject).mockImplementation((async (args: { prompt: string }) =>
    ({ object: args.prompt.includes('You are a student taking a quiz') ? solve : gen })) as never)
}

function setup(topic: Record<string, unknown>, profile: TutorProfile, rigorExercises: unknown[] = []) {
  vi.mocked(prisma.topic.findUnique).mockResolvedValue({ id: 't1', courseId: 'c1', title: 'Topic', week: 'W1', content: 'body', isQuantitative: false, ...topic } as never)
  vi.mocked(prisma.topic.findMany).mockResolvedValue([{ id: 't1', title: 'Topic', content: 'body', resourceType: 'Transcript' }] as never)
  vi.mocked(prisma.$queryRaw).mockResolvedValue([] as never)
  vi.mocked(prisma.course.findUnique).mockResolvedValue({ id: 'c1', code: 'x1', title: 'Course', profile: JSON.stringify(profile) } as never)
  vi.mocked(prisma.exercise.findMany).mockImplementation((async (args: { where?: { topicId?: unknown } }) =>
    args?.where?.topicId && typeof args.where.topicId === 'object' && 'in' in (args.where.topicId as object) && (args.where.topicId as { in: string[] }).in[0] === 'cal1' ? rigorExercises : []) as never)
  mockModel()
  vi.mocked(prisma.exercise.count).mockResolvedValue(0 as never)
  vi.mocked(prisma.exercise.create).mockResolvedValue({ id: 'gen-1' } as never)
}

/** Answers the logistics-marker query with `markers` and every other exercise query with `rows`. */
function mockExerciseRows(rows: unknown[], markers: unknown[] = []) {
  vi.mocked(prisma.exercise.findMany).mockImplementation((async (args: { where?: { reportedReason?: unknown } }) =>
    args?.where?.reportedReason ? markers : rows) as never)
}

const promptOf = () => vi.mocked(generateObject).mock.calls[0][0].prompt as string

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(Math, 'random').mockReturnValue(0.9)
})

describe('generateExerciseForTopic', () => {
  it('throws a GenerationError when the primary topic does not exist', async () => {
    vi.mocked(prisma.topic.findUnique).mockResolvedValue(null)
    vi.mocked(prisma.topic.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.exercise.findMany).mockResolvedValue([] as never)
    await expect(generateExerciseForTopic({ primaryTopicId: 'nope', poolTopicIds: [], existingExerciseIds: [] })).rejects.toMatchObject({ code: 'topic_not_found' })
    expect(generateObject).not.toHaveBeenCalled()
  })

  it('refuses a primary topic without content, before any model call', async () => {
    setup({ content: '' }, defaultProfile({ title: 'Course' }))
    vi.mocked(prisma.topic.findMany).mockImplementation((async (args: { where: { AND?: unknown } }) =>
      args.where.AND ? [] : [{ id: 't1', resourceType: null }]) as never) // exists, content filter finds nothing
    await expect(generateExerciseForTopic({ primaryTopicId: 't1', poolTopicIds: ['t1'], existingExerciseIds: [] })).rejects.toMatchObject({ code: 'no_content' })
    expect(generateObject).not.toHaveBeenCalled()
    expect(prisma.exercise.create).not.toHaveBeenCalled()
  })

  it('refuses a primary topic that only holds ungraded exercises', async () => {
    setup({}, defaultProfile({ title: 'Course' }))
    mockExerciseRows([{ topicId: 't1', isGraded: false }])
    await expect(generateExerciseForTopic({ primaryTopicId: 't1', poolTopicIds: ['t1'], existingExerciseIds: [] })).rejects.toMatchObject({ code: 'ungraded_only' })
    expect(generateObject).not.toHaveBeenCalled()
  })

  it('lets model errors propagate and stores nothing', async () => {
    setup({}, defaultProfile({ title: 'Course' }))
    vi.mocked(generateObject).mockRejectedValue(new Error('provider down'))
    await expect(generateExerciseForTopic({ primaryTopicId: 't1', poolTopicIds: ['t1'], existingExerciseIds: [] })).rejects.toThrow('provider down')
    expect(prisma.exercise.create).not.toHaveBeenCalled()
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
      data: expect.objectContaining({
        id: expect.stringMatching(/^gen-/),
        topicId: 't1',
        questionText: 'Q?',
        correctAnswer: 'A',
        choices: JSON.stringify(['A', 'B', 'C', 'D']),
        origin: 'generated',
        status: 'active',
        promptVersion: GENERATE_EXERCISE_PROMPT_VERSION,
      }),
      include: { topic: true },
    })
  })
})

describe('generateExerciseForTopic validation', () => {
  const args = { primaryTopicId: 't1', poolTopicIds: ['t1'], existingExerciseIds: [] as string[] }
  const solverCalls = () => vi.mocked(generateObject).mock.calls.filter((c) => (c[0].prompt as string).includes('You are a student taking a quiz'))
  const created = () => vi.mocked(prisma.exercise.create).mock.calls.map((c) => c[0].data as Record<string, unknown>)

  it('sends the solver only what the student sees: no topic content, answer key or explanation', async () => {
    setup({ content: 'SECRET-TOPIC-CONTENT' }, defaultProfile({ title: 'Course' }))
    mockModel({ newExercise: { ...generated.newExercise, correctChoiceIndexes: [3], correctAnswer: '', choices: ['A', 'B', 'C', 'ANSWER-KEY-D'], explanation: 'EXPLAIN-TEXT' } }, { answerable: true, issue: '', answer: ['ANSWER-KEY-D'] })
    await generateExerciseForTopic(args)
    const prompt = solverCalls()[0][0].prompt as string
    expect(prompt).toContain('Q?')
    expect(prompt).toContain('- A')
    expect(prompt).not.toContain('SECRET-TOPIC-CONTENT')
    expect(prompt).not.toContain('EXPLAIN-TEXT')
    // the stored key is not marked anywhere: the choice that is the key is listed like the others
    expect(prompt).not.toMatch(/Correct Answer|Official Explanation/)
  })

  it('stores a rejected row and retries when the blind solve disagrees, then returns the accepted question', async () => {
    setup({}, defaultProfile({ title: 'Course' }))
    vi.mocked(generateObject).mockReset()
    vi.mocked(generateObject)
      .mockResolvedValueOnce({ object: generated } as never)
      .mockResolvedValueOnce({ object: { answerable: true, issue: '', answer: ['B'] } } as never)
      .mockResolvedValueOnce({ object: generated } as never)
      .mockResolvedValueOnce({ object: solvedRight } as never)
    vi.mocked(prisma.exercise.create).mockResolvedValue({ id: 'gen-ok' } as never)

    const res = await generateExerciseForTopic(args)

    expect(res).toEqual({ id: 'gen-ok' })
    const rows = created()
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ status: 'rejected', origin: 'generated', topicId: 't1', promptVersion: GENERATE_EXERCISE_PROMPT_VERSION })
    expect(rows[0].reportedReason).toMatch(/^blind_solve\[.*\]: mismatch/)
    expect(rows[1]).toMatchObject({ status: 'active' })
  })

  it('rejects a structurally invalid question without spending a blind solve', async () => {
    setup({}, defaultProfile({ title: 'Course' }))
    mockModel({ newExercise: { ...generated.newExercise, choices: ['A', 'B'] } })
    await expect(generateExerciseForTopic(args)).rejects.toMatchObject({ code: 'validation_failed' })
    expect(solverCalls()).toHaveLength(0)
    expect(created()[0]).toMatchObject({ status: 'rejected' })
    expect(created()[0].reportedReason).toMatch(/^structural: choice_count/)
  })

  it('rejects a question the solver says cannot be answered from its own text (exam rules example)', async () => {
    setup({}, defaultProfile({ title: 'Course' }))
    mockModel(
      { newExercise: { questionText: 'According to the exam rules, which materials are you allowed to bring to the final?', exerciseType: 'single_choice', choices: ['A calculator', 'Open notes', 'A laptop', 'Nothing'], correctChoiceIndexes: [0], correctAnswer: '', explanation: 'The rules say so.' } },
      { answerable: false, issue: 'The exam rules are not stated in the question.', answer: ['A calculator'] },
    )
    await expect(generateExerciseForTopic(args)).rejects.toMatchObject({ code: 'validation_failed' })
    expect(created().every((r) => r.status === 'rejected')).toBe(true)
    expect(created()[0].reportedReason).toContain('not_answerable')
  })

  it('uses at most MAX_GENERATION_ATTEMPTS generations and as many blind solves, then fails with a student-safe message', async () => {
    setup({}, defaultProfile({ title: 'Course' }))
    mockModel(generated, { answerable: true, issue: '', answer: ['C'] })
    const err = await generateExerciseForTopic(args).catch((e) => e)
    expect(err).toBeInstanceOf(GenerationError)
    expect(err.userMessage).not.toMatch(/gemini|api|key/i)
    expect(vi.mocked(generateObject)).toHaveBeenCalledTimes(MAX_GENERATION_ATTEMPTS * 2)
    expect(created()).toHaveLength(MAX_GENERATION_ATTEMPTS)
    expect(created().every((r) => r.status === 'rejected')).toBe(true)
  })

  it('stores one marker row, skips the blind solve and does not retry when the model says the content is logistics', async () => {
    setup({}, defaultProfile({ title: 'Course' }))
    mockModel({ newExercise: { contentKind: 'logistics', logisticsReason: 'Exam rules and submission limits.', questionText: '', exerciseType: 'single_choice', choices: [], correctChoiceIndexes: [], correctAnswer: '', explanation: '' } })
    await expect(generateExerciseForTopic(args)).rejects.toMatchObject({ code: 'not_study_material' })
    expect(vi.mocked(generateObject)).toHaveBeenCalledTimes(1)
    expect(solverCalls()).toHaveLength(0)
    expect(created()).toHaveLength(1)
    expect(created()[0]).toMatchObject({
      topicId: 't1',
      status: 'rejected',
      isGraded: false,
      promptVersion: GENERATE_EXERCISE_PROMPT_VERSION,
      reportedReason: `${NOT_STUDY_MATERIAL_PREFIX}: Exam rules and submission limits.`,
    })
  })

  it('refuses a topic that already carries the marker before any model call', async () => {
    setup({}, defaultProfile({ title: 'Course' }))
    mockExerciseRows([], [{ topicId: 't1' }])
    await expect(generateExerciseForTopic(args)).rejects.toMatchObject({ code: 'not_study_material' })
    expect(generateObject).not.toHaveBeenCalled()
  })

  it('asks the model to judge the content first, and asks for the logistics fields in the schema', async () => {
    setup({}, defaultProfile({ title: 'Course' }))
    await generateExerciseForTopic(args)
    expect(promptOf()).toContain('FIRST, JUDGE THE TARGET CONTENT')
    expect(promptOf()).toMatch(/honor code/)
    expect(generatedExerciseSchema.safeParse({ newExercise: { contentKind: 'logistics', logisticsReason: 'x', questionText: '', exerciseType: 'single_choice', choices: [], correctChoiceIndexes: [], correctAnswer: '', explanation: '' } }).success).toBe(true)
    expect(GENERATE_EXERCISE_PROMPT_VERSION).toBe('gen-v6')
  })

  it('lets a solver error propagate and stores nothing for that attempt', async () => {
    setup({}, defaultProfile({ title: 'Course' }))
    vi.mocked(generateObject).mockReset()
    vi.mocked(generateObject).mockResolvedValueOnce({ object: generated } as never).mockRejectedValueOnce(new Error('provider down'))
    await expect(generateExerciseForTopic(args)).rejects.toThrow('provider down')
    expect(prisma.exercise.create).not.toHaveBeenCalled()
  })
})

describe('correct answers are derived from correctChoiceIndexes', () => {
  const args = { primaryTopicId: 't1', poolTopicIds: ['t1'], existingExerciseIds: [] as string[] }
  const created = () => vi.mocked(prisma.exercise.create).mock.calls.map((c) => c[0].data as Record<string, unknown>)
  const latexChoices = ['$\\frac{\\sigma}{\\sqrt{n}}$', '$\\beta$', '$\\theta$', '$1{,}5$', '$\\nu$']
  const base = { contentKind: 'subject_matter', logisticsReason: '', questionText: 'Which of these are correct?', exerciseType: 'multiple_choice', choices: latexChoices, correctChoiceIndexes: [0, 2, 4], correctAnswer: '', explanation: 'Because.' }
  const solved = (answer: string[]) => ({ answerable: true, issue: '', answer })

  it('stores a multiple-choice key that parses to exactly the selected LaTeX option strings, and it validates and grades', async () => {
    setup({}, defaultProfile({ title: 'Course' }))
    mockModel({ newExercise: base }, solved([latexChoices[0], latexChoices[2], latexChoices[4]]))
    await generateExerciseForTopic(args)
    const row = created()[0]
    expect(row.status).toBe('active')
    const stored = row.correctAnswer as string
    expect(JSON.parse(stored)).toEqual([latexChoices[0], latexChoices[2], latexChoices[4]])
    // byte for byte: the backslash sequences stayed backslashes, not \f \t \n control characters
    expect(stored).toBe(JSON.stringify([latexChoices[0], latexChoices[2], latexChoices[4]]))
    expect(stored).not.toMatch(/[\u0000-\u001f]/)
    const ex = { questionText: base.questionText, exerciseType: 'multiple_choice', choices: JSON.parse(row.choices as string) as string[], correctAnswer: stored, explanation: 'Because.' }
    expect(validateExerciseStructure(ex)).toEqual([])
    expect(gradeAnswer(ex, JSON.stringify([latexChoices[4], latexChoices[0], latexChoices[2]])).isCorrect).toBe(true)
    expect(gradeAnswer(ex, JSON.stringify([latexChoices[0], latexChoices[2]])).isCorrect).toBe(false)
  })

  it('ignores whatever the model wrote in correctAnswer for a choice type', async () => {
    setup({}, defaultProfile({ title: 'Course' }))
    mockModel({ newExercise: { ...base, correctAnswer: '["$\\beta$"' } }, solved([latexChoices[0], latexChoices[2], latexChoices[4]]))
    await generateExerciseForTopic(args)
    expect(JSON.parse(created()[0].correctAnswer as string)).toEqual([latexChoices[0], latexChoices[2], latexChoices[4]])
  })

  it('derives the exact option text for single choice and dropdown', async () => {
    setup({}, defaultProfile({ title: 'Course' }))
    mockModel({ newExercise: { ...base, exerciseType: 'single_choice', choices: ['one', 'two', 'three', '$\\theta$'], correctChoiceIndexes: [3] } }, solved(['$\\theta$']))
    await generateExerciseForTopic(args)
    expect(created()[0]).toMatchObject({ status: 'active', correctAnswer: '$\\theta$' })

    vi.mocked(prisma.exercise.create).mockClear()
    mockModel({ newExercise: { ...base, exerciseType: 'dropdown', questionText: 'The mean is [Dropdown 1].', choices: ['biased', 'unbiased', 'noisy'], correctChoiceIndexes: [1] } }, solved(['unbiased']))
    await generateExerciseForTopic(args)
    expect(created()[0]).toMatchObject({ status: 'active', correctAnswer: 'unbiased' })
  })

  it('keeps a numeric answer as written', async () => {
    setup({}, defaultProfile({ title: 'Course' }))
    mockModel({ newExercise: { ...base, exerciseType: 'numeric', choices: [], correctChoiceIndexes: [], correctAnswer: '2.5', questionText: 'Compute it. Please enter your numeric response rounded to two decimal places (for example, -0.07)' } }, solved(['2.5']))
    await generateExerciseForTopic(args)
    expect(created()[0]).toMatchObject({ status: 'active', correctAnswer: '2.5' })
  })

  it.each([
    ['out of range', 'multiple_choice', [0, 7]],
    ['negative', 'single_choice', [-1]],
    ['duplicate', 'multiple_choice', [1, 1]],
    ['empty for a choice type', 'multiple_choice', []],
    ['two for a single choice', 'single_choice', [0, 1]],
    ['non-integer', 'single_choice', [0.5]],
    ['non-empty for numeric', 'numeric', [0]],
  ])('rejects %s indexes as a structural failure, retries, and never runs a blind solve', async (_name, exerciseType, correctChoiceIndexes) => {
    setup({}, defaultProfile({ title: 'Course' }))
    const numeric = exerciseType === 'numeric'
    mockModel({ newExercise: { ...base, exerciseType, choices: numeric ? [] : latexChoices, correctChoiceIndexes, correctAnswer: numeric ? '2.5' : '' } })
    await expect(generateExerciseForTopic(args)).rejects.toMatchObject({ code: 'validation_failed' })
    expect(created()).toHaveLength(MAX_GENERATION_ATTEMPTS)
    expect(created().every((r) => r.status === 'rejected')).toBe(true)
    expect(created()[0].reportedReason).toMatch(/^structural: invalid_correct_choice_indexes \|/)
    expect(vi.mocked(generateObject)).toHaveBeenCalledTimes(MAX_GENERATION_ATTEMPTS)
  })

  it('asks for indexes in the schema and in the prompt, and never for option text or JSON in correctAnswer', async () => {
    setup({}, defaultProfile({ title: 'Course' }))
    await generateExerciseForTopic(args)
    const prompt = vi.mocked(generateObject).mock.calls[0][0].prompt as string
    expect(prompt).toContain('correctChoiceIndexes')
    expect(prompt).toMatch(/0-based position/)
    expect(prompt).not.toMatch(/JSON array string/)
    expect(prompt).toContain('Never copy or JSON-encode option texts')
    expect(generatedExerciseSchema.safeParse({ newExercise: { ...generated.newExercise, correctChoiceIndexes: undefined } }).success).toBe(false)
    expect(generatedExerciseSchema.safeParse({ newExercise: { ...generated.newExercise, correctChoiceIndexes: [1.5] } }).success).toBe(false)
  })
})

describe('rejected and reported rows are never read by generation', () => {
  it('style examples, rigor examples and the ungraded-only test exclude rejected rows; selection reads only active ones', async () => {
    vi.mocked(prisma.exercise.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.topic.findMany).mockResolvedValue([{ id: 'cal1' }] as never)
    await fetchLocalStyleExamples({ week: 'W1', courseId: 'c1', order: 1 }, ['t1'], [])
    await fetchRigorExamples('c1', { ...defaultProfile({ title: 'C' }), calibrationModule: 'Final' })
    const wheres = vi.mocked(prisma.exercise.findMany).mock.calls.map((c) => c[0]?.where as Record<string, unknown>)
    expect(wheres.length).toBeGreaterThanOrEqual(2)
    expect(wheres.every((w) => w.status === 'active')).toBe(true)

    vi.mocked(prisma.exercise.findMany).mockClear()
    vi.mocked(prisma.topic.findMany).mockResolvedValue([{ id: 't1', resourceType: null }] as never)
    vi.mocked(prisma.$queryRaw).mockResolvedValue([] as never)
    await classifyTopics(['t1'])
    expect(vi.mocked(prisma.exercise.findMany).mock.calls.map((c) => c[0]?.where)).toContainEqual(expect.objectContaining({ status: { not: 'rejected' } }))
  })

  it('the already-asked block keeps the most recent 30 questions, 300 characters each', async () => {
    setup({}, defaultProfile({ title: 'Course' }))
    const ids = Array.from({ length: 45 }, (_, i) => `e${i + 1}`)
    vi.mocked(prisma.exercise.findMany).mockImplementation((async (args: { where?: { id?: { in: string[] } } }) =>
      args?.where?.id?.in ? args.where.id.in.map((id) => ({ id, topicId: 't1', questionText: `${id} ${'x'.repeat(500)}` })) : []) as never)
    const { prompt } = await buildGenerationPrompt({ primaryTopicId: 't1', poolTopicIds: ['t1'], existingExerciseIds: ids })
    const block = prompt.slice(prompt.indexOf('ALREADY present'), prompt.indexOf('CRITICAL DEDUPLICATION RULES'))
    const entries = block.match(/Question \d+: .*/g) ?? []
    expect(entries).toHaveLength(ALREADY_ASKED_LIMIT)
    expect(entries[0]).toContain('e16 ')
    expect(block).toContain('e45 ')
    expect(block).not.toContain('e15 ')
    expect(entries.every((e) => e.length <= 'Question 30: '.length + ALREADY_ASKED_CHARS + 3)).toBe(true)
  })
})

describe('fetchRigorExamples', () => {
  it('returns an empty string without a calibration module and does not query', async () => {
    expect(await fetchRigorExamples('c1', { ...defaultProfile({ title: 'C' }), calibrationModule: null })).toBe('')
    expect(prisma.topic.findMany).not.toHaveBeenCalled()
  })
})

describe('selectContentWindow', () => {
  const text = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ')

  it('returns short content unchanged', () => {
    expect(selectContentWindow('abc', 10, 5)).toEqual({ text: 'abc', start: 0, end: 3, total: 3 })
  })

  it('never exceeds the cap, even for an 830k-character topic', () => {
    const content = text(150_000) // ~ 830k chars
    for (const rotation of [0, 1, 7, 34, 35, 100]) {
      const w = selectContentWindow(content, TARGET_CONTENT_CAP, rotation)
      expect(w.text.length).toBeLessThanOrEqual(TARGET_CONTENT_CAP)
      expect(w.text.length).toBeGreaterThan(TARGET_CONTENT_CAP - 400)
    }
  })

  it('is deterministic and rotates through the content with the rotation number', () => {
    const content = text(20_000)
    const windows = Math.ceil(content.length / TARGET_CONTENT_CAP)
    const a = selectContentWindow(content, TARGET_CONTENT_CAP, 0)
    expect(selectContentWindow(content, TARGET_CONTENT_CAP, 0)).toEqual(a)
    const b = selectContentWindow(content, TARGET_CONTENT_CAP, 1)
    expect(b.start).toBeGreaterThanOrEqual(a.end - 400)
    expect(a.start).toBe(0)
    expect(selectContentWindow(content, TARGET_CONTENT_CAP, windows)).toEqual(a) // wraps around
    const last = selectContentWindow(content, TARGET_CONTENT_CAP, windows - 1)
    expect(last.end).toBe(content.length) // the last window reaches the end
  })

  it('does not cut words at the edges', () => {
    const content = text(20_000)
    const w = selectContentWindow(content, TARGET_CONTENT_CAP, 1)
    expect(w.text).toMatch(/^w\d+/)
    expect(w.text).toMatch(/w\d+$/)
    expect(w.text.split(' ').every((tok) => /^w\d+$/.test(tok))).toBe(true)
  })
})

describe('describeSibling and buildBucketContext', () => {
  it('uses the summary when there is one and the start of the content when there is not', () => {
    expect(describeSibling({ title: 'A', summary: 'About A', content: 'ignored' })).toBe('- A: About A')
    const line = describeSibling({ title: 'B', summary: null, content: 'x'.repeat(5000) })
    expect(line).toBe(`- B: ${'x'.repeat(SIBLING_EXCERPT_CHARS)}`)
    expect(describeSibling({ title: 'C', summary: '  ', content: ' ' })).toBe('')
  })

  it('keeps the target within the cap and adds at most SIBLING_LIMIT sibling lines', () => {
    const siblings = Array.from({ length: 20 }, (_, i) => ({ title: `S${i}`, summary: `sum ${i}` }))
    const ctx = buildBucketContext({ title: 'Target', content: 'a'.repeat(830_000) }, siblings, 3, 'W4')
    const [targetPart, siblingPart] = ctx.split('\n\nOther topics in')
    expect(targetPart.length).toBeLessThanOrEqual(TARGET_CONTENT_CAP + 200) // header lines around the capped text
    expect(siblingPart.match(/^- S\d+: sum/gm)).toHaveLength(SIBLING_LIMIT)
    expect(siblingPart).toContain('"W4"')
  })

  it('has no sibling block without siblings and no excerpt note for short content', () => {
    const ctx = buildBucketContext({ title: 'T', content: 'short' }, [], 0, 'W1')
    expect(ctx).toBe('Unit/Topic: T\nContent:\nshort')
  })
})

describe('classifyTopics', () => {
  it('marks empty, ungraded-only and usable topics (a topic without exercises is usable)', async () => {
    vi.mocked(prisma.topic.findMany).mockResolvedValue([{ id: 'ok' }, { id: 'survey' }, { id: 'noex' }] as never)
    mockExerciseRows([
      { topicId: 'ok', isGraded: true },
      { topicId: 'ok', isGraded: false },
      { topicId: 'survey', isGraded: false },
    ])
    const m = await classifyTopics(['ok', 'survey', 'noex', 'blank'])
    expect(Object.fromEntries(m)).toEqual({ ok: 'ok', survey: 'ungraded_only', noex: 'ok', blank: 'missing' })
  })

  it('marks a topic with a not_study_material marker row as ineligible, ahead of the ungraded-only test', async () => {
    vi.mocked(prisma.topic.findMany).mockResolvedValue([{ id: 'welcome' }, { id: 'lecture' }] as never)
    mockExerciseRows([{ topicId: 'lecture', isGraded: true }], [{ topicId: 'welcome' }])
    const m = await classifyTopics(['welcome', 'lecture'])
    expect(Object.fromEntries(m)).toEqual({ welcome: 'not_study_material', lecture: 'ok' })
    expect(prisma.exercise.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: 'rejected', reportedReason: { startsWith: NOT_STUDY_MATERIAL_PREFIX } }),
    }))
    expect(await filterGeneratableTopicIds(['welcome', 'lecture'])).toEqual(['lecture'])
  })
})

describe('topics without usable content (failed extraction, binary)', () => {
  const nulHex = (n: number, total: number) => '00'.repeat(n) + '41'.repeat(total - n)

  it('looksLikeBinary: NUL-interleaved data is binary, text and a few stray NULs are not', () => {
    expect(looksLikeBinary('4100'.repeat(200))).toBe(true)
    expect(looksLikeBinary(nulHex(0, 500))).toBe(false)
    expect(looksLikeBinary(nulHex(3, 500))).toBe(false)
    expect(looksLikeBinary('')).toBe(false)
    expect(looksLikeBinary(null)).toBe(false)
  })

  it('classifies a resourceType containing "Error" as empty without reading any content', async () => {
    vi.mocked(prisma.topic.findMany).mockImplementation((async () => [{ id: 'bad', resourceType: 'Slides PDF Error' }]) as never)
    vi.mocked(prisma.exercise.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.$queryRaw).mockClear()
    const m = await classifyTopics(['bad'])
    expect(m.get('bad')).toBe('empty')
    expect(prisma.$queryRaw).not.toHaveBeenCalled()
  })

  it('classifies binary content as empty (prefix check) and keeps text with stray NULs', async () => {
    vi.mocked(prisma.topic.findMany).mockImplementation((async () => [{ id: 'bin', resourceType: 'Slides PDF' }, { id: 'txt', resourceType: 'Slides PDF' }]) as never)
    vi.mocked(prisma.exercise.findMany).mockResolvedValue([] as never)
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ id: 'bin', prefix: '4100'.repeat(200) }, { id: 'txt', prefix: nulHex(2, 500) }] as never)
    const m = await classifyTopics(['bin', 'txt'])
    expect(Object.fromEntries(m)).toEqual({ bin: 'empty', txt: 'ok' })
    // only the hex of a bounded prefix is requested, never the whole content
    const sql = JSON.stringify((vi.mocked(prisma.$queryRaw).mock.calls[0][0] as { strings?: string[]; sql?: string }))
    expect(sql).toMatch(/hex\(substr\(CAST\(content AS BLOB\)/)
  })

  it('refuses such a primary topic with no_content before loading its content', async () => {
    setup({}, defaultProfile({ title: 'Course' }))
    vi.mocked(prisma.topic.findMany).mockImplementation((async () => [{ id: 't1', resourceType: 'Slides PDF Error' }]) as never)
    await expect(buildGenerationPrompt({ primaryTopicId: 't1', poolTopicIds: ['t1'], existingExerciseIds: [] })).rejects.toMatchObject({ code: 'no_content' })
    expect(prisma.topic.findUnique).not.toHaveBeenCalled()
    expect(generateObject).not.toHaveBeenCalled()
  })

  it('leaves such siblings out of the grounding', async () => {
    setup({ week: 'W1', order: 10 }, defaultProfile({ title: 'Course' }))
    vi.mocked(prisma.topic.findMany).mockImplementation((async (args: { where: { id?: { in: string[] }; week?: string }; select?: Record<string, boolean> }) => {
      if (args.where.week === 'W1' && args.select?.order) {
        return [{ id: 'good', title: 'Good sibling', summary: 'Fine', order: 11 }, { id: 'bad', title: 'Broken sibling', summary: 'Garbage', order: 12 }]
      }
      const ids = args.where.id?.in ?? []
      return ids.map((id) => ({ id, resourceType: id === 'bad' ? 'Slides PDF Error' : 'Slides PDF' }))
    }) as never)
    const { bucketContext } = await buildGenerationPrompt({ primaryTopicId: 't1', poolTopicIds: ['t1', 'good', 'bad'], existingExerciseIds: [] })
    expect(bucketContext).toContain('Good sibling')
    expect(bucketContext).not.toContain('Broken sibling')
  })
})

describe('classifyTopics chunking', () => {
  it('queries in chunks so that very large sessions stay under the driver parameter limit', async () => {
    vi.mocked(prisma.topic.findMany).mockImplementation((async (args: { where: { id: { in: string[] } } }) => {
      expect(args.where.id.in.length).toBeLessThanOrEqual(300)
      return args.where.id.in.map((id) => ({ id }))
    }) as never)
    vi.mocked(prisma.exercise.findMany).mockResolvedValue([] as never)
    const ids = Array.from({ length: 700 }, (_, i) => `t${i}`)
    const m = await classifyTopics(ids)
    expect(m.size).toBe(700)
    expect(vi.mocked(prisma.topic.findMany)).toHaveBeenCalledTimes(6) // existence + content query per chunk
  })
})

describe('buildGenerationPrompt grounding', () => {
  it('grounds a topic with 830k characters on a capped window and short sibling descriptions', async () => {
    setup({ content: 'z'.repeat(830_000), week: 'W1', order: 10 }, defaultProfile({ title: 'Course' }))
    const poolIds = ['t1', ...Array.from({ length: 12 }, (_, i) => `s${i}`)]
    vi.mocked(prisma.topic.findMany).mockImplementation((async (args: { where: { id?: { in: string[] }; week?: string }; select?: Record<string, boolean> }) => {
      const ids = args.where.id?.in ?? []
      if (args.where.week === 'W1' && args.select?.order) {
        // the whole module, including a topic that is not in the pool
        return [...poolIds, 'not-in-pool'].map((id, i) => ({ id, title: `Sibling ${id}`, summary: id === 's0' ? 'Summary of s0' : null, order: 11 + i }))
      }
      if (args.select?.content) return ids.map((id) => ({ id, content: `start of ${id} ` + 'q'.repeat(5000) }))
      return ids.map((id) => ({ id })) // content filter
    }) as never)
    const { prompt, bucketContext } = await buildGenerationPrompt({ primaryTopicId: 't1', poolTopicIds: poolIds, existingExerciseIds: [] })
    const siblingBlock = bucketContext.split('Other topics in')[1]
    expect(bucketContext.length).toBeLessThanOrEqual(TARGET_CONTENT_CAP + 200 + siblingBlock.length + 20)
    expect(bucketContext.split('\n\nOther topics in')[0].length).toBeLessThanOrEqual(TARGET_CONTENT_CAP + 200)
    expect(siblingBlock.match(/^- Sibling/gm)).toHaveLength(SIBLING_LIMIT)
    expect(siblingBlock).toContain('- Sibling s0: Summary of s0')
    expect(siblingBlock).toContain(`- Sibling s1: start of s1 ${'q'.repeat(SIBLING_EXCERPT_CHARS - 'start of s1 '.length)}`)
    expect(siblingBlock).not.toContain('not-in-pool')
    expect(prompt).toContain(bucketContext)
    expect(prompt.length).toBeLessThan(TARGET_CONTENT_CAP + 20_000)
  })

  it('picks a different window of a long topic once the topic has more exercises', async () => {
    const content = Array.from({ length: 20_000 }, (_, i) => `w${i}`).join(' ')
    setup({ content }, defaultProfile({ title: 'Course' }))
    const first = (await buildGenerationPrompt({ primaryTopicId: 't1', poolTopicIds: ['t1'], existingExerciseIds: [] })).bucketContext
    vi.mocked(prisma.exercise.count).mockResolvedValue(1 as never)
    const second = (await buildGenerationPrompt({ primaryTopicId: 't1', poolTopicIds: ['t1'], existingExerciseIds: [] })).bucketContext
    expect(first).not.toBe(second)
    expect(first).toContain('w0 ')
    expect(second).not.toContain('Content:\nw0 ')
  })

  it('caps the calibration search context at CALIBRATION_CONTEXT_CAP in total', async () => {
    setup({ week: 'Final' }, { ...defaultProfile({ title: 'Course' }), calibrationModule: 'Final' })
    vi.mocked(prisma.exercise.findMany).mockResolvedValue([{ topicId: 'x', isGraded: true, questionText: 'What does Acemoglu say about institutions?' }] as never)
    vi.mocked(prisma.topic.findMany).mockImplementation((async (args: { where: Record<string, unknown>; select?: Record<string, boolean> }) => {
      if (args.select?.keyTerms) {
        return Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, title: `Lecture acemoglu ${i}`, week: 'W1', resourceType: 'Transcript', content: 'institutions '.repeat(8000), summary: null, keyTerms: null }))
      }
      if (args.select?.title && !args.select?.content && !args.select?.order) return [] // vocabulary
      if (args.select?.order) return []
      return [{ id: 't1' }]
    }) as never)
    const { bucketContext } = await buildGenerationPrompt({ primaryTopicId: 't1', poolTopicIds: ['t1'], existingExerciseIds: [] })
    const extra = bucketContext.split('ADDITIONAL GROUNDING CONTEXT FROM PRECEDING LECTURES/SLIDES:\n\n')[1]
    expect(extra).toBeDefined()
    expect(extra.length).toBeLessThanOrEqual(CALIBRATION_CONTEXT_CAP)
    expect(extra.length).toBeGreaterThan(CALIBRATION_CONTEXT_CAP - 500)
  })
})

describe('GenerationError', () => {
  it('carries a student-safe message', () => {
    const e = new GenerationError('no_content', 'This topic has no study material.')
    expect(e.userMessage).toBe('This topic has no study material.')
    expect(e).toBeInstanceOf(Error)
  })
})

/** Largest array found under an `in` or `notIn` key anywhere in a query argument. */
function largestIdList(value: unknown): number {
  if (Array.isArray(value)) return Math.max(0, ...value.map(largestIdList))
  if (value && typeof value === 'object') {
    return Math.max(0, ...Object.entries(value).map(([k, v]) => ((k === 'in' || k === 'notIn') && Array.isArray(v) ? v.length : largestIdList(v))))
  }
  return 0
}
const largestListInAllQueries = () =>
  Math.max(
    0,
    ...[prisma.topic.findMany, prisma.topic.findUnique, prisma.exercise.findMany, prisma.exercise.count].flatMap((fn) =>
      vi.mocked(fn).mock.calls.map((c) => largestIdList(c[0])),
    ),
  )

describe('chunkIds', () => {
  it('splits into pieces of at most the size and keeps the order', () => {
    expect(chunkIds([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(chunkIds([], 2)).toEqual([])
    expect(chunkIds(Array.from({ length: 1322 }, (_, i) => i)).every((c) => c.length <= ID_CHUNK_SIZE)).toBe(true)
  })
})

describe('bounded id lists in generation queries', () => {
  const ids = Array.from({ length: 1322 }, (_, i) => `t${i}`)
  const ex = (id: string, topicId: string) => ({ id, topicId, topic: { id: topicId }, questionText: `Q ${id}`, exerciseType: 'single_choice', choices: '[]', correctAnswer: 'A' })

  it('style examples: a 1,322-topic session never produces a long id list, walks the nearest topics and stops when it has 5', async () => {
    vi.mocked(prisma.topic.findMany).mockResolvedValue(ids.map((id, i) => ({ id, order: i })) as never)
    vi.mocked(prisma.exercise.findMany).mockImplementation((async (args: { where: { topicId?: { in: string[] }; topic?: unknown } }) => {
      if (args.where.topic) return [] // the module has nothing
      return args.where.topicId!.in.map((tid) => ex(`e-${tid}`, tid))
    }) as never)
    const found = await fetchLocalStyleExamples({ week: 'W', courseId: 'c1', order: 500 }, ids, Array.from({ length: 700 }, (_, i) => `old${i}`))
    expect(found).toHaveLength(5)
    expect(largestListInAllQueries()).toBeLessThanOrEqual(20)
    // the nearest topics are used first and the walk stops after the first query that fills the quota
    expect(found.map((e) => e.topicId)).toContain('t500')
    expect(vi.mocked(prisma.exercise.findMany)).toHaveBeenCalledTimes(2)
  })

  it('style examples: ids already in the session are filtered in memory, not sent to the database', async () => {
    vi.mocked(prisma.exercise.findMany).mockResolvedValue([ex('a', 't1'), ex('b', 't1'), ex('c', 't1'), ex('d', 't1')] as never)
    const found = await fetchLocalStyleExamples({ week: 'W', courseId: 'c1', order: 1 }, ['t1'], ['a'])
    expect(found.map((e) => e.id)).toEqual(['b', 'c', 'd'])
    expect(JSON.stringify(vi.mocked(prisma.exercise.findMany).mock.calls[0][0])).not.toContain('notIn')
  })

  it('buildGenerationPrompt with 1,322 pool ids, 1,322 style ids and 700 session exercises stays within the bound', async () => {
    setup({ week: 'W1' }, defaultProfile({ title: 'Course' }))
    vi.mocked(prisma.topic.findMany).mockImplementation((async (args: { where: { id?: { in: string[] } } }) =>
      (args.where.id?.in ?? ['t1']).map((id) => ({ id, title: 'T', content: 'body', resourceType: 'Transcript', order: 1 }))) as never)
    await buildGenerationPrompt({
      primaryTopicId: 't1',
      poolTopicIds: ids,
      styleTopicIds: ids,
      existingExerciseIds: Array.from({ length: 700 }, (_, i) => `x${i}`),
    })
    expect(largestListInAllQueries()).toBeLessThanOrEqual(ID_CHUNK_SIZE)
  })
})
