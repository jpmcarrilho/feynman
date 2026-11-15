import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  resolveInside, isInside, isLegacyPathAllowed, readSourceFile, newSummaryFilePath, newSessionIndexPath,
  summaryKey, safeSourceContentType, contentTypeForPath,
  sourceStorageKey, pagesStorageKey, sourceDir, atomicWriteStorageFile, writeSourceFile, writePages, readPages,
  removeStaleTempFiles,
} from './storage'

describe('resolveInside', () => {
  it('accepts nested relative keys and rejects escapes', () => {
    expect(resolveInside('/r/storage', 'sources/c/s/original.pdf')).toBe('/r/storage/sources/c/s/original.pdf')
    expect(resolveInside('/r/storage', '../etc/passwd')).toBeNull()
    expect(resolveInside('/r/storage', 'a/../../b')).toBeNull()
    expect(resolveInside('/r/storage', '/etc/hosts')).toBeNull()
    expect(resolveInside('/r/storage', '')).toBeNull()
    expect(resolveInside('/r/storage', 'a\0b')).toBeNull()
    expect(resolveInside('/r/storage', '../storage-evil/x')).toBeNull()
    expect(resolveInside('/r/storage', '.')).toBeNull()
  })
})

describe('isInside', () => {
  it('is strict about the directory boundary', () => {
    expect(isInside('/r/s', '/r/s/a.md')).toBe(true)
    expect(isInside('/r/s', '/r/s')).toBe(false)
    expect(isInside('/r/s', '/r/s-other/a.md')).toBe(false)
    expect(isInside('/r/s', '/r/s/../x.md')).toBe(false)
  })
})

describe('isLegacyPathAllowed', () => {
  const roots = ['/app/summaries', '/app/storage/summaries']
  it('allows an exact stored topic path whatever its extension', () => {
    expect(isLegacyPathAllowed('/Users/me/MIT/14.750x/W1/Slides.pdf', roots, true)).toBe(true)
    expect(isLegacyPathAllowed('/Users/me/MIT/14.750x/W1/Question_1', roots, true)).toBe(true)
  })
  it('allows .md files inside the summary roots', () => {
    expect(isLegacyPathAllowed('/app/summaries/14.750x/Week_01.md', roots, false)).toBe(true)
    expect(isLegacyPathAllowed('/app/storage/summaries/sessions/x_index.md', roots, false)).toBe(true)
  })
  it('refuses everything else', () => {
    expect(isLegacyPathAllowed('/etc/hosts', roots, false)).toBe(false)
    expect(isLegacyPathAllowed('/app/.env', roots, false)).toBe(false)
    expect(isLegacyPathAllowed('/app/summaries/../.env', roots, false)).toBe(false)
    expect(isLegacyPathAllowed('/app/summaries/../.env.md', roots, false)).toBe(false)
    expect(isLegacyPathAllowed('/app/summaries/../storage/sources/c/s/original.md', roots, false)).toBe(false)
    expect(isLegacyPathAllowed('/app/summaries-evil/a.md', roots, false)).toBe(false)
    expect(isLegacyPathAllowed('/app/summaries/a.pdf', roots, false)).toBe(false)
    expect(isLegacyPathAllowed('/app/summaries', roots, false)).toBe(false)
    expect(isLegacyPathAllowed('summaries/a.md', roots, false)).toBe(false)
    expect(isLegacyPathAllowed('/app/summaries/a.md\0.png', roots, false)).toBe(false)
    expect(isLegacyPathAllowed('', roots, false)).toBe(false)
  })
})

describe('summary paths', () => {
  const course = { id: 'c1', code: '14.750x' }
  it('builds keys and new file paths only for valid names', () => {
    expect(summaryKey('Week 01 Intro')).toBe('Week_01_Intro')
    expect(summaryKey('Week/01')).toBeNull()
    expect(newSummaryFilePath(course, 'Week_01')).toMatch(/storage\/summaries\/c1\/Week_01\.md$/)
    expect(newSummaryFilePath(course, '../x')).toBeNull()
    expect(newSessionIndexPath('abc-1')).toMatch(/storage\/summaries\/sessions\/abc-1_index\.md$/)
    expect(newSessionIndexPath('../x')).toBeNull()
  })
})

describe('content types', () => {
  it('serves sources only as pdf/text/markdown', () => {
    expect(safeSourceContentType('application/pdf')).toBe('application/pdf')
    expect(safeSourceContentType('text/plain')).toContain('text/plain')
    expect(safeSourceContentType('text/html')).toBe('application/octet-stream')
    expect(contentTypeForPath('/a/b.html')).toBe('application/octet-stream')
    expect(contentTypeForPath('/a/b.PDF')).toBe('application/pdf')
  })
})

describe('readSourceFile', () => {
  let tmp: string
  let prev: string | undefined
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-test-'))
    prev = process.env.STORAGE_DIR
    process.env.STORAGE_DIR = path.join(tmp, 'storage')
    fs.mkdirSync(path.join(tmp, 'storage', 'sources', 'c', 's'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'storage', 'sources', 'c', 's', 'original.txt'), 'hello')
    fs.writeFileSync(path.join(tmp, 'secret.txt'), 'secret')
    fs.symlinkSync(path.join(tmp, 'secret.txt'), path.join(tmp, 'storage', 'sources', 'c', 's', 'link.txt'))
  })
  afterAll(() => {
    if (prev === undefined) delete process.env.STORAGE_DIR
    else process.env.STORAGE_DIR = prev
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('reads a file inside the storage directory', async () => {
    expect((await readSourceFile('sources/c/s/original.txt')).toString()).toBe('hello')
  })
  it('rejects keys that escape the storage directory', async () => {
    await expect(readSourceFile('../secret.txt')).rejects.toThrow()
    await expect(readSourceFile(path.join(tmp, 'secret.txt'))).rejects.toThrow()
    await expect(readSourceFile('sources/../../secret.txt')).rejects.toThrow()
  })
  it('rejects a symlink that points outside the storage directory', async () => {
    await expect(readSourceFile('sources/c/s/link.txt')).rejects.toThrow()
  })
  it('fails for a missing file', async () => {
    await expect(readSourceFile('sources/c/s/nope.txt')).rejects.toThrow()
  })
})

