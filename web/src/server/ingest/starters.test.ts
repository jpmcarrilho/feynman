// Starter questions against a real (temporary) database, with the generator replaced by a fake that stores a question.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'

const env = vi.hoisted(() => ({ dir: '' }))
vi.mock('@ai-sdk/google', () => ({ google: vi.fn(() => 'mocked-google-model') }))
vi.mock('@/lib/db', async () => {
  const { createTestPrisma } = await import('./__fixtures__/testDb')
  const t = await createTestPrisma()
  env.dir = t.dir
  process.env.STORAGE_DIR = `${t.dir}/storage`
  return { prisma: t.prisma }
})

import { GenerationError, NOT_STUDY_MATERIAL_PREFIX } from '@/services/exerciseGenerator'
import { STARTERS_PER_SOURCE, STARTER_MAX_CONSECUTIVE_FAILURES } from '@/lib/ingestLimits'

type Prisma = typeof import('@/lib/db').prisma
let prisma: Prisma
let mod: typeof import('./starters')
let counter = 0

beforeAll(async () => {
  prisma = (await import('@/lib/db')).prisma
  mod = await import('./starters')
})
afterAll(async () => {
  await prisma.$disconnect()
  fs.rmSync(env.dir, { recursive: true, force: true })
})
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

async function makeSource(topicCount: number) {
  const courseId = `c-${++counter}`
  const sourceId = `s-${counter}`
  await prisma.course.create({ data: { id: courseId, code: courseId, title: courseId } })
  await prisma.source.create({
    data: { id: sourceId, courseId, originalName: 'a.txt', mimeType: 'text/plain', sizeBytes: 1, storageKey: `sources/${courseId}/${sourceId}/original.txt`, status: 'ready' },
  })
  const topicIds: string[] = []
  for (let i = 0; i < topicCount; i++) {
    const id = `t-${counter}-${i}`
    await prisma.topic.create({ data: { id, courseId, sourceId, order: i, week: '01 · M', title: `Topic ${i}`, content: `Content of topic ${i}` } })
    topicIds.push(id)
  }
  return { courseId, sourceId, topicIds }
}

/** Generator fake: stores a question like the real one (origin generated, status active) and returns it. */
type Args = { primaryTopicId: string }
const store = (args: Args) =>
  prisma.exercise.create({
    data: { id: `gen-${crypto.randomUUID()}`, topicId: args.primaryTopicId, questionText: 'Q?', choices: '["a","b","c"]', correctAnswer: 'a', origin: 'generated', status: 'active' },
    include: { topic: true },
  })
const asGenerator = (fn: (args: Args) => Promise<unknown>) => fn as unknown as typeof import('@/services/exerciseGenerator').generateExerciseForTopic
function storingGenerator(onCall?: (topicId: string) => void) {
  return asGenerator(async (args) => {
    onCall?.(args.primaryTopicId)
    return store(args)
  })
}

const startersOf = (topicId: string) => prisma.exercise.count({ where: { topicId, origin: 'starter', status: 'active' } })

