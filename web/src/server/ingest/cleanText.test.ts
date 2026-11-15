import { describe, it, expect } from 'vitest'
import {
  cleanPageText, isNoisePage, noiseShare, dehyphenate, stripRepeatedLines, isSparse, pageRanges, splitTextIntoPages,
  splitMarkdownIntoPages, MD_MIN_SECTION_CHARS,
} from './cleanText'

const pdfOpts = { keepIndent: false }

describe('cleanPageText', () => {
  it('removes NUL and other control characters but keeps newline and tab', () => {
    const out = cleanPageText('Hel\u0000lo\u0001 wor\u0007ld\u007f\nSecond\tcell\u009f line', pdfOpts)
    expect(out).toBe('Hello world\nSecond\tcell line')
    expect(out).not.toMatch(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/)
  })

  it('normalises line endings, form feeds and Unicode separators to \\n', () => {
    expect(cleanPageText('a\r\nb\rc d e\ff', pdfOpts)).toBe('a\nb\nc\nd\ne\nf')
  })

  it('collapses repeated spaces and tabs, trims lines and caps blank lines at one', () => {
    expect(cleanPageText('  a    b  \n\n\n\n\n  c  d \t\t e  ', pdfOpts)).toBe('a b\n\nc d\te')
  })

  it('keeps leading indentation for text files and leaves fenced code untouched', () => {
    const md = '- item\n    - nested   item\n```\ncode    with   gaps\n```\nafter    fence'
    expect(cleanPageText(md, { keepIndent: true, markdown: true })).toBe('- item\n    - nested item\n```\ncode    with   gaps\n```\nafter fence')
  })

  it('expands presentation ligatures, removes soft hyphens and zero-width characters, applies NFC', () => {
    expect(cleanPageText('oﬃce ﬁnal ﬂow eﬀect', pdfOpts)).toBe('office final flow effect')
    expect(cleanPageText('co­oper​ation﻿', pdfOpts)).toBe('cooperation')
    expect(cleanPageText('café', pdfOpts)).toBe('café')
  })

  it('does not touch math symbols, accents or non-Latin scripts', () => {
    const s = '∑ x² ≤ ∫ f(x)dx éè 日本語 αβ'
    expect(cleanPageText(s, pdfOpts)).toBe(s)
  })
})

describe('binary-noise page rule', () => {
  it('flags a page that is mostly replacement characters or control bytes', () => {
    const noise = '�'.repeat(80) + 'ab'
    expect(isNoisePage(noise)).toBe(true)
    expect(cleanPageText(noise, pdfOpts)).toBe('')
    expect(isNoisePage('\u0000\u0001\u0002 \u0003\u0004\u0005 ok')).toBe(true)
  })

  it('keeps real text that contains a few stray replacement or NUL characters', () => {
    const text = 'This slide has real content about instrumental variables � and more \u0000 text.'
    expect(noiseShare(text)).toBeLessThan(0.1)
    expect(isNoisePage(text)).toBe(false)
    expect(cleanPageText(text, pdfOpts)).toBe('This slide has real content about instrumental variables and more text.')
  })

  it('treats private-use glyph dumps as noise but not whitespace-only pages', () => {
    expect(isNoisePage(' ')).toBe(true)
    expect(isNoisePage('   \n\t ')).toBe(false)
    expect(isNoisePage('')).toBe(false)
  })
})

describe('dehyphenate', () => {
  it('joins a hyphenated line break only when the joined word occurs elsewhere in the document', () => {
    const pages = ['The popula-\ntion grew.', 'Population is large. The population fell.']
    expect(dehyphenate(pages)[0]).toBe('The population grew.')
  })

  it('keeps compounds and unknown words as they are', () => {
    const pages = ['A cross-\nsectional study of self-\nevident facts and rare-\nword.', 'Nothing else here.']
    expect(dehyphenate(pages)[0]).toBe(pages[0])
  })

  it('never joins across pages', () => {
    const pages = ['The popula-', 'tion grew. Population.']
    expect(dehyphenate(pages)).toEqual(pages)
  })
})

