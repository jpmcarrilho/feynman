// Segmentation (plan 4.5): split the extracted pages of a Source into topics a student studies in one sitting, group the
// topics into modules and store them as Topic rows of the studyspace.
//
//   text <= 60,000 chars   one call (segmentSinglePrompt): modules with their topics
//   longer                 windows of ~60,000 chars on page boundaries, 1 page overlap, three at a time
//                          (segmentWindowPrompt), then ONE merge call (moduleGroupingPrompt) that groups the window
//                          topics into modules and joins topics cut in two by a window boundary
//
// The model's answer is never trusted for structure: `normalizeSegments` (pure) makes the page ranges cover [1, pageCount]
// exactly once, in order, within the caps; key terms that do not occur in a topic's text are dropped. Everything is
// written in one transaction together with the move of the source to `importing_questions`, so a failure leaves nothing
// half-written.
import crypto from 'crypto'
import { prisma } from '@/lib/db'
import { MAX_TOPIC_CHARS, extensionOf } from '@/lib/ingestLimits'
import {
  segmentSinglePrompt, segmentWindowPrompt, moduleGroupingPrompt, INGEST_PROMPT_VERSION, type GroupingTopic,
} from '@/lib/prompts/ingest'
import { NOT_STUDY_MATERIAL_PREFIX } from '@/services/exerciseGenerator'
import { readPages } from '@/server/storage'
import {
  SegmentationOutputSchema, WindowTopicsSchema, ModuleGroupingSchema, type TopicSegment, type PagesFile,
} from './schemas'
import { structuredCall, newModelStats, StageError, type GenerateObjectFn, type ModelStats } from './modelCall'
import { mapWithConcurrency, STAGE_CONCURRENCY } from './pool'

// ---------------------------------------------------------------------------------------------------------------------
// Constants and types
// ---------------------------------------------------------------------------------------------------------------------

/** A document up to this many characters (page markers included) is segmented in one call; longer ones in windows. */
export const WINDOW_CHARS = 60_000
export const MAX_MODULES = 40
export const MAX_TOPICS = 400
export const TOPIC_TITLE_MAX = 80
export const MODULE_TITLE_MAX = 60
export const KEY_TERMS_MAX = 8
export const KEY_TERM_MAX_CHARS = 60
/** Separator between the pages of a topic's content. */
const PAGE_SEPARATOR = '\n\n'

type Page = { n: number; text: string }

export type OutlineTopic = {
  title: string
  pageStart: number
  pageEnd: number
  summary: string
  keyTerms: string[]
  isQuantitative: boolean
  isStudyMaterial: boolean
}
export type OutlineModule = { title: string; topics: OutlineTopic[] }
export type RawModule = { title: string; topics: TopicSegment[] }

/** What `normalizeSegments` had to change in the model's answer. All counters are 0 when the answer was already valid. */
export type RepairLog = {
  /** Topics with a page range outside [1, pageCount] (or a non-integer one) that was clamped. */
  rangesClamped: number
  /** Topics whose end was before their start. */
  rangesSwapped: number
  /** Topics dropped because the range was not a number. */
  invalidDropped: number
  /** Pages not covered by any topic that were given to the previous topic (or the first one). */
  gapPages: number
  /** Pages claimed by two topics that were cut at the next topic's start. */
  overlapPages: number
  /** Topics dropped because another topic starts on the same page (the longer one is kept). */
  duplicateStartsDropped: number
  /** Topics that held only blank pages and were absorbed by a neighbour. */
  blankTopicsAbsorbed: number
  /** Topics moved out of a module that had already been closed (modules interleaved in page order). */
  modulesReassigned: number
  /** Titles cut to the length limit. */
  titlesTrimmed: number
  /** Adjacent topics / modules merged to respect the caps. */
  capMerges: number
}
export function newRepairLog(): RepairLog {
  return {
    rangesClamped: 0, rangesSwapped: 0, invalidDropped: 0, gapPages: 0, overlapPages: 0, duplicateStartsDropped: 0,
    blankTopicsAbsorbed: 0, modulesReassigned: 0, titlesTrimmed: 0, capMerges: 0,
  }
}
/** Number of repairs that changed the structure of the model's answer (titles trimmed and cap merges excluded: they are limits, not errors). */
export function repairCount(log: RepairLog): number {
  return log.rangesClamped + log.rangesSwapped + log.invalidDropped + (log.gapPages > 0 ? 1 : 0) + (log.overlapPages > 0 ? 1 : 0) +
    log.duplicateStartsDropped + log.blankTopicsAbsorbed + log.modulesReassigned
}
function addLogs(into: RepairLog, from: RepairLog): void {
  for (const k of Object.keys(into) as (keyof RepairLog)[]) into[k] += from[k]
}

