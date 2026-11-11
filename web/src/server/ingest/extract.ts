// Extraction (plan 4.4): turn the original file of a Source into clean per-page text in storage/…/pages.json.
//   .txt / .md  decoded (UTF-8, BOM stripped; UTF-16 and Windows-1252 detected), cleaned, cut into ~4,000-char pages
//   .pdf        pdf-parse page by page; a Gemini transcription of the page ranges that need it when the text is too sparse
// Failures carry a message a student can act on and are recorded on the Source row (status failed, failedStage extracting).
import { TextDecoder } from 'util'
import { generateObject } from 'ai'
import { prisma } from '@/lib/db'
import { textModel } from '@/lib/ai'
import { ocrPagesPrompt } from '@/lib/prompts/ingest'
import {
  MAX_FILE_BYTES, MAX_EXTRACTED_CHARS, MAX_OCR_BYTES, MAX_OCR_PAGES, OCR_RANGE_SIZE, SPARSE_AVG_CHARS_PER_PAGE, SPARSE_PAGE_MIN_CHARS,
  TOO_LONG_MESSAGE, OCR_TOO_LARGE_MESSAGE, extensionOf,
} from '@/lib/ingestLimits'
import { readSourceFile, readPages, writePages, removeStaleTempFiles } from '@/server/storage'
import { OcrPagesSchema, type PagesFile } from './schemas'
import {
  cleanPageText, isNoisePage, dehyphenate, stripRepeatedLines, isSparse, pageRanges, pageChars, splitTextIntoPages,
} from './cleanText'

export * from '@/lib/ingestLimits'
export { splitTextIntoPages, isSparse, pageRanges } from './cleanText'

/** An expected failure with a message that tells the student what is wrong and what to do. */
export class ExtractionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExtractionError'
  }
}

export type ExtractResult = { pageCount: number; charCount: number; ocr: boolean }
type Page = { n: number; text: string }
type Extracted = { pages: Page[]; ocr: boolean; warning: string | null }

// ---------------------------------------------------------------------------------------------------------------------
// Text files
// ---------------------------------------------------------------------------------------------------------------------

function sniffBinaryKind(b: Uint8Array): string | null {
  const starts = (sig: number[]) => sig.every((v, i) => b[i] === v)
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return 'a PDF'
  if (starts([0x50, 0x4b, 0x03, 0x04])) return 'a ZIP-based file (for example a Word or Excel document)'
  if (starts([0xd0, 0xcf, 0x11, 0xe0])) return 'an old Microsoft Office document'
  if (starts([0x89, 0x50, 0x4e, 0x47])) return 'an image'
  if (starts([0xff, 0xd8, 0xff]) || starts([0x47, 0x49, 0x46, 0x38])) return 'an image'
  if (starts([0x1f, 0x8b])) return 'a compressed file'
  return null
}

