// The status read for the wizard, against a real (temporary) database.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'fs'

const env = vi.hoisted(() => ({ dir: '' }))
vi.mock('@ai-sdk/google', () => ({ google: vi.fn(() => 'mocked-google-model') }))
vi.mock('@/lib/db', async () => {
  const { createTestPrisma } = await import('@/server/ingest/__fixtures__/testDb')
  const t = await createTestPrisma()
  env.dir = t.dir
  process.env.STORAGE_DIR = `${t.dir}/storage`
  return { prisma: t.prisma }
})

import { progressText } from './spaceStatus'

type Prisma = typeof import('@/lib/db').prisma
let prisma: Prisma
let status: typeof import('./spaceStatus')

beforeAll(async () => {
  prisma = (await import('@/lib/db')).prisma
  status = await import('./spaceStatus')
})
afterAll(async () => {
  await prisma.$disconnect()
  fs.rmSync(env.dir, { recursive: true, force: true })
})

describe('getSpaceStatus', () => {
  it('returns null for an unknown studyspace', async () => {
    expect(await status.getSpaceStatus('nope')).toBeNull()
  })

  it('reports each file with stage, text, counts, the course state and the outline size', async () => {
    const now = new Date('2026-11-11T12:00:00Z')
    await prisma.course.create({
      data: { id: 'sp', code: 'sp', title: 'Space', starterStatus: 'waiting_for_profile', profileSuggestion: JSON.stringify({ kind: 'initial', createdAt: '2026-11-11T11:00:00Z' }) },
    })
    const base = { courseId: 'sp', mimeType: 'text/plain', sizeBytes: 100, storageKey: 'k' }
    await prisma.source.create({ data: { ...base, id: 'ready1', originalName: 'ready.txt', status: 'ready', createdAt: new Date('2026-11-11T10:00:00Z'), warning: 'w' } })
    await prisma.source.create({
      data: { ...base, id: 'seg1', originalName: 'seg.pdf', status: 'segmenting', pageCount: 42, createdAt: new Date('2026-11-11T10:01:00Z'), leaseExpiresAt: new Date('2026-11-11T12:01:00Z') },
    })
    await prisma.source.create({ data: { ...base, id: 'wait1', originalName: 'wait.md', status: 'uploaded', createdAt: new Date('2026-11-11T10:02:00Z') } })
    await prisma.source.create({
      data: { ...base, id: 'bad1', originalName: 'bad.txt', status: 'failed', failedStage: 'extracting', error: 'Document too long', bundle: 'later', createdAt: new Date('2026-11-11T10:03:00Z') },
    })
    for (const [i, week] of [[0, '01 · A'], [1, '01 · A'], [2, '02 · B']] as const) {
      await prisma.topic.create({ data: { id: `t${i}`, courseId: 'sp', sourceId: 'ready1', order: i, week, title: `T${i}`, content: 'x' } })
    }
    await prisma.exercise.create({ data: { id: 'imp-1', topicId: 't0', questionText: 'Q', choices: '[]', correctAnswer: 'a', origin: 'imported' } })
    await prisma.exercise.create({ data: { id: 'gen-1', topicId: 't1', questionText: 'Q', choices: '[]', correctAnswer: 'a', origin: 'starter' } })
    await prisma.exercise.create({ data: { id: 'mark', topicId: 't2', questionText: '(marker)', choices: '[]', correctAnswer: '', status: 'rejected', reportedReason: 'not_study_material: front matter' } })

    const s = (await status.getSpaceStatus('sp', now))!
    const byId = Object.fromEntries(s.sources.map((x) => [x.id, x]))
    expect(s.sources.map((x) => x.id)).toEqual(['ready1', 'seg1', 'wait1', 'bad1'])
    expect(byId.ready1).toMatchObject({ status: 'ready', stage: null, working: false, topicCount: 3, moduleCount: 2, notStudyTopicCount: 1, importedQuestionCount: 1, starterQuestionCount: 1, warning: 'w' })
    expect(byId.ready1.progressText).toBe('Ready: 3 topics, 1 question from the file')
    expect(byId.seg1).toMatchObject({ status: 'segmenting', stage: { index: 3, total: 5 }, working: true, progressText: 'Splitting 42 pages into topics…' })
    expect(byId.wait1).toMatchObject({ working: false, progressText: 'Waiting in line…', stage: { index: 1, total: 5 } })
    expect(byId.bad1).toMatchObject({ canRetry: true, failedStage: 'extracting', progressText: 'Document too long', bundle: 'later' })
    expect(s).toMatchObject({
      initialBundleFinished: false, processing: true, starterStatus: 'waiting_for_profile', hasProfile: false,
      profileSuggestion: { kind: 'initial', createdAt: '2026-11-11T11:00:00Z' }, outline: { modules: 2, topics: 3 },
      starterProgress: { studyTopics: 2, topicsWithQuestions: 2 },
    })
  })

  it('initialBundleFinished: every initial file is ready or failed', async () => {
    await prisma.course.create({ data: { id: 'sp2', code: 'sp2', title: 'Space 2' } })
    const base = { courseId: 'sp2', mimeType: 'text/plain', sizeBytes: 1, storageKey: 'k' }
    await prisma.source.create({ data: { ...base, id: 'a2', originalName: 'a', status: 'ready' } })
    await prisma.source.create({ data: { ...base, id: 'b2', originalName: 'b', status: 'failed', failedStage: 'segmenting' } })
    expect((await status.getSpaceStatus('sp2'))!).toMatchObject({ initialBundleFinished: true, processing: false })
  })
})

describe('progressText', () => {
  it('has a readable line for every stage', () => {
    const c = { topics: 1, imported: 0, starters: 7 }
    expect(progressText({ status: 'extracting', working: true, pageCount: null, error: null }, c)).toBe('Reading the file…')
    expect(progressText({ status: 'importing_questions', working: true, pageCount: null, error: null }, c)).toBe('Looking for questions in the file…')
    expect(progressText({ status: 'generating_exercises', working: true, pageCount: null, error: null }, c)).toBe('Preparing starter questions… (7 so far)')
    expect(progressText({ status: 'segmenting', working: false, pageCount: null, error: null }, c)).toBe('Waiting to continue splitting into topics…')
  })
})
