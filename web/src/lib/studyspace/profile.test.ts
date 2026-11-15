import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import {
  applyPreset, buildCycleFromMix, capOpenShare, choiceMixOf, setMixShare, defaultProfile, normalizeMix, parseProfile, pickQuestionType, TutorProfileSchema,
  ProfileProposalModelSchema, ProfileProposalSchema, ProfileUpdateModelSchema, QuestionTypeMixModelSchema, QuestionTypeMixChoiceModelSchema, QuestionTypeMixSchema,
} from './profile'
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
    const cycle = buildCycleFromMix({ single_choice: 0.5, numeric: 0.3, multiple_choice: 0.2, dropdown: 0, open: 0 })
    expect(cycle).toHaveLength(10)
    expect(cycle.filter((t) => t === 'single_choice')).toHaveLength(5)
    expect(cycle.filter((t) => t === 'numeric')).toHaveLength(3)
    expect(cycle.filter((t) => t === 'multiple_choice')).toHaveLength(2)
    expect(cycle.slice(0, 3)).toEqual(['single_choice', 'numeric', 'multiple_choice'])
    const p = { ...defaultProfile({ title: 'x' }), questionTypeMix: { single_choice: 1, numeric: 0, multiple_choice: 0, dropdown: 0, open: 0 } }
    expect(pickQuestionType(p, false, 7)).toBe('single_choice')
  })
})

describe('normalizeMix', () => {
  it('scales to 1, ignores bad weights, zeroes numeric on request and falls back when nothing is left', () => {
    const sum = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0)
    const m = normalizeMix({ single_choice: 3, multiple_choice: 1, numeric: -2, dropdown: Number.NaN })
    expect(m).toEqual({ single_choice: 0.75, multiple_choice: 0.25, numeric: 0, dropdown: 0, open: 0 })
    const q = normalizeMix({ single_choice: 1, multiple_choice: 1, numeric: 2, dropdown: 0 }, { noNumeric: true })
    expect(q.numeric).toBe(0)
    expect(sum(q)).toBeCloseTo(1, 10)
    const fb = normalizeMix({}, { noNumeric: true })
    expect(fb.numeric).toBe(0)
    expect(sum(fb)).toBeCloseTo(1, 10)
    expect(normalizeMix({ numeric: 1 }, { noNumeric: true, fallback: { single_choice: 1, multiple_choice: 1, numeric: 0, dropdown: 0, open: 0 } })).toEqual({ single_choice: 0.5, multiple_choice: 0.5, numeric: 0, dropdown: 0, open: 0 })
  })
})

