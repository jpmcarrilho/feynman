import { describe, it, expect } from 'vitest'
import {
  buildWindows, normalizeSegments, verifyKeyTerms, applyGrouping, planTopicRows, chunkText, modulesFromHints, repairCount, renderPages,
  WINDOW_CHARS, MAX_TOPICS, MAX_MODULES,
} from './segment'
import { MAX_TOPIC_CHARS } from '@/lib/ingestLimits'
import { topicSizeGuidance } from '@/lib/prompts/ingest'

const topic = (title: string, pageStart: number, pageEnd: number, extra: Record<string, unknown> = {}) => ({
  title, pageStart, pageEnd, summary: `${title} summary.`, keyTerms: [], isQuantitative: false, isStudyMaterial: true, ...extra,
})
const chars = (n: number, each = 1000) => Array.from({ length: n }, () => each)
const pageList = (count: number, textChars: number) => Array.from({ length: count }, (_, i) => ({ n: i + 1, text: 'x'.repeat(textChars) }))

/** Every page in exactly one topic, ranges ordered and contiguous. */
function expectCovers(modules: { topics: { pageStart: number; pageEnd: number }[] }[], pageCount: number) {
  const flat = modules.flatMap((m) => m.topics)
  expect(flat.length).toBeGreaterThan(0)
  expect(flat[0].pageStart).toBe(1)
  expect(flat[flat.length - 1].pageEnd).toBe(pageCount)
  flat.forEach((t, i) => {
    expect(t.pageEnd).toBeGreaterThanOrEqual(t.pageStart)
    if (i > 0) expect(t.pageStart).toBe(flat[i - 1].pageEnd + 1)
  })
}

describe('buildWindows', () => {
  it('splits an 830k-character, 367-page document into ~14 windows that overlap by one page and cover every page', () => {
    const pages = pageList(367, 2250) // 367 * (2250 + marker + separator) ~ 830k
    const windows = buildWindows(pages)
    expect(windows.length).toBeGreaterThanOrEqual(14)
    expect(windows.length).toBeLessThanOrEqual(15)
    expect(windows[0].start).toBe(1)
    expect(windows[windows.length - 1].end).toBe(367)
    windows.forEach((w, i) => {
      if (i > 0) expect(w.start).toBe(windows[i - 1].end)
      const rendered = renderPages(pages, w.start, w.end).length
      expect(rendered).toBeLessThanOrEqual(WINDOW_CHARS)
    })
  })

  it('gives a page larger than the window a window of its own and moves on', () => {
    const pages = [{ n: 1, text: 'a'.repeat(100) }, { n: 2, text: 'b'.repeat(70_000) }, { n: 3, text: 'c'.repeat(100) }]
    const windows = buildWindows(pages)
    expect(windows).toEqual([{ start: 1, end: 1 }, { start: 2, end: 2 }, { start: 3, end: 3 }])
  })

  it('returns one window for a short document', () => {
    expect(buildWindows(pageList(3, 100))).toEqual([{ start: 1, end: 3 }])
  })
})

