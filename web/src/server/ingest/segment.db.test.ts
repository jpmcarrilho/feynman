// Segmentation against a real (temporary) SQLite database: transactions, cascades, ordering and re-runs.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'

const env = vi.hoisted(() => ({ dir: '' }))
vi.mock('@ai-sdk/google', () => ({ google: vi.fn(() => 'mocked-google-model') }))
// The database is always a throwaway one, whatever the import order
vi.mock('@/lib/db', async () => {
  const { createTestPrisma } = await import('./__fixtures__/testDb')
  const t = await createTestPrisma()
  env.dir = t.dir
  process.env.STORAGE_DIR = `${t.dir}/storage`
  return { prisma: t.prisma }
})

import { SegmentationOutputSchema, WindowTopicsSchema, ModuleGroupingSchema } from './schemas'

type Prisma = typeof import('@/lib/db').prisma
let prisma: Prisma
let segmentSource: typeof import('./segment').segmentSource
let writePages: typeof import('@/server/storage').writePages

const topic = (title: string, pageStart: number, pageEnd: number, extra: Record<string, unknown> = {}) => ({
  title, pageStart, pageEnd, summary: `About ${title}.`, keyTerms: [title.toLowerCase(), 'not in the text'], isQuantitative: false, isStudyMaterial: true, ...extra,
})

type Call = { schema: unknown; prompt: string }
let calls: Call[] = []
/** A fake generateObject answering by schema. */
function fakeGenerate(handlers: { single?: (n: number) => unknown; window?: (prompt: string, n: number) => unknown; grouping?: (prompt: string, n: number) => unknown }) {
  const counts = { single: 0, window: 0, grouping: 0 }
  return (async (args: { schema: unknown; prompt: string }) => {
    calls.push({ schema: args.schema, prompt: args.prompt })
    const usage = { inputTokens: 100, outputTokens: 10 }
    if (args.schema === SegmentationOutputSchema) return { object: handlers.single!(++counts.single), usage }
    if (args.schema === WindowTopicsSchema) return { object: handlers.window!(args.prompt, ++counts.window), usage }
    if (args.schema === ModuleGroupingSchema) return { object: handlers.grouping!(args.prompt, ++counts.grouping), usage }
    throw new Error('unexpected schema')
  }) as never
}

let courseCounter = 0
async function makeSource(pageTexts: string[], opts: { courseId?: string; name?: string; ext?: string } = {}) {
  const courseId = opts.courseId ?? `course-${++courseCounter}`
  if (!(await prisma.course.findUnique({ where: { id: courseId } }))) await prisma.course.create({ data: { id: courseId, code: courseId, title: courseId } })
  const id = `src-${++courseCounter}`
  const ext = opts.ext ?? '.txt'
  await prisma.source.create({
    data: { id, courseId, originalName: opts.name ?? `file${ext}`, mimeType: 'text/plain', sizeBytes: 1, storageKey: `sources/${courseId}/${id}/original${ext}`, status: 'segmenting' },
  })
  await writePages(courseId, id, { pages: pageTexts.map((text, i) => ({ n: i + 1, text })), ocr: false })
  return { id, courseId }
}

beforeAll(async () => {
  prisma = (await import('@/lib/db')).prisma
  segmentSource = (await import('./segment')).segmentSource
  writePages = (await import('@/server/storage')).writePages
})
afterAll(async () => {
  await prisma.$disconnect()
  fs.rmSync(env.dir, { recursive: true, force: true })
})
beforeEach(() => {
  calls = []
})

const SIX = ['Intro page about voters', 'Median voter theorem proof', 'More about the median voter', 'Cycles and Condorcet', 'Agenda setting rules', 'Conclusion and references']