/** What a file that was uploaded as a PDF but is not one actually is, for the error message. */
function describeNonPdf(b: Uint8Array): string {
  const kind = sniffBinaryKind(b)
  if (kind) return kind
  const head = Buffer.from(b.subarray(0, 512)).toString('latin1').trimStart().toLowerCase()
  if (head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<?xml')) return 'a web page'
  return 'some other kind of file'
}

function zeroShare(b: Uint8Array, parity: 0 | 1, sample: number): number {
  let zeros = 0
  let n = 0
  for (let i = parity; i < sample; i += 2) { n++; if (b[i] === 0) zeros++ }
  return n === 0 ? 0 : zeros / n
}

/** Share of control bytes (other than tab, newline, carriage return, form feed) in the first 8 KB. */
function controlByteShare(b: Uint8Array): number {
  const n = Math.min(b.length, 8192)
  let c = 0
  for (let i = 0; i < n; i++) {
    const v = b[i]
    if ((v < 32 && v !== 9 && v !== 10 && v !== 13 && v !== 12) || v === 127) c++
  }
  return n === 0 ? 0 : c / n
}

/** Windows-1252 characters for bytes 0x80-0x9F (Node's TextDecoder maps these to C1 controls instead). Undefined bytes stay U+FFFD. */
const CP1252_HIGH = [
  '\u20AC', '\uFFFD', '\u201A', '\u0192', '\u201E', '\u2026', '\u2020', '\u2021', '\u02C6', '\u2030', '\u0160', '\u2039', '\u0152', '\uFFFD', '\u017D', '\uFFFD',
  '\uFFFD', '\u2018', '\u2019', '\u201C', '\u201D', '\u2022', '\u2013', '\u2014', '\u02DC', '\u2122', '\u0161', '\u203A', '\u0153', '\uFFFD', '\u017E', '\u0178',
]

export type DecodedText = { text: string; encoding: 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252'; warning: string | null }

/**
 * Decodes the bytes of a .txt / .md file. A UTF-8 BOM is stripped; UTF-16 is recognised by its BOM or by NUL bytes
 * at every second position (common in Windows exports) and decoded; bytes that are not valid UTF-8 are decoded as
 * Windows-1252 (the usual Latin-1 export) and a warning says so. Binary content (NUL bytes elsewhere, many control
 * bytes, known binary signatures) is rejected.
 */
export function decodeTextFile(bytes: Uint8Array): DecodedText {
  const binaryKind = sniffBinaryKind(bytes)
  if (binaryKind) {
    throw new ExtractionError(`This file is ${binaryKind}, not a text file. Rename it with the right extension or export it as .txt, .md or .pdf.`)
  }
  const strip = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s)
  const view = bytes
  if (view.length >= 2 && view[0] === 0xff && view[1] === 0xfe) {
    return { text: strip(new TextDecoder('utf-16le').decode(view)), encoding: 'utf-16le', warning: null }
  }
  if (view.length >= 2 && view[0] === 0xfe && view[1] === 0xff) {
    return { text: strip(new TextDecoder('utf-16be').decode(view)), encoding: 'utf-16be', warning: null }
  }
  const sample = Math.min(view.length, 8192)
  if (view.length >= 4) {
    const even = zeroShare(view, 0, sample)
    const odd = zeroShare(view, 1, sample)
    if (odd > 0.3 && even < 0.02) return { text: strip(new TextDecoder('utf-16le').decode(view)), encoding: 'utf-16le', warning: null }
    if (even > 0.3 && odd < 0.02) return { text: strip(new TextDecoder('utf-16be').decode(view)), encoding: 'utf-16be', warning: null }
  }
  if (controlByteShare(view) > 0.02 || view.includes(0)) {
    throw new ExtractionError('This file contains binary data, not text. Upload a .txt or .md file saved as plain text, or a PDF.')
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(view)
    return { text: strip(text), encoding: 'utf-8', warning: null }
  } catch {
    const text = Buffer.from(view.buffer, view.byteOffset, view.byteLength)
      .toString('latin1')
      .replace(/[\x80-\x9f]/g, (c) => CP1252_HIGH[c.charCodeAt(0) - 0x80])
    return {
      text,
      encoding: 'windows-1252',
      warning: 'The file was not valid UTF-8 and was read as Windows-1252 (Latin-1). Check that accented characters look right.',
    }
  }
}

function extractTextPages(bytes: Uint8Array, markdown: boolean): Extracted {
  const decoded = decodeTextFile(bytes)
  if (decoded.text.length > MAX_EXTRACTED_CHARS * 1.05 + 1000) {
    throw new ExtractionError(TOO_LONG_MESSAGE(decoded.text.length))
  }
  const chunks = splitTextIntoPages(decoded.text, { markdown })
  const noisy = chunks.filter(isNoisePage).length
  const texts = chunks.map((p) => cleanPageText(p, { keepIndent: true, markdown })).filter((t) => t !== '')
  if (noisy > 0 && texts.length === 0) {
    throw new ExtractionError('This file does not contain readable text (it looks like binary data). Upload a .txt or .md file saved as plain text, or a PDF.')
  }
  const pages = texts.map((text, i) => ({ n: i + 1, text }))
  const warnings = [decoded.warning, noisy > 0 ? `${noisy} unreadable section(s) of the file were skipped.` : null].filter(Boolean)
  return { pages, ocr: false, warning: warnings.length ? warnings.join(' ') : null }
}

// ---------------------------------------------------------------------------------------------------------------------
// PDFs
// ---------------------------------------------------------------------------------------------------------------------

const PDF_BATCH_PAGES = 50

function startsWithPdfHeader(b: Uint8Array): boolean {
  return b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d
}

function translatePdfError(error: unknown): ExtractionError {
  const name = error instanceof Error ? error.name : ''
  if (name === 'PasswordException') {
    return new ExtractionError('This PDF is password-protected. Remove the password (open it, then save or print it to a new PDF) and upload it again.')
  }
  if (name === 'InvalidPDFException' || name === 'FormatError') {
    return new ExtractionError('This PDF could not be opened; the file may be damaged. Open it in a PDF viewer, save a copy and upload that.')
  }
  const detail = error instanceof Error ? error.message.slice(0, 160) : 'unknown error'
  return new ExtractionError(`This PDF could not be read (${detail}). Try saving a copy of it and uploading that.`)
}

/** Raw text of every page, page by page in batches so the text of a huge file is checked against the limit early. */
async function parsePdfPages(bytes: Uint8Array): Promise<{ texts: string[] }> {
  const { PDFParse } = await import('pdf-parse')
  // pdf.js takes ownership of (detaches) the array it is given, and pdf-parse copies a Buffer. A file that may still be
  // sent to Gemini (<= 20 MB) is therefore parsed from a plain copy; a larger file cannot use the fallback, so it is
  // parsed from a zero-copy view and no second copy of up to 50 MB is made.
  const data = bytes.byteLength <= MAX_OCR_BYTES
    ? Uint8Array.prototype.slice.call(bytes)
    : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const parser = new PDFParse({ data })
  try {
    const first = await parser.getText({ partial: [1] }).catch((e: unknown) => { throw translatePdfError(e) })
    const total = first.total
    if (!total || total < 1) throw new ExtractionError('This PDF has no pages.')
    const texts: string[] = new Array(total).fill('')
    texts[0] = first.pages[0]?.text ?? ''
    let chars = texts[0].length
    for (let start = 2; start <= total; start += PDF_BATCH_PAGES) {
      const partial: number[] = []
      for (let n = start; n < start + PDF_BATCH_PAGES && n <= total; n++) partial.push(n)
      const part = await parser.getText({ partial }).catch((e: unknown) => { throw translatePdfError(e) })
      for (const p of part.pages) {
        texts[p.num - 1] = p.text
        chars += p.text.length
      }
      // Raw text overstates the cleaned size only slightly; stop early on clearly oversized documents.
      if (chars > MAX_EXTRACTED_CHARS * 1.5) throw new ExtractionError(TOO_LONG_MESSAGE(chars))
    }
    return { texts }
  } finally {
    await parser.destroy().catch(() => {})
  }
}

/** Runs `fn` over `items` with at most `limit` running at once; resolves in input order, rejects with the first error. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  let failed = false
  async function worker() {
    while (!failed) {
      const i = next++
      if (i >= items.length) return
      try {
        results[i] = await fn(items[i], i)
      } catch (e) {
        failed = true
        throw e
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

export type OcrRangeResult = { texts: Map<number, string>; byOrder: boolean }

/**
 * Validates the model output for pages start..end. Accepts the exact set of page numbers; if the model numbered the
 * pages relatively but returned one entry per requested page, maps them by order; anything else is a failure
 * (null). Entries outside the range are ignored. Pure.
 */
export function mapOcrPages(pages: Array<{ n: number; text: string }>, start: number, end: number): OcrRangeResult | null {
  const expected = end - start + 1
  const inRange = pages.filter((p) => p.n >= start && p.n <= end)
  const distinct = new Map<number, string>()
  for (const p of inRange) if (!distinct.has(p.n)) distinct.set(p.n, p.text)
  // Pages that are blank may be omitted, but at least half of the range must come back to trust the numbering.
  if (distinct.size >= Math.ceil(expected / 2) && distinct.size === inRange.length) return { texts: distinct, byOrder: false }
  if (pages.length === expected) {
    const byOrder = new Map<number, string>()
    pages.forEach((p, i) => byOrder.set(start + i, p.text))
    return { texts: byOrder, byOrder: true }
  }
  return null
}

type GenerateObjectFn = typeof generateObject

async function transcribeRange(
  pdf: Uint8Array, start: number, end: number, total: number, generate: GenerateObjectFn,
): Promise<OcrRangeResult> {
  let lastReason = 'no answer'
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { object } = await generate({
        model: textModel(),
        schema: OcrPagesSchema,
        maxRetries: 1,
        abortSignal: AbortSignal.timeout(240_000),
        messages: [{
          role: 'user',
          content: [
            { type: 'file', data: pdf, mediaType: 'application/pdf' },
            { type: 'text', text: ocrPagesPrompt(start, end, total) },
          ],
        }],
      })
      const mapped = mapOcrPages(object.pages, start, end)
      if (mapped) return mapped
      lastReason = `the model returned ${object.pages.length} page(s) for ${end - start + 1} requested`
    } catch (e) {
      lastReason = e instanceof Error ? e.message.slice(0, 120) : 'unknown error'
    }
  }
  throw new ExtractionError(
    `Could not read pages ${start}-${end} of this PDF with the Gemini fallback (${lastReason}). Nothing was saved; use Retry to try again.`,
  )
}