// ---------------------------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------------------------

/** The text of pages `from..to` as the model sees it: each page behind a [[p:N]] marker line. */
export function renderPages(pages: Page[], from = 1, to = pages.length): string {
  return pages.filter((p) => p.n >= from && p.n <= to).map((p) => `[[p:${p.n}]]\n${p.text}`).join(PAGE_SEPARATOR)
}

function renderedLength(page: Page): number {
  return `[[p:${page.n}]]\n`.length + page.text.length + PAGE_SEPARATOR.length
}

/**
 * Windows of at most `maxChars` rendered characters on page boundaries (a single page larger than that is a window of its
 * own). Consecutive windows share one page: the next window starts at the last page of the previous one, unless the
 * previous window held a single page.
 */
export function buildWindows(pages: Page[], maxChars: number = WINDOW_CHARS): { start: number; end: number }[] {
  const windows: { start: number; end: number }[] = []
  let i = 0
  while (i < pages.length) {
    let size = renderedLength(pages[i])
    let j = i
    while (j + 1 < pages.length && size + renderedLength(pages[j + 1]) <= maxChars) {
      j++
      size += renderedLength(pages[j])
    }
    windows.push({ start: pages[i].n, end: pages[j].n })
    if (j === pages.length - 1) break
    i = j > i ? j : j + 1
  }
  return windows
}

export function collapseSpace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function haystack(text: string): string {
  return collapseSpace(text.normalize('NFKC')).toLowerCase()
}

/** The key terms that literally occur in `text` (case-insensitive, whitespace-insensitive), without duplicates, at most KEY_TERMS_MAX. */
export function verifyKeyTerms(terms: string[], text: string): { kept: string[]; dropped: number } {
  const hay = haystack(text)
  const seen = new Set<string>()
  const kept: string[] = []
  let dropped = 0
  for (const raw of terms) {
    const term = collapseSpace(String(raw ?? ''))
    const key = term.normalize('NFKC').toLowerCase()
    if (!term || term.length > KEY_TERM_MAX_CHARS || seen.has(key)) {
      dropped++
      continue
    }
    seen.add(key)
    if (hay.includes(key) && kept.length < KEY_TERMS_MAX) kept.push(term)
    else dropped++
  }
  return { kept, dropped }
}

function trimTitle(title: string, max: number, log: RepairLog): string {
  const t = collapseSpace(String(title ?? ''))
  if (t.length <= max) return t
  log.titlesTrimmed++
  return `${t.slice(0, max - 1).trimEnd()}…`
}

type Flat = {
  t: TopicSegment
  /** Module id (index of the module in the model's answer). */
  m: number
  seq: number
  start: number
  end: number
  /** Size of the original range, to prefer the longer of two topics that start on the same page. */
  span: number
}

function sumChars(chars: number[], from: number, to: number): number {
  let n = 0
  for (let p = from; p <= to; p++) n += chars[p - 1] ?? 0
  return n
}

/**
 * Sorts topics by page, resolves duplicate starts and makes the ranges contiguous over [1, pageCount]: every topic
 * covers [its start, the next topic's start - 1]; the first starts at page 1 and the last ends at the last page, so gaps
 * go to the previous topic and overlaps are cut at the next topic's start.
 */
function makeContiguous(flat: Flat[], chars: number[], log: RepairLog): Flat[] {
  const pageCount = chars.length
  const sorted = [...flat].sort((a, b) => a.start - b.start || b.span - a.span || a.seq - b.seq)
  const unique: Flat[] = []
  for (const f of sorted) {
    if (unique.length > 0 && unique[unique.length - 1].start === f.start) log.duplicateStartsDropped++
    else unique.push(f)
  }
  if (unique.length === 0) return []
  const out: Flat[] = unique.map((f, i) => {
    const originalStart = f.start
    const originalEnd = f.end
    const start = i === 0 ? 1 : f.start
    if (i === 0 && originalStart > 1) log.gapPages += originalStart - 1
    const end = i === unique.length - 1 ? pageCount : unique[i + 1].start - 1
    if (originalEnd < end) log.gapPages += end - originalEnd
    else if (originalEnd > end) log.overlapPages += originalEnd - end
    return { ...f, start, end }
  })
  return out
}

