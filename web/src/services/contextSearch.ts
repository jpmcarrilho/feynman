import { prisma } from '@/lib/db'
import { getProfileForCourse } from '@/services/studyspaceService'

/**
 * Context lookups over the topics of one studyspace. They replace the hard-coded author/term list,
 * the outline JSON file and the "comprehensive review" string match that the two MIT courses used.
 */

const VOCABULARY_TTL_MS = 5 * 60 * 1000
const MAX_TERMS = 12
const DEFAULT_LIMIT = 10
const DEFAULT_MAX_CHARS_PER_TOPIC = 50_000
// Safety bound on rows read per call. Prisma cannot order by relevance, so this should never be the
// thing that decides the ranking; the term filters keep real queries far below it.
const CANDIDATE_CAP = 2000
const DEFAULT_MAX_DOC_FRACTION = 0.2
const MIN_TOPICS_FOR_DF_PRUNING = 20
const MIN_PRECEDING_CHARS = 50
const PRECEDING_BATCH = 40

// Words that are common in question text and say nothing about the subject.
const STOPWORDS = new Set(
  `about above according across actually after again against all also although always among another answer answers any are around assume assuming
  because been before being below between both but can cannot choose choices clearly consider considering correct could describe described describes does doing during each either else
  enough every example exercise explain figure first following for from further given has have having here however how into its itself just know last least less like likely made make many
  may might more most much must need next none not note now often once only options other our out over own part per perhaps please possible question questions rather really refer refers
  relevant remains result results said same select several shall should show shown shows since some such suppose statement statements table than that the their them then there therefore these they this those
  though through thus under until upon use used uses using very was were what when where whether which while who whom whose why will with within without would yes you your
  according answer answers choose correct following select statement true false which what
  above below earlier later video lecture lectures slides slide transcript week module unit reading
  graded point points possible displayed fill blank blanks hint hints yourself remind review problem problems part parts true false apply
  submit submitted attempt attempts discussion topic
  another because between different during following however includes including instead overall
  students student study studies thing things
  `
    .split(/\s+/)
    .filter(Boolean),
)

export function isStopword(word: string): boolean {
  return STOPWORDS.has(word.toLowerCase())
}

const TOKEN_RE = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu

function tokenize(text: string): string[] {
  return text.match(TOKEN_RE) ?? []
}

function cleanToken(token: string): string {
  return token.replace(/['’-]+$/g, '').replace(/['’]s$/i, '')
}

/**
 * Candidate search terms for a text: vocabulary terms that occur in it, then capitalised tokens, then tokens
 * of length >= 6, skipping stopwords. Lowercased, unique, at most MAX_TERMS.
 */
export function extractSearchTerms(text: string, vocabulary: ReadonlySet<string>, maxTerms: number = MAX_TERMS): string[] {
  const lower = text.toLowerCase()
  const out: string[] = []
  const seen = new Set<string>()
  const add = (term: string) => {
    if (term.length < 3 || seen.has(term) || out.length >= maxTerms) return
    seen.add(term)
    out.push(term)
  }

  // 1. Vocabulary terms present in the text; longest (most specific) first.
  const vocabHits = [...vocabulary].filter((v) => v.length >= 3 && !isStopword(v) && lower.includes(v)).sort((a, b) => b.length - a.length)
  for (const v of vocabHits) add(v)

  // 2. Capitalised tokens (names, acronyms); 3. long tokens.
  const tokens = tokenize(text).map(cleanToken).filter((t) => t.length >= 3)
  for (const t of tokens) {
    if (/^\p{Lu}/u.test(t) && !isStopword(t)) add(t.toLowerCase())
  }
  const longTokens = tokens
    .filter((t) => t.length >= 6 && !isStopword(t))
    .map((t) => t.toLowerCase())
    .sort((a, b) => b.length - a.length)
  for (const t of longTokens) add(t)
  return out
}

type VocabularyEntry = { terms: Set<string>; topicCount: number; expires: number }
const vocabularyCache = new Map<string, VocabularyEntry>()

export function clearVocabularyCache(): void {
  vocabularyCache.clear()
}

