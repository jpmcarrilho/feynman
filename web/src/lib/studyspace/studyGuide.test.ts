import { describe, it, expect } from 'vitest'
import { studyGuideBlurb } from './studyGuide'
import { LEGACY_PROFILES } from './legacyProfiles'

describe('studyGuideBlurb', () => {
  it('keeps the old wording for the imported studyspaces', () => {
    for (const p of Object.values(LEGACY_PROFILES)) {
      expect(studyGuideBlurb(p.subject)).toBe('A structured, concept-demystifying lecture summary compiling the core intuitive economics and policy models, analogies, common pitfalls, and formulas using the Feynman style.')
    }
  })
  it('names the subject of other studyspaces and never says economics', () => {
    expect(studyGuideBlurb('Organic chemistry')).toContain('core Organic chemistry concepts')
    expect(studyGuideBlurb('Organic chemistry')).not.toMatch(/economics/)
    expect(studyGuideBlurb('')).not.toMatch(/economics|undefined/)
    expect(studyGuideBlurb(null)).toContain('core concepts')
  })
})