/** Merges topics that hold only blank pages into a neighbour (the previous topic, or the next one for the first). */
function absorbBlankTopics(topics: Flat[], chars: number[], log: RepairLog): Flat[] {
  const isBlank = (f: Flat) => sumChars(chars, f.start, f.end) === 0
  if (topics.every(isBlank)) return topics
  const out = [...topics]
  for (let i = 0; i < out.length; ) {
    if (out.length > 1 && isBlank(out[i])) {
      if (i > 0) out[i - 1] = { ...out[i - 1], end: out[i].end }
      else out[i + 1] = { ...out[i + 1], start: out[i].start }
      out.splice(i, 1)
      log.blankTopicsAbsorbed++
      continue
    }
    i++
  }
  return out
}

function mergeTwo(a: OutlineTopic, b: OutlineTopic, chars: number[]): OutlineTopic {
  const bigger = sumChars(chars, a.pageStart, a.pageEnd) >= sumChars(chars, b.pageStart, b.pageEnd) ? a : b
  return {
    title: bigger.title,
    pageStart: Math.min(a.pageStart, b.pageStart),
    pageEnd: Math.max(a.pageEnd, b.pageEnd),
    summary: bigger.summary,
    keyTerms: [...new Set([...a.keyTerms, ...b.keyTerms])].slice(0, KEY_TERMS_MAX * 2),
    isQuantitative: a.isQuantitative || b.isQuantitative,
    isStudyMaterial: a.isStudyMaterial || b.isStudyMaterial,
  }
}

function splitOversized(topic: OutlineTopic, pageChars: number[], cap: number): OutlineTopic[] {
  const size = (from: number, to: number) => sumChars(pageChars, from, to) + (to - from) * PAGE_SEPARATOR.length
  if (size(topic.pageStart, topic.pageEnd) <= cap) return [topic]
  const parts: { start: number; end: number }[] = []
  let start = topic.pageStart
  for (let p = topic.pageStart; p <= topic.pageEnd; p++) {
    if (p > start && size(start, p) > cap) {
      parts.push({ start, end: p - 1 })
      start = p
    }
  }
  parts.push({ start, end: topic.pageEnd })
  return parts.map((r, i) => ({ ...topic, title: `${topic.title} (part ${i + 1})`, pageStart: r.start, pageEnd: r.end }))
}

/**
 * Turns the model's modules into a valid outline. Pure.
 *  - page ranges are clamped to [1, pageCount], sorted and made contiguous: gaps go to the previous topic, overlaps are cut
 *    at the next topic's start, so every page belongs to exactly one topic;
 *  - topics with blank pages only are absorbed by a neighbour; topics that start on the same page keep the longer one;
 *  - modules follow page order: a topic whose module was already closed by another module in between joins the module
 *    before it;
 *  - topics over `maxTopicChars` of content are split into "Title (part k)" along page boundaries;
 *  - more than MAX_TOPICS topics: the smallest adjacent topics of a module are merged; more than MAX_MODULES modules: the
 *    smallest adjacent modules are merged.
 * `pageChars[i]` is the number of characters of page i + 1; the page count is its length.
 */
