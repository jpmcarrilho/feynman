import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const pdf = vi.hoisted(() => ({ pages: [] as string[], error: null as Error | null, opened: 0 }))

vi.mock('pdf-parse', () => ({
  PDFParse: class {
    constructor(opts: { data: Uint8Array }) {
      pdf.opened++
      // like pdf.js: the array handed over is detached
      const b = opts.data.buffer as ArrayBuffer
      structuredClone(b, { transfer: [b] })
    }
    async getText(params: { partial?: number[] }) {
      if (pdf.error) throw pdf.error
      const total = pdf.pages.length
      const nums = (params.partial ?? []).filter((n) => n >= 1 && n <= total)
      return { total, pages: nums.map((n) => ({ num: n, text: pdf.pages[n - 1] })) }
    }
    async destroy() {}
  },
}))
vi.mock('ai', () => ({ generateObject: vi.fn() }))
vi.mock('@ai-sdk/google', () => ({ google: vi.fn(() => 'mocked-google-model') }))

type Row = { id: string; courseId: string; storageKey: string; status: string; failedStage: string | null; error: string | null; warning: string | null; pageCount: number | null; charCount: number | null; usedOcrFallback: boolean }
const db = vi.hoisted(() => ({ row: null as unknown, updates: [] as unknown[] }))
vi.mock('@/lib/db', () => ({
  prisma: {
    source: {
      findUnique: vi.fn(async () => (db.row ? { ...(db.row as object) } : null)),
      updateMany: vi.fn(async (args: { where: { status?: string | { in: string[] } }; data: Record<string, unknown> }) => {
        const row = db.row as Row | null
        if (!row) return { count: 0 }
        const st = args.where.status
        const ok = st === undefined || (typeof st === 'string' ? row.status === st : st.in.includes(row.status))
        if (!ok) return { count: 0 }
        Object.assign(row, args.data)
        db.updates.push(args.data)
        return { count: 1 }
      }),
    },
  },
}))

import { generateObject } from 'ai'
import {
  extractBytes, extractSource, decodeTextFile, mapOcrPages, modelAddedValue, ExtractionError, MAX_FILE_BYTES, MAX_EXTRACTED_CHARS,
} from './extract'
import { readPages } from '@/server/storage'

const enc = new TextEncoder()
// Digits in transcribed text must not follow the page index (a footer-like pattern the header rule would remove)
const label = (n: number) => `${(n * 7919) % 1000 + 2000}`
const dense = (i: number) => `Heading ${label(i)}\n` + 'The quick brown fox jumps over the lazy dog. '.repeat(8)

function mockOcr(impl: (start: number, end: number, call: number) => unknown) {
  let call = 0
  vi.mocked(generateObject).mockImplementation((async (args: { messages: Array<{ content: Array<{ type: string; text?: string }> }> }) => {
    const text = args.messages[0].content.find((c) => c.type === 'text')!.text!
    const m = text.match(/Transcribe pages (\d+) to (\d+)/)!
    call++
    return { object: impl(Number(m[1]), Number(m[2]), call) }
  }) as never)
}
const pdfBytes = (extra = 0) => {
  const b = new Uint8Array(1024 + extra)
  b.set(enc.encode('%PDF-1.7\n'))
  return b
}

beforeEach(() => {
  pdf.pages = []
  pdf.error = null
  pdf.opened = 0
  vi.mocked(generateObject).mockReset()
})