describe('segmentSource: single call', () => {
  it('stores topics with contiguous page ranges, verified key terms, markers for logistics, and moves the source on', async () => {
    const { id, courseId } = await makeSource(SIX)
    const generate = fakeGenerate({
      // messy: topic ranges overlap on page 4
      single: () => ({ modules: [
        { title: 'Voting', topics: [topic('Welcome', 1, 1, { isStudyMaterial: false }), topic('Median voter', 2, 4, { keyTerms: ['median voter', 'theorem', 'Condorcet'] })] },
        { title: 'Rules', topics: [topic('Cycles', 4, 5), topic('Wrap up', 6, 6, { isStudyMaterial: false })] },
      ] }),
    })
    const result = await segmentSource(id, { generate })
    expect(calls).toHaveLength(1)
    expect(result.stats.mode).toBe('single')
    expect(result.stats.model.calls).toBe(1)
    expect(result.stats.model.inputTokens).toBe(100)
    expect(result.stats.repairCount).toBeGreaterThan(0)

    const topics = await prisma.topic.findMany({ where: { sourceId: id }, orderBy: { order: 'asc' } })
    expect(topics.map((t) => [t.order, t.week, t.unit, t.title, t.pageStart, t.pageEnd])).toEqual([
      [0, '01 · Voting', '1', 'Welcome', 1, 1],
      [1, '01 · Voting', '2', 'Median voter', 2, 3],
      [2, '02 · Rules', '1', 'Cycles', 4, 5],
      [3, '02 · Rules', '2', 'Wrap up', 6, 6],
    ])
    expect(topics.every((t) => t.className === 'file.txt' && t.resourceType === 'Uploaded text' && t.courseId === courseId && t.localPath === null)).toBe(true)
    expect(topics[1].content).toBe('Median voter theorem proof\n\nMore about the median voter')
    // "median voter" occurs, "theorem" occurs, "Condorcet" does not occur in pages 2-3
    expect(JSON.parse(topics[1].keyTerms!)).toEqual(['median voter', 'theorem'])
    expect(JSON.parse(topics[0].keyTerms!)).toEqual([])
    const markers = await prisma.exercise.findMany({ where: { topic: { sourceId: id } } })
    expect(markers.map((m) => m.topicId).sort()).toEqual([topics[0].id, topics[3].id].sort())
    expect(markers.every((m) => m.status === 'rejected' && m.isGraded === false && m.reportedReason!.startsWith('not_study_material'))).toBe(true)
    const source = await prisma.source.findUnique({ where: { id } })
    expect(source!.status).toBe('importing_questions')
    expect(result.topicIds).toEqual(topics.map((t) => t.id))
  })

  it('marker rows make classifyTopics treat the topic as not study material', async () => {
    const { id } = await makeSource(SIX)
    await segmentSource(id, { generate: fakeGenerate({ single: () => ({ modules: [{ title: 'M', topics: [topic('Welcome', 1, 1, { isStudyMaterial: false }), topic('Lecture', 2, 6)] }] }) }) })
    const { classifyTopics } = await import('@/services/exerciseGenerator')
    const topics = await prisma.topic.findMany({ where: { sourceId: id }, orderBy: { order: 'asc' } })
    const map = await classifyTopics(topics.map((t) => t.id))
    expect([...map.values()]).toEqual(['not_study_material', 'ok'])
  })

  it('retries an unusable answer once and succeeds', async () => {
    const { id } = await makeSource(SIX)
    const generate = fakeGenerate({ single: (n) => (n === 1 ? { modules: [] } : { modules: [{ title: 'M', topics: [topic('All', 1, 6)] }] }) })
    const result = await segmentSource(id, { generate })
    expect(result.stats.model.calls).toBe(2)
    expect(result.stats.model.failedCalls).toBe(1)
  })

  it('fails the source with a readable reason after two bad answers and writes nothing', async () => {
    const { id } = await makeSource(SIX)
    const generate = (async () => {
      throw new Error('provider says: secret request details')
    }) as never
    await expect(segmentSource(id, { generate })).rejects.toThrow(/failed twice/)
    const source = await prisma.source.findUnique({ where: { id } })
    expect(source).toMatchObject({ status: 'failed', failedStage: 'segmenting' })
    expect(source!.error).toMatch(/Building the outline failed twice/)
    expect(source!.error).not.toMatch(/secret/)
    expect(await prisma.topic.count({ where: { sourceId: id } })).toBe(0)
  })

  it('a failure inside the write transaction leaves nothing half-written', async () => {
    const { id } = await makeSource(SIX)
    // the source is taken away from this stage while the model answers; the final status update then finds nothing to move
    const generate = (async () => {
      await prisma.source.update({ where: { id }, data: { status: 'uploaded' } })
      return { object: { modules: [{ title: 'M', topics: [topic('A', 1, 3), topic('B', 4, 6, { isStudyMaterial: false })] }] }, usage: {} }
    }) as never
    await expect(segmentSource(id, { generate })).rejects.toThrow(/changed while it was being processed/)
    expect(await prisma.topic.count({ where: { sourceId: id } })).toBe(0)
    expect(await prisma.exercise.count({ where: { topic: { sourceId: id } } })).toBe(0)
  })

  it('does nothing for a source that is past segmenting and returns its topics', async () => {
    const { id } = await makeSource(SIX)
    await segmentSource(id, { generate: fakeGenerate({ single: () => ({ modules: [{ title: 'M', topics: [topic('A', 1, 6)] }] }) }) })
    calls = []
    const again = await segmentSource(id, { generate: fakeGenerate({}) })
    expect(calls).toHaveLength(0)
    expect(again.stats.mode).toBe('reused')
    expect(again.topicIds).toHaveLength(1)
  })
})