describe('written-answer share (open)', () => {
  // Mixes of HEAD 3853085 (before the fifth type existed). Their cycles are spread evenly since the even-spread change; the counts per type are the same.
  const OLD_DEFAULT_QUALITATIVE = { single_choice: 0.4, multiple_choice: 0.3, numeric: 0, dropdown: 0.3 }
  const OLD_DEFAULT_QUANTITATIVE = { single_choice: 0.2, multiple_choice: 0.2, numeric: 0.5, dropdown: 0.1 }
  const LEGACY_QUALITATIVE = { single_choice: 0.4, multiple_choice: 0.2, numeric: 0, dropdown: 0.4 }
  const LEGACY_QUANTITATIVE = { single_choice: 1 / 6, multiple_choice: 1 / 3, numeric: 1 / 3, dropdown: 1 / 6 }

  it('a stored profile or suggestion mix without `open` parses with open 0', () => {
    const stored = JSON.parse(JSON.stringify(defaultProfile({ title: 'x' })))
    stored.questionTypeMix = OLD_DEFAULT_QUALITATIVE
    stored.quantitativeQuestionTypeMix = OLD_DEFAULT_QUANTITATIVE
    const parsed = parseProfile(JSON.stringify(stored))
    expect(parsed?.questionTypeMix).toEqual({ ...OLD_DEFAULT_QUALITATIVE, open: 0 })
    expect(parsed?.quantitativeQuestionTypeMix).toEqual({ ...OLD_DEFAULT_QUANTITATIVE, open: 0 })
    expect(QuestionTypeMixSchema.parse(LEGACY_QUALITATIVE).open).toBe(0)
  })

  it('with open 0 (or absent) the cycles keep their counts per type and are spread evenly', () => {
    const QUAL_OLD_DEFAULT = ['single_choice', 'multiple_choice', 'dropdown', 'single_choice', 'multiple_choice', 'dropdown', 'single_choice', 'multiple_choice', 'dropdown', 'single_choice']
    const QUANT_OLD_DEFAULT = ['numeric', 'single_choice', 'multiple_choice', 'numeric', 'numeric', 'dropdown', 'numeric', 'single_choice', 'multiple_choice', 'numeric']
    const QUAL_LEGACY_MIX = ['single_choice', 'dropdown', 'multiple_choice', 'single_choice', 'dropdown', 'single_choice', 'dropdown', 'multiple_choice', 'single_choice', 'dropdown']
    const QUANT_LEGACY_MIX = ['numeric', 'multiple_choice', 'single_choice', 'dropdown', 'numeric', 'multiple_choice', 'single_choice', 'dropdown', 'numeric', 'multiple_choice']
    for (const open of [0, undefined]) {
      const w = (m: object) => (open === undefined ? m : { ...m, open }) as never
      expect(buildCycleFromMix(w(OLD_DEFAULT_QUALITATIVE))).toEqual(QUAL_OLD_DEFAULT)
      expect(buildCycleFromMix(w(OLD_DEFAULT_QUANTITATIVE))).toEqual(QUANT_OLD_DEFAULT)
      expect(buildCycleFromMix(w(LEGACY_QUALITATIVE))).toEqual(QUAL_LEGACY_MIX)
      expect(buildCycleFromMix(w(LEGACY_QUANTITATIVE))).toEqual(QUANT_LEGACY_MIX)
    }
    // through a stored profile that has the old mixes and no cycles
    const stored = JSON.parse(JSON.stringify(defaultProfile({ title: 'x' })))
    stored.questionTypeMix = OLD_DEFAULT_QUALITATIVE
    stored.quantitativeQuestionTypeMix = OLD_DEFAULT_QUANTITATIVE
    const p = parseProfile(JSON.stringify(stored))!
    expect(Array.from({ length: 10 }, (_, i) => pickQuestionType(p, false, i))).toEqual(QUAL_OLD_DEFAULT)
    expect(Array.from({ length: 10 }, (_, i) => pickQuestionType(p, true, i))).toEqual(QUANT_OLD_DEFAULT)
  })

  it('spreads every type evenly: counts stay the same and any window of 5 within a cycle is within one question of the mix', () => {
    const mixes = [
      { single_choice: 0.3, multiple_choice: 0.25, numeric: 0, dropdown: 0.25, open: 0.2 },
      { single_choice: 0.2, multiple_choice: 0.15, numeric: 0.45, dropdown: 0.1, open: 0.1 },
      { single_choice: 0.25, multiple_choice: 0.25, numeric: 0, dropdown: 0, open: 0.5 },
      { single_choice: 0.1, multiple_choice: 0.1, numeric: 0.1, dropdown: 0.1, open: 0.6 },
      { single_choice: 0.5, multiple_choice: 0.5, numeric: 0, dropdown: 0, open: 0 },
      { single_choice: 0.4, multiple_choice: 0.3, numeric: 0, dropdown: 0.3, open: 0 },
    ]
    for (const mix of mixes) {
      const cycle = buildCycleFromMix(mix)
      expect(cycle).toHaveLength(10)
      for (let start = 0; start + 5 <= 10; start++) {
        const window = cycle.slice(start, start + 5)
        for (const t of Object.keys(mix) as (keyof typeof mix)[]) {
          expect(Math.abs(window.filter((x) => x === t).length - 5 * mix[t]), `${JSON.stringify(mix)} ${t} @${start}`).toBeLessThanOrEqual(1)
        }
      }
    }
    const half = buildCycleFromMix(mixes[2])
    expect(half.slice(0, 5).filter((t) => t === 'open')).toHaveLength(2)
    expect(buildCycleFromMix(mixes[0]).filter((t) => t === 'open')).toHaveLength(2)
    expect(buildCycleFromMix(mixes[2]).filter((t) => t === 'open')).toHaveLength(5)
  })

  it('the legacy profiles keep their fixed sequences and a 0 open share', () => {
    const quant = ['numeric', 'multiple_choice', 'single_choice', 'numeric', 'multiple_choice', 'dropdown', 'numeric', 'multiple_choice', 'single_choice', 'numeric', 'multiple_choice', 'dropdown']
    const qual = ['single_choice', 'dropdown', 'single_choice', 'multiple_choice', 'dropdown', 'single_choice', 'dropdown', 'single_choice', 'multiple_choice', 'dropdown']
    for (const code of ['14.750x', 'JPAL102x']) {
      const p = LEGACY_PROFILES[code]
      expect(p.questionTypeMix.open).toBe(0)
      expect(p.quantitativeQuestionTypeMix.open).toBe(0)
      expect(Array.from({ length: 12 }, (_, i) => pickQuestionType(p, true, i))).toEqual(quant)
      expect(Array.from({ length: 10 }, (_, i) => pickQuestionType(p, false, i))).toEqual(qual)
    }
  })

  it('the new default mixes carry the planned open shares and put 2 (concepts) and 1 (calculations) of 10 slots on open', () => {
    const d = defaultProfile({ title: 'x' })
    expect(d.questionTypeMix).toEqual({ single_choice: 0.3, multiple_choice: 0.25, numeric: 0, dropdown: 0.25, open: 0.2 })
    expect(d.quantitativeQuestionTypeMix).toEqual({ single_choice: 0.2, multiple_choice: 0.15, numeric: 0.45, dropdown: 0.1, open: 0.1 })
    for (const m of [d.questionTypeMix, d.quantitativeQuestionTypeMix]) expect(Object.values(m).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10)
    const concepts = buildCycleFromMix(d.questionTypeMix)
    expect(concepts).toHaveLength(10)
    expect(concepts.filter((t) => t === 'open')).toHaveLength(2)
    expect(buildCycleFromMix(d.quantitativeQuestionTypeMix).filter((t) => t === 'open')).toHaveLength(1)
    expect(Array.from({ length: 10 }, (_, i) => pickQuestionType(d, false, i)).filter((t) => t === 'open')).toHaveLength(2)
    expect(pickQuestionType({ ...d, questionTypeMix: { single_choice: 0, multiple_choice: 0, numeric: 0, dropdown: 0, open: 1 } }, false, 3)).toBe('open')
  })

  it('normalizeMix keeps the open share and the fallbacks have none', () => {
    expect(normalizeMix({ single_choice: 1, open: 1 })).toEqual({ single_choice: 0.5, multiple_choice: 0, numeric: 0, dropdown: 0, open: 0.5 })
    expect(normalizeMix({}).open).toBe(0)
    expect(normalizeMix({}, { noNumeric: true }).open).toBe(0)
  })

  it('capOpenShare lowers a share above the cap and scales the others into the rest; choiceMixOf drops it', () => {
    const fb = normalizeMix({ single_choice: 1, multiple_choice: 1, dropdown: 2 })
    const capped = capOpenShare({ single_choice: 0.1, multiple_choice: 0.1, numeric: 0, dropdown: 0.1, open: 0.7 }, 0.3, fb)
    expect(capped.open).toBeCloseTo(0.3, 10)
    expect(capped.single_choice).toBeCloseTo(0.7 / 3, 10)
    expect(Object.values(capped).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10)
    expect(capOpenShare({ single_choice: 0.8, multiple_choice: 0, numeric: 0, dropdown: 0, open: 0.2 }, 0.3, fb).open).toBe(0.2)
    // only open: the others take the fallback's proportions
    const allOpen = capOpenShare({ single_choice: 0, multiple_choice: 0, numeric: 0, dropdown: 0, open: 1 }, 0.3, fb)
    expect(allOpen.open).toBeCloseTo(0.3, 10)
    expect(allOpen.dropdown).toBeCloseTo(0.35, 10)
    const four = choiceMixOf({ single_choice: 0.3, multiple_choice: 0.25, numeric: 0, dropdown: 0.25, open: 0.2 })
    expect(Object.keys(four)).toEqual(['single_choice', 'multiple_choice', 'numeric', 'dropdown'])
    expect(four.single_choice).toBeCloseTo(0.375, 10)
    expect(four.multiple_choice).toBeCloseTo(0.3125, 10)
    expect(four.numeric).toBe(0)
  })

  it('the JSON schema of every schema sent to the model has no `default` (and the stored one still has it)', () => {
    const schemas = {
      proposal: ProfileProposalModelSchema,
      update: ProfileUpdateModelSchema,
      mixModel: QuestionTypeMixModelSchema,
      mixChoiceModel: QuestionTypeMixChoiceModelSchema,
    }
    for (const [name, schema] of Object.entries(schemas)) {
      for (const io of ['input', 'output'] as const) {
        const json = JSON.stringify(z.toJSONSchema(schema as z.ZodType, { io }))
        expect(json, `${name} (${io})`).not.toContain('"default"')
      }
    }
    expect(JSON.stringify(z.toJSONSchema(QuestionTypeMixSchema, { io: 'input' }))).toContain('"default"')
    expect(JSON.stringify(z.toJSONSchema(ProfileProposalSchema, { io: 'input' }))).toContain('"default"')
    // the proposal asks for the open share, the update does not
    expect(QuestionTypeMixModelSchema.safeParse({ single_choice: 1, multiple_choice: 0, numeric: 0, dropdown: 0 }).success).toBe(false)
    expect('open' in ProfileUpdateModelSchema.shape.questionTypeMix.shape).toBe(false)
  })
})

