import { describe, it, expect, vi, beforeEach } from 'vitest'
import { prisma } from '@/lib/db'
import {
  searchTopics,
  extractSearchTerms,
  scoreTopic,
  getCourseVocabulary,
  clearVocabularyCache,
  getPrecedingTopicsContext,
  formatSearchResults,
} from './contextSearch'

vi.mock('@/lib/db', () => ({
  prisma: {
    course: { findUnique: vi.fn() },
    topic: { findMany: vi.fn() },
  },
}))

const findMany = vi.mocked(prisma.topic.findMany)

beforeEach(() => {
  vi.clearAllMocks()
  clearVocabularyCache()
})

describe('extractSearchTerms', () => {
  it('prefers vocabulary terms, then capitalised tokens, then long tokens, and skips stopwords', () => {
    const vocab = new Set(['instrumental variable', 'rdd'])
    const terms = extractSearchTerms('Which of the following Duflo studies used an instrumental variable in microfinance?', vocab)
    expect(terms[0]).toBe('instrumental variable')
    expect(terms).toContain('duflo')
    expect(terms).toContain('microfinance')
    expect(terms).not.toContain('which')
    expect(terms).not.toContain('following')
  })

  it('caps the number of terms at 12', () => {
    const text = Array.from({ length: 40 }, (_, i) => `wordnumber${String.fromCharCode(97 + (i % 26))}${i}`).join(' ')
    expect(extractSearchTerms(text, new Set()).length).toBe(12)
  })

  it('returns nothing for text made of stopwords and short words', () => {
    expect(extractSearchTerms('Which of the following is true?', new Set())).toEqual([])
  })
})

describe('scoreTopic', () => {
  it('weights keyTerms 5, title 3, summary 2 and counts content occurrences up to 10 per term', () => {
    const topic = { title: 'Poverty traps', summary: 'about poverty', keyTerms: '["poverty"]', content: 'poverty '.repeat(25) }
    expect(scoreTopic(topic, ['poverty'])).toBe(5 + 3 + 2 + 10)
    expect(scoreTopic({ title: 'x', content: 'a poverty b' }, ['poverty'])).toBe(1)
  })
})

describe('getCourseVocabulary', () => {
  it('uses keyTerms when present and falls back to title words otherwise; caches for 5 minutes', async () => {
    findMany.mockResolvedValueOnce([{ title: 'Ignored', keyTerms: '["Gini Index"," lorenz curve "]' }] as never)
    const a = await getCourseVocabulary('c1', 1000)
    expect([...a.terms].sort()).toEqual(['gini index', 'lorenz curve'])
    expect(a.topicCount).toBe(1)
    await getCourseVocabulary('c1', 1000 + 4 * 60 * 1000)
    expect(findMany).toHaveBeenCalledTimes(1)

    findMany.mockResolvedValueOnce([{ title: 'Voting systems and Turnout', keyTerms: null }] as never)
    const b = await getCourseVocabulary('c2')
    expect([...b.terms].sort()).toEqual(['systems', 'turnout', 'voting'])
  })
})