describe('generateStartersForSource', () => {
  it('creates 2 starters per topic, tags them as starters and counts them', async () => {
    const { sourceId, topicIds } = await makeSource(3)
    const out = await mod.generateStartersForSource(sourceId, mod.newStarterBudget(), () => false, storingGenerator())
    expect(out).toMatchObject({ created: 6, failedSlots: 0, stoppedBy: null })
    for (const id of topicIds) expect(await startersOf(id)).toBe(2)
  })

  it('is a top-up: a repeated run creates nothing, a partial topic gets only the missing question', async () => {
    const { sourceId, topicIds } = await makeSource(2)
    await prisma.exercise.create({ data: { id: `gen-${crypto.randomUUID()}`, topicId: topicIds[0], questionText: 'old', choices: '[]', correctAnswer: 'a', origin: 'starter', status: 'active' } })
    const first = await mod.generateStartersForSource(sourceId, mod.newStarterBudget(), () => false, storingGenerator())
    expect(first.created).toBe(3)
    const second = await mod.generateStartersForSource(sourceId, mod.newStarterBudget(), () => false, storingGenerator())
    expect(second.created).toBe(0)
    for (const id of topicIds) expect(await startersOf(id)).toBe(2)
  })

  it('stops at 60 per source, breadth first, and says so', async () => {
    const { sourceId, topicIds } = await makeSource(40)
    const out = await mod.generateStartersForSource(sourceId, mod.newStarterBudget(1000), () => false, storingGenerator())
    expect(out.created).toBe(STARTERS_PER_SOURCE)
    expect(out.stoppedBy).toBe('cap')
    expect(out.notAttempted).toBe(20)
    const counts = await Promise.all(topicIds.map(startersOf))
    expect(counts.every((n) => n >= 1)).toBe(true) // every topic has its first starter
    expect(counts.filter((n) => n === 2)).toHaveLength(20)
    expect(mod.starterNote(out)).toMatch(/stopped at the limit \(60 per file/)
  })

  it('stops when the run budget of slots is used up', async () => {
    const { sourceId } = await makeSource(5)
    const budget = mod.newStarterBudget(3)
    const out = await mod.generateStartersForSource(sourceId, budget, () => false, storingGenerator())
    expect(out.created).toBe(3)
    expect(out.stoppedBy).toBe('budget')
    expect(budget.slotsLeft).toBe(0)
  })

  it('skips topics that are not study material, empty or ungraded-only, and topics the generator refuses', async () => {
    const { sourceId, topicIds } = await makeSource(5)
    await prisma.exercise.create({ data: { id: 'm1', topicId: topicIds[0], questionText: '(marker)', choices: '[]', correctAnswer: '', status: 'rejected', reportedReason: `${NOT_STUDY_MATERIAL_PREFIX}: logistics` } })
    await prisma.topic.update({ where: { id: topicIds[1] }, data: { content: '' } })
    await prisma.exercise.create({ data: { id: 'u1', topicId: topicIds[2], questionText: 'survey', choices: '[]', correctAnswer: 'a', isGraded: false } })
    const asked: string[] = []
    const generate = asGenerator(async (args) => {
      asked.push(args.primaryTopicId)
      if (args.primaryTopicId === topicIds[3]) throw new GenerationError('not_study_material', 'logistics')
      return store(args)
    })
    const out = await mod.generateStartersForSource(sourceId, mod.newStarterBudget(), () => false, generate)
    expect(out.created).toBe(2) // only topic 4, twice
    expect(out.failedSlots).toBe(0)
    expect(new Set(asked)).toEqual(new Set([topicIds[3], topicIds[4]]))
    expect(asked.filter((id) => id === topicIds[3])).toHaveLength(1) // dropped after the refusal, not asked for a second round
  })

  it('counts a question that never passed validation as a failed slot and goes on', async () => {
    const { sourceId, topicIds } = await makeSource(3)
    const generate = asGenerator(async (args) => {
      if (args.primaryTopicId === topicIds[1]) throw new GenerationError('validation_failed', 'checks failed')
      return store(args)
    })
    const out = await mod.generateStartersForSource(sourceId, mod.newStarterBudget(), () => false, generate)
    expect(out.created).toBe(4)
    expect(out.failedSlots).toBe(1)
    expect(mod.starterNote(out)).toBe('Starter questions: 4 created, 1 could not be generated.')
  })

  it('ends the run after repeated infrastructure failures', async () => {
    const { sourceId } = await makeSource(20)
    let calls = 0
    const generate = asGenerator(async () => { calls++; throw new Error('503 from the model') })
    const budget = mod.newStarterBudget()
    const out = await mod.generateStartersForSource(sourceId, budget, () => false, generate)
    expect(out.stoppedBy).toBe('breaker')
    expect(budget.broken).toBe(true)
    // concurrency 3: a few slots already in flight when the limit is reached
    expect(calls).toBeGreaterThanOrEqual(STARTER_MAX_CONSECUTIVE_FAILURES)
    expect(calls).toBeLessThan(STARTER_MAX_CONSECUTIVE_FAILURES + 3)
    expect(out.created).toBe(0)
  })

  it('stops between slots when asked to', async () => {
    const { sourceId } = await makeSource(10)
    let made = 0
    const out = await mod.generateStartersForSource(sourceId, mod.newStarterBudget(), () => made >= 2, storingGenerator(() => { made++ }))
    expect(out.stoppedBy).toBe('cancelled')
    expect(out.created).toBeLessThan(10)
  })
})

describe('warning notes', () => {
  it('the note is empty when nothing needs saying and is replaced, not repeated', () => {
    expect(mod.starterNote({ created: 5, failedSlots: 0, notAttempted: 0, stoppedBy: null })).toBe('')
    const note = mod.starterNote({ created: 5, failedSlots: 2, notAttempted: 0, stoppedBy: null })
    expect(mod.stripStarterNote(`Encoding was guessed. ${note}`)).toBe('Encoding was guessed.')
    expect(mod.stripStarterNote(null)).toBe('')
  })
})