describe('source storage', () => {
  let tmp: string
  let prev: string | undefined
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'src-storage-'))
    prev = process.env.STORAGE_DIR
    process.env.STORAGE_DIR = path.join(tmp, 'storage')
  })
  afterAll(() => {
    if (prev === undefined) delete process.env.STORAGE_DIR
    else process.env.STORAGE_DIR = prev
    fs.rmSync(tmp, { recursive: true, force: true })
  })
  const dirOf = (c: string, s: string) => path.join(tmp, 'storage', 'sources', c, s)

  it('builds keys only from valid ids and extensions', () => {
    expect(sourceStorageKey('c1', 's1', '.pdf')).toBe('sources/c1/s1/original.pdf')
    expect(pagesStorageKey('c1', 's1')).toBe('sources/c1/s1/pages.json')
    expect(() => sourceStorageKey('../x', 's1', '.pdf')).toThrow()
    expect(() => sourceStorageKey('c1', 'a/b', '.pdf')).toThrow()
    expect(() => sourceStorageKey('c1', 's1', '/../../etc')).toThrow()
    expect(() => pagesStorageKey('c1', '..')).toThrow()
    expect(() => sourceDir('c1', '')).toThrow()
  })

  it('writes the uploaded bytes under sources/<course>/<source>/', async () => {
    const key = await writeSourceFile('c1', 's1', '.txt', Buffer.from('hello'))
    expect(key).toBe('sources/c1/s1/original.txt')
    expect(fs.readFileSync(path.join(dirOf('c1', 's1'), 'original.txt'), 'utf8')).toBe('hello')
    expect((await readSourceFile(key)).toString()).toBe('hello')
  })

  it('replaces a file atomically: a failed write leaves the old content and no temporary file', async () => {
    await atomicWriteStorageFile('sources/c2/s2/pages.json', 'old')
    await expect(atomicWriteStorageFile('sources/c2/s2/pages.json', 42 as unknown as string)).rejects.toThrow()
    expect(fs.readFileSync(path.join(dirOf('c2', 's2'), 'pages.json'), 'utf8')).toBe('old')
    expect(fs.readdirSync(dirOf('c2', 's2'))).toEqual(['pages.json'])
    // rename onto a directory fails after the temp file was written: it is cleaned up
    fs.mkdirSync(path.join(dirOf('c2', 's2'), 'blocked.json'))
    await expect(atomicWriteStorageFile('sources/c2/s2/blocked.json', 'x')).rejects.toThrow()
    expect(fs.readdirSync(dirOf('c2', 's2')).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('refuses keys that escape the storage directory, also through a symlink', async () => {
    await expect(atomicWriteStorageFile('../outside.txt', 'x')).rejects.toThrow('Invalid storage key')
    await expect(atomicWriteStorageFile('/etc/evil', 'x')).rejects.toThrow('Invalid storage key')
    const outside = path.join(tmp, 'outside')
    fs.mkdirSync(outside)
    fs.mkdirSync(path.join(tmp, 'storage', 'sources', 'c3'), { recursive: true })
    fs.symlinkSync(outside, path.join(tmp, 'storage', 'sources', 'c3', 's3'))
    await expect(atomicWriteStorageFile('sources/c3/s3/pages.json', 'x')).rejects.toThrow('Invalid storage key')
    expect(fs.readdirSync(outside)).toEqual([])
  })

  it('round-trips pages.json and returns null for missing, corrupt or invalid files', async () => {
    expect(await readPages('c4', 's4')).toBeNull()
    await writePages('c4', 's4', { pages: [{ n: 1, text: 'a' }, { n: 2, text: '' }], ocr: true, warning: 'w' })
    expect(await readPages('c4', 's4')).toEqual({ pages: [{ n: 1, text: 'a' }, { n: 2, text: '' }], ocr: true, warning: 'w' })
    fs.writeFileSync(path.join(dirOf('c4', 's4'), 'pages.json'), '{"pages": [{"n": 1')
    expect(await readPages('c4', 's4')).toBeNull()
    fs.writeFileSync(path.join(dirOf('c4', 's4'), 'pages.json'), JSON.stringify({ pages: [{ n: 0, text: 'x' }], ocr: false }))
    expect(await readPages('c4', 's4')).toBeNull()
  })

  it('removes stale temporary files only', async () => {
    await writePages('c5', 's5', { pages: [{ n: 1, text: 'a' }], ocr: false })
    fs.writeFileSync(path.join(dirOf('c5', 's5'), 'pages.json.9.abcd.tmp'), 'partial')
    await removeStaleTempFiles('c5', 's5')
    expect(fs.readdirSync(dirOf('c5', 's5'))).toEqual(['pages.json'])
    await expect(removeStaleTempFiles('c5', 'missing')).resolves.toBeUndefined()
  })
})
