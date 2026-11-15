// @vitest-environment node
// addSourcesToSpace against a real (temporary) database and storage folder.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { defaultProfile } from '@/lib/studyspace/profile'

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
vi.mock('./runner', () => ({ enqueueSource: (id: string) => { queued.ids.push(id) } }))

type Prisma = typeof import('@/lib/db').prisma
let prisma: Prisma
let upload: typeof import('./upload')
let courseId = ''
let counter = 0

const PDF = '%PDF-1.4\n1 0 obj\n<<>>\nendobj\n'
const file = (name: string, content: string | Uint8Array = 'Some study text.\n') => new File([content as BlobPart], name)
const toUpload = (f: File) => ({ name: f.name, size: f.size, blob: f })
const storageRoot = () => path.join(env.dir, 'storage', 'sources')
const filesOnDisk = () => (fs.existsSync(storageRoot()) ? fs.readdirSync(storageRoot(), { recursive: true }).map(String).filter((p) => p.includes('original')) : [])

beforeAll(async () => {
  prisma = (await import('@/lib/db')).prisma
  upload = await import('./upload')
})
afterAll(async () => {
  await prisma.$disconnect()
  fs.rmSync(env.dir, { recursive: true, force: true })
})
beforeEach(async () => {
  queued.ids = []
  courseId = `course-${++counter}`
  await prisma.course.create({ data: { id: courseId, code: courseId, title: courseId } })
  fs.rmSync(storageRoot(), { recursive: true, force: true })
})

describe('addSourcesToSpace: success', () => {
  it('stores originals, creates the rows in upload order, queues them in that order', async () => {
    const added = await upload.addSourcesToSpace(courseId, 'initial', [toUpload(file('b.txt')), toUpload(file('a.pdf', PDF)), toUpload(file('c.md', '# T\ntext'))])
    expect(added.map((a) => a.originalName)).toEqual(['b.txt', 'a.pdf', 'c.md'])
    expect(queued.ids).toEqual(added.map((a) => a.id))
    const rows = await prisma.source.findMany({ where: { courseId }, orderBy: { createdAt: 'asc' } })
    expect(rows.map((r) => r.originalName)).toEqual(['b.txt', 'a.pdf', 'c.md'])
    expect(rows.map((r) => r.mimeType)).toEqual(['text/plain', 'application/pdf', 'text/markdown'])
    expect(rows.every((r) => r.status === 'uploaded' && r.bundle === 'initial' && r.leaseExpiresAt === null)).toBe(true)
    for (const r of rows) {
      expect(fs.existsSync(path.join(env.dir, 'storage', r.storageKey))).toBe(true)
      expect(r.storageKey).toBe(`sources/${courseId}/${r.id}/original${path.extname(r.originalName)}`)
    }
  })

  it('keeps the name as data only: path parts and control characters are dropped and the storage key never contains it', async () => {
    const [a] = await upload.addSourcesToSpace(courseId, 'later', [toUpload(file('../../etc/pass\u0000wd‮.txt'))])
    expect(a.originalName).toBe('passwd.txt')
    const row = await prisma.source.findUniqueOrThrow({ where: { id: a.id } })
    expect(row.storageKey).not.toContain('passwd')
  })

  it('the server decides the bundle: initial without a tutor whatever the client sent, later with an accepted profile or imported topics', async () => {
    const [first] = await upload.addSourcesToSpace(courseId, 'later', [toUpload(file('a.txt'))])
    expect((await prisma.source.findUniqueOrThrow({ where: { id: first.id } })).bundle).toBe('initial')

    await prisma.course.update({ where: { id: courseId }, data: { profile: JSON.stringify(defaultProfile({ title: 'T' })) } })
    const [second] = await upload.addSourcesToSpace(courseId, 'initial', [toUpload(file('b.txt'))])
    expect((await prisma.source.findUniqueOrThrow({ where: { id: second.id } })).bundle).toBe('later')

    // An imported studyspace (topics without a source) takes later files even where no profile is stored in the row
    const imported = `${courseId}-imported`
    await prisma.course.create({ data: { id: imported, code: imported, title: imported } })
    await prisma.topic.create({ data: { courseId: imported, title: 'Week 1', week: 'Week_01', className: 'c', unit: '1', resourceType: 'Transcript', content: 'x', order: 1 } })
    const [third] = await upload.addSourcesToSpace(imported, 'initial', [toUpload(file('c.txt'))])
    expect((await prisma.source.findUniqueOrThrow({ where: { id: third.id } })).bundle).toBe('later')

    // A profile that does not validate counts as no tutor
    const broken = `${courseId}-broken`
    await prisma.course.create({ data: { id: broken, code: broken, title: broken, profile: '{"version":1}' } })
    const [fourth] = await upload.addSourcesToSpace(broken, 'later', [toUpload(file('d.txt'))])
    expect((await prisma.source.findUniqueOrThrow({ where: { id: fourth.id } })).bundle).toBe('initial')
  })

  it('accepts a second file with a name already used in the studyspace as a separate source and says so', async () => {
    await upload.addSourcesToSpace(courseId, 'initial', [toUpload(file('notes.txt'))])
    const [again] = await upload.addSourcesToSpace(courseId, 'later', [toUpload(file('Notes.TXT', 'another version'))])
    expect(again.nameAlreadyInSpace).toBe(true)
    expect(await prisma.source.count({ where: { courseId } })).toBe(2)
  })
})

