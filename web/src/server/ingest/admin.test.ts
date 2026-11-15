// Retry, remove and delete against a real (temporary) database and storage folder.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'

const env = vi.hoisted(() => ({ dir: '' }))
const queued = vi.hoisted(() => ({ ids: [] as string[] }))
vi.mock('@ai-sdk/google', () => ({ google: vi.fn(() => 'mocked-google-model') }))
vi.mock('@/lib/db', async () => {
  const { createTestPrisma } = await import('./__fixtures__/testDb')
  const t = await createTestPrisma()
  env.dir = t.dir
  process.env.STORAGE_DIR = `${t.dir}/storage`
  return { prisma: t.prisma }
})
vi.mock('./runner', async (orig) => ({ ...(await orig<typeof import('./runner')>()), enqueueSource: (id: string) => { queued.ids.push(id) } }))

type Prisma = typeof import('@/lib/db').prisma
let prisma: Prisma
let admin: typeof import('./admin')
let runner: typeof import('./runner')
let counter = 0
const storage = () => path.join(env.dir, 'storage')

beforeAll(async () => {
  prisma = (await import('@/lib/db')).prisma
  admin = await import('./admin')
  runner = await import('./runner')
})
afterAll(async () => {
  await prisma.$disconnect()
  fs.rmSync(env.dir, { recursive: true, force: true })
})
beforeEach(() => {
  queued.ids = []
  runner.tuning.exclusiveTimeoutMs = 300
})

async function makeSpace(opts: { title?: string; status?: string; withLog?: boolean; lease?: Date } = {}) {
  const n = ++counter
  const courseId = `c-${n}`
  const sourceId = `s-${n}`
  await prisma.course.create({ data: { id: courseId, code: courseId, title: opts.title ?? `Space ${n}` } })
  await prisma.source.create({
    data: {
      id: sourceId, courseId, originalName: 'a.txt', mimeType: 'text/plain', sizeBytes: 1, storageKey: `sources/${courseId}/${sourceId}/original.txt`,
      status: opts.status ?? 'ready', leaseExpiresAt: opts.lease ?? null,
    },
  })
  await prisma.topic.create({ data: { id: `t-${n}`, courseId, sourceId, title: 'T', content: 'text' } })
  await prisma.exercise.create({ data: { id: `e-${n}`, topicId: `t-${n}`, questionText: 'Q', choices: '[]', correctAnswer: 'a' } })
  fs.mkdirSync(path.join(storage(), 'sources', courseId, sourceId), { recursive: true })
  fs.writeFileSync(path.join(storage(), 'sources', courseId, sourceId, 'original.txt'), 'text')
  if (opts.withLog) {
    await prisma.studySession.create({ data: { id: `ss-${n}`, courseId, status: 'completed' } })
    await prisma.exerciseLog.create({ data: { sessionId: `ss-${n}`, exerciseId: `e-${n}`, isCorrect: true, duration: 3 } })
  }
  return { courseId, sourceId, topicId: `t-${n}`, exerciseId: `e-${n}`, sessionId: `ss-${n}` }
}

describe('retrySource', () => {
  it('moves a failed source back to the stage that failed and queues it; only failed sources', async () => {
    const { sourceId } = await makeSpace({ status: 'failed' })
    await prisma.source.update({ where: { id: sourceId }, data: { failedStage: 'segmenting', error: 'The model failed.' } })
    expect(await admin.retrySource(sourceId)).toEqual({ ok: true })
    const row = await prisma.source.findUniqueOrThrow({ where: { id: sourceId } })
    expect([row.status, row.failedStage, row.error]).toEqual(['segmenting', null, null])
    expect(queued.ids).toEqual([sourceId])
    // no longer failed: a second retry is refused
    expect((await admin.retrySource(sourceId)).ok).toBe(false)
    const ready = await makeSpace({ status: 'ready' })
    expect(await admin.retrySource(ready.sourceId)).toEqual({ ok: false, reason: 'Only a file that failed can be retried.' })
    expect((await admin.retrySource('nope')).ok).toBe(false)
  })
})

