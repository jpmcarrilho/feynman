// Outline reads and edits against a real (temporary) database.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'fs'

const env = vi.hoisted(() => ({ dir: '' }))
vi.mock('@ai-sdk/google', () => ({ google: vi.fn(() => 'mocked-google-model') }))
vi.mock('@/lib/db', async () => {
  const { createTestPrisma } = await import('@/server/ingest/__fixtures__/testDb')
  const t = await createTestPrisma()
  env.dir = t.dir
  return { prisma: t.prisma }
})

type Prisma = typeof import('@/lib/db').prisma
let prisma: Prisma
let svc: typeof import('./outlineService')
let n = 0

beforeAll(async () => {
  prisma = (await import('@/lib/db')).prisma
  svc = await import('./outlineService')
})
afterAll(async () => {
  await prisma.$disconnect()
  fs.rmSync(env.dir, { recursive: true, force: true })
})

/** Space with one PDF source (ids p1..) and one text source: A1 A2 A3 | B1 in module 01, C1 (text) in module 02, A4 in module 02. */
async function makeSpace() {
  const k = ++n
  const courseId = `oc-${k}`
  await prisma.course.create({ data: { id: courseId, code: courseId, title: 'Space' } })
  const base = { courseId, sizeBytes: 1, storageKey: 'k', status: 'ready' }
  await prisma.source.create({ data: { ...base, id: `${courseId}-pdf`, originalName: 'a.pdf', mimeType: 'application/pdf' } })
  await prisma.source.create({ data: { ...base, id: `${courseId}-txt`, originalName: 'b.md', mimeType: 'text/markdown' } })
  const rows = [
    ['A1', 'pdf', '01 · One', 1, 2, 'content a1', 'sum a1', ['x', 'Y']],
    ['A2', 'pdf', '01 · One', 3, 4, 'content a2', 'sum a2', ['y', 'z']],
    ['A3', 'pdf', '01 · One', 5, 9, 'content a3', null, null],
    ['B1', 'txt', '01 · One', 1, 1, 'content b1', null, null],
    ['C1', 'txt', '02 · Two', 2, 2, 'content c1', null, null],
    ['A4', 'pdf', '02 · Two', 10, 12, 'content a4', null, null],
  ] as const
  const ids: Record<string, string> = {}
  for (const [i, [title, src, week, ps, pe, content, summary, terms]] of rows.entries()) {
    const id = `${courseId}-${title}`
    ids[title] = id
    await prisma.topic.create({
      data: { id, courseId, sourceId: `${courseId}-${src}`, order: i * 10, week, unit: String(i), title, pageStart: ps, pageEnd: pe, content, summary, keyTerms: terms ? JSON.stringify(terms) : null },
    })
  }
  return { courseId, ids }
}

const titles = async (courseId: string) =>
  (await prisma.topic.findMany({ where: { courseId }, orderBy: { order: 'asc' } })).map((t) => `${t.order}:${t.week}:${t.unit}:${t.title}`)

describe('splitModuleName / moduleName', () => {
  it('splits and builds the numbered label', () => {
    expect(svc.splitModuleName('03 · Market failures')).toEqual({ prefix: '03', title: 'Market failures' })
    expect(svc.splitModuleName('Week 1')).toEqual({ prefix: null, title: 'Week 1' })
    expect(svc.moduleName(0, 'A')).toBe('01 · A')
    expect(svc.moduleName(11, 'A')).toBe('12 · A')
  })
})

describe('getOutline', () => {
  it('lists modules in order with source names, pdf flag, counts and the front matter marker', async () => {
    const { courseId, ids } = await makeSpace()
    await prisma.exercise.create({ data: { id: `${ids.A1}-e`, topicId: ids.A1, questionText: 'Q', choices: '[]', correctAnswer: 'a' } })
    await prisma.exercise.create({ data: { id: `${ids.B1}-m`, topicId: ids.B1, questionText: 'x', choices: '[]', correctAnswer: 'a', status: 'rejected', reportedReason: 'not_study_material: logistics' } })
    const r = await svc.getOutline(courseId)
    if (!r.ok) throw new Error('expected ok')
    expect(r.modules.map((m) => [m.name, m.title, m.topics.map((t) => t.title)])).toEqual([
      ['01 · One', 'One', ['A1', 'A2', 'A3', 'B1']],
      ['02 · Two', 'Two', ['C1', 'A4']],
    ])
    const a1 = r.modules[0].topics[0]
    expect(a1).toMatchObject({ sourceName: 'a.pdf', sourceIsPdf: true, pageStart: 1, pageEnd: 2, exerciseCount: 1, notStudyMaterial: false })
    expect(r.modules[0].topics[3]).toMatchObject({ sourceIsPdf: false, exerciseCount: 0, notStudyMaterial: true })
    expect((await svc.getOutline('nope')).ok).toBe(false)
  })
})

