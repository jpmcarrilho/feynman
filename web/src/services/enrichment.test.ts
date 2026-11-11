import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateObject } from 'ai'
import { prisma } from '@/lib/db'
import { enrichExercise, enrichBatch, CallBudget, isBackgroundEnrichmentEnabled, type EnrichableRow } from './enrichment'
import { ENRICH_CONTEXT_MAX_CHARS, capEnrichmentContext } from '@/lib/prompts'

vi.mock('ai', () => ({ generateText: vi.fn(), generateObject: vi.fn() }))
vi.mock('@ai-sdk/google', () => ({ google: vi.fn(() => 'mocked-google-model') }))
vi.mock('next/server', () => ({ after: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    course: { findUnique: vi.fn() },
    topic: { findMany: vi.fn() },
    exercise: { updateMany: vi.fn() },
  },
}))

const topic = { id: 'topic-1', courseId: 'course-1', week: 'week-1', order: 5, className: 'Current', sourceId: null }
const base: EnrichableRow = {
  id: 'ex-1',
  topicId: 'topic-1',
  questionText: 'Which step is missing in the process described in the above figure?',
  exerciseType: 'single_choice',
  choices: JSON.stringify(['Double data entry', 'Random audit', 'Nothing is missing']),
  correctAnswer: 'Double data entry',
  explanation: 'x',
  origin: 'imported',
  status: 'active',
  isGraded: true,
  enrichedAt: null,
  originalQuestionText: null,
  topic,
}

type UpdateArg = { where: unknown; data: Record<string, unknown> }
const updateArg = (i = 0) => vi.mocked(prisma.exercise.updateMany).mock.calls[i][0] as UpdateArg

type Solve = { answerable: boolean; issue?: string; answer: string[] }
const CORRECT: Solve = { answerable: true, answer: ['Double data entry'] }
const NOT_ANSWERABLE: Solve = { answerable: false, issue: 'figure missing', answer: [] }
const WRONG: Solve = { answerable: true, answer: ['Random audit'] }

/** Routes generateObject: blind-solve prompts get the next `solves` entry, the enrichment prompt gets `enriched`. */
function mockModel(solves: Solve[], enriched?: string) {
  const queue = [...solves]
  vi.mocked(generateObject).mockImplementation((async ({ prompt }: { prompt: string }) => {
    if (prompt.includes('You are a student taking a quiz')) {
      const r = queue.shift() ?? CORRECT
      return { object: { answerable: r.answerable, issue: r.issue ?? '', answer: r.answer } }
    }
    return { object: { enrichedQuestionText: enriched ?? '' } }
  }) as never)
}
const modelCalls = () => vi.mocked(generateObject).mock.calls.length

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.mocked(prisma.topic.findMany).mockResolvedValue([{ id: 't-prev', title: 'Prev', content: 'Transcript for context.', week: 'week-1', className: 'Prev', order: 1, resourceType: 'Transcript .txt' }] as never)
  vi.mocked(prisma.course.findUnique).mockResolvedValue({ id: 'course-1', code: 'JPAL102x', title: 'JPAL', profile: null } as never)
  vi.mocked(prisma.exercise.updateMany).mockResolvedValue({ count: 1 } as never)
})

const REWRITE = 'Which step is missing in the clinic data verification process of the Kenya trial?'

