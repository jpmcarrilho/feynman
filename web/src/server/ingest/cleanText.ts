// Pure text helpers of extraction: cleaning, noise detection, header/footer stripping, de-hyphenation, page splitting,
// the sparse rule and page ranges. No I/O, no server imports.
import {
  TEXT_PAGE_CHARS, SPARSE_AVG_CHARS_PER_PAGE, SPARSE_PAGE_MIN_CHARS, SPARSE_SHARE_OF_SHORT_PAGES, OCR_RANGE_SIZE,
} from '@/lib/ingestLimits'

// ---------------------------------------------------------------------------------------------------------------------
// Noise and cleaning
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Characters that are never readable text: replacement characters, C0/C1 controls (newline, tab, carriage return,
 * form feed and vertical tab are handled separately), DEL, lone surrogates, private use, unassigned and noncharacters.
 */
const NOISE_CHAR = /[\uFFFD\u0000-\u0008\u000E-\u001F\u007F-\u009F\uFFFE\uFFFF]|\p{Cs}|\p{Co}|\p{Cn}/gu
/** Invisible formatting characters that carry no text: soft hyphen, zero-width characters, bidi marks, BOM. */
const INVISIBLE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g
const UNICODE_SPACES = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g
const LIGATURES: Record<string, string> = {
  '\uFB00': 'ff', '\uFB01': 'fi', '\uFB02': 'fl', '\uFB03': 'ffi', '\uFB04': 'ffl', '\uFB05': 'st', '\uFB06': 'st',
}
const LIGATURE_RE = /[\uFB00-\uFB06]/g

/** A page whose share of noise among its non-whitespace characters exceeds this is binary garbage, not text. */
export const NOISE_PAGE_SHARE = 0.3

/** Share of noise characters among the non-whitespace characters of `text` (0 for an empty text). */
export function noiseShare(text: string): number {
  let total = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x2028 || c === 0x2029) continue
    total++
  }
  if (total === 0) return 0
  const matches = text.match(NOISE_CHAR)
  return (matches ? matches.length : 0) / total
}

/** True when the page is mostly replacement characters, controls or other binary noise. Such a page is treated as empty. */
export function isNoisePage(text: string): boolean {
  return noiseShare(text) > NOISE_PAGE_SHARE
}

export type CleanOptions = {
  /** Keep leading indentation of lines (plain text and Markdown); PDFs trim it. */
  keepIndent: boolean
  /** Do not touch spacing inside ``` / ~~~ fenced blocks (Markdown). */
  markdown?: boolean
}

/**
 * Cleans one page. Returns '' for a noise page. Rules: NUL and other control characters removed (newline and tab kept),
 * invisible formatting characters removed, Unicode spaces turned into spaces, line endings normalised to \n, the
 * presentation ligatures ﬀ-ﬆ expanded, NFC normalisation, repeated spaces and tabs collapsed, trailing spaces removed,
 * 3+ consecutive newlines reduced to one blank line, the page trimmed.
 */
export function cleanPageText(raw: string, opts: CleanOptions): string {
  if (isNoisePage(raw)) return ''
  let t = raw
    .replace(/\r\n?|\u2028|\u2029|\u0085|\f/g, '\n')
    .replace(/\u000B/g, ' ')
    .replace(NOISE_CHAR, '')
    .replace(INVISIBLE, '')
    .replace(UNICODE_SPACES, ' ')
    .replace(LIGATURE_RE, (c) => LIGATURES[c] ?? c)
    .normalize('NFC')

  let inFence = false
  const lines = t.split('\n').map((line) => {
    if (opts.markdown && /^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      return line.replace(/\s+$/, '')
    }
    if (opts.markdown && inFence) return line.replace(/\s+$/, '')
    const indent = opts.keepIndent ? (line.match(/^[ \t]*/)?.[0] ?? '') : ''
    const body = opts.keepIndent ? line.slice(indent.length) : line.replace(/^[ \t]+/, '')
    const collapsed = body.replace(/[ \t]{2,}/g, (run) => (run.includes('\t') ? '\t' : ' ')).replace(/[ \t]+$/, '')
    return collapsed === '' ? '' : indent + collapsed
  })
  t = lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\s+$/, '')
  return t
}

// ---------------------------------------------------------------------------------------------------------------------
// De-hyphenation
// ---------------------------------------------------------------------------------------------------------------------

const HYPHEN_BREAK = /(\p{L}{2,})[-\u2010\u2011][ \t]*\n[ \t]*(\p{Ll}{2,})/gu

/**
 * Joins words split by a hyphen at a line end ("informa-\ntion") but only when the joined word occurs elsewhere in the
 * same document written without a break. Compounds ("cross-\nsectional") and rare words stay as they are, so a real
 * hyphen is never deleted on a guess. Pages are processed independently (a break across pages is never joined).
 */