export function normalizeSegments(
  modules: RawModule[],
  pageChars: number[],
  opts: { maxTopicChars?: number; maxTopics?: number; maxModules?: number } = {},
): { modules: OutlineModule[]; repairs: RepairLog } {
  const log = newRepairLog()
  const pageCount = pageChars.length
  const maxTopicChars = opts.maxTopicChars ?? MAX_TOPIC_CHARS
  const maxTopics = opts.maxTopics ?? MAX_TOPICS
  const maxModules = opts.maxModules ?? MAX_MODULES
  if (pageCount === 0) return { modules: [], repairs: log }

  const flat: Flat[] = []
  let seq = 0
  modules.forEach((mod, m) => {
    for (const t of mod.topics ?? []) {
      let s = Number(t.pageStart)
      let e = Number(t.pageEnd)
      if (!Number.isFinite(s) || !Number.isFinite(e)) {
        log.invalidDropped++
        continue
      }
      if (e < s) {
        ;[s, e] = [e, s]
        log.rangesSwapped++
      }
      const cs = Math.min(pageCount, Math.max(1, Math.trunc(s)))
      const ce = Math.min(pageCount, Math.max(1, Math.trunc(e)))
      if (cs !== s || ce !== e) log.rangesClamped++
      flat.push({ t, m, seq: seq++, start: cs, end: ce, span: ce - cs })
    }
  })

  let topics = absorbBlankTopics(makeContiguous(flat, pageChars, log), pageChars, log)

  // Module runs in page order
  const runs: { title: string; topics: OutlineTopic[] }[] = []
  const closed = new Set<number>()
  let currentModule = -1
  for (const f of topics) {
    if (f.m !== currentModule) {
      if (closed.has(f.m) && runs.length > 0) {
        log.modulesReassigned++
        // joins the module before it
      } else {
        if (currentModule !== -1) closed.add(currentModule)
        currentModule = f.m
        runs.push({ title: trimTitle(modules[f.m]?.title ?? '', MODULE_TITLE_MAX, log) || `Module ${runs.length + 1}`, topics: [] })
      }
    }
    runs[runs.length - 1].topics.push({
      title: trimTitle(f.t.title, TOPIC_TITLE_MAX, log) || `Pages ${f.start}-${f.end}`,
      pageStart: f.start,
      pageEnd: f.end,
      summary: collapseSpace(f.t.summary ?? ''),
      keyTerms: Array.isArray(f.t.keyTerms) ? f.t.keyTerms.map(String) : [],
      isQuantitative: !!f.t.isQuantitative,
      isStudyMaterial: f.t.isStudyMaterial !== false,
    })
  }
  topics = []

  let result: OutlineModule[] = runs.map((r) => ({ title: r.title, topics: r.topics.flatMap((t) => splitOversized(t, pageChars, maxTopicChars)) }))

  // Caps. Topics: merge the smallest adjacent pair of one module whose merged content stays within the content cap.
  const count = () => result.reduce((n, m) => n + m.topics.length, 0)
  const size = (t: OutlineTopic) => sumChars(pageChars, t.pageStart, t.pageEnd)
  while (count() > maxTopics) {
    let best: { m: number; i: number; total: number } | null = null
    result.forEach((mod, m) => {
      for (let i = 0; i + 1 < mod.topics.length; i++) {
        const total = size(mod.topics[i]) + size(mod.topics[i + 1])
        if (total <= maxTopicChars && (!best || total < best.total)) best = { m, i, total }
      }
    })
    if (!best) break
    const { m, i } = best as { m: number; i: number }
    result[m].topics.splice(i, 2, mergeTwo(result[m].topics[i], result[m].topics[i + 1], pageChars))
    log.capMerges++
  }
  while (result.length > maxModules) {
    let bestI = 0
    let bestTotal = Infinity
    for (let i = 0; i + 1 < result.length; i++) {
      const total = result[i].topics.concat(result[i + 1].topics).reduce((n, t) => n + size(t), 0)
      if (total < bestTotal) {
        bestTotal = total
        bestI = i
      }
    }
    const a = result[bestI]
    const b = result[bestI + 1]
    const sizeOf = (mod: OutlineModule) => mod.topics.reduce((n, t) => n + size(t), 0)
    result.splice(bestI, 2, { title: sizeOf(a) >= sizeOf(b) ? a.title : b.title, topics: [...a.topics, ...b.topics] })
    log.capMerges++
  }
  result = result.filter((m) => m.topics.length > 0)
  return { modules: result, repairs: log }
}

/** Splits `text` into chunks of at most `cap` characters, at paragraph, line or space boundaries when one is near. */
export function chunkText(text: string, cap: number = MAX_TOPIC_CHARS): string[] {
  if (text.length <= cap) return [text]
  const chunks: string[] = []
  let rest = text
  while (rest.length > cap) {
    const window = rest.slice(0, cap)
    const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf(' '))
    const at = cut > cap * 0.8 ? cut : cap
    chunks.push(rest.slice(0, at))
    rest = rest.slice(at).replace(/^\s+/, '')
  }
  if (rest) chunks.push(rest)
  return chunks
}

// ---------------------------------------------------------------------------------------------------------------------
// Model passes
// ---------------------------------------------------------------------------------------------------------------------

function windowCheck(start: number, end: number) {
  return (object: { topics: { pageStart: number; pageEnd: number }[] }): string | null => {
    if (object.topics.length === 0) return 'no topics'
    const inside = object.topics.filter((t) => Math.max(t.pageStart, t.pageEnd) >= start && Math.min(t.pageStart, t.pageEnd) <= end)
    return inside.length === 0 ? 'no topic lies inside the window' : null
  }
}

function singleCheck(object: { modules: { topics: unknown[] }[] }): string | null {
  return object.modules.some((m) => m.topics.length > 0) ? null : 'no topics'
}

type WindowTopic = TopicSegment & { moduleHint: string }

/** Groups consecutive topics by their module hint (the fallback when the merge call fails). */
export function modulesFromHints(topics: WindowTopic[]): RawModule[] {
  const modules: RawModule[] = []
  let lastKey = ''
  for (const t of topics) {
    const key = collapseSpace(t.moduleHint).toLowerCase()
    if (modules.length === 0 || key !== lastKey) modules.push({ title: t.moduleHint, topics: [] })
    modules[modules.length - 1].topics.push(t)
    lastKey = key
  }
  return modules
}

