import { describe, it, expect } from 'vitest'
import { braceNotationToMath, numericOption, numericParts, hasLetterPrefixes, stripChoiceLetter, needsExternalData } from './edxNotation'
import { latexProblems } from '@/lib/exerciseValidation'
import { edxCandidates, acceptCandidate } from './importQuestions'

describe('braceNotationToMath', () => {
  it('puts a subscripted symbol and its argument list inside math', () => {
    expect(braceNotationToMath('Y_{i}(1) is observed')).toBe('$Y_{i}(1)$ is observed')
    expect(braceNotationToMath('what is E[Y_{i}(1) – Y_{i}(0) | W_{i}=1]')).toBe('what is E[$Y_{i}(1)$ – $Y_{i}(0)$ | $W_{i}$=1]')
  })
  it('wraps a whole equation line and names multi-letter variables as text', () => {
    const out = braceNotationToMath('Use_{i} = a + b*Price_{i} + e_{i}')
    expect(out).toBe('$\\text{Use}_{i} = a + b\\cdot \\text{Price}_{i} + e_{i}$')
    expect(latexProblems(out)).toEqual([])
  })
  it('leaves existing math, links and money alone', () => {
    expect(braceNotationToMath('Already $x_{i}$ and \\(\\gamma_{1}\\)')).toBe('Already $x_{i}$ and \\(\\gamma_{1}\\)')
    expect(braceNotationToMath('![a](https://x.org/a_{1}.png) costs $5 and $7 for Y_{i}')).toBe('![a](https://x.org/a_{1}.png) costs $5 and $7 for $Y_{i}$')
  })
  it('does nothing without brace notation', () => {
    expect(braceNotationToMath('a_b is a name and $5')).toBe('a_b is a name and $5')
  })
  it('makes the converted text pass the LaTeX check', () => {
    for (const t of ['Y_{i}(1) – Y_{i}(0)', 'Attendance_{it} = a + b*post_{t}', 'effect of x^{2} on Y_{i}']) {
      expect(latexProblems(braceNotationToMath(t)), t).toEqual([])
    }
  })
})

describe('numeric options', () => {
  it('reads a plain number, a labelled number, thousands separators and a percent sign', () => {
    expect(numericOption('0.13')).toEqual({ label: '', value: '0.13' })
    expect(numericOption('Mean: 25.61')).toEqual({ label: 'Mean', value: '25.61' })
    expect(numericOption('12,967')).toEqual({ label: '', value: '12967' })
    expect(numericOption('Median GDP per capita: 4110')).toEqual({ label: 'Median GDP per capita', value: '4110' })
    expect(numericOption('21%')).toEqual({ label: '', value: '21' })
    expect(numericOption('Coefficient = -0.5')).toEqual({ label: 'Coefficient', value: '-0.5' })
  })
  it('does not read text, table cells or ranges', () => {
    expect(numericOption('Prefer not to say')).toBeNull()
    expect(numericOption('A: 11.839')).toBeNull()
    expect(numericOption('0-25,000 USD')).toBeNull()
  })
  it('needs every option marked and numeric, and distinct labels for several', () => {
    expect(numericParts(['0.13'], ['0.13'])).toEqual([{ label: '', value: '0.13' }])
    expect(numericParts(['Mean: 1', 'Max: 2'], ['Mean: 1', 'Max: 2'])).toHaveLength(2)
    expect(numericParts(['Mean: 1', 'Max: 2'], ['Mean: 1'])).toBeNull()
    expect(numericParts(['1', '2'], ['1', '2'])).toBeNull()
    expect(numericParts(['Man', 'Woman'], ['Man', 'Woman'])).toBeNull()
  })
})