describe('normalizeSegments', () => {
  it('leaves a valid answer unchanged and reports no repairs', () => {
    const { modules, repairs } = normalizeSegments([{ title: 'M', topics: [topic('A', 1, 3), topic('B', 4, 6)] }], chars(6))
    expect(modules).toHaveLength(1)
    expect(modules[0].topics.map((t) => [t.pageStart, t.pageEnd])).toEqual([[1, 3], [4, 6]])
    expect(repairCount(repairs)).toBe(0)
  })

  it('gives gaps to the previous topic, extends the first topic to page 1 and the last to the final page', () => {
    const { modules, repairs } = normalizeSegments([{ title: 'M', topics: [topic('A', 3, 4), topic('B', 7, 8)] }], chars(10))
    expect(modules[0].topics.map((t) => [t.pageStart, t.pageEnd])).toEqual([[1, 6], [7, 10]])
    expect(repairs.gapPages).toBe(2 + 2 + 2)
    expectCovers(modules, 10)
  })

  it('cuts overlaps at the next topic start', () => {
    const { modules, repairs } = normalizeSegments([{ title: 'M', topics: [topic('A', 1, 6), topic('B', 4, 10)] }], chars(10))
    expect(modules[0].topics.map((t) => [t.pageStart, t.pageEnd])).toEqual([[1, 3], [4, 10]])
    expect(repairs.overlapPages).toBe(3)
  })

  it('clamps ranges outside [1, pageCount] and swaps reversed ones', () => {
    const { modules, repairs } = normalizeSegments([{ title: 'M', topics: [topic('A', -4, 3), topic('B', 9, 4), topic('C', 8, 99)] }], chars(10))
    expectCovers(modules, 10)
    expect(repairs.rangesClamped).toBeGreaterThanOrEqual(2)
    expect(repairs.rangesSwapped).toBe(1)
    expect(modules[0].topics.map((t) => t.title)).toEqual(['A', 'B', 'C'])
  })

  it('keeps the longer of two topics that start on the same page and drops the other', () => {
    const { modules, repairs } = normalizeSegments([{ title: 'M', topics: [topic('Short', 1, 2), topic('Long', 1, 5), topic('Rest', 6, 8)] }], chars(8))
    expect(modules[0].topics.map((t) => t.title)).toEqual(['Long', 'Rest'])
    expect(repairs.duplicateStartsDropped).toBe(1)
    expectCovers(modules, 8)
  })

  it('drops topics whose range is not a number', () => {
    const { modules, repairs } = normalizeSegments([{ title: 'M', topics: [topic('A', 1, 4), { ...topic('B', 0, 0), pageStart: NaN }] }], chars(4))
    expect(modules[0].topics).toHaveLength(1)
    expect(repairs.invalidDropped).toBe(1)
  })

  it('absorbs topics that hold only blank pages into the previous topic (or the next one for the first)', () => {
    const c = [0, 0, 500, 500, 0, 0, 500]
    const { modules, repairs } = normalizeSegments([{ title: 'M', topics: [topic('Blank first', 1, 2), topic('A', 3, 4), topic('Blank mid', 5, 6), topic('B', 7, 7)] }], c)
    expect(modules[0].topics.map((t) => [t.title, t.pageStart, t.pageEnd])).toEqual([['A', 1, 4 + 2], ['B', 7, 7]])
    expect(repairs.blankTopicsAbsorbed).toBe(2)
  })

  it('orders modules by page and moves a topic of a module that was already closed into the module before it', () => {
    const { modules, repairs } = normalizeSegments([
      { title: 'Later', topics: [topic('C', 7, 9)] },
      { title: 'Early', topics: [topic('A', 1, 3), topic('D', 4, 5)] },
      { title: 'Mid', topics: [topic('B', 6, 6)] },
    ], chars(9))
    expect(modules.map((m) => m.title)).toEqual(['Early', 'Mid', 'Later'])
    const interleaved = normalizeSegments([
      { title: 'X', topics: [topic('a', 1, 2), topic('c', 5, 6)] },
      { title: 'Y', topics: [topic('b', 3, 4)] },
    ], chars(6))
    expect(interleaved.modules.map((m) => m.title)).toEqual(['X', 'Y'])
    expect(interleaved.modules[1].topics.map((t) => t.title)).toEqual(['b', 'c'])
    expect(interleaved.repairs.modulesReassigned).toBe(1)
    expect(repairs.modulesReassigned).toBe(0)
  })

  it('trims long titles and fills empty ones', () => {
    const { modules, repairs } = normalizeSegments([{ title: '', topics: [topic('T'.repeat(200), 1, 2)] }, { title: 'M'.repeat(100), topics: [topic('', 3, 4)] }], chars(4))
    expect(modules[0].title).toBe('Module 1')
    expect(modules[0].topics[0].title.length).toBeLessThanOrEqual(80)
    expect(modules[1].title.length).toBeLessThanOrEqual(60)
    expect(modules[1].topics[0].title).toBe('Pages 3-4')
    expect(repairs.titlesTrimmed).toBe(2)
  })

  it('splits a topic over the content cap into parts along page boundaries', () => {
    const c = chars(10, 30_000) // 300k chars
    const { modules } = normalizeSegments([{ title: 'M', topics: [topic('Big', 1, 10)] }], c)
    const parts = modules[0].topics
    expect(parts.length).toBeGreaterThanOrEqual(3)
    expect(parts[0].title).toBe('Big (part 1)')
    expectCovers(modules, 10)
    for (const p of parts) {
      let size = 0
      for (let n = p.pageStart; n <= p.pageEnd; n++) size += c[n - 1]
      expect(size).toBeLessThanOrEqual(MAX_TOPIC_CHARS)
    }
  })

  it('caps topics by merging the smallest adjacent topics of a module', () => {
    const topics = Array.from({ length: 450 }, (_, i) => topic(`T${i}`, i + 1, i + 1))
    const { modules, repairs } = normalizeSegments([{ title: 'M', topics }], chars(450, 100))
    expect(modules.reduce((n, m) => n + m.topics.length, 0)).toBe(MAX_TOPICS)
    expect(repairs.capMerges).toBe(50)
    expectCovers(modules, 450)
  })

  it('caps modules by merging the smallest adjacent modules', () => {
    const mods = Array.from({ length: 45 }, (_, i) => ({ title: `Mod ${i}`, topics: [topic(`T${i}`, i + 1, i + 1)] }))
    const { modules } = normalizeSegments(mods, chars(45, 100))
    expect(modules).toHaveLength(MAX_MODULES)
    expectCovers(modules, 45)
  })

  it('keeps isStudyMaterial false only when every merged topic is not study material', () => {
    const topics = [topic('Cover', 1, 1, { isStudyMaterial: false }), topic('Agenda', 2, 2, { isStudyMaterial: false }), topic('Lecture', 3, 3)]
    const { modules } = normalizeSegments([{ title: 'M', topics }], chars(3, 100), { maxTopics: 2 })
    const flat = modules.flatMap((m) => m.topics)
    expect(flat).toHaveLength(2)
    expect(flat[0].isStudyMaterial).toBe(false)
    expect(flat[1].isStudyMaterial).toBe(true)
  })

  it('returns no modules when the model returned no topics', () => {
    expect(normalizeSegments([{ title: 'M', topics: [] }], chars(3)).modules).toEqual([])
  })

  it('every page belongs to exactly one topic for random model answers', () => {
    let seed = 7
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296)
    for (let run = 0; run < 200; run++) {
      const pages = 1 + Math.floor(rnd() * 60)
      const mods = Array.from({ length: 1 + Math.floor(rnd() * 4) }, (_, m) => ({
        title: `M${m}`,
        topics: Array.from({ length: Math.floor(rnd() * 8) }, (_, t) => {
          const a = Math.floor(rnd() * (pages + 10)) - 5
          const b = a + Math.floor(rnd() * 12) - 3
          return topic(`T${m}.${t}`, a, b)
        }),
      }))
      const c = Array.from({ length: pages }, () => (rnd() < 0.2 ? 0 : 500))
      const { modules } = normalizeSegments(mods, c)
      if (modules.length > 0) expectCovers(modules, pages)
    }
  })
})

