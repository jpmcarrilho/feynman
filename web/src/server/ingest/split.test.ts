// Splitting a studyspace against a real (temporary) database and storage folder.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'

const env = vi.hoisted(() => ({ dir: '' }))
vi.mock('@ai-sdk/google', () => ({ google: vi.fn(() => 'mocked-google-model') }))
vi.mock('@/lib/db', async () => {
  const { createTestPrisma } = await import('./__fixtures__/testDb')
  const t = await createTestPrisma()
  env.dir = t.dir
  process.env.STORAGE_DIR = `${t.dir}/storage`
  return { prisma: t.prisma }
})

import { defaultProfile } from '@/lib/studyspace/profile'

type Prisma = typeof import('@/lib/db').prisma
let prisma: Prisma
let split: typeof import('./split')
let runner: typeof import('./runner')
let n = 0
const storage = () => path.join(env.dir, 'storage')
const exists = (rel: string) => fs.existsSync(path.join(storage(), rel))

beforeAll(async () => {
  prisma = (await import('@/lib/db')).prisma
  split = await import('./split')
  runner = await import('./runner')
})
afterAll(async () => {
  await prisma.$disconnect()
  fs.rmSync(env.dir, { recursive: true, force: true })
})
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  runner.tuning.exclusiveTimeoutMs = 300
})

/** Two ready files: A (modules 01, 02) and B (module 03); A and B share nothing. Files exist on disk. */
async function makeSpace(opts: { statusB?: string; leaseB?: Date; imported?: boolean; profile?: boolean; session?: boolean } = {}) {
  const k = ++n
  const courseId = `sp-${k}`
  await prisma.course.create({ data: { id: courseId, code: courseId, title: 'Mixed', goal: 'learn', starterStatus: 'waiting_for_profile', profile: opts.profile ? JSON.stringify(defaultProfile({ title: 'Mixed' })) : null, profileSuggestion: '{"old":true}' } })
  const ids = { a: `${courseId}-A`, b: `${courseId}-B` }
  for (const [key, id] of Object.entries(ids)) {
    const rel = `sources/${courseId}/${id}`
    fs.mkdirSync(path.join(storage(), rel), { recursive: true })
    fs.writeFileSync(path.join(storage(), rel, 'original.md'), `original ${key}`)
    fs.writeFileSync(path.join(storage(), rel, 'pages.json'), `{"pages":"${key}"}`)
    await prisma.source.create({
      data: { id, courseId, originalName: `${key}.md`, mimeType: 'text/markdown', sizeBytes: 1, storageKey: `${rel}/original.md`, status: key === 'b' ? opts.statusB ?? 'ready' : 'ready', leaseExpiresAt: key === 'b' ? opts.leaseB : undefined },
    })
  }
  const topic = async (id: string, sourceId: string | null, week: string, order: number) => {
    await prisma.topic.create({ data: { id: `${courseId}-${id}`, courseId, sourceId, week, order, unit: '1', title: id, content: id } })
    await prisma.exercise.create({ data: { id: `${courseId}-q-${id}`, topicId: `${courseId}-${id}`, questionText: 'q', choices: '[]', correctAnswer: 'a', origin: 'imported' } })
  }
  await topic('a1', opts.imported ? null : ids.a, '01 · Chem', 0)
  await topic('a2', opts.imported ? null : ids.a, '02 · Chem more', 1)
  await topic('b1', opts.imported ? null : ids.b, '03 · History', 2)
  if (opts.session) await prisma.studySession.create({ data: { id: `${courseId}-sess`, courseId, status: 'completed' } })
  return { courseId, ...ids }
}

const groups = (s: { a: string; b: string }) => [{ label: 'Chemistry', sourceIds: [s.a] }, { label: 'History', sourceIds: [s.b] }]