export type SegmentStats = {
  mode: 'single' | 'windowed' | 'reused'
  pages: number
  chars: number
  windows: number
  model: ModelStats
  repairs: RepairLog
  repairCount: number
  modules: number
  topics: number
  notStudyTopics: number
  keyTermsKept: number
  keyTermsDropped: number
  /** Topics with a content larger than the cap that had to be cut by characters (a single page above the cap). */
  oversizedPageParts: number
  mergeFallback: boolean
  ms: number
}

/** The model passes: outline of the whole document before normalization. */
async function buildOutline(
  fileName: string, pages: Page[], renderedChars: number, generate: GenerateObjectFn | undefined, model: ModelStats,
): Promise<{ modules: RawModule[]; mode: 'single' | 'windowed'; windows: number; repairs: RepairLog; mergeFallback: boolean }> {
  const pageCount = pages.length
  const pageChars = pages.map((p) => p.text.length)
  const avgPageChars = pageChars.reduce((a, b) => a + b, 0) / Math.max(1, pageCount)
  if (renderedChars <= WINDOW_CHARS) {
    const object = await structuredCall({
      generate, stats: model, schema: SegmentationOutputSchema, what: 'Building the outline', check: singleCheck,
      prompt: segmentSinglePrompt({ fileName, pageCount, avgPageChars, markedText: renderPages(pages) }),
    })
    return { modules: object.modules, mode: 'single', windows: 1, repairs: newRepairLog(), mergeFallback: false }
  }

  const windows = buildWindows(pages)
  const repairs = newRepairLog()
  const perWindow = await mapWithConcurrency(windows, STAGE_CONCURRENCY, async (w) => {
    const object = await structuredCall({
      generate, stats: model, schema: WindowTopicsSchema, what: `Building the outline of pages ${w.start}-${w.end}`,
      check: windowCheck(w.start, w.end),
      prompt: segmentWindowPrompt({ fileName, pageCount, avgPageChars, windowStart: w.start, windowEnd: w.end, markedText: renderPages(pages, w.start, w.end) }),
    })
    // Keep each window's topics inside the window
    const log = newRepairLog()
    const topics: WindowTopic[] = []
    for (const t of object.topics) {
      let s = Math.trunc(Number(t.pageStart))
      let e = Math.trunc(Number(t.pageEnd))
      if (e < s) [s, e] = [e, s]
      if (e < w.start || s > w.end) {
        log.invalidDropped++
        continue
      }
      const cs = Math.max(w.start, s)
      const ce = Math.min(w.end, e)
      if (cs !== t.pageStart || ce !== t.pageEnd) log.rangesClamped++
      topics.push({ ...t, pageStart: cs, pageEnd: ce })
    }
    return { topics, log }
  })
  const all: WindowTopic[] = []
  for (const w of perWindow) {
    all.push(...w.topics)
    addLogs(repairs, w.log)
  }

  // Contiguous, deduplicated topics in page order, so the merge call and its indices are unambiguous
  const flat: Flat[] = all.map((t, seq) => ({ t, m: 0, seq, start: t.pageStart, end: t.pageEnd, span: t.pageEnd - t.pageStart }))
  const contiguity = newRepairLog()
  const contiguous = absorbBlankTopics(makeContiguous(flat, pageChars, contiguity), pageChars, contiguity)
  // The one page two windows share is claimed by both of their topics by design: not a repair of the model's answer
  contiguity.overlapPages = Math.max(0, contiguity.overlapPages - (windows.length - 1))
  addLogs(repairs, contiguity)
  const ordered: WindowTopic[] = contiguous.map((f) => ({ ...(f.t as WindowTopic), pageStart: f.start, pageEnd: f.end }))

  const grouping: GroupingTopic[] = ordered.map((t, index) => ({
    index, title: t.title, pageStart: t.pageStart, pageEnd: t.pageEnd, summary: t.summary, moduleHint: t.moduleHint,
  }))
  let mergeFallback = false
  let modules: RawModule[]
  try {
    const object = await structuredCall({
      generate, stats: model, schema: ModuleGroupingSchema, what: 'Grouping the topics into modules',
      check: (o) => (o.modules.length === 0 ? 'no modules' : null),
      prompt: moduleGroupingPrompt({ fileName, pageCount, topics: grouping }),
    })
    const applied = applyGrouping(ordered, object, pageChars)
    modules = applied.modules
  } catch (error) {
    if (!(error instanceof StageError)) throw error
    // Section hints are a usable grouping; the outline is better than a failed upload
    mergeFallback = true
    modules = modulesFromHints(ordered)
  }
  return { modules, mode: 'windowed', windows: windows.length, repairs, mergeFallback }
}