/** Probe thresholds: the model's first range counts as "no gain" with at least this many existing characters... */
export const PROBE_MIN_EXISTING_CHARS = 300
/** ...when the added characters stay under this share of the existing text... */
export const PROBE_MAX_ADDED_SHARE = 0.1
/** ...and no page went from under 50 characters to at least this many. */
export const PROBE_PAGE_JUMP_CHARS = 100

/**
 * True when the model's answer for a range is worth the remaining calls. False only with clear evidence of no gain:
 * the range already has >= 300 characters of pdf-parse text, the model added < 10 % of that (summed over pages, only
 * counting pages where it produced more), and no page went from < 50 to >= 100 characters. Blank or text-less ranges
 * (a scan with an empty cover) never stop the run. Pure.
 */
export function modelAddedValue(existing: Page[], result: OcrRangeResult): boolean {
  let existingChars = 0
  let added = 0
  for (const p of existing) {
    const have = pageChars(p)
    const model = cleanPageText(result.texts.get(p.n) ?? '', { keepIndent: false }).length
    existingChars += have
    added += Math.max(0, model - have)
    if (have < SPARSE_PAGE_MIN_CHARS && model >= PROBE_PAGE_JUMP_CHARS) return true
  }
  if (existingChars < PROBE_MIN_EXISTING_CHARS) return true
  return added >= PROBE_MAX_ADDED_SHARE * existingChars
}