export function dehyphenate(pages: string[]): string[] {
  const vocab = new Set<string>()
  const WORD = /\p{L}{3,}/gu
  for (const p of pages) {
    // Words as they appear; fragments of broken words ("informa", "tion") are added too but never equal a joined word.
    for (const m of p.matchAll(WORD)) vocab.add(m[0].toLowerCase())
  }
  return pages.map((p) =>
    p.replace(HYPHEN_BREAK, (whole, a: string, b: string) => (vocab.has((a + b).toLowerCase()) ? a + b : whole)),
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Repeated headers, footers and slide numbers
// ---------------------------------------------------------------------------------------------------------------------

export const HEADER_MIN_PAGES = 5
export const HEADER_MIN_SHARE = 0.6
export const HEADER_MAX_LINE_CHARS = 100
const EDGE_LINES = 2

function lineKey(line: string): { template: string; num: number | null } {
  const norm = line.trim().replace(/\s+/g, ' ')
  const m = norm.match(/\d+/)
  return { template: norm.replace(/\d+/g, '#'), num: m ? Number(m[0]) : null }
}

/**
 * Removes lines that repeat at the top or bottom edge of most pages (running titles, course names, "Page 3 of 40",
 * slide numbers). Deliberately conservative, because deleting content is worse than keeping a footer:
 *  - at least 5 non-empty pages, and the line must sit among the first or last 2 non-empty lines of at least 60 % of them;
 *  - at most 100 characters;
 *  - a line with digits only counts when its number follows the page position (same offset from the page index on
 *    at least 80 % of occurrences), so a table that ends every page with a number is not removed;
 *  - a line without any letter or digit is never removed.
 */
export function stripRepeatedLines(pages: string[]): string[] {
  const nonEmpty = pages.filter((p) => p.trim() !== '').length
  if (nonEmpty < HEADER_MIN_PAGES) return pages

  type Occ = { page: number; num: number | null }
  const byTemplate = new Map<string, Occ[]>()
  const edgeLines: Array<Array<{ idx: number; template: string; num: number | null }>> = []

  pages.forEach((text, pageIdx) => {
    const lines = text.split('\n')
    const idxs: number[] = []
    lines.forEach((l, i) => { if (l.trim() !== '') idxs.push(i) })
    const edge = new Set([...idxs.slice(0, EDGE_LINES), ...idxs.slice(-EDGE_LINES)])
    const found: Array<{ idx: number; template: string; num: number | null }> = []
    for (const i of edge) {
      const line = lines[i]
      if (line.trim().length > HEADER_MAX_LINE_CHARS) continue
      if (!/[\p{L}\p{N}]/u.test(line)) continue
      const { template, num } = lineKey(line)
      found.push({ idx: i, template, num })
      const list = byTemplate.get(template) ?? []
      list.push({ page: pageIdx, num })
      byTemplate.set(template, list)
    }
    edgeLines.push(found)
  })

  const minPages = Math.max(4, Math.ceil(HEADER_MIN_SHARE * nonEmpty))
  const approved = new Map<string, { offset: number | null }>()
  for (const [template, occ] of byTemplate) {
    const pageSet = new Set(occ.map((o) => o.page))
    if (pageSet.size < minPages) continue
    if (!template.includes('#')) { approved.set(template, { offset: null }); continue }
    const offsets = new Map<number, number>()
    for (const o of occ) if (o.num !== null) offsets.set(o.num - o.page, (offsets.get(o.num - o.page) ?? 0) + 1)
    let best = 0
    let bestOffset = 0
    for (const [off, n] of offsets) if (n > best) { best = n; bestOffset = off }
    if (best >= Math.ceil(0.8 * occ.length)) approved.set(template, { offset: bestOffset })
  }
  if (approved.size === 0) return pages

  return pages.map((text, pageIdx) => {
    const drop = new Set<number>()
    for (const e of edgeLines[pageIdx]) {
      const a = approved.get(e.template)
      if (!a) continue
      if (a.offset !== null && (e.num === null || e.num - pageIdx !== a.offset)) continue
      drop.add(e.idx)
    }
    if (drop.size === 0) return text
    return text.split('\n').filter((_, i) => !drop.has(i)).join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\s+$/, '')
  })
}

// ---------------------------------------------------------------------------------------------------------------------
// Sparse rule and ranges
// ---------------------------------------------------------------------------------------------------------------------

/** Trimmed length of a page text. */
export function pageChars(page: { text: string }): number {
  return page.text.trim().length
}

/**
 * Sparse PDF (scan or image-heavy deck): fewer than 200 characters per page on average, or more than 40 % of the
 * pages under 50 characters. No pages at all is not sparse (the caller rejects it separately).
 */
export function isSparse(pages: Array<{ text: string }>): boolean {
  if (pages.length === 0) return false
  const counts = pages.map(pageChars)
  const avg = counts.reduce((a, b) => a + b, 0) / pages.length
  const short = counts.filter((c) => c < SPARSE_PAGE_MIN_CHARS).length
  return avg < SPARSE_AVG_CHARS_PER_PAGE || short / pages.length > SPARSE_SHARE_OF_SHORT_PAGES
}

/** Inclusive 1-based page ranges of at most `size` pages covering 1..pageCount. */
export function pageRanges(pageCount: number, size = OCR_RANGE_SIZE): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = []
  for (let start = 1; start <= pageCount; start += size) out.push({ start, end: Math.min(pageCount, start + size - 1) })
  return out
}

