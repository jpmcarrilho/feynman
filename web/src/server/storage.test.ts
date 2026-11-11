import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  resolveInside, isInside, isLegacyPathAllowed, readSourceFile, newSummaryFilePath, newSessionIndexPath,
  summaryKey, safeSourceContentType, contentTypeForPath,
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