describe('decodeTextFile', () => {
  it('strips a UTF-8 BOM', () => {
    const r = decodeTextFile(new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode('héllo')]))
    expect(r.text).toBe('héllo')
    expect(r.encoding).toBe('utf-8')
    expect(r.warning).toBeNull()
  })

  it('decodes UTF-16 with a BOM (both byte orders) and without one', () => {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('café über\nsecond line', 'utf16le')])
    expect(decodeTextFile(le).text).toBe('café über\nsecond line')
    const be = Buffer.from(Buffer.from('café über\nsecond line', 'utf16le')).swap16()
    expect(decodeTextFile(Buffer.concat([Buffer.from([0xfe, 0xff]), be])).text).toBe('café über\nsecond line')
    expect(decodeTextFile(Buffer.from('plain ascii text in utf16', 'utf16le')).encoding).toBe('utf-16le')
    expect(decodeTextFile(Buffer.from(Buffer.from('plain ascii text in utf16', 'utf16le')).swap16()).encoding).toBe('utf-16be')
  })

  it('decodes invalid UTF-8 as Windows-1252 and says so', () => {
    const r = decodeTextFile(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x93, 0x71, 0x75, 0x6f, 0x74, 0x65, 0x94]))
    expect(r.text).toBe('café “quote”')
    expect(r.encoding).toBe('windows-1252')
    expect(r.warning).toMatch(/Windows-1252/)
  })

  it('rejects binary content and known non-text signatures with a readable message', () => {
    expect(() => decodeTextFile(Buffer.from([0x41, 0x00, 0x42, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x00]))).toThrow(/binary data/)
    expect(() => decodeTextFile(enc.encode('%PDF-1.4 rest'))).toThrow(/is a PDF, not a text file/)
    expect(() => decodeTextFile(Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]))).toThrow(/ZIP-based/)
    expect(() => decodeTextFile(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toThrow(/image/)
    // a NUL far from the start is still binary
    const late = Buffer.concat([Buffer.from('a'.repeat(20000)), Buffer.from([0]), Buffer.from('tail')])
    expect(() => decodeTextFile(late)).toThrow(/binary data/)
  })
})

describe('extractBytes: text files', () => {
  it('cleans, pages and numbers a .txt file', async () => {
    const text = Array.from({ length: 12 }, (_, i) => `Paragraph ${i}   with  spaces.\r\n` + 'word '.repeat(150)).join('\r\n\r\n')
    const r = await extractBytes('.txt', Buffer.from('﻿' + text))
    expect(r.pages.map((p) => p.n)).toEqual(r.pages.map((_, i) => i + 1))
    expect(r.pages.length).toBeGreaterThan(1)
    const all = r.pages.map((p) => p.text).join('\n')
    expect(all).not.toContain('\r')
    expect(all).not.toContain('  ')
    expect(all).not.toContain('﻿')
    expect(all).toContain('Paragraph 11 with spaces.')
    expect(r.ocr).toBe(false)
    expect(r.charCount).toBe(r.pages.reduce((n, p) => n + p.text.length, 0))
  })

  it('splits Markdown at headings', async () => {
    const md = ['# A', 'x '.repeat(900), '## B', 'y '.repeat(900), '## C', 'z '.repeat(900)].join('\n')
    const r = await extractBytes('.md', Buffer.from(md))
    expect(r.pages.length).toBeGreaterThanOrEqual(2)
    expect(r.pages.slice(1).every((p) => p.text.startsWith('#'))).toBe(true)
  })

  it('reports Windows-1252 decoding as a warning', async () => {
    const r = await extractBytes('.txt', Buffer.from([...enc.encode('Na'), 0xef, ...enc.encode('ve caf'), 0xe9]))
    expect(r.pages[0].text).toBe('Naïve café')
    expect(r.warning).toMatch(/Windows-1252/)
  })

  it('fails on empty and whitespace-only files', async () => {
    await expect(extractBytes('.txt', Buffer.from(''))).rejects.toThrow(/No readable text/)
    await expect(extractBytes('.md', Buffer.from(' \n\n \t '))).rejects.toThrow(/No readable text/)
  })

  it('fails for a .txt that is a PDF or binary', async () => {
    await expect(extractBytes('.txt', Buffer.from('%PDF-1.5\n1 0 obj'))).rejects.toThrow(/is a PDF, not a text file/)
    await expect(extractBytes('.txt', Buffer.from([1, 2, 3, 0, 0, 9, 8, 7]))).rejects.toThrow(/binary data/)
  })

  it('accepts exactly 2,000,000 characters and rejects 2,000,001 with the documented message', async () => {
    // one unbroken run so that page cuts lose no whitespace and the count is exact
    const ok = await extractBytes('.txt', Buffer.from('x'.repeat(MAX_EXTRACTED_CHARS)))
    expect(ok.charCount).toBe(MAX_EXTRACTED_CHARS)
    await expect(extractBytes('.txt', Buffer.from('x'.repeat(MAX_EXTRACTED_CHARS + 1)))).rejects.toThrow(
      'Document too long (2,000,001 chars, limit 2,000,000)',
    )
  })

  it('rejects files over 50 MB and unsupported types', async () => {
    await expect(extractBytes('.txt', Buffer.alloc(MAX_FILE_BYTES + 1, 97))).rejects.toThrow(/File too large/)
    await expect(extractBytes('.docx', Buffer.from('x'))).rejects.toThrow(/Unsupported file type/)
  })
})