describe('verifyKeyTerms', () => {
  const text = 'The Median Voter Theorem says that the  median\nvoter decides. Condorcet cycles appear.'
  it('keeps terms that occur literally, case-insensitively and across whitespace, and drops the rest', () => {
    const { kept, dropped } = verifyKeyTerms(['median voter theorem', 'Condorcet cycles', 'Arrow', 'condorcet CYCLES', ''], text)
    expect(kept).toEqual(['median voter theorem', 'Condorcet cycles'])
    expect(dropped).toBe(3)
  })
  it('caps at 8 terms', () => {
    const words = Array.from({ length: 12 }, (_, i) => `term${i}`)
    expect(verifyKeyTerms(words, words.join(' ')).kept).toHaveLength(8)
  })
})

describe('applyGrouping', () => {
  const t = (title: string, a: number, b: number) => ({ ...topic(title, a, b), moduleHint: 'h' })
  const pageChars = chars(10, 100)
  it('merges duplicate groups, keeps module order and assigns unlisted topics to the module before them', () => {
    const topics = [t('A', 1, 2), t('B', 3, 4), t('B cont', 4, 5), t('C', 6, 7), t('D', 8, 10)]
    const out = applyGrouping(topics, { modules: [{ title: 'One', topicIndices: [0, 1, 2] }, { title: 'Two', topicIndices: [3] }], mergeGroups: [[1, 2]] }, pageChars)
    expect(out.modules.map((m) => [m.title, m.topics.map((x) => x.title)])).toEqual([['One', ['A', 'B']], ['Two', ['C', 'D']]])
    expect(out.topics[1].pageEnd).toBe(5)
  })
  it('ignores invalid merge groups (non-consecutive, out of range, overlapping)', () => {
    const topics = [t('A', 1, 3), t('B', 4, 6), t('C', 7, 10)]
    const out = applyGrouping(topics, { modules: [{ title: 'All', topicIndices: [0, 1, 2] }], mergeGroups: [[0, 2], [5, 6], [1], [0, 1], [1, 2]] }, pageChars)
    expect(out.topics.map((x) => x.title)).toEqual(['A', 'C'])
  })
  it('uses the first module that lists a topic', () => {
    const out = applyGrouping([t('A', 1, 5), t('B', 6, 10)], { modules: [{ title: 'X', topicIndices: [0, 1] }, { title: 'Y', topicIndices: [1] }], mergeGroups: [] }, pageChars)
    expect(out.modules.map((m) => m.title)).toEqual(['X'])
  })
})

