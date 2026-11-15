import { describe, it, expect } from 'vitest'
import { linkifyFilePaths } from './linkifyFileLinks'

describe('linkifyFilePaths', () => {
  it('uses a preceding [Title] on the previous line as the link text', () => {
    expect(linkifyFilePaths('See:\n[Lecture 3 slides]\n/api/files/topic/abc123 for details'))
      .toBe('See:\n[Lecture 3 slides](/api/files/topic/abc123) for details')
  })

  it('keeps #page and ?highlight and strips sentence punctuation', () => {
    expect(linkifyFilePaths('[Slides] /api/files/topic/t-1#page=4.')).toBe('[Slides](/api/files/topic/t-1#page=4).')
    expect(linkifyFilePaths('/api/files/source/s_9?highlight=gini%20index, then')).toBe('[Open document](/api/files/source/s_9?highlight=gini%20index), then')
  })

  it('links a bare path without a title', () => {
    expect(linkifyFilePaths('Read /api/files/topic/xyz')).toBe('Read [Open document](/api/files/topic/xyz)')
  })

  it('does not touch existing Markdown links, other routes, other hosts, code, or invalid ids', () => {
    const same = [
      '[Slides](/api/files/topic/abc)',
      'see /api/file?path=/etc/passwd',
      '/api/files/summary?session=abc',
      'https://evil.example/api/files/topic/abc',
      'x/api/files/topic/abc',
      'use `/api/files/topic/abc` here',
      '```\n/api/files/topic/abc\n```',
      '/api/files/topic/../../etc/passwd',
      '/api/files/topic/',
    ]
    for (const s of same) expect(linkifyFilePaths(s)).toBe(s)
  })

  it('does not take a title that is separated from the path by other text', () => {
    expect(linkifyFilePaths('[Slides] are at /api/files/topic/abc')).toBe('[Slides] are at [Open document](/api/files/topic/abc)')
  })
})