/** Applies the merge call's answer: merges the duplicate groups, then assigns every topic to exactly one module. */
export function applyGrouping(
  topics: WindowTopic[],
  grouping: { modules: { title: string; topicIndices: number[] }[]; mergeGroups: number[][] },
  pageChars: number[],
): { modules: RawModule[]; topics: WindowTopic[] } {
  const n = topics.length
  // Valid merge groups: consecutive ascending indices, at least two, not overlapping another group
  const groupOf = new Map<number, number[]>()
  const valid: number[][] = []
  for (const g of grouping.mergeGroups ?? []) {
    const idx = [...g]
    const ok = idx.length >= 2 && idx.every((v, i) => Number.isInteger(v) && v >= 0 && v < n && (i === 0 || v === idx[i - 1] + 1)) && !idx.some((v) => groupOf.has(v))
    if (!ok) continue
    valid.push(idx)
    idx.forEach((v) => groupOf.set(v, idx))
  }
  // Module of each original topic (first mention wins), unassigned topics follow the topic before them
  const moduleOf: number[] = new Array(n).fill(-1)
  grouping.modules.forEach((mod, mi) => {
    for (const v of mod.topicIndices) if (Number.isInteger(v) && v >= 0 && v < n && moduleOf[v] === -1) moduleOf[v] = mi
  })
  let last = moduleOf.find((m) => m !== -1) ?? 0
  for (let i = 0; i < n; i++) {
    if (moduleOf[i] === -1) moduleOf[i] = last
    else last = moduleOf[i]
  }

  const outTopics: WindowTopic[] = []
  const outModule: number[] = []
  for (let i = 0; i < n; ) {
    const group = groupOf.get(i)
    if (group && group[0] === i) {
      const parts = group.map((v) => topics[v])
      const asOutline = parts.map((p): OutlineTopic => ({ title: p.title, pageStart: p.pageStart, pageEnd: p.pageEnd, summary: p.summary, keyTerms: p.keyTerms, isQuantitative: p.isQuantitative, isStudyMaterial: p.isStudyMaterial }))
      const m = asOutline.reduce((a, b) => mergeTwo(a, b, pageChars))
      outTopics.push({ ...m, moduleHint: parts[0].moduleHint })
      outModule.push(moduleOf[i])
      i += group.length
    } else {
      outTopics.push(topics[i])
      outModule.push(moduleOf[i])
      i++
    }
  }
  const modules: RawModule[] = grouping.modules.map((m) => ({ title: m.title, topics: [] }))
  outTopics.forEach((t, i) => modules[outModule[i]].topics.push(t))
  return { modules: modules.filter((m) => m.topics.length > 0), topics: outTopics }
}

// ---------------------------------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------------------------------

export type TopicRowPlan = {
  id: string
  module: number
  indexInModule: number
  title: string
  week: string
  unit: string
  pageStart: number
  pageEnd: number
  content: string
  summary: string | null
  keyTerms: string[]
  isQuantitative: boolean
  isStudyMaterial: boolean
}

/** One row per topic (and per content chunk of a page above the cap), with the verified key terms. Pure apart from ids. */
export function planTopicRows(
  outline: OutlineModule[], pages: Page[], moduleNumberBase: number, newId: () => string = () => crypto.randomUUID(),
): { rows: TopicRowPlan[]; keyTermsKept: number; keyTermsDropped: number; oversizedPageParts: number } {
  const byN = new Map(pages.map((p) => [p.n, p.text]))
  const rows: TopicRowPlan[] = []
  let kept = 0
  let dropped = 0
  let oversized = 0
  outline.forEach((mod, mi) => {
    const week = `${String(moduleNumberBase + mi + 1).padStart(2, '0')} · ${mod.title}`
    let unit = 0
    for (const t of mod.topics) {
      const texts: string[] = []
      for (let n = t.pageStart; n <= t.pageEnd; n++) {
        const text = (byN.get(n) ?? '').trim()
        if (text) texts.push(text)
      }
      const content = texts.join(PAGE_SEPARATOR)
      const chunks = chunkText(content, MAX_TOPIC_CHARS)
      if (chunks.length > 1) oversized += chunks.length
      chunks.forEach((chunk, ci) => {
        unit++
        const { kept: terms, dropped: d } = verifyKeyTerms(t.keyTerms, chunk)
        kept += terms.length
        dropped += d
        rows.push({
          id: newId(), module: mi, indexInModule: unit, week, unit: String(unit),
          title: chunks.length > 1 ? `${t.title} (part ${ci + 1})` : t.title,
          pageStart: t.pageStart, pageEnd: t.pageEnd, content: chunk, summary: t.summary || null, keyTerms: terms,
          isQuantitative: t.isQuantitative, isStudyMaterial: t.isStudyMaterial,
        })
      })
    }
  })
  return { rows, keyTermsKept: kept, keyTermsDropped: dropped, oversizedPageParts: oversized }
}