describe('stripRepeatedLines', () => {
  // Content numbers deliberately do not follow the page index, as in a real deck
  const num = (i: number) => ((i * 37 + 11) % 101) + 200
  const deck = (n: number, footer: (i: number) => string) =>
    Array.from({ length: n }, (_, i) => `Slide title ${num(i)}\nbody text number ${num(i) * 7}\n${footer(i)}`)

  it('removes slide numbers that follow the page position', () => {
    const pages = deck(10, (i) => String(i + 1))
    const out = stripRepeatedLines(pages)
    expect(out[3]).toBe(`Slide title ${num(3)}\nbody text number ${num(3) * 7}`)
  })

  it('removes a repeated running title with its page counter', () => {
    const pages = deck(8, (i) => `Course name ${i + 1} / 8`)
    expect(stripRepeatedLines(pages)[2]).toBe(`Slide title ${num(2)}\nbody text number ${num(2) * 7}`)
  })

  it('removes a repeated header line without digits', () => {
    const pages = Array.from({ length: 6 }, (_, i) => `J-PAL | Why randomize\ncontent ${num(i)} words`)
    expect(stripRepeatedLines(pages)[0]).toBe(`content ${num(0)} words`)
  })

  it('keeps a trailing number that does not follow the page position (a table total)', () => {
    const pages = deck(10, (i) => String(num(i * 3)))
    expect(stripRepeatedLines(pages)).toEqual(pages)
  })

  it('keeps lines that repeat on fewer than 60 % of pages and documents under 5 pages', () => {
    const some = Array.from({ length: 10 }, (_, i) => (i < 4 ? `Questions?\nbody ${num(i)}` : `body ${num(i)}\nmore ${num(i + 50)}`))
    expect(stripRepeatedLines(some)).toEqual(some)
    const short = deck(4, (i) => String(i + 1))
    expect(stripRepeatedLines(short)).toEqual(short)
  })

  it('only looks at the first and last two lines of a page', () => {
    const pages = Array.from({ length: 8 }, (_, i) => `a ${num(i)}\nb ${num(i + 5)}\nSame middle line\nc ${num(i + 9)}\nd ${num(i + 3)}`)
    expect(stripRepeatedLines(pages)).toEqual(pages)
  })
})

describe('isSparse and pageRanges', () => {
  const pagesOf = (...lens: number[]) => lens.map((n) => ({ text: 'x'.repeat(n) }))

  it('flags an average under 200 characters per page', () => {
    expect(isSparse(pagesOf(199, 199, 199))).toBe(true)
    expect(isSparse(pagesOf(200, 200, 200))).toBe(false)
  })

  it('flags more than 40 % of pages under 50 characters even with a high average', () => {
    expect(isSparse(pagesOf(0, 0, 0, 2000, 2000))).toBe(true) // 60 % empty
    expect(isSparse(pagesOf(0, 0, 900, 900, 900))).toBe(false) // exactly 40 %
    expect(isSparse(pagesOf(49, 49, 900, 900, 900))).toBe(false)
    expect(isSparse(pagesOf(49, 49, 49, 900, 900))).toBe(true) // 60 %
  })

  it('counts trimmed length and treats no pages as not sparse', () => {
    expect(isSparse([{ text: ' '.repeat(500) }])).toBe(true)
    expect(isSparse([])).toBe(false)
  })

  it('splits 1..N into ranges of at most 15 pages', () => {
    expect(pageRanges(32)).toEqual([{ start: 1, end: 15 }, { start: 16, end: 30 }, { start: 31, end: 32 }])
    expect(pageRanges(15)).toEqual([{ start: 1, end: 15 }])
    expect(pageRanges(16, 15)).toHaveLength(2)
    expect(pageRanges(0)).toEqual([])
    expect(pageRanges(5, 2)).toEqual([{ start: 1, end: 2 }, { start: 3, end: 4 }, { start: 5, end: 5 }])
  })
})

describe('splitTextIntoPages', () => {
  const para = (i: number) => `Paragraph ${i} ` + 'word '.repeat(60).trim() + '.'

  it('keeps all text: the pages concatenate to the input', () => {
    const text = Array.from({ length: 80 }, (_, i) => para(i)).join('\n\n')
    const pages = splitTextIntoPages(text, { markdown: false })
    expect(pages.join('')).toBe(text)
    expect(pages.length).toBeGreaterThan(5)
    for (const p of pages) expect(p.length).toBeLessThanOrEqual(4000)
  })

  it('cuts at a blank line before the limit', () => {
    const text = Array.from({ length: 40 }, (_, i) => para(i)).join('\n\n')
    const pages = splitTextIntoPages(text, { markdown: false })
    for (const p of pages.slice(0, -1)) expect(p.endsWith('\n\n')).toBe(true)
  })

  it('cuts Markdown right before the last heading in the window', () => {
    const body = (n: number) => 'line of text '.repeat(n)
    const text = `# One\n${body(100)}\n## Two\n${body(120)}\n## Three\n${body(150)}\n## Four\n${body(100)}`
    const pages = splitTextIntoPages(text, { markdown: true, target: 2500 })
    expect(pages.join('')).toBe(text)
    for (const p of pages.slice(1)) expect(p.startsWith('#')).toBe(true)
  })

  it('falls back to sentence, space and hard cuts for text without line breaks, never splitting a surrogate pair', () => {
    const sentences = 'This is a sentence. '.repeat(500)
    const a = splitTextIntoPages(sentences, { markdown: false })
    expect(a.join('')).toBe(sentences)
    expect(a[0].endsWith('. ')).toBe(true)
    const noBreaks = 'x'.repeat(9000)
    expect(splitTextIntoPages(noBreaks, { markdown: false }).map((p) => p.length)).toEqual([4000, 4000, 1000])
    const emoji = '\u{1F600}'.repeat(3000)
    const pages = splitTextIntoPages(emoji, { markdown: false, target: 1001 })
    expect(pages.join('')).toBe(emoji)
    for (const p of pages) expect(p.codePointAt(p.length - 1)).toBeDefined()
    expect(pages.every((p) => !/[\uD800-\uDBFF]$/.test(p))).toBe(true)
  })

  it('returns one page for short text and none for empty text', () => {
    expect(splitTextIntoPages('short', { markdown: false })).toEqual(['short'])
    expect(splitTextIntoPages('', { markdown: false })).toEqual([])
  })
})