/** Gemini fallback. Only ranges that contain a page under 200 characters are sent. Model text replaces pdf-parse text
 * unless the model returned nothing for that page. Throws ExtractionError when a range fails twice. */
export async function ocrFallback(
  pdf: Uint8Array, pages: Page[], generate: GenerateObjectFn = generateObject,
): Promise<{ pages: Page[]; warning: string | null; calls: number; noGain: boolean }> {
  const ranges = pageRanges(pages.length, OCR_RANGE_SIZE).filter((r) =>
    pages.slice(r.start - 1, r.end).some((p) => pageChars(p) < SPARSE_AVG_CHARS_PER_PAGE))
  // The first range runs alone: every call starts with the same PDF bytes, so once the first request has been
  // processed Gemini's implicit prompt cache serves the PDF tokens of the other ranges at a reduced price (measured on
  // a 35-page scan: about 88 % of the input tokens cached). The remaining ranges then run three at a time.
  const results: OcrRangeResult[] = []
  if (ranges.length > 0) {
    const first = await transcribeRange(pdf, ranges[0].start, ranges[0].end, pages.length, generate)
    // Probe: when the model added essentially nothing to the first range, the pages are plots or images without
    // readable text and the other ranges would cost the same for no gain.
    if (!modelAddedValue(pages.slice(ranges[0].start - 1, ranges[0].end), first)) {
      return { pages, warning: null, calls: 1, noGain: true }
    }
    results.push(first)
    const rest = await mapLimit(ranges.slice(1), 3, (r) => transcribeRange(pdf, r.start, r.end, pages.length, generate))
    results.push(...rest)
  }
  const out = pages.map((p) => ({ ...p }))
  let byOrder = false
  results.forEach((res, i) => {
    if (res.byOrder) byOrder = true
    for (let n = ranges[i].start; n <= ranges[i].end; n++) {
      const text = cleanPageText(res.texts.get(n) ?? '', { keepIndent: false })
      if (text !== '') out[n - 1] = { n, text }
    }
  })
  return {
    pages: out,
    warning: byOrder ? 'The page numbers returned by the Gemini fallback were not absolute and were matched by order; check page links.' : null,
    calls: ranges.length,
    noGain: false,
  }
}