/** `reportedReason` of the marker row of a topic classified as front matter or logistics (the generator's own prefix). */
export function notStudyMaterialReason(title: string): string {
  return `${NOT_STUDY_MATERIAL_PREFIX}: front matter or course logistics, classified when the file was segmented ("${title.slice(0, 80)}").`
}

const UPLOADED_WEEK_RE = /^\d+ · /

// ---------------------------------------------------------------------------------------------------------------------
// segmentSource
// ---------------------------------------------------------------------------------------------------------------------

export type SegmentResult = { topicIds: string[]; stats: SegmentStats }

const SEGMENT_TX_TIMEOUT_MS = 120_000

async function countLogs(sourceId: string): Promise<number> {
  return prisma.exerciseLog.count({ where: { exercise: { topic: { sourceId } } } })
}

async function existingTopicIds(sourceId: string): Promise<string[]> {
  const rows = await prisma.topic.findMany({ where: { sourceId }, orderBy: { order: 'asc' }, select: { id: true } })
  return rows.map((r) => r.id)
}

function emptyStats(mode: SegmentStats['mode'], pages: number, chars: number): SegmentStats {
  return {
    mode, pages, chars, windows: 0, model: newModelStats(), repairs: newRepairLog(), repairCount: 0, modules: 0, topics: 0,
    notStudyTopics: 0, keyTermsKept: 0, keyTermsDropped: 0, oversizedPageParts: 0, mergeFallback: false, ms: 0,
  }
}

/**
 * Segments an extracted source into modules and topics and stores them (plan 4.5).
 *
 * Runs from status `segmenting`; on success the source moves to `importing_questions` inside the same transaction that
 * writes the topics. A model failure (two attempts per call) or an unusable answer sets status `failed`,
 * failedStage `segmenting` and a readable `error`, writes nothing else, and rethrows.
 *
 * Re-running (after a crash, or Retry):
 *  - status already past `segmenting` and topics exist: nothing happens, the existing topic ids are returned;
 *  - any topic of the source has answered exercises (logs): the outline is frozen, nothing is deleted or created, the
 *    status moves on, no model call is made;
 *  - otherwise the source's topics (and through the cascade their exercises) are deleted and the outline is built again,
 *    in the same slot of the course order (topics after it are shifted by the difference in count); other sources are untouched.
 * Ordering of a new source follows plan 3.5: `order` continues after the highest `order` of the course, module numbers
 * continue after the uploaded modules that come before it.
 */