describe('extractBytes: PDFs with pdf-parse mocked', () => {
  it('keeps one entry per PDF page in the PDF order, cleaned, with 1-based numbers', async () => {
    pdf.pages = [1, 2, 3, 4, 5, 6].map((i) => (i === 4 ? '�'.repeat(300) : dense(i) + ' oﬃce\u0000'))
    const r = await extractBytes('.pdf', pdfBytes())
    expect(r.ocr).toBe(false)
    expect(r.pages.map((p) => p.n)).toEqual([1, 2, 3, 4, 5, 6])
    expect(r.pages[1].text).toContain(`Heading ${label(2)}`)
    expect(r.pages[3].text).toBe('')
    expect(r.pages[4].text).toContain(`Heading ${label(5)}`)
    expect(r.pages[0].text).toContain('office')
    expect(r.pages[0].text).not.toContain('\u0000')
    expect(r.warning).toMatch(/1 page\(s\) held unreadable data/)
    expect(generateObject).not.toHaveBeenCalled()
  })

  it('rejects files that are not PDFs even with a .pdf name and says what they are', async () => {
    await expect(extractBytes('.pdf', enc.encode('<!DOCTYPE html><html><body>x</body></html>'))).rejects.toThrow(/is a web page, not a PDF/)
    await expect(extractBytes('.pdf', Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]))).rejects.toThrow(/ZIP-based file.*not a PDF/)
    await expect(extractBytes('.pdf', enc.encode('hello world'))).rejects.toThrow(/not a PDF/)
    expect(pdf.opened).toBe(0)
  })

  it('fails clearly for password-protected, damaged and empty PDFs', async () => {
    pdf.error = Object.assign(new Error('No password given'), { name: 'PasswordException' })
    await expect(extractBytes('.pdf', pdfBytes())).rejects.toThrow(/password-protected/)
    pdf.error = Object.assign(new Error('Invalid PDF structure'), { name: 'InvalidPDFException' })
    await expect(extractBytes('.pdf', pdfBytes())).rejects.toThrow(/damaged/)
    pdf.error = null
    pdf.pages = []
    await expect(extractBytes('.pdf', pdfBytes())).rejects.toThrow('This PDF has no pages.')
  })

  it('fails when the PDF text exceeds 2,000,000 characters', async () => {
    pdf.pages = Array.from({ length: 30 }, () => ('word '.repeat(13000)).trim()) // 30 x 64,999
    // 1,949,970 chars: fine
    await expect(extractBytes('.pdf', pdfBytes())).resolves.toBeDefined()
    pdf.pages = Array.from({ length: 32 }, () => ('word '.repeat(13000)).trim()) // 2,079,968
    await expect(extractBytes('.pdf', pdfBytes())).rejects.toThrow(/Document too long \(2,079,968 chars, limit 2,000,000\)/)
  })

  it('does not strip real content and drops repeated slide numbers and running titles', async () => {
    pdf.pages = Array.from({ length: 8 }, (_, i) => `${dense(i)}\nCourse deck\n${i + 1}`)
    const r = await extractBytes('.pdf', pdfBytes())
    for (const p of r.pages) {
      expect(p.text).not.toContain('Course deck')
      expect(p.text.trim().endsWith('dog.')).toBe(true)
    }
  })
})

