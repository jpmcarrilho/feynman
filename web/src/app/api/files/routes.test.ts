import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const auth = vi.hoisted(() => ({ ok: true }))
vi.mock('@/app/auth-actions', () => ({ checkIsAuthenticated: vi.fn(async () => auth.ok) }))
vi.mock('@/lib/db', () => ({
  prisma: {
    topic: { findFirst: vi.fn(), findUnique: vi.fn() },
    source: { findUnique: vi.fn() },
    course: { findUnique: vi.fn() },
  },
}))

import { prisma } from '@/lib/db'
import { GET as legacyGET } from '../file/route'
import { GET as topicGET } from './topic/[topicId]/route'
import { GET as sourceGET } from './source/[sourceId]/route'
import { GET as summaryGET } from './summary/route'

const req = (url: string) => new NextRequest(`http://localhost:3000${url}`)
const ctx = (k: string, v: string) => ({ params: Promise.resolve({ [k]: v }) }) as never

describe('file routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    auth.ok = true
    vi.mocked(prisma.topic.findFirst).mockResolvedValue(null as never)
  })

  it('return 401 before touching the database when unauthenticated', async () => {
    auth.ok = false
    expect((await legacyGET(req('/api/file?path=/etc/hosts'))).status).toBe(401)
    expect((await topicGET(req('/api/files/topic/x'), ctx('topicId', 'x'))).status).toBe(401)
    expect((await sourceGET(req('/api/files/source/x'), ctx('sourceId', 'x'))).status).toBe(401)
    expect((await summaryGET(req('/api/files/summary?session=x'))).status).toBe(401)
    expect(prisma.topic.findFirst).not.toHaveBeenCalled()
    expect(prisma.topic.findUnique).not.toHaveBeenCalled()
    expect(prisma.source.findUnique).not.toHaveBeenCalled()
  })

  it('legacy route refuses paths that are not a stored topic path or a summary file', async () => {
    for (const p of ['/etc/hosts', `${process.cwd()}/.env`, `${process.cwd()}/summaries/../.env`, `${process.cwd()}/summaries/../package.json`]) {
      const res = await legacyGET(req(`/api/file?path=${encodeURIComponent(p)}`))
      expect(res.status, p).toBe(404)
    }
    expect((await legacyGET(req('/api/file'))).status).toBe(400)
  })

  it('legacy route serves stored content for a stored folder path, and nothing for other folders', async () => {
    const folder = process.cwd() // exists, is a directory
    vi.mocked(prisma.topic.findFirst).mockResolvedValueOnce({ title: 'Question 3', content: 'the question outline' } as never)
    const ok = await legacyGET(req(`/api/file?path=${encodeURIComponent(folder)}`))
    expect(ok.status).toBe(200)
    expect(ok.headers.get('Content-Type')).toBe('text/plain; charset=utf-8')
    expect(decodeURIComponent(ok.headers.get('X-File-Title') || '')).toBe('Question 3')
    expect(await ok.text()).toBe('the question outline')

    vi.mocked(prisma.topic.findFirst).mockResolvedValueOnce({ title: 'Empty', content: null } as never)
    expect((await legacyGET(req(`/api/file?path=${encodeURIComponent(folder)}`))).status).toBe(404)

    // folder that matches no stored topic
    expect((await legacyGET(req(`/api/file?path=${encodeURIComponent(`${process.cwd()}/src`)}`))).status).toBe(404)
  })

  it('legacy route serves a tracked summary file by path', async () => {
    const res = await legacyGET(req(`/api/file?path=${encodeURIComponent(`${process.cwd()}/summaries/14.750x/Week_09_Week_8__Corruption_I.md`)}`))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/markdown')
  })

  it('id routes reject malformed ids without a database lookup', async () => {
    expect((await topicGET(req('/api/files/topic/..'), ctx('topicId', '../etc'))).status).toBe(404)
    expect((await sourceGET(req('/api/files/source/..'), ctx('sourceId', 'a/b'))).status).toBe(404)
    expect(prisma.topic.findUnique).not.toHaveBeenCalled()
    expect(prisma.source.findUnique).not.toHaveBeenCalled()
  })

  it('topic route serves stored content as text and 404s when there is nothing to serve', async () => {
    vi.mocked(prisma.topic.findUnique).mockResolvedValueOnce({ title: 'Ünit 1', sourceId: null, localPath: null, content: 'hello' } as never)
    const ok = await topicGET(req('/api/files/topic/t1'), ctx('topicId', 't1'))
    expect(ok.status).toBe(200)
    expect(ok.headers.get('Content-Type')).toContain('text/plain')
    expect(decodeURIComponent(ok.headers.get('X-File-Title') || '')).toBe('Ünit 1')
    expect(await ok.text()).toBe('hello')
    vi.mocked(prisma.topic.findUnique).mockResolvedValueOnce({ title: 'T', sourceId: null, localPath: '/nonexistent/dir', content: null } as never)
    expect((await topicGET(req('/api/files/topic/t2'), ctx('topicId', 't2'))).status).toBe(404)
    vi.mocked(prisma.topic.findUnique).mockResolvedValueOnce(null as never)
    expect((await topicGET(req('/api/files/topic/t3'), ctx('topicId', 't3'))).status).toBe(404)
  })

  it('topic route serves the topic\'s own content for a topic of an uploaded .md or .txt, not the whole file', async () => {
    vi.mocked(prisma.topic.findUnique).mockResolvedValueOnce({ title: 'Sec', sourceId: 's1', localPath: null, content: '# Section\ntext' } as never)
    vi.mocked(prisma.source.findUnique).mockResolvedValueOnce({ storageKey: 'sources/c/s1/original.md', mimeType: 'text/markdown' } as never)
    const md = await topicGET(req('/api/files/topic/t1'), ctx('topicId', 't1'))
    expect(md.status).toBe(200)
    expect(md.headers.get('Content-Type')).toContain('text/markdown')
    expect(await md.text()).toBe('# Section\ntext')
    vi.mocked(prisma.topic.findUnique).mockResolvedValueOnce({ title: 'Sec', sourceId: 's2', localPath: null, content: 'plain' } as never)
    vi.mocked(prisma.source.findUnique).mockResolvedValueOnce({ storageKey: 'sources/c/s2/original.txt', mimeType: 'text/plain' } as never)
    const txt = await topicGET(req('/api/files/topic/t2'), ctx('topicId', 't2'))
    expect(txt.headers.get('Content-Type')).toContain('text/plain')
    expect(await txt.text()).toBe('plain')
  })

  it('topic route replaces huge stored content by a short message', async () => {
    const huge = 'x'.repeat(2_000_001)
    vi.mocked(prisma.topic.findUnique).mockResolvedValueOnce({ title: 'Slides PDF Error', sourceId: null, localPath: null, content: huge } as never)
    const res = await topicGET(req('/api/files/topic/big'), ctx('topicId', 'big'))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('This file could not be imported, so there is nothing to show.')
    vi.mocked(prisma.topic.findUnique).mockResolvedValueOnce({ title: 'Big md', sourceId: 's1', localPath: null, content: huge } as never)
    vi.mocked(prisma.source.findUnique).mockResolvedValueOnce({ storageKey: 'k', mimeType: 'text/markdown' } as never)
    const md = await topicGET(req('/api/files/topic/big2'), ctx('topicId', 'big2'))
    expect((await md.text()).length).toBeLessThan(100)
    vi.mocked(prisma.topic.findUnique).mockResolvedValueOnce({ title: 'ok', sourceId: null, localPath: null, content: 'x'.repeat(2_000_000) } as never)
    expect((await (await topicGET(req('/api/files/topic/ok'), ctx('topicId', 'ok'))).text()).length).toBe(2_000_000)
  })

  it('source route 404s for a missing row and for a key that escapes storage', async () => {
    vi.mocked(prisma.source.findUnique).mockResolvedValueOnce(null as never)
    expect((await sourceGET(req('/api/files/source/s1'), ctx('sourceId', 's1'))).status).toBe(404)
    vi.mocked(prisma.source.findUnique).mockResolvedValueOnce({ originalName: 'x.pdf', mimeType: 'application/pdf', storageKey: '../../etc/hosts' } as never)
    expect((await sourceGET(req('/api/files/source/s2'), ctx('sourceId', 's2'))).status).toBe(404)
  })

  it('summary route validates key and session shapes', async () => {
    expect((await summaryGET(req('/api/files/summary?course=c1&key=../x'))).status).toBe(404)
    expect((await summaryGET(req('/api/files/summary?course=c1&key=a/b'))).status).toBe(404)
    expect((await summaryGET(req('/api/files/summary?session=../x'))).status).toBe(404)
    expect((await summaryGET(req('/api/files/summary'))).status).toBe(404)
    expect(prisma.course.findUnique).not.toHaveBeenCalled()
  })

  it('summary route opens a legacy session index and a legacy module summary', async () => {
    const sid = '38336795-b86c-49e1-90a9-7056f8d7ece9'
    const idx = await summaryGET(req(`/api/files/summary?session=${sid}`))
    expect(idx.status).toBe(200)
    vi.mocked(prisma.course.findUnique).mockResolvedValueOnce({ id: 'c1', code: '14.750x' } as never)
    const wk = await summaryGET(req('/api/files/summary?course=c1&key=Week_09_Week_8__Corruption_I'))
    expect(wk.status).toBe(200)
    vi.mocked(prisma.course.findUnique).mockResolvedValueOnce({ id: 'c1', code: '14.750x' } as never)
    const wkMd = await summaryGET(req('/api/files/summary?course=c1&key=Week_09_Week_8__Corruption_I.md'))
    expect(wkMd.status).toBe(200)
  })
})