describe('splitStudyspace', () => {
  it('moves the second group with topics, questions and files, renumbers both and clears the suggestion', async () => {
    const s = await makeSpace()
    const r = await split.splitStudyspace(s.courseId, groups(s))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const [keptId, newId] = r.ids
    expect(keptId).toBe(s.courseId)
    expect(r.created).toEqual([{ id: newId, title: 'History' }])

    const moved = await prisma.source.findUnique({ where: { id: s.b } })
    expect(moved).toMatchObject({ courseId: newId, storageKey: `sources/${newId}/${s.b}/original.md` })
    expect((await prisma.source.findUnique({ where: { id: s.a } }))!.courseId).toBe(s.courseId)
    const topicsNew = await prisma.topic.findMany({ where: { courseId: newId }, orderBy: { order: 'asc' } })
    expect(topicsNew.map((t) => [t.title, t.week, t.order, t.unit])).toEqual([['b1', '01 · History', 0, '1']])
    const topicsOld = await prisma.topic.findMany({ where: { courseId: s.courseId }, orderBy: { order: 'asc' } })
    expect(topicsOld.map((t) => [t.title, t.week, t.order])).toEqual([['a1', '01 · Chem', 0], ['a2', '02 · Chem more', 1]])
    // questions follow the topic
    expect(await prisma.exercise.count({ where: { topic: { courseId: newId } } })).toBe(1)
    // files moved, old folder gone, kept source untouched
    expect(exists(`sources/${newId}/${s.b}/original.md`)).toBe(true)
    expect(exists(`sources/${newId}/${s.b}/pages.json`)).toBe(true)
    expect(exists(`sources/${s.courseId}/${s.b}`)).toBe(false)
    expect(exists(`sources/${s.courseId}/${s.a}/original.md`)).toBe(true)
    // the studyspace that stays takes the name of its group
    expect((await prisma.course.findUnique({ where: { id: s.courseId } }))!.title).toBe('Chemistry')
    expect(r.keptTitle).toBe('Chemistry')
    // new space starts at its persona step
    const created = await prisma.course.findUnique({ where: { id: newId } })
    expect(created).toMatchObject({ title: 'History', goal: 'learn', starterStatus: 'waiting_for_profile', profile: null, profileSuggestion: null })
    expect((await prisma.course.findUnique({ where: { id: s.courseId } }))!.profileSuggestion).toBeNull()
  })

  it('refuses with a reason and changes nothing in the listed cases', async () => {
    const cases: [RegExp, Parameters<typeof makeSpace>[0]][] = [
      [/study sessions/, { session: true }],
      [/still being processed/, { statusB: 'segmenting' }],
      [/imported/, { imported: true }],
      [/already has a tutor/, { profile: true }],
    ]
    for (const [pattern, opts] of cases) {
      const s = await makeSpace(opts)
      const r = await split.splitStudyspace(s.courseId, groups(s))
      expect(r.ok, String(pattern)).toBe(false)
      expect(!r.ok && r.reason, String(pattern)).toMatch(pattern)
      expect((await prisma.source.findUnique({ where: { id: s.b } }))!.courseId).toBe(s.courseId)
      expect(exists(`sources/${s.courseId}/${s.b}/original.md`)).toBe(true)
    }
  })

  it('refuses groups that do not cover the ready files exactly once', async () => {
    const s = await makeSpace()
    for (const bad of [
      [{ label: 'x', sourceIds: [s.a, s.b] }],
      [{ label: 'x', sourceIds: [s.a] }],
      [{ label: 'x', sourceIds: [s.a] }, { label: 'y', sourceIds: ['unknown'] }],
      [{ label: 'x', sourceIds: [s.a, s.b] }, { label: 'y', sourceIds: [s.b] }],
      'nope',
    ]) {
      expect((await split.splitStudyspace(s.courseId, bad)).ok).toBe(false)
    }
    expect(await prisma.course.count({ where: { id: { startsWith: 'sp-' }, title: 'y' } })).toBe(0)
  })

  it('does not split while a stage holds a moved source, and changes nothing', async () => {
    const s = await makeSpace({ leaseB: new Date(Date.now() + 60_000) })
    const r = await split.splitStudyspace(s.courseId, groups(s))
    expect(r).toMatchObject({ ok: false })
    expect((await prisma.source.findUnique({ where: { id: s.b } }))!.courseId).toBe(s.courseId)
    expect(exists(`sources/${s.courseId}/${s.b}/original.md`)).toBe(true)
  })

  it('leaves rows and files intact and removes its copies when the database step fails', async () => {
    const s = await makeSpace()
    const spy = vi.spyOn(prisma, '$transaction').mockRejectedValueOnce(new Error('disk full'))
    const r = await split.splitStudyspace(s.courseId, groups(s))
    spy.mockRestore()
    expect(r).toMatchObject({ ok: false })
    expect((await prisma.source.findUnique({ where: { id: s.b } }))!.courseId).toBe(s.courseId)
    expect(exists(`sources/${s.courseId}/${s.b}/original.md`)).toBe(true)
    // no copy of the file is left in any other studyspace folder
    const copies = fs.readdirSync(path.join(storage(), 'sources')).filter((d) => d !== s.courseId && fs.existsSync(path.join(storage(), 'sources', d, s.b)))
    expect(copies).toEqual([])
  })

  it('keeps the old title when the first label is empty or the same, and refuses a name that is too long', async () => {
    const s = await makeSpace()
    expect((await split.splitStudyspace(s.courseId, [{ label: 'x'.repeat(81), sourceIds: [s.a] }, { label: 'H', sourceIds: [s.b] }])).ok).toBe(false)
    const r = await split.splitStudyspace(s.courseId, [{ label: '', sourceIds: [s.a] }, { label: 'History', sourceIds: [s.b] }])
    expect(r.ok && r.keptTitle).toBe('Mixed')
    expect((await prisma.course.findUnique({ where: { id: s.courseId } }))!.title).toBe('Mixed')
  })

  it('releases the hold on the moved sources afterwards', async () => {
    const s = await makeSpace()
    await split.splitStudyspace(s.courseId, groups(s))
    const row = await prisma.source.findUnique({ where: { id: s.b } })
    expect(row!.leaseExpiresAt === null || row!.leaseExpiresAt.getTime() <= Date.now()).toBe(true)
  })
})