describe('rename', () => {
  it('renames a topic, trimming and refusing empty, too long and foreign ids', async () => {
    const a = await makeSpace()
    const b = await makeSpace()
    expect(await svc.renameTopic(a.courseId, a.ids.A1, '  New   title ')).toEqual({ ok: true })
    expect((await prisma.topic.findUnique({ where: { id: a.ids.A1 } }))!.title).toBe('New title')
    expect((await svc.renameTopic(a.courseId, a.ids.A1, '  ')).ok).toBe(false)
    expect((await svc.renameTopic(a.courseId, a.ids.A1, 'x'.repeat(201))).ok).toBe(false)
    const foreign = await svc.renameTopic(a.courseId, b.ids.A1, 'Hijack')
    expect(foreign.ok).toBe(false)
    expect((await prisma.topic.findUnique({ where: { id: b.ids.A1 } }))!.title).toBe('A1')
  })

  it('renames a module keeping its number, and refuses unknown and empty', async () => {
    const { courseId } = await makeSpace()
    expect(await svc.renameModule(courseId, '02 · Two', 'Second')).toEqual({ ok: true })
    expect((await titles(courseId)).filter((t) => t.includes('Second'))).toHaveLength(2)
    expect((await svc.renameModule(courseId, '02 · Second', 'One')).ok).toBe(true) // "02 · One" differs from "01 · One"
    expect((await svc.renameModule(courseId, '09 · Nope', 'X')).ok).toBe(false)
    expect((await svc.renameModule(courseId, '01 · One', ' ')).ok).toBe(false)
  })
})

describe('reorder', () => {
  it('rewrites order densely, keeps modules together and renumbers them by first appearance', async () => {
    const { courseId, ids } = await makeSpace()
    // Put module Two first and swap A1/A2
    const order = [ids.C1, ids.A4, ids.A2, ids.A1, ids.A3, ids.B1]
    expect(await svc.reorderTopics(courseId, order)).toEqual({ ok: true })
    expect(await titles(courseId)).toEqual([
      '0:01 · Two:1:C1', '1:01 · Two:2:A4', '2:02 · One:1:A2', '3:02 · One:2:A1', '4:02 · One:3:A3', '5:02 · One:4:B1',
    ])
  })

  it('regroups an interleaved list by module', async () => {
    const { courseId, ids } = await makeSpace()
    expect(await svc.reorderTopics(courseId, [ids.A1, ids.C1, ids.A2, ids.A3, ids.B1, ids.A4])).toEqual({ ok: true })
    expect((await titles(courseId)).map((t) => t.split(':')[3])).toEqual(['A1', 'A2', 'A3', 'B1', 'C1', 'A4'])
  })

  it('refuses a list that is incomplete, repeats an id or holds a foreign id', async () => {
    const a = await makeSpace()
    const b = await makeSpace()
    const all = Object.values(a.ids)
    expect((await svc.reorderTopics(a.courseId, all.slice(1))).ok).toBe(false)
    expect((await svc.reorderTopics(a.courseId, [...all.slice(1), all[1]])).ok).toBe(false)
    expect((await svc.reorderTopics(a.courseId, [...all.slice(1), b.ids.A1])).ok).toBe(false)
    expect((await svc.reorderTopics(a.courseId, 'x')).ok).toBe(false)
  })
})