describe('Gemini fallback', () => {
  const sparse = (n: number) => Array.from({ length: n }, (_, i) => (i % 5 === 0 ? `Title ${i + 1}` : ''))
  const answer = (start: number, end: number) => ({
    pages: Array.from({ length: end - start + 1 }, (_, k) => ({ n: start + k, text: `Transcribed ${label(start + k)} with some words` })),
  })

  it('runs for a sparse PDF: sends the PDF as a file part per range, first range alone, keeps page numbers', async () => {
    pdf.pages = sparse(32)
    const order: string[] = []
    let inFlight = 0
    let maxInFlight = 0
    mockOcr((s, e) => { order.push(`${s}-${e}`); return answer(s, e) })
    vi.mocked(generateObject).mockImplementation((async (args: { messages: Array<{ content: Array<{ type: string; text?: string; mediaType?: string; data?: Uint8Array }> }> }) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      const parts = args.messages[0].content
      const file = parts.find((c) => c.type === 'file')!
      expect(file.mediaType).toBe('application/pdf')
      expect(file.data!.byteLength).toBe(1024)
      expect(parts[0].type).toBe('file') // PDF first so the prompt prefix is identical across ranges (implicit caching)
      const m = parts.find((c) => c.type === 'text')!.text!.match(/Transcribe pages (\d+) to (\d+)/)!
      order.push(`${m[1]}-${m[2]}`)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return { object: answer(Number(m[1]), Number(m[2])) }
    }) as never)
    const r = await extractBytes('.pdf', pdfBytes())
    expect(r.ocr).toBe(true)
    expect(order[0]).toBe('1-15')
    expect(new Set(order)).toEqual(new Set(['1-15', '16-30', '31-32']))
    expect(maxInFlight).toBeLessThanOrEqual(3)
    expect(r.pages).toHaveLength(32)
    expect(r.pages.map((p) => p.n)).toEqual(Array.from({ length: 32 }, (_, i) => i + 1))
    expect(r.pages[16].text).toBe(`Transcribed ${label(17)} with some words`)
  })

  it('skips ranges whose pages all have enough text, keeping their pdf-parse text', async () => {
    pdf.pages = [...sparse(15), ...Array.from({ length: 15 }, (_, i) => dense(16 + i))]
    mockOcr((s, e) => answer(s, e))
    const r = await extractBytes('.pdf', pdfBytes())
    expect(vi.mocked(generateObject)).toHaveBeenCalledTimes(1)
    expect(r.pages[20].text).toContain(`Heading ${label(21)}`)
    expect(r.pages[0].text).toBe(`Transcribed ${label(1)} with some words`)
  })

  it('keeps the pdf-parse text of a page when the model returns an empty string for it', async () => {
    pdf.pages = sparse(15).map((t, i) => (i === 0 ? 'Only title here' : t))
    mockOcr((s, e) => ({ pages: answer(s, e).pages.map((p) => (p.n === 1 ? { ...p, text: '' } : p)) }))
    const r = await extractBytes('.pdf', pdfBytes())
    expect(r.pages[0].text).toBe('Only title here')
  })

  it('retries a failed range once and then succeeds', async () => {
    pdf.pages = sparse(20)
    mockOcr((s, e, call) => { if (call === 2) throw new Error('503 overloaded'); return answer(s, e) })
    const r = await extractBytes('.pdf', pdfBytes())
    expect(r.ocr).toBe(true)
    expect(generateObject).toHaveBeenCalledTimes(3) // 1-15, 16-20 (fails), 16-20 again
    expect(r.pages).toHaveLength(20)
  })

  it('fails the whole source with a clear message when a range fails twice (no document with missing pages)', async () => {
    pdf.pages = sparse(32)
    mockOcr((s, e) => { if (s === 16) throw new Error('quota exceeded'); return answer(s, e) })
    const error = await extractBytes('.pdf', pdfBytes()).catch((e) => e)
    expect(error).toBeInstanceOf(ExtractionError)
    expect(error.message).toMatch(/pages 16-30/)
    expect(error.message).toMatch(/quota exceeded/)
    expect(error.message).toMatch(/Retry/)
  })

  it('treats a range answer with too few pages as a failure and retries it', async () => {
    pdf.pages = sparse(15)
    mockOcr((s, e, call) => (call === 1 ? { pages: [{ n: 1, text: 'only one' }] } : answer(s, e)))
    const r = await extractBytes('.pdf', pdfBytes())
    expect(generateObject).toHaveBeenCalledTimes(2)
    expect(r.pages).toHaveLength(15)
  })

  it('ignores pages outside the requested range', async () => {
    pdf.pages = sparse(15)
    mockOcr((s, e) => ({ pages: [...answer(s, e).pages, { n: 99, text: 'stray' }, { n: 0, text: 'stray' }] }))
    const r = await extractBytes('.pdf', pdfBytes())
    expect(r.pages).toHaveLength(15)
    expect(r.pages.map((p) => p.text).join(' ')).not.toContain('stray')
  })

  it('maps relative numbering by order and records a warning', async () => {
    pdf.pages = sparse(30)
    mockOcr((s, e) => ({ pages: Array.from({ length: e - s + 1 }, (_, k) => ({ n: k + 1, text: `Relative ${label(s + k)}` })) }))
    const r = await extractBytes('.pdf', pdfBytes())
    expect(r.pages[17].text).toBe(`Relative ${label(18)}`)
    expect(r.warning).toMatch(/matched by order/)
  })

  it('stops after the first range when the model adds essentially nothing (plots with titles)', async () => {
    // 32 pages with a 60-character title each (about 1,900 characters in total, 900 in the first range)
    pdf.pages = Array.from({ length: 32 }, (_, i) => `Figure caption ${label(i + 1)} for the capacity curve slide.`)
    mockOcr((s, e) => ({ pages: Array.from({ length: e - s + 1 }, (_, k) => ({ n: s + k, text: `Figure caption ${label(s + k)} for the capacity curve slide.${s + k === 3 ? ' $v_1$' : ''}` })) }))
    const r = await extractBytes('.pdf', pdfBytes())
    expect(generateObject).toHaveBeenCalledTimes(1)
    expect(r.ocr).toBe(false)
    expect(r.warning).toMatch(/images or plots without readable text/)
    expect(r.pages).toHaveLength(32)
    expect(r.pages[20].text).toBe(`Figure caption ${label(21)} for the capacity curve slide.`)
  })

  it('continues after the first range when the model recovers real text (scan)', async () => {
    pdf.pages = Array.from({ length: 35 }, () => '')
    mockOcr((s, e) => answer(s, e))
    const r = await extractBytes('.pdf', pdfBytes())
    expect(generateObject).toHaveBeenCalledTimes(3)
    expect(r.ocr).toBe(true)
    expect(r.warning).toBeNull()
  })

  it('enforces 300 pages and 20 MB before any model call', async () => {
    pdf.pages = sparse(301)
    await expect(extractBytes('.pdf', pdfBytes())).rejects.toThrow('Scanned PDF too large for the Gemini fallback (limit 20 MB / 300 pages)')
    pdf.pages = sparse(10)
    await expect(extractBytes('.pdf', pdfBytes(20 * 1024 * 1024))).rejects.toThrow('Scanned PDF too large for the Gemini fallback (limit 20 MB / 300 pages)')
    expect(generateObject).not.toHaveBeenCalled()
  })

  it('fails with "No readable text" when the fallback also finds nothing', async () => {
    pdf.pages = ['', '', '']
    mockOcr((s, e) => ({ pages: Array.from({ length: e - s + 1 }, (_, k) => ({ n: s + k, text: '' })) }))
    await expect(extractBytes('.pdf', pdfBytes())).rejects.toThrow(/No readable text/)
  })
})

