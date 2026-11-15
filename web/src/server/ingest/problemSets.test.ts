import { describe, it, expect, vi } from 'vitest'
vi.mock('@ai-sdk/google', () => ({ google: vi.fn(() => 'mocked-google-model') }))
import { checkProposal, stemCoverage, proposeProblemSets, renderUnit, ProblemSetsSchema, normalizeDisplayMath } from './problemSets'
import { edxCandidates } from './importQuestions'
import { newModelStats, StageError } from './modelCall'

const HANDOUT = `Homework Assignment. This assignment is motivated by research on tax collectors in Pakistan. A citizen pays a bribe b to a collector. The collector reports a value tau to the government while the true value is tau star. Reporting less than the true value is lying.`
const QUESTIONS = [
  '# Question\nWhat is the citizen payoff if the collector reports truthfully?\n\n## Choices\n- [x] A\n- [ ] B\n\n## Explanation/Solution\nExplanation\n\nBecause.',
  '# Question\nWhat is the collector payoff if the collector reports truthfully?\n\n## Choices\n- [x] A\n- [ ] B\n\n## Explanation/Solution\nExplanation\n\nBecause.',
  '# Question\nWhich is a fruit?\n\n## Choices\n- [x] Apple\n- [ ] Rock\n\n## Explanation/Solution\nExplanation\n\nBecause.',
]
const STEM = 'A citizen pays a bribe $b$ to a collector. The collector reports a value $\\tau$ to the government while the true value is $\\tau^*$. Reporting less than the true value is lying.'
const texts = QUESTIONS.map((q) => q.split('\n')[1])

describe('stemCoverage and checkProposal', () => {
  it('measures how much of the stem prose comes from the sources', () => {
    expect(stemCoverage(STEM, HANDOUT)).toBeGreaterThan(0.5)
    expect(stemCoverage('Totally invented content about elephants migrating across the savannah every spring', HANDOUT)).toBe(0)
  })
  it('accepts a proper group and rejects the unusable ones', () => {
    const ok = { groups: [{ title: 'Tax collector model', stem: STEM, questionNumbers: [1, 2] }] }
    expect(checkProposal(ok, texts, HANDOUT)).toBeNull()
    expect(checkProposal({ groups: [] }, texts, HANDOUT)).toBeNull()
    expect(checkProposal({ groups: [{ ...ok.groups[0], questionNumbers: [1] }] }, texts, HANDOUT)).toMatch(/fewer than two/)
    expect(checkProposal({ groups: [{ ...ok.groups[0], questionNumbers: [1, 9] }] }, texts, HANDOUT)).toMatch(/does not exist/)
    expect(checkProposal({ groups: [{ ...ok.groups[0], questionNumbers: [1, 1] }] }, texts, HANDOUT)).toMatch(/twice/)
    expect(checkProposal({ groups: [ok.groups[0], { ...ok.groups[0], questionNumbers: [2, 3] }] }, texts, HANDOUT)).toMatch(/two groups/)
    expect(checkProposal({ groups: [{ ...ok.groups[0], stem: 'too short' }] }, texts, HANDOUT)).toMatch(/characters/)
    expect(checkProposal({ groups: [{ ...ok.groups[0], stem: 'Elephants migrate across the savannah every spring and the rangers count them from helicopters at dawn.' }] }, texts, HANDOUT)).toMatch(/not taken from/)
  })
})

describe('proposeProblemSets', () => {
  const gen = (groups: unknown) => (async (args: { schema: unknown }) => {
    expect(args.schema).toBe(ProblemSetsSchema)
    return { object: { groups }, usage: { inputTokens: 10, outputTokens: 5 } }
  }) as never
  it('returns the checked groups', async () => {
    const stats = newModelStats()
    const out = await proposeProblemSets({ unitTitle: 'HW', handout: HANDOUT, questions: texts }, { generate: gen([{ title: ' Tax collector model ', stem: STEM, questionNumbers: [1, 2] }]), stats })
    expect(out).toEqual([{ title: 'Tax collector model', stem: STEM, questionNumbers: [1, 2] }])
    expect(stats.calls).toBe(1)
  })
  it('fails after the retry when the model keeps returning an invented stem', async () => {
    const bad = [{ title: 'X', stem: 'Elephants migrate across the savannah every spring and the rangers count them from helicopters at dawn.', questionNumbers: [1, 2] }]
    await expect(proposeProblemSets({ unitTitle: 'HW', handout: HANDOUT, questions: texts }, { generate: gen(bad), stats: newModelStats() })).rejects.toBeInstanceOf(StageError)
  })
  it('asks nothing for a unit with a single question', async () => {
    expect(await proposeProblemSets({ unitTitle: 'HW', handout: HANDOUT, questions: [texts[0]] }, { generate: gen([]) })).toEqual([])
  })
})

describe('renderUnit', () => {
  it('writes a group where its first question was and round-trips through the importer', () => {
    const md = renderUnit(QUESTIONS, [{ title: 'Tax collector model', stem: STEM, questionNumbers: [2, 1] }])
    expect(md.indexOf('# Problem set: Tax collector model')).toBe(0)
    const cs = edxCandidates(md)
    expect(cs).toHaveLength(3)
    expect(cs[0].group).toMatchObject({ title: 'Tax collector model', position: 0 })
    expect(cs[0].questionText).toContain('collector payoff')
    expect(cs[1].questionText).toContain('citizen payoff')
    expect(cs[1].group?.position).toBe(1)
    expect(cs[2].group).toBeUndefined()
  })
  it('leaves a unit without groups as it was', () => {
    expect(renderUnit(QUESTIONS, [])).toBe(QUESTIONS.map((q) => q.trim()).join('\n\n'))
  })
})

describe('normalizeDisplayMath', () => {
  it('puts each display equation in its own paragraph and leaves inline math alone', () => {
    const out = normalizeDisplayMath('Costs where\n$$f(x) = x^2$$\n$$g(x) = x$$\nThen $u$ is used.')
    expect(out).toBe('Costs where\n\n$$f(x) = x^2$$\n\n$$g(x) = x$$\n\nThen $u$ is used.')
    expect(normalizeDisplayMath('Plain $a$ text')).toBe('Plain $a$ text')
  })
})