describe('moveTopicToModule', () => {
  it('moves a topic to the end of another module and renumbers units', async () => {
    const { courseId, ids } = await makeSpace()
    expect(await svc.moveTopicToModule(courseId, ids.A2, '02 · Two')).toEqual({ ok: true })
    expect(await titles(courseId)).toEqual([
      '0:01 · One:1:A1', '1:01 · One:2:A3', '2:01 · One:3:B1', '3:02 · Two:1:C1', '4:02 · Two:2:A4', '5:02 · Two:3:A2',
    ])
  })

  it('drops a module that becomes empty and renumbers the rest; refuses unknown module and foreign topic', async () => {
    const { courseId, ids } = await makeSpace()
    await svc.moveTopicToModule(courseId, ids.C1, '01 · One')
    await svc.moveTopicToModule(courseId, ids.A4, '01 · One')
    expect(await titles(courseId)).toHaveLength(6)
    expect((await titles(courseId)).every((t) => t.includes('01 · One'))).toBe(true)
    expect((await svc.moveTopicToModule(courseId, ids.A1, '05 · Nope')).ok).toBe(false)
    const other = await makeSpace()
    expect((await svc.moveTopicToModule(courseId, other.ids.A1, '01 · One')).ok).toBe(false)
  })
})

describe('mergeTopics', () => {
  it('merges adjacent topics of one file: content in order, page span, summary, key terms, exercises and session lists re-pointed', async () => {
    const { courseId, ids } = await makeSpace()
    await prisma.exercise.create({ data: { id: `${courseId}-e2`, topicId: ids.A2, questionText: 'Q2', choices: '[]', correctAnswer: 'a' } })
    await prisma.exercise.create({ data: { id: `${courseId}-e3`, topicId: ids.A3, questionText: 'Q3', choices: '[]', correctAnswer: 'a' } })
    await prisma.studySession.create({ data: { id: `${courseId}-s`, courseId, status: 'completed' } })
    await prisma.exerciseLog.create({ data: { sessionId: `${courseId}-s`, exerciseId: `${courseId}-e3`, isCorrect: true, duration: 2 } })
    await prisma.studySession.update({ where: { id: `${courseId}-s` }, data: { topicIds: JSON.stringify([ids.A3, ids.C1, ids.A1]) } })

    const r = await svc.mergeTopics(courseId, [ids.A3, ids.A1, ids.A2])
    expect(r).toEqual({ ok: true, id: ids.A1 })
    const kept = (await prisma.topic.findUnique({ where: { id: ids.A1 } }))!
    expect(kept.title).toBe('A1')
    expect(kept.content).toBe('content a1\n\ncontent a2\n\ncontent a3')
    expect([kept.pageStart, kept.pageEnd]).toEqual([1, 9])
    expect(kept.summary).toBe('sum a1\n\nsum a2')
    expect(JSON.parse(kept.keyTerms!)).toEqual(['x', 'Y', 'z'])
    expect(await prisma.topic.count({ where: { id: { in: [ids.A2, ids.A3] } } })).toBe(0)
    expect((await prisma.exercise.findMany({ where: { topicId: ids.A1 } })).map((e) => e.id).sort()).toEqual([`${courseId}-e2`, `${courseId}-e3`])
    expect(await prisma.exerciseLog.count({ where: { sessionId: `${courseId}-s` } })).toBe(1) // answers survive
    expect(JSON.parse((await prisma.studySession.findUnique({ where: { id: `${courseId}-s` } }))!.topicIds!)).toEqual([ids.A1, ids.C1])
    expect(await titles(courseId)).toEqual(['0:01 · One:1:A1', '1:01 · One:2:B1', '2:02 · Two:1:C1', '3:02 · Two:2:A4'])
  })

  it('refuses topics that are not next to each other, from different files, in different modules, unknown or fewer than two', async () => {
    const { courseId, ids } = await makeSpace()
    const other = await makeSpace()
    const skip = await svc.mergeTopics(courseId, [ids.A1, ids.A3])
    expect(skip).toMatchObject({ ok: false })
    expect((skip as { reason: string }).reason).toMatch(/next to each other/)
    expect((await svc.mergeTopics(courseId, [ids.A3, ids.B1])) as { reason: string }).toMatchObject({ ok: false, reason: expect.stringMatching(/same file/) })
    expect((await svc.mergeTopics(courseId, [ids.B1, ids.C1])) as { reason: string }).toMatchObject({ ok: false, reason: expect.stringMatching(/same file|different modules/) })
    expect((await svc.mergeTopics(courseId, [ids.C1, ids.A4])) as { reason: string }).toMatchObject({ ok: false, reason: expect.stringMatching(/same file/) })
    expect((await svc.mergeTopics(courseId, [ids.A1, other.ids.A2])).ok).toBe(false)
    expect((await svc.mergeTopics(courseId, [ids.A1])).ok).toBe(false)
    expect((await svc.mergeTopics(courseId, [ids.A1, ids.A1])).ok).toBe(false)
    expect(await prisma.topic.count({ where: { courseId } })).toBe(6)
  })

  it('refuses while the file is still being processed and when the merged content would be too long', async () => {
    const a = await makeSpace()
    await prisma.source.update({ where: { id: `${a.courseId}-pdf` }, data: { status: 'segmenting' } })
    expect(((await svc.mergeTopics(a.courseId, [a.ids.A1, a.ids.A2])) as { reason: string }).reason).toMatch(/still being processed/)
    const b = await makeSpace()
    await prisma.topic.update({ where: { id: b.ids.A1 }, data: { content: 'x'.repeat(70_000) } })
    await prisma.topic.update({ where: { id: b.ids.A2 }, data: { content: 'y'.repeat(70_000) } })
    expect(((await svc.mergeTopics(b.courseId, [b.ids.A1, b.ids.A2])) as { reason: string }).reason).toMatch(/limit/)
    expect(await prisma.topic.count({ where: { courseId: b.courseId } })).toBe(6)
  })

  it('drops the front matter marker when one merged part is study material, keeps it when all parts are markers', async () => {
    const a = await makeSpace()
    const mark = (topicId: string, id: string) => prisma.exercise.create({ data: { id, topicId, questionText: 'm', choices: '[]', correctAnswer: 'a', status: 'rejected', reportedReason: 'not_study_material: x' } })
    await mark(a.ids.A1, `${a.courseId}-m1`)
    await svc.mergeTopics(a.courseId, [a.ids.A1, a.ids.A2])
    expect(await prisma.exercise.count({ where: { topicId: a.ids.A1 } })).toBe(0)
    const b = await makeSpace()
    await mark(b.ids.A1, `${b.courseId}-m1`)
    await mark(b.ids.A2, `${b.courseId}-m2`)
    await svc.mergeTopics(b.courseId, [b.ids.A1, b.ids.A2])
    expect(await prisma.exercise.count({ where: { topicId: b.ids.A1 } })).toBe(2)
  })
})