describe('edxCandidates: numeric and notation', () => {
  const file = (body: string) => `# Question\n${body}\n`
  it('turns a single marked number into a numeric question that is accepted', () => {
    const [c] = edxCandidates(file('What percentage of the pupils are boys?\n\n## Choices\n- [x] 52.08\n\n## Explanation/Solution\nExplanation\n\n52.08 of them.'))
    expect(c).toMatchObject({ exerciseType: 'numeric', choices: [], correctAnswer: '52.08' })
    expect(acceptCandidate(c, null).ok).toBe(true)
  })
  it('splits a multi-part problem into one numeric question per labelled box', () => {
    const cs = edxCandidates(file('What are the mean and the maximum?\n\n## Choices\n- [x] Mean: 4.19\n- [x] Maximum: 9.97\n\n## Explanation/Solution\nExplanation\n\nSee data.'))
    expect(cs.map((c) => c.correctAnswer)).toEqual(['4.19', '9.97'])
    expect(cs[0].questionText).toContain('Enter the value of: Mean')
    expect(cs.every((c) => acceptCandidate(c, null).ok)).toBe(true)
  })
  it('keeps a survey with every option marked as it was (rejected)', () => {
    const [c] = edxCandidates(file('What is your gender?\n\n## Choices\n- [x] Man\n- [x] Woman\n- [x] Other'))
    expect(c.exerciseType).toBe('multiple_choice')
    expect(acceptCandidate(c, null).ok).toBe(false)
  })
  it('accepts a choice question written with brace notation and keeps the key matching its option', () => {
    const [c] = edxCandidates(file('Which is the treatment effect for individual i if Y_{i}(1) is observed?\n\n## Choices\n- [ ] a. Y_{i}(0)\n- [x] b. Y_{i}(1) – Y_{i}(0)\n- [ ] c. none\n\n## Explanation/Solution\nExplanation\n\nBecause.'))
    const r = acceptCandidate(c, null)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.question.choices).toContain(r.question.correctAnswer)
  })
})

describe('list letters', () => {
  it('detects options lettered in order and strips the letter', () => {
    expect(hasLetterPrefixes(['a. One', 'b. Two', 'c. Three'])).toBe(true)
    expect(hasLetterPrefixes(['a. One', 'c. Two'])).toBe(false)
    expect(hasLetterPrefixes(['One', 'Two'])).toBe(false)
    expect(hasLetterPrefixes(['a. Only'])).toBe(false)
    expect(stripChoiceLetter('b. Price of inputs')).toBe('Price of inputs')
    expect(stripChoiceLetter('(c) Three')).toBe('Three')
    expect(stripChoiceLetter('a lot of things')).toBe('a lot of things')
  })
  it('imports lettered options without the letters and keeps the key matching (single and multiple)', () => {
    const single = edxCandidates('# Question\nQ one?\n\n## Choices\n- [ ] a. First\n- [x] b. Second\n- [ ] c. Third\n\n## Explanation/Solution\nExplanation\n\nBecause.\n')[0]
    expect(single.choices).toEqual(['First', 'Second', 'Third'])
    expect(single.correctAnswer).toBe('Second')
    expect(acceptCandidate(single, null).ok).toBe(true)
    const multi = edxCandidates('# Question\nWhich apply? (Check all that apply)\n\n## Choices\n- [x] a. First\n- [ ] b. Second\n- [x] c. Third\n\n## Explanation/Solution\nExplanation\n\nBecause.\n')[0]
    expect(JSON.parse(multi.correctAnswer)).toEqual(['First', 'Third'])
    expect(acceptCandidate(multi, null).ok).toBe(true)
  })
})

describe('needsExternalData', () => {
  it('flags questions that need the course dataset or code run on it', () => {
    for (const q of [
      'What are the mean, minimum, and maximum illiteracy rate among the 50 poorest countries? (Please round)',
      'Using the data, find and enter the difference in outcomes between students.',
      'Regress the illiteracy rate on GDP per capita. Is the coefficient significant?',
      'Now load the data tea_data.csv in R.',
      'Which of the following variables from the dataset are dummy variables?',
      'Recall the Wald estimator. Run the DD regressions for estimating the impact.',
    ]) expect(needsExternalData(q), q).toBe(true)
  })
  it('keeps conceptual questions that only mention a regression or data', () => {
    for (const q of [
      'If you regress income or nutrition on education, do you expect the coefficients b and d to be positive?',
      'True or False: With cross-cutting treatments, if you run a regression including interaction terms, you learn more.',
      'Comparing show up rates based on observable characteristics, which of the following do the data reveal?',
      'Imagine that we have survey data of food expenditure. Assume you would run the following regression. Is it biased?',
      'Suppose the baseline adoption rate is 0.75. What is the elasticity?',
    ]) expect(needsExternalData(q), q).toBe(false)
  })
  it('keeps a question whose figure or table is embedded', () => {
    expect(needsExternalData('![Table of regression results](https://x.org/t.png)\n\nRegress Y on X using the table above.')).toBe(false)
  })
})