describe('removeSource', () => {
  it('deletes the source with its topics, exercises and files', async () => {
    const { courseId, sourceId, topicId, exerciseId } = await makeSpace()
    expect(await admin.removeSource(sourceId)).toEqual({ ok: true })
    expect(await prisma.source.count({ where: { id: sourceId } })).toBe(0)
    expect(await prisma.topic.count({ where: { id: topicId } })).toBe(0)
    expect(await prisma.exercise.count({ where: { id: exerciseId } })).toBe(0)
    expect(fs.existsSync(path.join(storage(), 'sources', courseId, sourceId))).toBe(false)
    expect(await prisma.course.count({ where: { id: courseId } })).toBe(1)
  })

  it('refuses when a question of the source has been answered, and deletes nothing', async () => {
    const { courseId, sourceId, topicId } = await makeSpace({ withLog: true })
    const res = await admin.removeSource(sourceId)
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.reason).toMatch(/already been answered/)
    expect(await prisma.topic.count({ where: { id: topicId } })).toBe(1)
    expect(fs.existsSync(path.join(storage(), 'sources', courseId, sourceId, 'original.txt'))).toBe(true)
  })

  it('stops a source that is being processed before deleting it, and refuses when its stage does not end', async () => {
    const live = await makeSpace({ status: 'segmenting', lease: new Date(Date.now() + 60_000) })
    const res = await admin.removeSource(live.sourceId)
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.reason).toBe('This file is being processed right now. Try again in a minute.')
    expect(await prisma.source.count({ where: { id: live.sourceId } })).toBe(1)
    // once the worker is gone (lease expired) the same call succeeds
    await prisma.source.update({ where: { id: live.sourceId }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } })
    expect(await admin.removeSource(live.sourceId)).toEqual({ ok: true })
    expect(await prisma.source.count({ where: { id: live.sourceId } })).toBe(0)
  })

  it('unknown source', async () => {
    expect(await admin.removeSource('nope')).toEqual({ ok: false, reason: 'File not found.' })
  })
})

describe('deleteStudyspace', () => {
  it('needs the exact title', async () => {
    const { courseId } = await makeSpace({ title: 'Organic Chemistry' })
    for (const typed of ['organic chemistry', 'Organic Chemistry ', '', undefined, 42]) {
      const res = await admin.deleteStudyspace(courseId, typed)
      expect(res.ok).toBe(false)
    }
    expect(await prisma.course.count({ where: { id: courseId } })).toBe(1)
  })

  it('removes the course with everything it owns and its storage folders, and leaves other studyspaces alone', async () => {
    const mine = await makeSpace({ title: 'Mine', withLog: true })
    const other = await makeSpace({ title: 'Other', withLog: true })
    await prisma.studyPlan.create({ data: { id: `p-${mine.courseId}`, courseId: mine.courseId, title: 'plan', executiveSummary: 's' } })
    fs.mkdirSync(path.join(storage(), 'summaries', mine.courseId), { recursive: true })
    fs.writeFileSync(path.join(storage(), 'summaries', mine.courseId, 'M.md'), 'summary')
    fs.mkdirSync(path.join(storage(), 'summaries', 'sessions'), { recursive: true })
    fs.writeFileSync(path.join(storage(), 'summaries', 'sessions', `${mine.sessionId}_index.md`), 'index')
    fs.writeFileSync(path.join(storage(), 'summaries', 'sessions', `${other.sessionId}_index.md`), 'index')

    expect(await admin.deleteStudyspace(mine.courseId, 'Mine')).toEqual({ ok: true })

    expect(await prisma.course.count({ where: { id: mine.courseId } })).toBe(0)
    for (const model of ['source', 'topic', 'studyPlan'] as const) {
      expect(await (prisma[model] as unknown as { count: (a: unknown) => Promise<number> }).count({ where: { courseId: mine.courseId } })).toBe(0)
    }
    expect(await prisma.exercise.count({ where: { id: mine.exerciseId } })).toBe(0)
    expect(await prisma.studySession.count({ where: { courseId: mine.courseId } })).toBe(0)
    expect(await prisma.exerciseLog.count({ where: { sessionId: mine.sessionId } })).toBe(0)
    expect(fs.existsSync(path.join(storage(), 'sources', mine.courseId))).toBe(false)
    expect(fs.existsSync(path.join(storage(), 'summaries', mine.courseId))).toBe(false)
    expect(fs.existsSync(path.join(storage(), 'summaries', 'sessions', `${mine.sessionId}_index.md`))).toBe(false)
    // the other studyspace is intact
    expect(await prisma.exerciseLog.count({ where: { sessionId: other.sessionId } })).toBe(1)
    expect(fs.existsSync(path.join(storage(), 'sources', other.courseId, other.sourceId, 'original.txt'))).toBe(true)
    expect(fs.existsSync(path.join(storage(), 'summaries', 'sessions', `${other.sessionId}_index.md`))).toBe(true)
  })

  it('refuses while a file is being processed by a worker that does not stop, and deletes nothing', async () => {
    const { courseId } = await makeSpace({ title: 'Busy', status: 'segmenting', lease: new Date(Date.now() + 60_000) })
    const res = await admin.deleteStudyspace(courseId, 'Busy')
    expect(res.ok).toBe(false)
    expect(await prisma.course.count({ where: { id: courseId } })).toBe(1)
    expect(runner.runnerSnapshot().cancelled).toEqual([])
  })

  it('unknown studyspace', async () => {
    expect(await admin.deleteStudyspace('nope', 'x')).toEqual({ ok: false, reason: 'Studyspace not found.' })
  })
})