describe('modelAddedValue', () => {
  const pagesOf = (...texts: string[]) => texts.map((text, i) => ({ n: i + 1, text }))
  const res = (...texts: string[]) => ({ texts: new Map(texts.map((t, i) => [i + 1, t])), byOrder: false })
  const long = (n: number) => 'x'.repeat(n)

  it('says no gain when the added text is under 10 % of 300+ existing characters and no page jumps', () => {
    expect(modelAddedValue(pagesOf(long(200), long(200)), res(long(215), long(210)))).toBe(false)
  })
  it('says gain at 10 % added or more', () => {
    expect(modelAddedValue(pagesOf(long(200), long(200)), res(long(240), long(200)))).toBe(true)
  })
  it('says gain when a nearly empty page becomes substantial, even if the total looks flat', () => {
    expect(modelAddedValue(pagesOf(long(500), long(10)), res(long(500), long(100)))).toBe(true)
    expect(modelAddedValue(pagesOf(long(500), long(10)), res(long(500), long(60)))).toBe(false)
  })
  it('never stops on too little existing text (a scan with blank first pages)', () => {
    expect(modelAddedValue(pagesOf('', '', ''), res('', '', ''))).toBe(true)
    expect(modelAddedValue(pagesOf(long(100), long(100)), res(long(100), long(100)))).toBe(true)
  })
})