describe('segmentSource: several sources and re-runs', () => {
  it('appends a second source after the first (order and module numbers) and leaves the first untouched', async () => {
    const a = await makeSource(SIX, { name: 'a.txt' })
    const gen = (titles: string[]) => fakeGenerate({ single: () => ({ modules: titles.map((t, i) => ({ title: t, topics: [topic(`${t} topic`, 1 + i * 3, 3 + i * 3)] })) }) })
    await segmentSource(a.id, { generate: gen(['A1', 'A2']) })
    const b = await makeSource(SIX, { courseId: a.courseId, name: 'b.txt' })
    await segmentSource(b.id, { generate: gen(['B1', 'B2']) })
    const topics = await prisma.topic.findMany({ where: { courseId: a.courseId }, orderBy: { order: 'asc' } })
    expect(topics.map((t) => [t.order, t.week, t.className])).toEqual([
      [0, '01 · A1', 'a.txt'], [1, '02 · A2', 'a.txt'], [2, '03 · B1', 'b.txt'], [3, '04 · B2', 'b.txt'],
    ])
  })

  it('re-running keeps the slot, shifts the topics after it and never touches other sources', async () => {
    const a = await makeSource(SIX, { name: 'a.txt' })
    await segmentSource(a.id, { generate: fakeGenerate({ single: () => ({ modules: [{ title: 'A', topics: [topic('a1', 1, 3), topic('a2', 4, 6)] }] }) }) })
    const b = await makeSource(SIX, { courseId: a.courseId, name: 'b.txt' })
    await segmentSource(b.id, { generate: fakeGenerate({ single: () => ({ modules: [{ title: 'B', topics: [topic('b1', 1, 6)] }] }) }) })
    const bBefore = await prisma.topic.findMany({ where: { sourceId: b.id } })
    expect(bBefore.map((t) => t.order)).toEqual([2])

    // the runner retries segmenting of A with a different outline: 3 topics instead of 2
    await prisma.source.update({ where: { id: a.id }, data: { status: 'segmenting' } })
    const oldIds = (await prisma.topic.findMany({ where: { sourceId: a.id } })).map((t) => t.id)
    await segmentSource(a.id, { generate: fakeGenerate({ single: () => ({ modules: [{ title: 'A new', topics: [topic('n1', 1, 2), topic('n2', 3, 4), topic('n3', 5, 6)] }] }) }) })
    const all = await prisma.topic.findMany({ where: { courseId: a.courseId }, orderBy: { order: 'asc' } })
    expect(all.map((t) => [t.order, t.title])).toEqual([[0, 'n1'], [1, 'n2'], [2, 'n3'], [3, 'b1']])
    expect(all.filter((t) => t.sourceId === a.id).some((t) => oldIds.includes(t.id))).toBe(false)
    expect(all.find((t) => t.title === 'b1')!.id).toBe(bBefore[0].id)
    // no duplicates of A's topics
    expect(await prisma.topic.count({ where: { sourceId: a.id } })).toBe(3)
  })

  it('freezes the outline when an exercise of the source has been answered: no model call, nothing deleted', async () => {
    const a = await makeSource(SIX)
    await segmentSource(a.id, { generate: fakeGenerate({ single: () => ({ modules: [{ title: 'A', topics: [topic('a1', 1, 3), topic('a2', 4, 6)] }] }) }) })
    const topics = await prisma.topic.findMany({ where: { sourceId: a.id }, orderBy: { order: 'asc' } })
    const ex = await prisma.exercise.create({ data: { id: 'imp-x', topicId: topics[0].id, questionText: 'q', choices: '[]', correctAnswer: '1' } })
    const session = await prisma.studySession.create({ data: { courseId: a.courseId, status: 'completed' } })
    await prisma.exerciseLog.create({ data: { sessionId: session.id, exerciseId: ex.id, isCorrect: true, duration: 5 } })

    await prisma.source.update({ where: { id: a.id }, data: { status: 'segmenting' } })
    calls = []
    const result = await segmentSource(a.id, { generate: fakeGenerate({}) })
    expect(calls).toHaveLength(0)
    expect(result.stats.mode).toBe('reused')
    expect((await prisma.topic.findMany({ where: { sourceId: a.id }, orderBy: { order: 'asc' } })).map((t) => t.id)).toEqual(topics.map((t) => t.id))
    expect(await prisma.exercise.findUnique({ where: { id: 'imp-x' } })).not.toBeNull()
    expect((await prisma.source.findUnique({ where: { id: a.id } }))!.status).toBe('importing_questions')
  })
})