export async function segmentSource(sourceId: string, deps: { generate?: GenerateObjectFn } = {}): Promise<SegmentResult> {
  const started = Date.now()
  const source = await prisma.source.findUnique({ where: { id: sourceId } })
  if (!source) throw new Error(`Source ${sourceId} not found`)
  const fail = async (message: string) => {
    await prisma.source.updateMany({ where: { id: sourceId, status: 'segmenting' }, data: { status: 'failed', failedStage: 'segmenting', error: message } })
  }

  if (source.status !== 'segmenting') {
    const ids = await existingTopicIds(sourceId)
    if (source.status !== 'failed' && source.status !== 'uploaded' && source.status !== 'extracting' && ids.length > 0) {
      return { topicIds: ids, stats: { ...emptyStats('reused', source.pageCount ?? 0, source.charCount ?? 0), topics: ids.length, ms: Date.now() - started } }
    }
    throw new Error(`Source ${sourceId} is ${source.status}; segmentation runs only from segmenting`)
  }

  try {
    const file: PagesFile | null = await readPages(source.courseId, source.id)
    if (!file || file.pages.length === 0) throw new StageError('The extracted text of this file is missing. Use Retry, or upload the file again.')
    const pages = file.pages
    const pageChars = pages.map((p) => p.text.length)
    const chars = pageChars.reduce((a, b) => a + b, 0)
    if (chars === 0) throw new StageError('This file has no readable text, so no outline can be built.')

    // Frozen outline: answered exercises exist
    if (await countLogs(sourceId) > 0) {
      const ids = await existingTopicIds(sourceId)
      await prisma.source.updateMany({ where: { id: sourceId, status: 'segmenting' }, data: { status: 'importing_questions', failedStage: null, error: null } })
      return { topicIds: ids, stats: { ...emptyStats('reused', pages.length, chars), topics: ids.length, ms: Date.now() - started } }
    }

    const model = newModelStats()
    const rendered = pages.reduce((n, p) => n + renderedLength(p), 0)
    const outline = await buildOutline(source.originalName, pages, rendered, deps.generate, model)
    const normalized = normalizeSegments(outline.modules, pageChars)
    addLogs(outline.repairs, normalized.repairs)
    if (normalized.modules.length === 0) throw new StageError('The model returned no usable topics for this file. Use Retry.')

    const warnings = [file.warning ?? '']
    if (outline.mergeFallback) warnings.push('The modules were grouped from section hints because the final grouping step failed.')
    const warning = warnings.filter(Boolean).join(' ') || null

    const isPdf = extensionOf(source.storageKey) === '.pdf'
    let committed: SegmentStats | null = null
    const topicIds = await prisma.$transaction(async (tx) => {
      if (await tx.exerciseLog.count({ where: { exercise: { topic: { sourceId } } } }) > 0) {
        throw new StageError('Questions of this file were answered while it was being processed. Use Retry.')
      }
      const old = await tx.topic.findMany({ where: { sourceId }, select: { order: true } })
      let base: number
      if (old.length > 0) {
        base = Math.min(...old.map((t) => t.order))
      } else {
        const agg = await tx.topic.aggregate({ where: { courseId: source.courseId }, _max: { order: true } })
        base = (agg._max.order ?? -1) + 1
      }
      const before = await tx.topic.findMany({
        where: { courseId: source.courseId, NOT: { sourceId }, order: { lt: base }, week: { not: null } }, select: { week: true }, distinct: ['week'],
      })
      const moduleBase = before.filter((t) => t.week && UPLOADED_WEEK_RE.test(t.week)).length

      const plan = planTopicRows(normalized.modules, pages, moduleBase)
      if (old.length > 0) {
        const oldMax = Math.max(...old.map((t) => t.order))
        await tx.topic.deleteMany({ where: { sourceId } })
        const delta = plan.rows.length - old.length
        if (delta !== 0) await tx.topic.updateMany({ where: { courseId: source.courseId, order: { gt: oldMax } }, data: { order: { increment: delta } } })
      }

      const ids: string[] = []
      for (let i = 0; i < plan.rows.length; i++) {
        const r = plan.rows[i]
        await tx.topic.create({
          data: {
            id: r.id, courseId: source.courseId, sourceId, order: base + i, week: r.week, className: source.originalName, unit: r.unit,
            title: r.title, resourceType: isPdf ? 'Uploaded PDF' : 'Uploaded text', content: r.content, localPath: null,
            summary: r.summary, keyTerms: JSON.stringify(r.keyTerms), isQuantitative: r.isQuantitative, pageStart: r.pageStart, pageEnd: r.pageEnd,
          },
        })
        ids.push(r.id)
        if (!r.isStudyMaterial) {
          await tx.exercise.create({
            data: {
              id: `gen-${crypto.randomUUID()}`, topicId: r.id, questionText: '(marker: this topic is not study material)', exerciseType: 'single_choice',
              choices: '[]', correctAnswer: '', isGraded: false, origin: 'generated', status: 'rejected', promptVersion: INGEST_PROMPT_VERSION,
              reportedReason: notStudyMaterialReason(r.title),
            },
          })
        }
      }
      const moved = await tx.source.updateMany({
        where: { id: sourceId, status: 'segmenting' }, data: { status: 'importing_questions', failedStage: null, error: null, warning },
      })
      if (moved.count !== 1) throw new StageError('The file changed while it was being processed. Use Retry.')

      const stats: SegmentStats = {
        mode: outline.mode, pages: pages.length, chars, windows: outline.windows, model, repairs: outline.repairs,
        repairCount: repairCount(outline.repairs), modules: normalized.modules.length, topics: plan.rows.length,
        notStudyTopics: plan.rows.filter((r) => !r.isStudyMaterial).length, keyTermsKept: plan.keyTermsKept,
        keyTermsDropped: plan.keyTermsDropped, oversizedPageParts: plan.oversizedPageParts, mergeFallback: outline.mergeFallback, ms: 0,
      }
      committed = stats
      return ids
    }, { timeout: SEGMENT_TX_TIMEOUT_MS, maxWait: 30_000 })
    return { topicIds, stats: { ...(committed as unknown as SegmentStats), ms: Date.now() - started } }
  } catch (error) {
    const message = error instanceof StageError
      ? error.message
      : 'Something went wrong while building the outline of this file. Use Retry; if it keeps failing, upload the file again.'
    if (!(error instanceof StageError)) console.error(`[segment] source ${sourceId}:`, error)
    await fail(error instanceof StageError && /failed twice/.test(message) ? `${message} Use Retry.` : message)
    throw error
  }
}