describe('mapOcrPages', () => {
  it('accepts an exact answer, a partial answer of at least half the range, and rejects the rest', () => {
    const p = (...ns: number[]) => ns.map((n) => ({ n, text: `t${n}` }))
    expect(mapOcrPages(p(1, 2, 3), 1, 3)?.byOrder).toBe(false)
    expect(mapOcrPages(p(1, 2), 1, 3)?.texts.size).toBe(2)
    expect(mapOcrPages(p(1), 1, 3)).toBeNull()
    expect(mapOcrPages([], 1, 3)).toBeNull()
    const rel = mapOcrPages(p(1, 2, 3), 31, 33)
    expect(rel?.byOrder).toBe(true)
    expect(rel?.texts.get(33)).toBe('t3')
    // a duplicated number makes the numbering untrustworthy: only an answer with one entry per page is mapped, by order
    expect(mapOcrPages([...p(1, 2), { n: 2, text: 'dup' }], 1, 4)).toBeNull()
  })
})

describe('extractSource', () => {
  let dir: string
  const prevStorage = process.env.STORAGE_DIR
  const KEY = 'sources/c1/s1/original.txt'

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-test-'))
    process.env.STORAGE_DIR = dir
  })
  afterAll(() => {
    if (prevStorage === undefined) delete process.env.STORAGE_DIR
    else process.env.STORAGE_DIR = prevStorage
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function seed(content: Buffer, key = KEY, status = 'uploaded') {
    fs.rmSync(path.join(dir, 'sources'), { recursive: true, force: true })
    fs.mkdirSync(path.join(dir, path.dirname(key)), { recursive: true })
    fs.writeFileSync(path.join(dir, key), content)
    db.updates = []
    db.row = { id: 's1', courseId: 'c1', storageKey: key, status, failedStage: null, error: null, warning: null, pageCount: null, charCount: null, usedOcrFallback: false } satisfies Row
  }
  const row = () => db.row as Row
  const pagesPath = () => path.join(dir, 'sources/c1/s1/pages.json')

  it('writes pages.json atomically, fills the row and moves the source to segmenting', async () => {
    seed(Buffer.from('First paragraph.\n\nSecond paragraph.'))
    const r = await extractSource('s1')
    expect(r).toEqual({ pageCount: 1, charCount: 'First paragraph.\n\nSecond paragraph.'.length, ocr: false })
    expect(JSON.parse(fs.readFileSync(pagesPath(), 'utf8'))).toEqual({ pages: [{ n: 1, text: 'First paragraph.\n\nSecond paragraph.' }], ocr: false })
    expect(fs.readdirSync(path.dirname(pagesPath())).filter((f) => f.endsWith('.tmp'))).toEqual([])
    expect(row()).toMatchObject({ status: 'segmenting', pageCount: 1, usedOcrFallback: false, error: null, failedStage: null })
  })

  it('is idempotent: re-running after a crash between pages.json and the row update reuses the file', async () => {
    seed(Buffer.from('Some text to extract.'))
    await extractSource('s1')
    // crash simulation: the row never saw the update
    Object.assign(row(), { status: 'extracting', pageCount: null, charCount: null })
    const before = fs.statSync(pagesPath()).mtimeMs
    fs.rmSync(path.join(dir, KEY)) // the original is not needed any more: pages.json is complete
    const again = await extractSource('s1')
    expect(again.pageCount).toBe(1)
    expect(fs.statSync(pagesPath()).mtimeMs).toBe(before)
    expect(row()).toMatchObject({ status: 'segmenting', pageCount: 1 })
  })

  it('does nothing for a source that is already past extraction and refuses a failed one', async () => {
    seed(Buffer.from('x'), KEY, 'ready')
    Object.assign(row(), { pageCount: 4, charCount: 99, usedOcrFallback: true })
    await expect(extractSource('s1')).resolves.toEqual({ pageCount: 4, charCount: 99, ocr: true })
    expect(db.updates).toEqual([])
    Object.assign(row(), { status: 'failed' })
    await expect(extractSource('s1')).rejects.toThrow(/extraction runs only from/)
  })

  it('removes leftover temporary files of a crashed write', async () => {
    seed(Buffer.from('Text body.'))
    fs.writeFileSync(path.join(dir, 'sources/c1/s1/pages.json.123.deadbeef.tmp'), '{"pages": [')
    await extractSource('s1')
    expect(fs.readdirSync(path.dirname(pagesPath())).sort()).toEqual(['original.txt', 'pages.json'])
  })

  it('ignores a corrupt pages.json (not valid JSON) and extracts again', async () => {
    seed(Buffer.from('Fresh text.'))
    fs.writeFileSync(pagesPath(), '{"pages": [{"n": 1, "te')
    const r = await extractSource('s1')
    expect(r.charCount).toBe('Fresh text.'.length)
    expect(await readPages('c1', 's1')).toEqual({ pages: [{ n: 1, text: 'Fresh text.' }], ocr: false })
  })

  it('records a readable failure on the row and rethrows; nothing is written to pages.json', async () => {
    seed(Buffer.from([0, 1, 2, 3, 0, 0, 0, 9]))
    await expect(extractSource('s1')).rejects.toBeInstanceOf(ExtractionError)
    expect(row()).toMatchObject({ status: 'failed', failedStage: 'extracting' })
    expect(row().error).toMatch(/binary data/)
    expect(fs.existsSync(pagesPath())).toBe(false)
  })

  it('records a generic readable message for an unexpected error', async () => {
    seed(Buffer.from('x'))
    fs.rmSync(path.join(dir, KEY))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(extractSource('s1')).rejects.toBeDefined()
    spy.mockRestore()
    expect(row()).toMatchObject({ status: 'failed', failedStage: 'extracting' })
    expect(row().error).toMatch(/Retry/)
  })

  it('stores the Gemini fallback result, usedOcrFallback and any warning', async () => {
    seed(pdfBytes() as unknown as Buffer, 'sources/c1/s1/original.pdf')
    pdf.pages = ['Title one', '', 'Title three']
    mockOcr((s, e) => ({ pages: Array.from({ length: e - s + 1 }, (_, k) => ({ n: s + k, text: `Page text ${label(s + k)}` })) }))
    const r = await extractSource('s1')
    expect(r).toMatchObject({ pageCount: 3, ocr: true })
    expect(row()).toMatchObject({ usedOcrFallback: true, status: 'segmenting' })
    expect((await readPages('c1', 's1'))?.ocr).toBe(true)
  })

  it('a failing Gemini range fails the source and leaves no pages.json', async () => {
    seed(pdfBytes() as unknown as Buffer, 'sources/c1/s1/original.pdf')
    pdf.pages = ['', '', '']
    vi.mocked(generateObject).mockRejectedValue(new Error('network down'))
    await expect(extractSource('s1')).rejects.toThrow(/pages 1-3/)
    expect(row()).toMatchObject({ status: 'failed', failedStage: 'extracting' })
    expect(fs.existsSync(pagesPath())).toBe(false)
  })
})