describe('addSourcesToSpace: validation happens before anything is written', () => {
  const expectNothing = async () => {
    expect(await prisma.source.count({ where: { courseId } })).toBe(0)
    expect(filesOnDisk()).toEqual([])
    expect(queued.ids).toEqual([])
  }

  it('one unsupported extension refuses the whole request (415) although the other file is fine', async () => {
    const err = await upload.addSourcesToSpace(courseId, 'initial', [toUpload(file('ok.txt')), toUpload(file('bad.docx'))]).catch((e) => e)
    expect(err).toBeInstanceOf(upload.UploadRejected)
    expect(err.status).toBe(415)
    expect(err.message).toBe('"bad.docx" is not supported. Upload .txt, .md or .pdf files.')
    await expectNothing()
  })

  it('refuses a file over 50 MB by its declared size (413) without reading it', async () => {
    const huge = { name: 'big.pdf', size: 60 * 1024 * 1024, blob: { slice: () => { throw new Error('must not be read') } } as unknown as Blob }
    const err = await upload.addSourcesToSpace(courseId, 'initial', [toUpload(file('ok.txt')), huge]).catch((e) => e)
    expect(err.status).toBe(413)
    expect(err.message).toBe('"big.pdf" is 60 MB; the limit is 50 MB per file.')
    await expectNothing()
  })

  it('refuses more than 20 files (413), empty files and duplicate names (400)', async () => {
    const many = Array.from({ length: 21 }, (_, i) => toUpload(file(`f${i}.txt`)))
    expect((await upload.addSourcesToSpace(courseId, 'initial', many).catch((e) => e)).status).toBe(413)
    const empty = await upload.addSourcesToSpace(courseId, 'initial', [toUpload(file('e.txt', ''))]).catch((e) => e)
    expect([empty.status, empty.message]).toEqual([400, '"e.txt" is empty.'])
    const dup = await upload.addSourcesToSpace(courseId, 'initial', [toUpload(file('a.txt')), toUpload(file('A.txt'))]).catch((e) => e)
    expect([dup.status, dup.message]).toEqual([400, '"a.txt" appears more than once in this upload. Rename or remove one of them.'])
    expect((await upload.addSourcesToSpace(courseId, 'initial', []).catch((e) => e)).status).toBe(400)
    await expectNothing()
  })

  it('sniffs the first bytes: a .pdf that is not a PDF and a .txt with binary content are refused (415) with the extractor messages', async () => {
    const html = await upload.addSourcesToSpace(courseId, 'initial', [toUpload(file('ok.txt')), toUpload(file('page.pdf', '<!DOCTYPE html><html></html>'))]).catch((e) => e)
    expect(html.status).toBe(415)
    expect(html.message).toBe('"page.pdf": This file has a .pdf name but is a web page, not a PDF (it does not start with %PDF-). Open the original document and export it as a PDF again.')
    const zip = await upload.addSourcesToSpace(courseId, 'initial', [toUpload(file('doc.txt', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])))]).catch((e) => e)
    expect(zip.message).toBe('"doc.txt": This file is a ZIP-based file (for example a Word or Excel document), not a text file. Rename it with the right extension or export it as .txt, .md or .pdf.')
    await expectNothing()
  })

  it('an unknown studyspace is refused', async () => {
    await expect(upload.addSourcesToSpace('nope', 'initial', [toUpload(file('a.txt'))])).rejects.toBeInstanceOf(upload.SpaceNotFoundError)
  })
})

describe('addSourcesToSpace: atomicity', () => {
  it('a write failing half-way removes the files already written and creates no rows', async () => {
    const broken = new File(['x'], 'broken.txt')
    Object.defineProperty(broken, 'stream', { value: () => new ReadableStream({ start(c) { c.error(new Error('disk full')) } }) })
    await expect(upload.addSourcesToSpace(courseId, 'initial', [toUpload(file('first.txt')), toUpload(broken)])).rejects.toThrow('disk full')
    expect(await prisma.source.count({ where: { courseId } })).toBe(0)
    expect(filesOnDisk()).toEqual([])
    expect(queued.ids).toEqual([])
  })

  it('a failing database transaction removes every written file and queues nothing', async () => {
    const spy = vi.spyOn(prisma, '$transaction').mockRejectedValueOnce(new Error('database is locked'))
    await expect(upload.addSourcesToSpace(courseId, 'initial', [toUpload(file('a.txt')), toUpload(file('b.txt'))])).rejects.toThrow('database is locked')
    spy.mockRestore()
    expect(await prisma.source.count({ where: { courseId } })).toBe(0)
    expect(filesOnDisk()).toEqual([])
    expect(queued.ids).toEqual([])
  })
})
