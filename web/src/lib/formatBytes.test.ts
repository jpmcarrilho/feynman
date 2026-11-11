import { describe, it, expect } from 'vitest'
import { formatBytes } from './formatBytes'

describe('formatBytes', () => {
  it('uses KB for small files, MB with one decimal, and whole MB from 10 MB', () => {
    expect(formatBytes(10)).toBe('1 KB')
    expect(formatBytes(51_200)).toBe('50 KB')
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB')
    expect(formatBytes(50 * 1024 * 1024)).toBe('50 MB')
  })
})