describe('setMixShare', () => {
  const pct = (m: Record<string, number>) => Object.values(m).map((v) => Math.round(v * 100))
  const base = { single_choice: 0.3, multiple_choice: 0.3, numeric: 0, dropdown: 0.2, open: 0.2 }
  it('keeps the typed share and scales the others in proportion', () => {
    expect(pct(setMixShare(base, 'single_choice', 40))).toEqual([40, 26, 0, 17, 17])
    expect(pct(setMixShare(base, 'open', 80))).toEqual([8, 7, 0, 5, 80])
    for (const v of [0, 7, 33, 80, 100]) {
      const out = setMixShare(base, 'open', v)
      expect(Math.round(out.open * 100)).toBe(v)
      expect(pct(out).reduce((a, b) => a + b, 0)).toBe(100)
      expect(out.numeric).toBe(0)
    }
  })
  it('clamps, gives the rest to single choice when the others are 0, and keeps numeric 0 when asked', () => {
    expect(setMixShare(base, 'open', 250).open).toBe(1)
    expect(setMixShare(base, 'open', -5).open).toBe(0)
    const onlyOpen = { single_choice: 0, multiple_choice: 0, numeric: 0, dropdown: 0, open: 1 }
    expect(setMixShare(onlyOpen, 'open', 40)).toEqual({ single_choice: 0.6, multiple_choice: 0, numeric: 0, dropdown: 0, open: 0.4 })
    const numericOn = { single_choice: 0.25, multiple_choice: 0.25, numeric: 0.25, dropdown: 0.25, open: 0 }
    expect(setMixShare(numericOn, 'open', 20, { noNumeric: true }).numeric).toBe(0)
    expect(pct(setMixShare(numericOn, 'open', 20, { noNumeric: true })).reduce((a, b) => a + b, 0)).toBe(100)
    // typing into single choice when it is the only share gives the rest to the next type
    expect(setMixShare({ single_choice: 1, multiple_choice: 0, numeric: 0, dropdown: 0, open: 0 }, 'single_choice', 40)).toMatchObject({ single_choice: 0.4, multiple_choice: 0.6 })
  })
})