/** Bytes of a file that `sniffUploadHead` needs (the text sniffing reads the first 8 KB). */
export const UPLOAD_SNIFF_BYTES = 8192

/**
 * Upload-time check of the first bytes of a file: the same rules and messages the extractor applies later, so an obviously
 * wrong file is refused at upload. Returns the message to show, or null when the file looks acceptable.
 */
export function sniffUploadHead(ext: string, head: Uint8Array): string | null {
  if (ext === '.pdf') {
    if (startsWithPdfHeader(head)) return null
    return `This file has a .pdf name but is ${describeNonPdf(head)}, not a PDF (it does not start with %PDF-). Open the original document and export it as a PDF again.`
  }
  try {
    decodeTextFile(head)
    return null
  } catch (error) {
    if (error instanceof ExtractionError) return error.message
    throw error
  }
}

export type PdfExtractOptions = { generate?: GenerateObjectFn }

/** pdf-parse text of every page, cleaned and stripped of repeated headers/footers (before the sparse test). */
export async function readPdfText(bytes: Uint8Array): Promise<{ pages: Page[]; warnings: string[] }> {
  if (!startsWithPdfHeader(bytes)) {
    const what = describeNonPdf(bytes)
    throw new ExtractionError(
      `This file has a .pdf name but is ${what}, not a PDF (it does not start with %PDF-). Open the original document and export it as a PDF again.`,
    )
  }
  const { texts } = await parsePdfPages(bytes)
  const warnings: string[] = []
  const cleaned = texts.map((t) => cleanPageText(t, { keepIndent: false }))
  const noisy = texts.filter((t, i) => cleaned[i] === '' && t.trim() !== '' && isNoisePage(t)).length
  if (noisy > 0) warnings.push(`${noisy} page(s) held unreadable data and were treated as empty.`)
  return { pages: stripRepeatedLines(cleaned).map((text, i) => ({ n: i + 1, text })), warnings }
}

export async function extractPdfPages(bytes: Uint8Array, opts: PdfExtractOptions = {}): Promise<Extracted> {
  // Read the size first: a file over 20 MB is parsed from a zero-copy view that pdf.js detaches (length becomes 0).
  const size = bytes.byteLength
  const read = await readPdfText(bytes)
  let pages = read.pages
  const warnings = read.warnings
  const total = pages.length
  let ocr = false

  if (isSparse(pages)) {
    if (size > MAX_OCR_BYTES || total > MAX_OCR_PAGES) throw new ExtractionError(OCR_TOO_LARGE_MESSAGE)
    const fallback = await ocrFallback(bytes, pages, opts.generate)
    if (fallback.noGain) {
      warnings.push('Most pages are images or plots without readable text; only their titles and captions were extracted.')
    } else {
      pages = fallback.pages
      ocr = true
      if (fallback.warning) warnings.push(fallback.warning)
      pages = stripRepeatedLines(pages.map((p) => p.text)).map((text, i) => ({ n: i + 1, text }))
    }
  }

  const joined = dehyphenate(pages.map((p) => p.text))
  pages = pages.map((p, i) => ({ n: p.n, text: joined[i] }))
  return { pages, ocr, warning: warnings.length ? warnings.join(' ') : null }
}