describe('enrichExercise gate', () => {
  it('triages an answerable, correctly solved question: marks it done, no rewrite, 1 call', async () => {
    mockModel([CORRECT])
    expect(await enrichExercise(base)).toEqual({ status: 'triaged-answerable', calls: 1 })
    expect(modelCalls()).toBe(1)
    expect(updateArg().where).toEqual({ id: 'ex-1', enrichedAt: null })
    expect(updateArg().data).toEqual({ enrichedAt: expect.any(Date) })
  })

  it('treats an answerable question the solver gets differently from the key as triaged, text untouched', async () => {
    mockModel([WRONG])
    expect(await enrichExercise(base)).toMatchObject({ status: 'triaged-solver-disagrees', calls: 1 })
    expect(updateArg().data).toEqual({ enrichedAt: expect.any(Date) })
  })

  it('enriches a not-answerable question and keeps the rewrite when the solver then answers it correctly (3 calls)', async () => {
    mockModel([NOT_ANSWERABLE, CORRECT], REWRITE)
    expect(await enrichExercise(base)).toEqual({ status: 'enriched', calls: 3, questionText: REWRITE })
    expect(updateArg().data).toEqual({ questionText: REWRITE, enrichedAt: expect.any(Date), originalQuestionText: base.questionText })
    expect(JSON.stringify(updateArg().data)).not.toContain('<!-- enriched -->')
  })

  it('never overwrites an existing originalQuestionText', async () => {
    mockModel([NOT_ANSWERABLE, CORRECT], REWRITE)
    await enrichExercise({ ...base, originalQuestionText: 'The very first wording' })
    expect(updateArg().data).not.toHaveProperty('originalQuestionText')
  })

  it('discards a rewrite that leaks the correct option (2 calls, no verify), keeps the text, sets enrichedAt', async () => {
    mockModel([NOT_ANSWERABLE], `${base.questionText} (Double data entry catches typing errors.)`)
    expect(await enrichExercise(base)).toMatchObject({ status: 'enrichment-rejected', calls: 2, reason: expect.stringMatching(/^leak/) })
    expect(updateArg().data).toEqual({ enrichedAt: expect.any(Date) })
  })

  it('does not call a correct option already in the original text a leak', async () => {
    mockModel([NOT_ANSWERABLE, CORRECT], 'Is double data entry the missing step in the clinic verification process of the Kenya trial?')
    expect((await enrichExercise({ ...base, questionText: 'Is double data entry the missing step in the above figure?' })).status).toBe('enriched')
  })

  it('discards a rewrite that breaks the question (dropdown placeholder removed)', async () => {
    const dropdown: EnrichableRow = {
      ...base,
      exerciseType: 'dropdown',
      questionText: 'In the study above the effect was [Dropdown 1].',
      choices: JSON.stringify(['[Dropdown 1] positive', '[Dropdown 1] negative', '[Dropdown 1] zero']),
      correctAnswer: JSON.stringify({ '[Dropdown 1]': 'negative' }),
    }
    mockModel([NOT_ANSWERABLE], 'In the Kenya study the effect was observed.')
    expect(await enrichExercise(dropdown)).toMatchObject({ status: 'enrichment-rejected', reason: expect.stringMatching(/^invalid/) })
    expect(updateArg().data).toEqual({ enrichedAt: expect.any(Date) })
  })

  it('discards a rewrite the solver still cannot answer', async () => {
    mockModel([NOT_ANSWERABLE, NOT_ANSWERABLE], REWRITE)
    expect(await enrichExercise(base)).toMatchObject({ status: 'enrichment-rejected', calls: 3, reason: 'still-not-answerable' })
    expect(updateArg().data).toEqual({ enrichedAt: expect.any(Date) })
  })

  it('discards a rewrite the solver answers wrongly', async () => {
    mockModel([NOT_ANSWERABLE, WRONG], REWRITE)
    expect(await enrichExercise(base)).toMatchObject({ status: 'enrichment-rejected', reason: 'wrong-answer' })
  })

  it('marks an unchanged rewrite as rejected without touching the text', async () => {
    mockModel([NOT_ANSWERABLE], base.questionText)
    expect(await enrichExercise(base)).toMatchObject({ status: 'enrichment-rejected', reason: 'unchanged' })
    expect(updateArg().data).toEqual({ enrichedAt: expect.any(Date) })
  })

  it('stores nothing when a model call fails, so a later run retries', async () => {
    vi.mocked(generateObject).mockRejectedValue(new Error('boom'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await enrichExercise(base)).status).toBe('failed')
    expect(prisma.exercise.updateMany).not.toHaveBeenCalled()
    err.mockRestore()
  })

  it('defers (stores nothing) a not-answerable question when fewer than 3 calls are left', async () => {
    mockModel([NOT_ANSWERABLE])
    const budget = new CallBudget(2)
    expect((await enrichExercise(base, budget)).status).toBe('deferred')
    expect(prisma.exercise.updateMany).not.toHaveBeenCalled()
    expect(budget.used).toBe(1)
  })

  it.each([
    ['generated', { origin: 'generated' }],
    ['uploaded topic', { topic: { ...topic, sourceId: 'src-1' } }],
    ['ungraded', { isGraded: false }],
    ['not active', { status: 'rejected' }],
    ['already enriched', { enrichedAt: new Date() }],
  ])('never enriches %s questions (no model call)', async (_n, patch) => {
    expect(await enrichExercise({ ...base, ...patch })).toEqual({ status: 'skipped', calls: 0 })
    expect(generateObject).not.toHaveBeenCalled()
  })

  it('enriches a question of an uploaded topic only with the explicit opt-in, grounded in the topic\'s own content', async () => {
    const uploaded = { ...base, topic: { ...topic, sourceId: 'src-1', content: 'OWN TOPIC TEXT about double data entry.' } }
    expect(await enrichExercise(uploaded)).toEqual({ status: 'skipped', calls: 0 })
    expect(generateObject).not.toHaveBeenCalled()
    mockModel([NOT_ANSWERABLE, CORRECT], REWRITE)
    const outcome = await enrichExercise(uploaded, new CallBudget(8), { forUploadedContent: true })
    expect(outcome.status).toBe('enriched')
    const prompts = vi.mocked(generateObject).mock.calls.map((c) => (c[0] as { prompt: string }).prompt)
    expect(prompts.find((p) => p.includes('Lecture Transcripts'))).toContain('OWN TOPIC TEXT')
    // the course-wide lookups of session-start enrichment are not used
    expect(prisma.topic.findMany).not.toHaveBeenCalled()
  })

  it('enrichBatch passes the opt-in through, and without it skips uploaded topics', async () => {
    const uploaded = { ...base, topic: { ...topic, sourceId: 'src-1', content: 'OWN' } }
    mockModel([CORRECT])
    expect(await enrichBatch([uploaded])).toEqual([])
    const outcomes = await enrichBatch([uploaded], { forUploadedContent: true, limit: 5 })
    expect(outcomes.map((o) => o.status)).toEqual(['triaged-answerable'])
  })

  it('caps the lecture context in the enrichment prompt at 30,000 characters', async () => {
    vi.mocked(prisma.topic.findMany).mockResolvedValue([{ id: 'big', title: 'Big', content: 'x'.repeat(200_000) }] as never)
    mockModel([NOT_ANSWERABLE], base.questionText)
    await enrichExercise(base)
    const prompts = vi.mocked(generateObject).mock.calls.map((c) => (c[0] as { prompt: string }).prompt)
    const enrichPrompt = prompts.find((p) => p.includes('Lecture Transcripts'))!
    expect(enrichPrompt.length).toBeLessThan(ENRICH_CONTEXT_MAX_CHARS + 8_000)
    expect(enrichPrompt).toContain('[TRUNCATED]')
  })
})