describe('splitMarkdownIntoPages', () => {
  const words = (n: number, w = 'market') => Array.from({ length: n }, (_, i) => `${w}${i % 7}`).join(' ')
  const logistics = [
    '## Course logistics', '',
    'Lectures are on Tuesdays and Thursdays at 10:00 in room 4.101. Office hours are on Fridays from 14:00 to 16:00.',
    'Grading: 40% problem sets, 20% midterm, 40% final exam. Late problem sets lose 10% per day.', '',
  ].join('\n')
  const doc = [
    '# Introduction to Microeconomics', '', 'These notes accompany the lectures.', '',
    logistics,
    '## Consumer theory', '', words(220), '',
    '### Budget sets', '', words(150), '',
    '## Producer theory', '', words(260), '',
  ].join('\n')

  it('starts a new page at every # and ## heading and keeps a short logistics section as its own page', () => {
    const pages = splitMarkdownIntoPages(doc)
    expect(pages.join('')).toBe(doc)
    const logisticsPage = pages.find((p) => p.includes('Course logistics'))!
    expect(logisticsPage).toContain('Office hours')
    expect(logisticsPage).not.toContain('Consumer theory')
    expect(logisticsPage.trimStart().startsWith('## Course logistics')).toBe(false) // the title section ahead of it merged forward (it is only a heading and a line)
    expect(pages.some((p) => p.startsWith('## Consumer theory'))).toBe(true)
    expect(pages.some((p) => p.startsWith('## Producer theory'))).toBe(true)
    // ### does not start a page: Budget sets stays with Consumer theory
    expect(pages.find((p) => p.startsWith('## Consumer theory'))).toContain('### Budget sets')
  })

  it('merges a section shorter than the minimum with the next one and the last short one with the previous', () => {
    const short = `## Overview\n\nOne short line.\n\n`
    expect(short.trim().length).toBeLessThan(MD_MIN_SECTION_CHARS)
    const text = `${short}## Theory\n\n${words(120)}\n\n## Practice\n\n${words(120)}\n\n## Thanks\n\nBye.\n`
    const pages = splitMarkdownIntoPages(text)
    expect(pages.join('')).toBe(text)
    expect(pages).toHaveLength(2)
    expect(pages[0].startsWith('## Overview')).toBe(true)
    expect(pages[0]).toContain('## Theory')
    expect(pages[1].startsWith('## Practice')).toBe(true)
    expect(pages[1].endsWith('Bye.\n')).toBe(true)
  })

  it('still cuts a long section at the size cap', () => {
    const text = `## Long section\n\n${Array.from({ length: 40 }, (_, i) => `Paragraph ${i}. ${words(30)}`).join('\n\n')}\n\n## Next\n\n${words(100)}\n`
    const pages = splitMarkdownIntoPages(text, { target: 1000 })
    expect(pages.join('')).toBe(text)
    expect(pages.length).toBeGreaterThan(3)
    expect(pages.filter((p) => !p.startsWith('## Next')).every((p) => p.length <= 1000)).toBe(true)
  })

  it('behaves as splitTextIntoPages for a file without # or ## headings', () => {
    const text = `### Only small headings\n\n${Array.from({ length: 30 }, (_, i) => `Paragraph ${i}. ${words(40)}`).join('\n\n')}\n`
    expect(splitMarkdownIntoPages(text)).toEqual(splitTextIntoPages(text, { markdown: true }))
    const plain = Array.from({ length: 30 }, (_, i) => `Line ${i} ${words(40)}`).join('\n\n')
    expect(splitMarkdownIntoPages(plain)).toEqual(splitTextIntoPages(plain, { markdown: true }))
  })

  it('ignores # lines inside fenced code and keeps a heading alone from becoming a page', () => {
    const text = `# Python notes\n\n## Loops\n\n${words(80)}\n\n\`\`\`python\n# not a heading\n## also not\nprint(1)\n\`\`\`\n\n${words(60)}\n\n## Functions\n\n${words(100)}\n`
    const pages = splitMarkdownIntoPages(text)
    expect(pages.join('')).toBe(text)
    expect(pages).toHaveLength(2)
    expect(pages[0]).toContain('# not a heading')
    expect(pages[1].startsWith('## Functions')).toBe(true)
  })
})
