import { describe, it, expect } from 'vitest'
import { courseCredit, creditLine, isWrittenByAi } from './attribution'

describe('attribution', () => {
  it('knows the three MITx courses and gives each its MIT Learn run', () => {
    expect(courseCredit('14.740x')).toMatchObject({ title: 'Foundations of Development Policy', run: '3T2026' })
    expect(courseCredit('14.750x')?.url).toContain('course-v1:MITxT+14.750x+2T2026')
    expect(courseCredit('JPAL102x')?.provider).toContain('J-PAL')
    expect(courseCredit('other')).toBeNull()
    expect(courseCredit(null)).toBeNull()
  })
  it('names the source of an imported question and says when the AI wrote the question', () => {
    expect(creditLine('14.740x', 'imported')).toBe('Course material: 14.740x Foundations of Development Policy, MITx (MIT Learn, run 3T2026). Used for personal, non-commercial study.')
    expect(creditLine('14.740x', 'starter')).toContain('This question was written by AI from that material.')
    expect(creditLine('14.740x', 'generated')).toContain('written by AI')
    expect(creditLine('unknown')).toBeNull()
  })
  it('treats generated and starter questions as written by the AI', () => {
    expect(isWrittenByAi('generated')).toBe(true)
    expect(isWrittenByAi('starter')).toBe(true)
    expect(isWrittenByAi('imported')).toBe(false)
    expect(isWrittenByAi(undefined)).toBe(false)
  })
})