describe('capEnrichmentContext', () => {
  it('leaves short text alone and cuts long text with a marker', () => {
    expect(capEnrichmentContext('short')).toBe('short')
    const cut = capEnrichmentContext('y'.repeat(ENRICH_CONTEXT_MAX_CHARS + 10))
    expect(cut.startsWith('y'.repeat(ENRICH_CONTEXT_MAX_CHARS))).toBe(true)
    expect(cut.endsWith('[TRUNCATED]')).toBe(true)
  })
})

describe('enrichBatch', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ ...base, id: `ex-${i}` }))

  it('triages at most 5 questions, 3 at a time, skipping non-candidates', async () => {
    let running = 0
    let peak = 0
    vi.mocked(generateObject).mockImplementation((async () => {
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 5))
      running--
      return { object: { answerable: true, issue: '', answer: CORRECT.answer } }
    }) as never)
    const list = rows(9)
    list.splice(1, 0, { ...base, id: 'gen', origin: 'generated' })
    const outcomes = await enrichBatch(list)
    expect(outcomes).toHaveLength(5)
    expect(modelCalls()).toBe(5)
    expect(peak).toBeLessThanOrEqual(3)
    expect(peak).toBeGreaterThan(1)
  })

  it('never exceeds 8 model calls when several questions need enrichment', async () => {
    mockModel([], REWRITE)
    vi.mocked(generateObject).mockImplementation((async ({ prompt }: { prompt: string }) => {
      if (prompt.includes('You are a student taking a quiz')) {
        // the rewrite is answerable, the original is not
        const ok = prompt.includes('Kenya trial')
        return { object: ok ? { answerable: true, issue: '', answer: CORRECT.answer } : { answerable: false, issue: 'x', answer: [] } }
      }
      return { object: { enrichedQuestionText: REWRITE } }
    }) as never)
    const outcomes = await enrichBatch(rows(5))
    expect(modelCalls()).toBeLessThanOrEqual(8)
    expect(outcomes.filter((o) => o.status === 'enriched')).toHaveLength(2)
    expect(outcomes.filter((o) => o.status === 'deferred').length).toBeGreaterThan(0)
  })
})

describe('isBackgroundEnrichmentEnabled', () => {
  afterEach(() => {
    delete process.env.ENRICH_IN_BACKGROUND
  })
  it('is off unless the variable is exactly "1", read at call time', () => {
    delete process.env.ENRICH_IN_BACKGROUND
    expect(isBackgroundEnrichmentEnabled()).toBe(false)
    for (const v of ['0', 'true', '', ' 1']) {
      process.env.ENRICH_IN_BACKGROUND = v
      expect(isBackgroundEnrichmentEnabled()).toBe(false)
    }
    process.env.ENRICH_IN_BACKGROUND = '1'
    expect(isBackgroundEnrichmentEnabled()).toBe(true)
  })
  it('does not stop the service being called directly', async () => {
    delete process.env.ENRICH_IN_BACKGROUND
    mockModel([CORRECT])
    expect((await enrichExercise(base)).status).toBe('triaged-answerable')
  })
})
