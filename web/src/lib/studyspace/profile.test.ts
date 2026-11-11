import { describe, it, expect } from 'vitest'
import { applyPreset, buildCycleFromMix, defaultProfile, parseProfile, pickQuestionType, TutorProfileSchema } from './profile'
import { LEGACY_PROFILES } from './legacyProfiles'

describe('parseProfile', () => {
  it('rejects garbage', () => {
    expect(parseProfile(null)).toBeNull()
    expect(parseProfile('')).toBeNull()
    expect(parseProfile('not json')).toBeNull()
    expect(parseProfile('{}')).toBeNull()
    expect(parseProfile(JSON.stringify({ version: 2 }))).toBeNull()
  })

  it('accepts both legacy profiles after a JSON round trip', () => {
    for (const code of ['14.750x', 'JPAL102x']) {
      const parsed = parseProfile(JSON.stringify(LEGACY_PROFILES[code]))
      expect(parsed).not.toBeNull()
      expect(parsed?.version).toBe(1)
    }
    expect(LEGACY_PROFILES['14.750x'].calibrationModule).toBe('Week_13_Comprehensive_Review')
    expect(LEGACY_PROFILES['JPAL102x'].examPreset).toEqual({ label: 'JPAL102x Final', questionCount: 53 })
  })

  it('defaultProfile validates and applyPreset swaps tone notes', () => {
    const p = defaultProfile({ title: 'Organic chemistry' })
    expect(TutorProfileSchema.safeParse(p).success).toBe(true)
    const q = applyPreset(p, 'exam_driller')
    expect(q.tone).toBe('exam_driller')
    expect(q.toneNotes).toMatch(/Exam-style/)
  })
})

describe('pickQuestionType', () => {
  const quant = ['numeric', 'multiple_choice', 'single_choice', 'numeric', 'multiple_choice', 'dropdown']
  const qual = ['single_choice', 'dropdown', 'single_choice', 'multiple_choice', 'dropdown']

  it('reproduces both legacy cycles for existingCount 0..11', () => {
    for (const code of ['14.750x', 'JPAL102x']) {
      const p = LEGACY_PROFILES[code]
      for (let n = 0; n <= 11; n++) {
        expect(pickQuestionType(p, true, n)).toBe(quant[n % quant.length])
        expect(pickQuestionType(p, false, n)).toBe(qual[n % qual.length])
      }
    }
  })

  it('builds a deterministic 10-slot cycle from a mix when no override is set', () => {
    const cycle = buildCycleFromMix({ single_choice: 0.5, numeric: 0.3, multiple_choice: 0.2, dropdown: 0 })
    expect(cycle).toHaveLength(10)
    expect(cycle.filter((t) => t === 'single_choice')).toHaveLength(5)
    expect(cycle.filter((t) => t === 'numeric')).toHaveLength(3)
    expect(cycle.filter((t) => t === 'multiple_choice')).toHaveLength(2)
    expect(cycle.slice(0, 3)).toEqual(['single_choice', 'numeric', 'multiple_choice'])
    const p = { ...defaultProfile({ title: 'x' }), questionTypeMix: { single_choice: 1, numeric: 0, multiple_choice: 0, dropdown: 0 } }
    expect(pickQuestionType(p, false, 7)).toBe('single_choice')
  })
})

describe('normalizeMix', () => {
  it('scales to 1, ignores bad weights, zeroes numeric on request and falls back when nothing is left', async () => {
    const { normalizeMix } = await import('./profile')
    const sum = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0)
    const m = normalizeMix({ single_choice: 3, multiple_choice: 1, numeric: -2, dropdown: Number.NaN })
    expect(m).toEqual({ single_choice: 0.75, multiple_choice: 0.25, numeric: 0, dropdown: 0 })
    const q = normalizeMix({ single_choice: 1, multiple_choice: 1, numeric: 2, dropdown: 0 }, { noNumeric: true })
    expect(q.numeric).toBe(0)
    expect(sum(q)).toBeCloseTo(1, 10)
    const fb = normalizeMix({}, { noNumeric: true })
    expect(fb.numeric).toBe(0)
    expect(sum(fb)).toBeCloseTo(1, 10)
    expect(normalizeMix({ numeric: 1 }, { noNumeric: true, fallback: { single_choice: 1, multiple_choice: 1, numeric: 0, dropdown: 0 } })).toEqual({ single_choice: 0.5, multiple_choice: 0.5, numeric: 0, dropdown: 0 })
  })
})
