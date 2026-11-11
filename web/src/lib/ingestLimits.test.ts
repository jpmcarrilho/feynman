import { describe, it, expect } from 'vitest'
import { checkUploadList, sanitizeFileName, mimeTypeForExtension, MAX_FILE_BYTES } from './ingestLimits'

describe('checkUploadList', () => {
  it('accepts a normal list', () => {
    expect(checkUploadList([{ name: 'a.PDF', size: 10 }, { name: 'b.md', size: MAX_FILE_BYTES }])).toEqual([])
  })
  it('reports every problem: extension 415, size 413, empty 400, duplicates 400, count 413', () => {
    const problems = checkUploadList([
      { name: 'a.docx', size: 1 }, { name: 'big.pdf', size: MAX_FILE_BYTES + 1 }, { name: 'e.txt', size: 0 }, { name: 'd.txt', size: 1 }, { name: 'D.TXT', size: 1 },
    ])
    expect(problems.map((p) => p.status)).toEqual([415, 413, 400, 400])
    expect(problems.map((p) => p.name)).toEqual(['a.docx', 'big.pdf', 'e.txt', 'd.txt'])
    const many = checkUploadList(Array.from({ length: 21 }, (_, i) => ({ name: `${i}.txt`, size: 1 })))
    expect(many[0]).toMatchObject({ status: 413, name: null })
    expect(checkUploadList([])[0].status).toBe(400)
  })
  it('a name without extension or with only a dot is unsupported', () => {
    expect(checkUploadList([{ name: 'README', size: 1 }, { name: '.txt', size: 1 }]).map((p) => p.status)).toEqual([415, 415])
  })
})

describe('sanitizeFileName', () => {
  it('keeps only the last path component and drops control and direction characters', () => {
    expect(sanitizeFileName('C:\\Users\\me\\Notes.txt')).toBe('Notes.txt')
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd')
    expect(sanitizeFileName('a\u0000b\u202ec.md')).toBe('abc.md')
    expect(sanitizeFileName('  spaced name.txt  ')).toBe('spaced name.txt')
  })
  it('caps the length and keeps the extension', () => {
    const out = sanitizeFileName('x'.repeat(500) + '.pdf')
    expect(out).toHaveLength(200)
    expect(out.endsWith('.pdf')).toBe(true)
  })
  it('maps extensions to stored media types', () => {
    expect([mimeTypeForExtension('.pdf'), mimeTypeForExtension('.md'), mimeTypeForExtension('.txt')]).toEqual(['application/pdf', 'text/markdown', 'text/plain'])
  })
})
