import { describe, it, expect, vi, beforeEach } from 'vitest'
import { generateObject } from 'ai'
import { prisma } from '@/lib/db'
import { defaultProfile } from '@/lib/studyspace/profile'

vi.mock('ai', () => ({ generateText: vi.fn(), generateObject: vi.fn() }))
vi.mock('@ai-sdk/google', () => ({ google: vi.fn(() => 'mocked-google-model') }))
vi.mock('@/lib/db', () => ({
  prisma: {
    exercise: { findMany: vi.fn(), create: vi.fn() },
    exerciseGroup: { create: vi.fn(), findMany: vi.fn() },
  },
}))
vi.mock('@/services/exerciseGenerator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/exerciseGenerator')>()),
  buildGenerationPrompt: vi.fn(),
  rejectionReason: vi.fn(),
}))

import { generateProblemForTopic, stemProblem, MAX_PROBLEM_ATTEMPTS, fetchProblemExemplars, describeExemplar } from './problemGenerator'
import { buildGenerationPrompt, rejectionReason, GenerationError } from '@/services/exerciseGenerator'

const STEM = 'A citizen pays a bribe $b$ to a tax collector who reports a value $\\tau$ while the true value is $\\tau^*$. Reporting less than the truth is lying.'
const part = (q: string, extra: Record<string, unknown> = {}) => ({
  exerciseType: 'single_choice', questionText: q, choices: ['A', 'B', 'C'], correctChoiceIndexes: [0], correctAnswer: '', explanation: 'Because.', ...extra,
})
const problem = (over: Record<string, unknown> = {}) => ({
  contentKind: 'subject_matter', logisticsReason: '', title: 'Tax collector model', stem: STEM,
  parts: [part('Part one?'), part('Part two?'), part('Part three?')], ...over,
})

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(buildGenerationPrompt).mockResolvedValue({ prompt: 'x', bucketContext: 'ctx', topicData: { id: 't1', title: 'Topic', week: 'W1' }, profile: defaultProfile({ title: 'Econ', goal: null }), targetType: 'single_choice' } as never)
  vi.mocked(prisma.exercise.findMany).mockResolvedValue([] as never)
  vi.mocked(prisma.exercise.create).mockImplementation((async (args: { data: Record<string, unknown> }) => ({ ...args.data, topic: { id: 't1' } })) as never)
  vi.mocked(prisma.exerciseGroup.findMany).mockResolvedValue([] as never)
  vi.mocked(prisma.exerciseGroup.create).mockImplementation((async (args: { data: Record<string, unknown> }) => ({ id: 'grp1', ...args.data })) as never)
})

const run = () => generateProblemForTopic({ primaryTopicId: 't1', poolTopicIds: ['t1'], existingExerciseIds: [] })

describe('stemProblem', () => {
  it('accepts a prose stem with math and rejects short, broken or placeholder stems', () => {
    expect(stemProblem(STEM)).toBeNull()
    expect(stemProblem('too short')).toMatch(/characters/)
    expect(stemProblem(`${STEM} with bare \\tau outside math symbols and more text to pass the length`)).toMatch(/bare_latex/)
    expect(stemProblem(`${STEM} Choose [Dropdown 1] now.`)).toMatch(/placeholder/)
  })
})

