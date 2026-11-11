import { describe, it, expect } from 'vitest'
import { cleanCourseId, dominantCourseId } from './courseScope'

describe('cleanCourseId', () => {
  it('keeps a usable id and treats anything else as no scope', () => {
    expect(cleanCourseId(' c1 ')).toBe('c1')
    expect(cleanCourseId('')).toBeUndefined()
    expect(cleanCourseId('   ')).toBeUndefined()
    expect(cleanCourseId(undefined)).toBeUndefined()
    expect(cleanCourseId(null)).toBeUndefined()
    expect(cleanCourseId(5)).toBeUndefined()
  })
})

describe('dominantCourseId', () => {
  it('picks the course with most entries and breaks ties by first appearance', () => {
    expect(dominantCourseId(['a', 'b', 'b'])).toBe('b')
    expect(dominantCourseId(['a', 'b'])).toBe('a')
    expect(dominantCourseId(['b', 'a'])).toBe('b')
  })
  it('ignores missing courses and returns null when there are none', () => {
    expect(dominantCourseId([null, undefined, 'a'])).toBe('a')
    expect(dominantCourseId([])).toBeNull()
    expect(dominantCourseId([null])).toBeNull()
  })
})