// ---------------------------------------------------------------------------------------------------------------------
// Synthetic pages of .txt / .md
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Splits text into chunks of about `target` characters. A chunk ends at the last blank line before the limit (for
 * Markdown also right before the last heading line, whichever is later); when there is none in the second half of the
 * window it ends at a line break, then a sentence end, then a space, and only as a last resort at the limit. No text is
 * lost or altered: the chunks concatenate to the input exactly.
 */
export function splitTextIntoPages(text: string, opts: { markdown: boolean; target?: number }): string[] {
  const target = opts.target ?? TEXT_PAGE_CHARS
  if (text === '') return []
  const pages: string[] = []
  let pos = 0
  while (pos < text.length) {
    if (text.length - pos <= target) { pages.push(text.slice(pos)); break }
    const window = text.slice(pos, pos + target)
    const half = Math.floor(target / 2)
    let cut = -1

    const blank = window.lastIndexOf('\n\n')
    if (blank >= half) cut = blank + 2
    if (opts.markdown) {
      const re = /\n(?=#{1,6}\s)/g
      let m: RegExpExecArray | null
      let lastHeading = -1
      while ((m = re.exec(window)) !== null) lastHeading = m.index + 1
      if (lastHeading >= half && lastHeading > cut) cut = lastHeading
    }
    if (cut < 0) {
      const nl = window.lastIndexOf('\n')
      if (nl >= half) cut = nl + 1
    }
    if (cut < 0) {
      const re = /[.!?]["')\]]?\s/g
      let m: RegExpExecArray | null
      let end = -1
      while ((m = re.exec(window)) !== null) end = m.index + m[0].length
      if (end >= half) cut = end
    }
    if (cut < 0) {
      const sp = window.lastIndexOf(' ')
      if (sp >= half) cut = sp + 1
    }
    if (cut < 0) {
      cut = target
      // never split a surrogate pair
      const code = text.charCodeAt(pos + cut - 1)
      if (code >= 0xd800 && code <= 0xdbff) cut -= 1
    }
    pages.push(text.slice(pos, pos + cut))
    pos += cut
  }
  return pages
}

// ---------------------------------------------------------------------------------------------------------------------
// Markdown: pseudo-pages that follow the headings
// ---------------------------------------------------------------------------------------------------------------------

/** A Markdown section shorter than this (trimmed) is merged with the next one, so a heading alone never becomes a page. */
export const MD_MIN_SECTION_CHARS = 200

/** Start offsets of the `#` and `##` heading lines of a Markdown text, ignoring lines inside ``` / ~~~ fenced blocks. */
function headingStarts(text: string): number[] {
  const starts: number[] = []
  let inFence = false
  let pos = 0
  for (const line of text.split('\n')) {
    if (/^\s{0,3}(```|~~~)/.test(line)) inFence = !inFence
    else if (!inFence && /^#{1,2}[ \t]+\S/.test(line)) starts.push(pos)
    pos += line.length + 1
  }
  return starts
}

/**
 * Pseudo-pages of a Markdown file: a new page starts at every `#` or `##` heading (headings inside fenced code are not
 * headings). A section shorter than MD_MIN_SECTION_CHARS is merged with the next one (the last one, with the one before),
 * and a page above `target` characters is cut by splitTextIntoPages, so the size cap of plain text still holds. A file with
 * no such heading is cut exactly as splitTextIntoPages cuts it. No text is lost: the pages concatenate to the input.
 */
export function splitMarkdownIntoPages(text: string, opts: { target?: number; minSection?: number } = {}): string[] {
  const target = opts.target ?? TEXT_PAGE_CHARS
  const minSection = opts.minSection ?? MD_MIN_SECTION_CHARS
  const starts = headingStarts(text)
  if (starts.length === 0) return splitTextIntoPages(text, { markdown: true, target })

  const cuts = [...new Set([0, ...starts])].sort((a, b) => a - b)
  const sections = cuts.map((from, i) => text.slice(from, i + 1 < cuts.length ? cuts[i + 1] : text.length))
  const merged: string[] = []
  let carry = ''
  for (const section of sections) {
    carry += section
    if (carry.trim().length >= minSection) {
      merged.push(carry)
      carry = ''
    }
  }
  if (carry !== '') {
    if (merged.length > 0) merged[merged.length - 1] += carry
    else merged.push(carry)
  }
  return merged.flatMap((page) => (page.length > target ? splitTextIntoPages(page, { markdown: true, target }) : [page]))
}