// ---------------------------------------------------------------------------------------------------------------------
// Source orchestration
// ---------------------------------------------------------------------------------------------------------------------

const EXTRACTABLE = ['uploaded', 'extracting']

function checkTotal(pages: Page[]): number {
  const chars = pages.reduce((n, p) => n + p.text.length, 0)
  if (chars > MAX_EXTRACTED_CHARS) throw new ExtractionError(TOO_LONG_MESSAGE(chars))
  if (chars === 0) {
    throw new ExtractionError('No readable text was found in this file. If it is a scan, make sure the pages are upright and legible, then upload it again.')
  }
  return chars
}

export async function extractBytes(ext: string, bytes: Uint8Array, opts: PdfExtractOptions = {}): Promise<Extracted & { charCount: number }> {
  if (bytes.byteLength > MAX_FILE_BYTES) {
    throw new ExtractionError(`File too large (${Math.round(bytes.byteLength / 1048576)} MB, limit 50 MB)`)
  }
  let extracted: Extracted
  if (ext === '.pdf') extracted = await extractPdfPages(bytes, opts)
  else if (ext === '.txt' || ext === '.md') extracted = extractTextPages(bytes, ext === '.md')
  else throw new ExtractionError('Unsupported file type. Upload a .txt, .md or .pdf file.')
  return { ...extracted, charCount: checkTotal(extracted.pages) }
}

/**
 * Extracts the text of a Source whose original file is in storage and records the result.
 * Idempotent and crash-safe: pages.json is written atomically and only after the whole extraction succeeded; the row
 * moves uploaded -> extracting -> segmenting only after pages.json exists. A re-run after a crash between the two reuses
 * a valid pages.json (no second Gemini bill) and finishes the row. On an expected failure the row is set to
 * failed / failedStage 'extracting' with a readable error and the same ExtractionError is rethrown.
 */
export async function extractSource(sourceId: string, deps: { generate?: GenerateObjectFn } = {}): Promise<ExtractResult> {
  const source = await prisma.source.findUnique({ where: { id: sourceId } })
  if (!source) throw new Error(`Source ${sourceId} not found`)
  if (!EXTRACTABLE.includes(source.status)) {
    if (source.status !== 'failed' && source.pageCount != null) {
      return { pageCount: source.pageCount, charCount: source.charCount ?? 0, ocr: source.usedOcrFallback }
    }
    throw new Error(`Source ${sourceId} is ${source.status}; extraction runs only from uploaded or extracting`)
  }

  try {
    await prisma.source.updateMany({
      where: { id: sourceId, status: { in: EXTRACTABLE } },
      data: { status: 'extracting', failedStage: null, error: null },
    })
    await removeStaleTempFiles(source.courseId, source.id)

    let file = await readPages(source.courseId, source.id)
    let warning: string | null = null
    if (file) {
      warning = file.warning ?? null
      checkTotal(file.pages)
    } else {
      const ext = extensionOf(source.storageKey)
      const bytes = await readSourceFile(source.storageKey)
      const result = await extractBytes(ext, bytes, {
        generate: deps.generate,
      })
      file = { pages: result.pages, ocr: result.ocr, ...(result.warning ? { warning: result.warning } : {}) }
      warning = result.warning
      await writePages(source.courseId, source.id, file as PagesFile)
    }

    const charCount = file.pages.reduce((n, p) => n + p.text.length, 0)
    await prisma.source.updateMany({
      where: { id: sourceId, status: 'extracting' },
      data: { status: 'segmenting', pageCount: file.pages.length, charCount, usedOcrFallback: file.ocr, warning },
    })
    return { pageCount: file.pages.length, charCount, ocr: file.ocr }
  } catch (error) {
    const message = error instanceof ExtractionError
      ? error.message
      : 'Something went wrong while reading this file. Use Retry; if it keeps failing, upload the file again.'
    if (!(error instanceof ExtractionError)) console.error(`[extract] source ${sourceId}:`, error)
    await prisma.source.updateMany({
      where: { id: sourceId, status: { in: EXTRACTABLE } },
      data: { status: 'failed', failedStage: 'extracting', error: message },
    })
    throw error
  }
}
