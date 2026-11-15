import { describe, it, expect } from 'vitest'
import { defaultProfile } from '@/lib/studyspace/profile'
import { fitProposalSources, proposeProfilePrompt, profileUpdatePrompt, existingOutline, PROFILE_PROMPT_CAPS, type ProposalOutlineSource } from './profile'

const source = (id: string, topics: number): ProposalOutlineSource => ({
  id,
  name: `${id}.pdf`,
  modules: [{ title: 'Module', topics: Array.from({ length: topics }, (_, i) => ({ title: `Topic ${i} ${'t'.repeat(50)}`, summary: 's'.repeat(400), keyTerms: ['a', 'b', 'c', 'd', 'e', 'f'] })) }],
  samples: ['x'.repeat(4000), 'y'.repeat(4000), 'z'.repeat(4000)],
})

describe('fitProposalSources', () => {
  it('caps summaries, key terms and samples for one file', () => {
    const [f] = fitProposalSources([source('a', 3)])
    expect(f.outline).toContain('[a; b; c; d]')
    expect(f.outline).not.toContain('e;')
    expect(f.outline.split('\n').find((l) => l.startsWith('- '))!.length).toBeLessThan(PROFILE_PROMPT_CAPS.summaryChars + 120)
    expect(f.samples).toHaveLength(PROFILE_PROMPT_CAPS.samplesPerFile)
    expect(f.samples.every((x) => x.length <= PROFILE_PROMPT_CAPS.sampleChars)).toBe(true)
  })

  it('keeps the whole prompt near 24,000 characters for 60 topics and for many files', () => {
    const one = fitProposalSources([source('a', 60)])
    expect(proposeProfilePrompt({ title: 'T', goal: 'g'.repeat(1000), sources: one }).length).toBeLessThan(26_000)
    expect(one[0].outline.length).toBeLessThanOrEqual(PROFILE_PROMPT_CAPS.outlineChars + 40)
    const many = fitProposalSources(Array.from({ length: 12 }, (_, i) => source(`f${i}`, 40)))
    expect(proposeProfilePrompt({ title: 'T', goal: null, sources: many }).length).toBeLessThan(28_000)
  })

  it('drops summaries before it drops topics, and counts the topics it had to leave out', () => {
    const [f] = fitProposalSources([source('a', 60)])
    expect(f.outline).not.toContain('sssss')
    const [g] = fitProposalSources([source('a', 400)])
    expect(g.outline).toMatch(/… and \d+ more topics$/)
  })

  it('tells the model that file text is data', () => {
    const prompt = proposeProfilePrompt({ title: 'T', goal: null, sources: fitProposalSources([source('a', 1)]) })
    expect(prompt).toMatch(/not instructions/)
    expect(prompt).toContain('id="a"')
  })
})


describe('the quantitative flag in the prompts', () => {
  it('both prompts tell the model to judge it from what the files contain, not from the subject, and to say false when they have no calculations', () => {
    const [f] = fitProposalSources([source('a', 2)])
    const initial = proposeProfilePrompt({ title: 'T', goal: null, sources: [f] })
    const update = profileUpdatePrompt({ title: 'T', goal: null, profile: defaultProfile({ title: 'T' }), source: f })
    for (const prompt of [initial, update]) {
      expect(prompt).toMatch(/what the (new )?files? actually contains?/)
      expect(prompt).toMatch(/not from the reputation of the subject/)
      expect(prompt).toMatch(/formulas, worked calculations, numeric exercises/)
      expect(prompt).toMatch(/(has|have) none, "quantitative" is false|file has none, false/)
    }
  })

  it('the update prompt asks for a new sample explanation in the new language when the subject or language changes', () => {
    const [f] = fitProposalSources([source('a', 1)])
    const update = profileUpdatePrompt({ title: 'T', goal: null, profile: defaultProfile({ title: 'T' }), source: f })
    expect(update).toContain('"sampleConcept" and "sampleExplanation"')
    expect(update).toMatch(/new content language/)
  })
})

describe('the update prompt judges the whole studyspace', () => {
  it('lists the existing files, bounded, and states that a new file adds to the studyspace', () => {
    const [f] = fitProposalSources([source('a', 1)])
    const existing = existingOutline([{ name: 'calc.pdf', modules: ['Optimisation', 'Integrals'] }, ...Array.from({ length: 200 }, (_, i) => ({ name: `file${i}.pdf`, modules: ['M'.repeat(60)] }))])
    expect(existing.length).toBeLessThan(3_300)
    expect(existing).toContain('- calc.pdf: Optimisation; Integrals')
    expect(existing).toMatch(/… and \d+ more files/)
    const prompt = profileUpdatePrompt({ title: 'T', goal: null, profile: defaultProfile({ title: 'T' }), source: f, existing })
    expect(prompt).toContain('Files the studyspace already holds')
    expect(prompt).toContain('calc.pdf')
    expect(prompt).toMatch(/ADDS to the studyspace; it does not replace/)
    expect(prompt).toMatch(/whole studyspace including the new file/)
    expect(prompt).toMatch(/never turn "quantitative" off/)
    expect(prompt).toMatch(/single new file in another language does not change "contentLanguage"/)
    expect(profileUpdatePrompt({ title: 'T', goal: null, profile: defaultProfile({ title: 'T' }), source: f })).not.toContain('already holds')
  })
})

describe('written-answer share in the profile prompts', () => {
  const [f] = fitProposalSources([source('a', 2)])
  it('the proposal asks for open about 0.2 (concepts) and 0.1 (calculations), at most 0.3', () => {
    const p = proposeProfilePrompt({ title: 'T', goal: null, sources: [f] })
    expect(p).toMatch(/single_choice, multiple_choice, numeric, dropdown and open/)
    expect(p).toMatch(/about 0\.2 for "questionTypeMix" and about 0\.1 for "quantitativeQuestionTypeMix", never more than 0\.3/)
  })
  it('the update shows the model four shares per mix, without the owner’s open share, and says it is not part of the answer', () => {
    const profile = defaultProfile({ title: 'T' })
    const p = profileUpdatePrompt({ title: 'T', goal: null, profile, source: f })
    const shown = JSON.parse(p.slice(p.indexOf('{\n'), p.indexOf('\n}\n') + 2))
    expect(Object.keys(shown.questionTypeMix)).toEqual(['single_choice', 'multiple_choice', 'numeric', 'dropdown'])
    expect(Object.values(shown.questionTypeMix as Record<string, number>).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10)
    expect(p).toMatch(/written-answer questions are the student's own setting/)
  })
})