describe('imported studyspaces (topics without a file)', () => {
  async function makeImported() {
    const k = ++n
    const courseId = `imp-${k}`
    await prisma.course.create({ data: { id: courseId, code: courseId, title: 'Imported' } })
    // Unit is a real lecture number shared by many topics, order is the import order
    const rows = [['I1', 'Week 1', '1', 5], ['I2', 'Week 1', '1', 9], ['I3', 'Week 2', '1', 12], ['I4', 'Week 2', '3', 20]] as const
    for (const [title, week, unit, order] of rows) {
      await prisma.topic.create({ data: { id: `${courseId}-${title}`, courseId, order, week, unit, title, content: title } })
    }
    return { courseId, ids: rows.map(([t]) => `${courseId}-${t}`) }
  }
  const snapshot = async (courseId: string) => JSON.stringify(await prisma.topic.findMany({ where: { courseId }, orderBy: { id: 'asc' } }))

  it('refuses module renames, reorders, moves and merges and leaves every topic byte-identical', async () => {
    const { courseId, ids } = await makeImported()
    const before = await snapshot(courseId)
    const results = [
      await svc.renameModule(courseId, 'Week 1', 'New'),
      await svc.reorderTopics(courseId, [...ids].reverse()),
      await svc.moveTopicToModule(courseId, ids[0], 'Week 2'),
      await svc.mergeTopics(courseId, [ids[0], ids[1]]),
    ]
    for (const r of results) expect(r).toEqual({ ok: false, reason: svc.IMPORTED_OUTLINE_REASON })
    expect(await snapshot(courseId)).toBe(before)
  })

  it('still renames a topic, and getOutline says the outline is not editable', async () => {
    const { courseId, ids } = await makeImported()
    expect(await svc.renameTopic(courseId, ids[0], 'Renamed')).toEqual({ ok: true })
    const r = await svc.getOutline(courseId)
    expect(r.ok && r.editable).toBe(false)
    expect(await svc.isImportedStudyspace(courseId)).toBe(true)
  })

  it('a wizard studyspace is editable and not imported', async () => {
    const { courseId } = await makeSpace()
    const r = await svc.getOutline(courseId)
    expect(r.ok && r.editable).toBe(true)
    expect(await svc.isImportedStudyspace(courseId)).toBe(false)
  })
})