describe('generateProblemForTopic', () => {
  it('stores the group with its passing parts in order and the failing part as rejected', async () => {
    vi.mocked(generateObject).mockResolvedValue({ object: problem() } as never)
    vi.mocked(rejectionReason).mockImplementation((async (c: { questionText: string }) => (c.questionText.endsWith('Part two?') ? 'blind_solve: mismatch' : null)) as never)
    const result = await run()
    expect(result.group).toMatchObject({ id: 'grp1', title: 'Tax collector model', origin: 'generated' })
    expect(result.exercises.map((e) => [e.questionText, e.groupPosition, e.status])).toEqual([['Part one?', 0, 'active'], ['Part three?', 1, 'active']])
    // the gate sees the stem together with each part
    expect(vi.mocked(rejectionReason).mock.calls[0][0].questionText).toBe(`${STEM}\n\nPart one?`)
    const rejected = vi.mocked(prisma.exercise.create).mock.calls.map((c) => c[0].data as Record<string, unknown>).filter((d) => d.status === 'rejected')
    expect(rejected).toHaveLength(1)
    expect(String(rejected[0].reportedReason)).toContain('blind_solve: mismatch')
    expect(rejected[0].groupId).toBeUndefined()
  })

  it('derives each stored answer from the correct indexes', async () => {
    vi.mocked(generateObject).mockResolvedValue({ object: problem({ parts: [part('One?', { choices: ['X', 'Y', 'Z'], correctChoiceIndexes: [1] }), part('Two?', { exerciseType: 'numeric', choices: [], correctChoiceIndexes: [], correctAnswer: '4.5' }), part('Three?')] }) } as never)
    vi.mocked(rejectionReason).mockResolvedValue(null as never)
    const result = await run()
    expect(result.exercises[0].correctAnswer).toBe('Y')
    expect(result.exercises[1]).toMatchObject({ exerciseType: 'numeric', correctAnswer: '4.5' })
  })

  it('repeats the attempt and throws validation_failed when fewer than two parts pass', async () => {
    vi.mocked(generateObject).mockResolvedValue({ object: problem() } as never)
    vi.mocked(rejectionReason).mockImplementation((async (c: { questionText: string }) => (c.questionText.endsWith('Part one?') ? null : 'blind_solve: mismatch')) as never)
    await expect(run()).rejects.toMatchObject({ code: 'validation_failed' })
    expect(vi.mocked(generateObject)).toHaveBeenCalledTimes(MAX_PROBLEM_ATTEMPTS)
    expect(vi.mocked(prisma.exerciseGroup.create)).not.toHaveBeenCalled()
  })

  it('rejects the whole problem for a bad stem without calling the quality gate', async () => {
    vi.mocked(generateObject).mockResolvedValue({ object: problem({ stem: 'short' }) } as never)
    await expect(run()).rejects.toBeInstanceOf(GenerationError)
    expect(vi.mocked(rejectionReason)).not.toHaveBeenCalled()
  })

  it('throws not_study_material for a logistics topic and writes nothing', async () => {
    vi.mocked(generateObject).mockResolvedValue({ object: problem({ contentKind: 'logistics', logisticsReason: 'syllabus' }) } as never)
    await expect(run()).rejects.toMatchObject({ code: 'not_study_material' })
    expect(vi.mocked(prisma.exercise.create)).not.toHaveBeenCalled()
  })
})

describe('exemplars', () => {
  const g = (title: string, week: string, parts: number) => ({
    title, stem: 'Stem of ' + title, topic: { week },
    exercises: Array.from({ length: parts }, (_, i) => ({ questionText: `Q${i + 1} of ${title}?`, exerciseType: 'single_choice', choices: JSON.stringify(['A', 'B']), correctAnswer: 'A' })),
  })
  it('describes a problem with its stem, parts, options and key', () => {
    const text = describeExemplar(g('Tax', 'W9', 3))
    expect(text).toContain('PROBLEM "Tax"')
    expect(text).toContain('Stem: Stem of Tax')
    expect(text).toContain('Part 2 (single_choice): Q2 of Tax?')
    expect(text).toContain('Options: A | B')
    expect(text).toContain('Answer: A')
  })
  it('prefers problems of the same module, skips ones with fewer than three parts and caps the count', async () => {
    vi.mocked(prisma.exerciseGroup.findMany).mockResolvedValue([g('Other', 'W1', 4), g('Short', 'W9', 2), g('Same1', 'W9', 3), g('Same2', 'W9', 5), g('Same3', 'W9', 3)] as never)
    const text = await fetchProblemExemplars('c1', 'W9')
    expect(text).not.toContain('Short')
    expect(text).not.toContain('Other')
    expect((text.match(/^PROBLEM /gm) ?? []).length).toBe(2)
  })
  it('passes them to the generation prompt', async () => {
    vi.mocked(prisma.exerciseGroup.findMany).mockResolvedValue([g('Real problem', 'W1', 3)] as never)
    vi.mocked(generateObject).mockResolvedValue({ object: problem() } as never)
    vi.mocked(rejectionReason).mockResolvedValue(null as never)
    await run()
    const prompt = vi.mocked(generateObject).mock.calls[0][0].prompt as string
    expect(prompt).toContain('REAL PROBLEMS FROM THIS COURSE')
    expect(prompt).toContain('PROBLEM "Real problem"')
    expect(prompt).toContain('DEPTH:')
  })
})

