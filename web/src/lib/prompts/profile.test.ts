import { describe, it, expect } from 'vitest'
import { fitProposalSources, proposeProfilePrompt, PROFILE_PROMPT_CAPS, type ProposalOutlineSource } from './profile'

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