describe('searchTopics', () => {
  const row = (id: string, p: Partial<{ title: string; week: string | null; content: string; summary: string | null; keyTerms: string | null; resourceType: string | null }> = {}) => ({
    id,
    title: p.title ?? id,
    week: p.week === undefined ? 'W1' : p.week,
    resourceType: p.resourceType ?? 'Transcript .txt',
    content: p.content ?? '',
    summary: p.summary ?? null,
    keyTerms: p.keyTerms ?? null,
  })

  it('ranks by keyTerms/title/summary/content score, best first, and honours limit', async () => {
    findMany.mockResolvedValueOnce([{ title: 'x', keyTerms: '["inflation"]' }] as never) // vocabulary
    findMany.mockResolvedValueOnce([
      row('content-only', { content: 'some inflation here' }),
      row('title-hit', { title: 'Inflation basics' }),
      row('keyterm-hit', { keyTerms: '["inflation"]' }),
      row('summary-hit', { summary: 'on inflation' }),
    ] as never)
    const res = await searchTopics('c1', 'What causes inflation?', { limit: 3 })
    expect(res.map((r) => r.id)).toEqual(['keyterm-hit', 'title-hit', 'summary-hit'])
    expect(res[0].score).toBeGreaterThan(res[1].score)
  })

  it('queries the course with contains over title, summary, keyTerms and content, and skips crawl-error rows', async () => {
    findMany.mockResolvedValueOnce([] as never)
    findMany.mockResolvedValueOnce([] as never)
    await searchTopics('c1', 'Acemoglu and Robinson on institutions')
    const where = (findMany.mock.calls[1][0] as { where: Record<string, unknown> }).where as { courseId: string; OR: Record<string, unknown>[]; AND: unknown[] }
    expect(where.courseId).toBe('c1')
    expect(where.OR).toContainEqual({ content: { contains: 'acemoglu' } })
    expect(where.OR).toContainEqual({ title: { contains: 'robinson' } })
    expect(JSON.stringify(where.AND)).toContain('Error')
  })

  it('excludes the given weeks, truncates content and returns [] without terms', async () => {
    findMany.mockResolvedValueOnce([] as never)
    findMany.mockResolvedValueOnce([
      row('review', { week: 'Review', content: 'tariffs tariffs' }),
      row('big', { week: 'W2', content: 'tariffs ' + 'x'.repeat(100) }),
    ] as never)
    const res = await searchTopics('c1', 'Explain tariffs', { excludeWeeks: ['Review'], maxCharsPerTopic: 20 })
    expect(res.map((r) => r.id)).toEqual(['big'])
    expect(res[0].content.endsWith('... [TRUNCATED]')).toBe(true)

    findMany.mockClear()
    expect(await searchTopics('c1', 'Which of the following is true?')).toEqual([])
    expect(findMany).not.toHaveBeenCalled() // vocabulary cached; no topic query without terms
  })

  it('drops terms that occur in more than 20% of the topics of a large course and weights rare terms higher', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ title: `t${i}`, keyTerms: null }))
    findMany.mockResolvedValueOnce(many as never) // vocabulary: 30 topics
    findMany.mockResolvedValueOnce([
      ...Array.from({ length: 10 }, (_, i) => row(`common${i}`, { content: 'economy economy' })),
      row('rare', { content: 'economy olken' }),
    ] as never)
    const res = await searchTopics('c1', 'economy Olken')
    expect(res.map((r) => r.id)).toEqual(['rare']) // "economy" is in 11/30 topics, dropped; only the Olken topic scores
  })

  it('formats results with source labels', () => {
    expect(formatSearchResults([{ id: 'a', title: 'T', week: 'W1', resourceType: 'Slides', content: 'body', score: 1 }])).toBe('[Source: W1 - T (Slides)]\nbody')
  })
})

describe('getPrecedingTopicsContext', () => {
  const t = (id: string, className: string | null, content: string, order: number) => ({ id, title: `Title ${id}`, content, week: 'W1', className, order })
  const anchor = { id: 'q', courseId: 'c1', week: 'W1', order: 100, className: 'Class B' }

  it('walks back class by class and returns the nearest class with enough text, oldest first', async () => {
    findMany.mockResolvedValueOnce([
      t('b2', 'Class B', 'tiny', 90),
      t('a2', 'Class A', 'x'.repeat(30), 80),
      t('a1', 'Class A', 'y'.repeat(30), 70),
    ] as never)
    const text = await getPrecedingTopicsContext(anchor)
    expect(text).toBe(`Topic: Title a1\nTranscript:\n${'y'.repeat(30)}\n\nTopic: Title a2\nTranscript:\n${'x'.repeat(30)}`)
    const call = findMany.mock.calls[0][0] as { orderBy: unknown; where: unknown }
    expect(call.orderBy).toEqual({ order: 'desc' })
    const where = JSON.stringify(call.where)
    expect(where).toContain('"order":{"lt":100}')
    expect(where).toContain('Transcript')
    expect(where).toContain('"week":"W1"')
  })

  it('falls back to earlier modules when the module itself has nothing, and returns null when no scope has text', async () => {
    findMany.mockResolvedValueOnce([] as never)
    findMany.mockResolvedValueOnce([{ ...t('p1', null, 'z'.repeat(60), 5), week: 'W0' }] as never)
    expect(await getPrecedingTopicsContext(anchor)).toContain('Topic: Title p1')
    expect(findMany).toHaveBeenCalledTimes(2)

    findMany.mockReset()
    findMany.mockResolvedValue([] as never)
    expect(await getPrecedingTopicsContext(anchor)).toBeNull()
  })

  it('treats topics without className as separate classes', async () => {
    findMany.mockResolvedValueOnce([t('u2', null, 'short', 90), t('u1', null, 'w'.repeat(80), 80)] as never)
    const text = await getPrecedingTopicsContext({ courseId: 'c1', week: 'W1', order: 100 })
    expect(text).toBe(`Topic: Title u1\nTranscript:\n${'w'.repeat(80)}`)
  })
})