function parseKeyTerms(json: string | null | undefined): string[] {
  if (!json) return []
  try {
    const raw: unknown = JSON.parse(json)
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/**
 * Union of all keyTerms of a course (lowercase); for courses without keyTerms, the words of the topic titles.
 * Also the number of topics. Cached 5 minutes.
 */
export async function getCourseVocabulary(courseId: string, now: number = Date.now()): Promise<{ terms: Set<string>; topicCount: number }> {
  const cached = vocabularyCache.get(courseId)
  if (cached && cached.expires > now) return cached
  const rows = await prisma.topic.findMany({ where: { courseId }, select: { title: true, keyTerms: true } })
  const terms = new Set<string>()
  for (const r of rows) for (const k of parseKeyTerms(r.keyTerms)) if (k.trim()) terms.add(k.trim().toLowerCase())
  if (terms.size === 0) {
    for (const r of rows) {
      for (const w of tokenize(r.title ?? '').map(cleanToken)) {
        const lw = w.toLowerCase()
        if (lw.length >= 5 && !isStopword(lw)) terms.add(lw)
      }
    }
  }
  const entry = { terms, topicCount: rows.length, expires: now + VOCABULARY_TTL_MS }
  vocabularyCache.set(courseId, entry)
  return entry
}

function countOccurrences(haystackLower: string, needle: string, cap: number): number {
  let n = 0
  let from = 0
  while (n < cap) {
    const i = haystackLower.indexOf(needle, from)
    if (i === -1) break
    n++
    from = i + needle.length
  }
  return n
}

export type ScorableTopic = { title: string; summary?: string | null; keyTerms?: string | null; content?: string | null }

/**
 * +5 per term in keyTerms, +3 in title, +2 in summary, +1 per occurrence in content (cap 10 per term).
 * `weights` (optional, default 1) scales each term, used to favour rare terms over common ones.
 */
export function scoreTopic(topic: ScorableTopic, terms: string[], weights?: ReadonlyMap<string, number>): number {
  const title = (topic.title ?? '').toLowerCase()
  const summary = (topic.summary ?? '').toLowerCase()
  const keyTerms = (topic.keyTerms ?? '').toLowerCase()
  const content = (topic.content ?? '').toLowerCase()
  let score = 0
  for (const t of terms) {
    let s = 0
    if (keyTerms.includes(t)) s += 5
    if (title.includes(t)) s += 3
    if (summary.includes(t)) s += 2
    s += countOccurrences(content, t, 10)
    score += s * (weights?.get(t) ?? 1)
  }
  return score
}

export type SearchTopicResult = {
  id: string
  title: string
  week: string | null
  resourceType: string | null
  content: string
  score: number
}

export type SearchTopicsOptions = {
  limit?: number
  maxCharsPerTopic?: number
  /** Topic.week values left out of the result (the calibration module, so style examples are not echoed back). */
  excludeWeeks?: string[]
  /**
   * Terms found in more than this fraction of the course's topics are ignored as too common to say anything
   * (default 0.2). Not applied to courses with fewer than 20 topics.
   */
  maxDocFraction?: number
}

/** Topics of the course that best match the text, best first. Empty when the text yields no terms or nothing matches. */
export async function searchTopics(courseId: string, queryText: string, opts: SearchTopicsOptions = {}): Promise<SearchTopicResult[]> {
  const limit = opts.limit ?? DEFAULT_LIMIT
  const maxChars = opts.maxCharsPerTopic ?? DEFAULT_MAX_CHARS_PER_TOPIC
  const exclude = new Set(opts.excludeWeeks ?? [])
  if (!queryText.trim()) return []

  const { terms: vocabulary, topicCount } = await getCourseVocabulary(courseId)
  const terms = extractSearchTerms(queryText, vocabulary)
  if (terms.length === 0) return []

  const rows = await prisma.topic.findMany({
    where: {
      courseId,
      // Crawl failures (resourceType "... Error") hold binary garbage that matches every term
      AND: [{ OR: [{ resourceType: null }, { NOT: { resourceType: { contains: 'Error' } } }] }],
      OR: terms.flatMap((t) => [
        { title: { contains: t } },
        { summary: { contains: t } },
        { keyTerms: { contains: t } },
        { content: { contains: t } },
      ]),
    },
    select: { id: true, title: true, week: true, resourceType: true, content: true, summary: true, keyTerms: true },
    take: CANDIDATE_CAP,
  })

  // Every topic containing a term is in `rows` (unless the cap was hit), so document frequency is exact here.
  // Terms in more than maxDocFraction of the topics are dropped; the rest are weighted 1 + ln(N / df) so a rare
  // name (an author, a model) outweighs a common word.
  let usable = terms
  const weights = new Map<string, number>()
  if (topicCount >= MIN_TOPICS_FOR_DF_PRUNING) {
    const maxDf = (opts.maxDocFraction ?? DEFAULT_MAX_DOC_FRACTION) * topicCount
    const haystacks = rows.map((r) => `${r.title}\n${r.summary ?? ''}\n${r.keyTerms ?? ''}\n${r.content ?? ''}`.toLowerCase())
    const df = new Map(terms.map((t) => [t, haystacks.reduce((n, h) => n + (h.includes(t) ? 1 : 0), 0)]))
    usable = terms.filter((t) => (df.get(t) ?? 0) <= maxDf)
    if (usable.length === 0) return []
    for (const t of usable) weights.set(t, 1 + Math.log(topicCount / Math.max(1, df.get(t) ?? 1)))
  }

  return rows
    .filter((r) => !(r.week != null && exclude.has(r.week)))
    .map((r) => ({ r, score: scoreTopic(r, usable, weights) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ r, score }) => {
      let content = r.content || ''
      if (content.length > maxChars) content = content.slice(0, maxChars) + '... [TRUNCATED]'
      return { id: r.id, title: r.title, week: r.week, resourceType: r.resourceType, content, score }
    })
}

/** Search results as the labelled text block the prompts expect. */
export function formatSearchResults(results: SearchTopicResult[]): string {
  return results
    .map((t) => `[Source: ${t.week} - ${t.title} (${t.resourceType})]\n${t.content}`)
    .join('\n\n=========================================\n\n')
}

/** Search context for a text, leaving out the course's calibration module. '' when nothing matches. */
export async function getGlobalContext(courseId: string, text: string): Promise<string> {
  const profile = await getProfileForCourse(courseId)
  const results = await searchTopics(courseId, text, { excludeWeeks: profile.calibrationModule ? [profile.calibrationModule] : [] })
  return formatSearchResults(results)
}

export type PrecedingAnchor = {
  id?: string
  courseId: string
  week: string | null
  order: number
  className?: string | null
}

const PRECEDING_SELECT = { id: true, title: true, content: true, week: true, className: true, order: true } as const

/**
 * Transcript-style text of the lectures that come before a topic. Same course, earlier `order`, same module first,
 * then earlier modules. Only topics that look like lecture content (resourceType contains "Transcript", or uploaded
 * from a source) count. Walks backwards one class at a time (topics sharing a className are one class; a topic without
 * className is its own class) and returns the first class with more than MIN_PRECEDING_CHARS of text.
 * Output format: "Topic: <title>\nTranscript:\n<content>" blocks joined by a blank line. null when nothing is found.
 */
export async function getPrecedingTopicsContext(topic: PrecedingAnchor): Promise<string | null> {
  const preferred = { OR: [{ resourceType: { contains: 'Transcript' } }, { sourceId: { not: null } }] }
  const before = { courseId: topic.courseId, order: { lt: topic.order }, ...(topic.id ? { id: { not: topic.id } } : {}) }
  const scopes: Record<string, unknown>[] = []
  if (topic.week != null) {
    scopes.push({ AND: [before, preferred, { week: topic.week }] })
    scopes.push({ AND: [before, preferred, { OR: [{ week: { not: topic.week } }, { week: null }] }] })
  } else {
    scopes.push({ AND: [before, preferred] })
  }

  for (const where of scopes) {
    const candidates = await prisma.topic.findMany({
      where: where as never,
      orderBy: { order: 'desc' },
      take: PRECEDING_BATCH,
      select: PRECEDING_SELECT,
    })
    // Group candidates (already newest first) into classes, keeping the walk-back order.
    const classes: (typeof candidates)[] = []
    for (const c of candidates) {
      const last = classes[classes.length - 1]
      if (c.className != null && last && last[0].className === c.className) last.push(c)
      else classes.push([c])
    }
    for (const cls of classes) {
      const text = [...cls]
        .reverse()
        .map((t) => `Topic: ${t.title}\nTranscript:\n${t.content || ''}`)
        .join('\n\n')
      if (text.trim().length >= MIN_PRECEDING_CHARS) return text
    }
  }
  return null
}