describe('modulesFromHints', () => {
  it('groups consecutive topics with the same hint', () => {
    const mk = (title: string, hint: string) => ({ ...topic(title, 1, 1), moduleHint: hint })
    const mods = modulesFromHints([mk('a', 'Lecture 1'), mk('b', 'lecture 1'), mk('c', 'Lecture 2')])
    expect(mods.map((m) => m.topics.length)).toEqual([2, 1])
  })
})

describe('planTopicRows', () => {
  const ids = () => {
    let i = 0
    return () => `id${++i}`
  }
  it('builds module labels, units, content from the page range and verified key terms', () => {
    const pages = [{ n: 1, text: 'Alpha beta' }, { n: 2, text: '' }, { n: 3, text: 'Gamma delta' }]
    const outline = [
      { title: 'Intro', topics: [{ ...topic('First', 1, 2), keyTerms: ['alpha', 'zeta'] }, { ...topic('Second', 3, 3), keyTerms: ['Gamma'], isStudyMaterial: false }] },
    ]
    const plan = planTopicRows(outline, pages, 4, ids())
    expect(plan.rows.map((r) => [r.week, r.unit, r.title, r.content])).toEqual([
      ['05 · Intro', '1', 'First', 'Alpha beta'],
      ['05 · Intro', '2', 'Second', 'Gamma delta'],
    ])
    expect(plan.rows[0].keyTerms).toEqual(['alpha'])
    expect(plan.keyTermsDropped).toBe(1)
    expect(plan.rows[1].isStudyMaterial).toBe(false)
  })
  it('splits a single page above the content cap by characters and numbers the parts', () => {
    const pages = [{ n: 1, text: ('word '.repeat(30_000)).trim() }]
    const plan = planTopicRows([{ title: 'M', topics: [topic('Huge', 1, 1)] }], pages, 0, ids())
    expect(plan.rows.length).toBeGreaterThanOrEqual(2)
    expect(plan.rows[0].title).toBe('Huge (part 1)')
    expect(plan.rows.every((r) => r.content.length <= MAX_TOPIC_CHARS)).toBe(true)
  })
})

describe('chunkText and prompts', () => {
  it('chunkText keeps all text', () => {
    const text = Array.from({ length: 50 }, (_, i) => `paragraph ${i} `.repeat(20)).join('\n\n')
    const chunks = chunkText(text, 3000)
    expect(chunks.every((c) => c.length <= 3000)).toBe(true)
    expect(chunks.join(' ').replace(/\s+/g, ' ').trim()).toBe(text.replace(/\s+/g, ' ').trim())
  })
  it('topicSizeGuidance turns characters into pages', () => {
    expect(topicSizeGuidance(4000)).toContain('roughly 1 to 4 pages')
    expect(topicSizeGuidance(300)).toContain('roughly 7 to 50 pages')
  })
})