describe('segmentSource: windowed', () => {
  // 12 pages of 20,000 characters: 4 windows of 3 pages
  const big = Array.from({ length: 12 }, (_, i) => `Page ${i + 1} ` + 'lorem ipsum '.repeat(1666))

  it('runs one call per window plus one grouping call, merges boundary duplicates and orders modules by page', async () => {
    const { id } = await makeSource(big)
    const windowTopics = (prompt: string) => {
      const m = prompt.match(/window pages (\d+) to (\d+)/)!
      const a = Number(m[1])
      const b = Number(m[2])
      return { topics: [topic(`T${a}`, a, a + 1, { moduleHint: `S${a}` }), topic(`T${a + 2}`, a + 2, b, { moduleHint: `S${a}` })].filter((t) => t.pageStart <= b) }
    }
    const generate = fakeGenerate({
      window: (prompt) => windowTopics(prompt),
      grouping: (prompt) => {
        const n = (prompt.match(/^\d+\. \[pages/gm) ?? []).length
        // everything in one module, in reverse listing order of modules is irrelevant here
        return { modules: [{ title: 'Whole', topicIndices: Array.from({ length: n }, (_, i) => i) }], mergeGroups: [] }
      },
    })
    const result = await segmentSource(id, { generate })
    expect(result.stats.mode).toBe('windowed')
    expect(result.stats.windows).toBeGreaterThanOrEqual(4)
    expect(result.stats.model.calls).toBe(result.stats.windows + 1)
    const topics = await prisma.topic.findMany({ where: { sourceId: id }, orderBy: { order: 'asc' } })
    expect(topics[0].pageStart).toBe(1)
    expect(topics[topics.length - 1].pageEnd).toBe(12)
    topics.forEach((t, i) => {
      if (i > 0) expect(t.pageStart).toBe(topics[i - 1].pageEnd! + 1)
    })
    expect(new Set(topics.map((t) => t.week)).size).toBe(1)
    // the window overlap pages are by design, not a repair of the model's answer
    expect(result.stats.repairs.overlapPages).toBe(0)
  })

  it('falls back to the section hints when the grouping call fails, and says so in Source.warning', async () => {
    const { id } = await makeSource(big)
    const generate = fakeGenerate({
      window: (prompt) => {
        const m = prompt.match(/window pages (\d+) to (\d+)/)!
        return { topics: [topic(`T${m[1]}`, Number(m[1]), Number(m[2]), { moduleHint: Number(m[1]) < 6 ? 'First half' : 'Second half' })] }
      },
      grouping: () => {
        throw new Error('boom')
      },
    })
    const result = await segmentSource(id, { generate })
    expect(result.stats.mergeFallback).toBe(true)
    const weeks = [...new Set((await prisma.topic.findMany({ where: { sourceId: id }, orderBy: { order: 'asc' } })).map((t) => t.week))]
    expect(weeks).toEqual(['01 · First half', '02 · Second half'])
    expect((await prisma.source.findUnique({ where: { id } }))!.warning).toMatch(/section hints/)
  })

  it('fails the source when one window fails twice', async () => {
    const { id } = await makeSource(big)
    const generate = fakeGenerate({
      window: (prompt) => {
        if (prompt.includes('window pages 4 to')) throw new Error('boom')
        const m = prompt.match(/window pages (\d+) to (\d+)/)!
        return { topics: [topic(`T${m[1]}`, Number(m[1]), Number(m[2]), { moduleHint: 'x' })] }
      },
      grouping: () => ({ modules: [], mergeGroups: [] }),
    })
    await expect(segmentSource(id, { generate })).rejects.toThrow(/failed twice/)
    const source = await prisma.source.findUnique({ where: { id } })
    expect(source).toMatchObject({ status: 'failed', failedStage: 'segmenting' })
    expect(source!.error).toMatch(/pages 4-/)
    expect(await prisma.topic.count({ where: { sourceId: id } })).toBe(0)
  })
})
