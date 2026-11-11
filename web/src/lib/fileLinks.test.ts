import { describe, it, expect } from 'vitest'
import {
  parseFileLink, topicFileLink, sourceFileLink, summaryLink, sessionSummaryLink, isValidSummaryKey, isValidFileId,
} from './fileLinks'

const ORIGIN = 'http://localhost:3000'

describe('link builders', () => {
  it('build the canonical forms', () => {
    expect(topicFileLink('abc-1')).toBe('/api/files/topic/abc-1')
    expect(topicFileLink('abc-1', { page: 5 })).toBe('/api/files/topic/abc-1#page=5')
    expect(topicFileLink('abc-1', { highlight: 'a b&c' })).toBe('/api/files/topic/abc-1?highlight=a%20b%26c')
    expect(sourceFileLink('s1', { page: 2 })).toBe('/api/files/source/s1#page=2')
    expect(summaryLink('c1', 'Week_01')).toBe('/api/files/summary?course=c1&key=Week_01')
    expect(sessionSummaryLink('s-9')).toBe('/api/files/summary?session=s-9')
  })
})

describe('parseFileLink', () => {
  it('parses topic links with page and highlight', () => {
    expect(parseFileLink('/api/files/topic/t-1#page=15', ORIGIN)).toEqual({ url: '/api/files/topic/t-1', page: 15, highlight: null, kind: 'topic' })
    expect(parseFileLink('/api/files/topic/t-1?highlight=does%20not%20change', ORIGIN)).toEqual({
      url: '/api/files/topic/t-1', page: null, highlight: 'does not change', kind: 'topic',
    })
  })

  it('parses source links', () => {
    expect(parseFileLink(`${ORIGIN}/api/files/source/src_1#page=3`, ORIGIN)).toEqual({ url: '/api/files/source/src_1', page: 3, highlight: null, kind: 'source' })
  })

  it('parses summary links (module and session)', () => {
    expect(parseFileLink('/api/files/summary?course=c1&key=Week_01.md', ORIGIN)).toEqual({
      url: '/api/files/summary?course=c1&key=Week_01.md', page: null, highlight: null, kind: 'summary',
    })
    expect(parseFileLink('/api/files/summary?session=abc-123', ORIGIN)?.url).toBe('/api/files/summary?session=abc-123')
  })

  it('parses legacy links, keeping the path and dropping hash and highlight', () => {
    const p = '/Users/x/MIT/Slides.pdf'
    const link = parseFileLink(`/api/file?path=${encodeURIComponent(p)}#page=7`, ORIGIN)
    expect(link).toEqual({ url: `/api/file?path=${encodeURIComponent(p)}`, page: 7, highlight: null, kind: 'legacy' })
    const hl = parseFileLink(`/api/file?path=${encodeURIComponent(p)}&highlight=a%20b`, ORIGIN)
    expect(hl?.highlight).toBe('a b')
    expect(hl?.url).toBe(`/api/file?path=${encodeURIComponent(p)}`)
  })

  it('rejects other links, other origins and malformed ids', () => {
    expect(parseFileLink('https://example.com/x', ORIGIN)).toBeNull()
    expect(parseFileLink('https://evil.test/api/files/topic/t-1', ORIGIN)).toBeNull()
    expect(parseFileLink('/api/files/topic/a%2Fb', ORIGIN)).toBeNull()
    expect(parseFileLink('/api/files/topic/..', ORIGIN)).toBeNull()
    expect(parseFileLink('/api/files/summary?course=c1&key=../x', ORIGIN)).toBeNull()
    expect(parseFileLink('/api/files/summary?course=c1', ORIGIN)).toBeNull()
    expect(parseFileLink('/api/file', ORIGIN)).toBeNull()
    expect(parseFileLink('/other', ORIGIN)).toBeNull()
    expect(parseFileLink('', ORIGIN)).toBeNull()
  })
})

describe('validators', () => {
  it('summary keys reject traversal and directories', () => {
    for (const bad of ['../x', 'a/b', 'a\\b', '..', '.', '.hidden', '', 'x'.repeat(121), 'a b', 'a%2Fb']) {
      expect(isValidSummaryKey(bad), bad).toBe(false)
    }
    for (const ok of ['Week_01', 'Week_01_Intro.md', '14.750x', 'a-b_c.d']) expect(isValidSummaryKey(ok), ok).toBe(true)
  })

  it('ids accept uuids and reject separators', () => {
    expect(isValidFileId('000eb8c9-717a-400a-9dd9-f1559a72d722')).toBe(true)
    expect(isValidFileId('a/b')).toBe(false)
    expect(isValidFileId('')).toBe(false)
  })
})
