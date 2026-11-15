import { describe, it, expect } from 'vitest'
import { plannerSuggestions, moduleLabelsOf } from './plannerSuggestions'

describe('plannerSuggestions', () => {
  it('is empty without modules', () => {
    expect(plannerSuggestions([])).toEqual([])
  })

  it('names modules of the studyspace and nothing else', () => {
    const s = plannerSuggestions(['01 · Cells', '02 · Genes', '03 · Evolution'])
    expect(s).toHaveLength(3)
    expect(s[0].prompt).toContain('01 · Cells')
    expect(s[1].prompt).toContain('02 · Genes')
    expect(s[2].prompt).toContain('01 · Cells, 02 · Genes and 03 · Evolution')
    for (const x of s) expect(`${x.prompt} ${x.title} ${x.focus}`).not.toMatch(/Sampling|Leaders|Logistics|OLS|Voting/)
  })

  it('works with a single module', () => {
    const s = plannerSuggestions(['Only'])
    expect(s[2].prompt).toBe('Create a complete conceptual review study plan. Cover Only.')
  })
})

describe('moduleLabelsOf', () => {
  it('lists distinct readable modules in order', () => {
    expect(moduleLabelsOf([{ week: 'Week_01_Intro' }, { week: 'Week_01_Intro' }, { week: null }, { week: '02 · B' }])).toEqual(['Week 1 · Intro', '02 · B'])
  })
})
