// @vitest-environment node
// The upload route: authentication first, then studyspace, size, form, and the all-or-nothing validation of the files.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { NextRequest } from 'next/server'

const env = vi.hoisted(() => ({ dir: '' }))
const auth = vi.hoisted(() => ({ ok: true }))
const queued = vi.hoisted(() => ({ ids: [] as string[] }))
vi.mock('@ai-sdk/google', () => ({ google: vi.fn(() => 'mocked-google-model') }))
vi.mock('@/lib/db', async () => {
  const { createTestPrisma } = await import('@/server/ingest/__fixtures__/testDb')
  const t = await createTestPrisma()
  env.dir = t.dir
  process.env.STORAGE_DIR = `${t.dir}/storage`
  return { prisma: t.prisma }
})
vi.mock('@/app/auth-actions', () => ({ checkIsAuthenticated: async () => auth.ok }))
vi.mock('@/server/ingest/runner', () => ({ enqueueSource: (id: string) => { queued.ids.push(id) } }))
// A small request limit so the test can exceed it
vi.mock('@/lib/ingestLimits', async (orig) => ({ ...(await orig<typeof import('@/lib/ingestLimits')>()), MAX_REQUEST_BYTES: 1024 * 1024 }))

type Prisma = typeof import('@/lib/db').prisma
let prisma: Prisma
let route: typeof import('./route')
let courseId = ''
let counter = 0

beforeAll(async () => {
  prisma = (await import('@/lib/db')).prisma
  route = await import('./route')
})
afterAll(async () => {
  await prisma.$disconnect()
  fs.rmSync(env.dir, { recursive: true, force: true })
})
beforeEach(async () => {
  auth.ok = true
  queued.ids = []
  courseId = `course-${++counter}`
  await prisma.course.create({ data: { id: courseId, code: courseId, title: courseId } })
  fs.rmSync(path.join(env.dir, 'storage', 'sources'), { recursive: true, force: true })
})

const call = (id: string, init: { body?: BodyInit | null; headers?: Record<string, string> }) =>
  route.POST(new NextRequest(`http://localhost/api/spaces/${id}/sources`, { method: 'POST', ...init }), { params: Promise.resolve({ id }) })

function form(files: { name: string; content: string | Uint8Array }[], fields: Record<string, string> = {}) {
  const f = new FormData()
  for (const file of files) f.append('files', new File([file.content as BlobPart], file.name))
  for (const [k, v] of Object.entries(fields)) f.append(k, v)
  return f
}

describe('POST /api/spaces/[id]/sources', () => {
  it('401 without a session, and the body is not read', async () => {
    auth.ok = false
    const request = new NextRequest('http://localhost/x', { method: 'POST', body: form([{ name: 'a.txt', content: 'x' }]) })
    const res = await route.POST(request, { params: Promise.resolve({ id: courseId }) })
    expect(res.status).toBe(401)
    expect(request.bodyUsed).toBe(false)
    expect(await prisma.source.count()).toBe(0)
  })

  it('404 for an unknown or malformed studyspace id', async () => {
    expect((await call('does-not-exist', { body: form([{ name: 'a.txt', content: 'x' }]) })).status).toBe(404)
    expect((await call('../etc', { body: form([{ name: 'a.txt', content: 'x' }]) })).status).toBe(404)
  })

  it('400 when the body is not a multipart form', async () => {
    const res = await call(courseId, { body: JSON.stringify({ a: 1 }), headers: { 'content-type': 'application/json' } })
    expect(res.status).toBe(400)
  })

  it('413 when Content-Length already announces more than the limit, and when the stream turns out larger', async () => {
    const announced = await call(courseId, { body: form([{ name: 'a.txt', content: 'x' }]), headers: { 'content-length': String(5 * 1024 * 1024) } })
    expect(announced.status).toBe(413)
    const big = form([{ name: 'a.txt', content: 'x'.repeat(2 * 1024 * 1024) }])
    const request = new Request('http://localhost/x', { method: 'POST', body: big })
    const type = request.headers.get('content-type')!
    const bytes = new Uint8Array(await request.arrayBuffer())
    const res = await call(courseId, { body: bytes, headers: { 'content-type': type, 'content-length': '10' } }) // a lying header
    expect(res.status).toBe(413)
    expect(await prisma.source.count({ where: { courseId } })).toBe(0)
  })

  it('201 and the created sources; the files are on disk and queued', async () => {
    const res = await call(courseId, { body: form([{ name: 'a.txt', content: 'Alpha' }, { name: 'b.md', content: '# Beta' }], { bundle: 'later' }) })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.sources.map((s: { originalName: string; status: string }) => [s.originalName, s.status])).toEqual([['a.txt', 'uploaded'], ['b.md', 'uploaded']])
    expect(queued.ids).toEqual(body.sources.map((s: { id: string }) => s.id))
    const rows = await prisma.source.findMany({ where: { courseId } })
    expect(rows.every((r) => r.bundle === 'later')).toBe(true)
    for (const r of rows) expect(fs.existsSync(path.join(env.dir, 'storage', r.storageKey))).toBe(true)
  })

  it('415 for an unsupported file and nothing at all is written for the good ones', async () => {
    const res = await call(courseId, { body: form([{ name: 'a.txt', content: 'Alpha' }, { name: 'slides.pptx', content: 'x' }]) })
    expect(res.status).toBe(415)
    const body = await res.json()
    expect(body.files).toEqual([{ name: 'slides.pptx', error: '"slides.pptx" is not supported. Upload .txt, .md or .pdf files.' }])
    expect(await prisma.source.count({ where: { courseId } })).toBe(0)
    expect(fs.existsSync(path.join(env.dir, 'storage', 'sources'))).toBe(false)
  })

  it('415 for a .pdf that is not a PDF, 400 for duplicate names, 400 for an unknown bundle, 400 without files', async () => {
    expect((await call(courseId, { body: form([{ name: 'a.pdf', content: 'not a pdf' }]) })).status).toBe(415)
    expect((await call(courseId, { body: form([{ name: 'a.txt', content: 'x' }, { name: 'a.txt', content: 'y' }]) })).status).toBe(400)
    expect((await call(courseId, { body: form([{ name: 'a.txt', content: 'x' }], { bundle: 'weird' }) })).status).toBe(400)
    expect((await call(courseId, { body: form([]) })).status).toBe(400)
    expect(await prisma.source.count({ where: { courseId } })).toBe(0)
  })
})
