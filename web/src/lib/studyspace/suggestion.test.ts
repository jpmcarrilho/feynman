import { describe, it, expect } from 'vitest'
import { defaultProfile, type ProfileSuggestion } from './profile'
import { describeMix, fieldChanged, parseSuggestion, parseUpdateSuggestion, profileChanges, sameDomains, sameMix } from './suggestion'

const base = { ...defaultProfile({ title: 'T' }), subject: 'Chemistry', analogyDomains: ['cooking', 'lego'] }
const stored = (over: Partial<ProfileSuggestion> = {}) => JSON.stringify({
  kind: 'update', createdAt: '2026-11-12T10:00:00.000Z', basedOnSourceIds: [], profile: base, rationale: 'r', excludedSources: [], split: null, ...over,
})

describe('parseSuggestion / parseUpdateSuggestion', () => {
  it('return null for nothing, for invalid JSON and for an invalid suggestion', () => {
    expect(parseSuggestion(null)).toBeNull()
    expect(parseSuggestion('{')).toBeNull()
    expect(parseSuggestion('{"kind":"update"}')).toBeNull()
  })
  it('parseUpdateSuggestion keeps only updates', () => {
    expect(parseUpdateSuggestion(stored())?.kind).toBe('update')
    expect(parseUpdateSuggestion(stored({ kind: 'initial' }))).toBeNull()
  })
})

describe('profileChanges', () => {
  it('lists changed fields only, with readable old and new values', () => {
    const next = { ...base, level: 'graduate' as const, quantitative: true, questionTypeMix: { single_choice: 0.5, multiple_choice: 0, numeric: 0.5, dropdown: 0 } }
    expect(profileChanges(base, next)).toEqual([
      { field: 'level', label: 'Level', from: 'Undergraduate', to: 'Graduate' },
      { field: 'quantitative', label: 'Quantitative material', from: 'no', to: 'yes' },
      { field: 'questionTypeMix', label: 'Question types (concepts)', from: 'single choice 40%, multiple choice 30%, dropdown 30%', to: 'single choice 50%, numeric 50%' },
    ])
  })
  it('lists a changed sample explanation as "updated" without the text', () => {
    const next = { ...base, sampleExplanation: { concept: 'Entropia', explanation: 'Uma explicação nova.' } }
    expect(profileChanges(base, next)).toEqual([{ field: 'sampleExplanation', label: 'Sample explanation', from: null, to: 'updated' }])
  })
  it('ignores fields the owner owns (tone, notes, chat mode, calibration module, exam preset)', () => {
    const next = { ...base, tone: 'patient_coach' as const, toneNotes: 'x', defaultChatMode: 'explain' as const, calibrationModule: 'm', examPreset: { label: 'E', questionCount: 3 } }
    expect(profileChanges(base, next)).toEqual([])
  })
  it('does not count spacing, case, order of domains or a rounding of the shares as a change', () => {
    expect(sameDomains(['cooking', 'Lego'], [' lego', 'COOKING'])).toBe(true)
    expect(sameDomains(['cooking'], ['cooking', 'lego'])).toBe(false)
    expect(sameMix(base.questionTypeMix, { ...base.questionTypeMix, single_choice: 0.4004 })).toBe(true)
    expect(fieldChanged('subject', base, { ...base, subject: '  Chemistry ' })).toBe(false)
    expect(describeMix({ single_choice: 0, multiple_choice: 0, numeric: 0, dropdown: 0 })).toBe('none')
  })
})
