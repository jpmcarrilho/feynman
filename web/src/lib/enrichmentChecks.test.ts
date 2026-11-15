import { describe, it, expect } from 'vitest'
import { correctOptionTexts, findAnswerLeak, findEnrichmentDamage, isEnrichmentCandidate } from './enrichmentChecks'

const single = {
  questionText: 'According to the study, what happened to enrollment?',
  exerciseType: 'single_choice',
  choices: ['Enrollment rose sharply', 'Enrollment fell', 'No change at all'],
  correctAnswer: 'Enrollment rose sharply',
  explanation: 'Because.',
}

describe('isEnrichmentCandidate', () => {
  const base = { origin: 'imported', status: 'active', isGraded: true, enrichedAt: null, topic: { sourceId: null } }
  it('accepts a never-enriched imported graded active question of a built-in topic', () => {
    expect(isEnrichmentCandidate(base)).toBe(true)
  })
  it.each([
    ['generated', { origin: 'generated' }],
    ['uploaded topic', { topic: { sourceId: 'src-1' } }],
    ['ungraded', { isGraded: false }],
    ['not active', { status: 'rejected' }],
    ['already enriched', { enrichedAt: new Date() }],
  ])('skips %s', (_name, patch) => {
    expect(isEnrichmentCandidate({ ...base, ...patch })).toBe(false)
  })
  it('lets uploaded topics through only with the explicit forUploadedContent opt-in, and nothing else', () => {
    const uploaded = { ...base, topic: { sourceId: 'src-1' } }
    expect(isEnrichmentCandidate(uploaded)).toBe(false)
    expect(isEnrichmentCandidate(uploaded, {})).toBe(false)
    expect(isEnrichmentCandidate(uploaded, { forUploadedContent: true })).toBe(true)
    // the opt-in does not relax any other rule
    expect(isEnrichmentCandidate({ ...uploaded, origin: 'generated' }, { forUploadedContent: true })).toBe(false)
    expect(isEnrichmentCandidate({ ...uploaded, isGraded: false }, { forUploadedContent: true })).toBe(false)
    expect(isEnrichmentCandidate({ ...uploaded, enrichedAt: new Date() }, { forUploadedContent: true })).toBe(false)
  })
})

describe('correctOptionTexts', () => {
  it('finds the correct option of a single choice question', () => {
    expect(correctOptionTexts(single)).toEqual(['Enrollment rose sharply'])
  })
  it('finds every correct option of a multi-select question, choices given as a JSON string', () => {
    const ex = { ...single, exerciseType: 'multiple_choice', choices: JSON.stringify(['Alpha effect', 'Beta effect', 'Gamma effect']), correctAnswer: JSON.stringify(['Alpha effect', 'Gamma effect']) }
    expect(correctOptionTexts(ex)).toEqual(['Alpha effect', 'Gamma effect'])
  })
  it('returns the option behind a dropdown key', () => {
    const ex = { ...single, exerciseType: 'dropdown', questionText: 'The effect is [Dropdown 1].', choices: ['[Dropdown 1] positive', '[Dropdown 1] negative', '[Dropdown 1] zero'], correctAnswer: JSON.stringify({ '[Dropdown 1]': 'negative' }) }
    expect(correctOptionTexts(ex)).toEqual(['negative'])
  })
  it('returns nothing for survey items where every option is correct', () => {
    const ex = { ...single, exerciseType: 'multiple_choice', choices: ['One option', 'Two option'], correctAnswer: JSON.stringify(['One option', 'Two option']) }
    expect(correctOptionTexts(ex)).toEqual([])
  })
})

describe('findAnswerLeak', () => {
  it('flags a correct option that appears only in the enriched text', () => {
    expect(findAnswerLeak(single, single.questionText, `${single.questionText} Note that enrollment rose sharply in treated villages.`)).toMatch(/Enrollment rose sharply/)
  })
  it('does not flag an option the original text already contained', () => {
    const original = 'Enrollment rose sharply in some villages. According to the study, which statement holds?'
    expect(findAnswerLeak(single, original, `${original} The study took place in Kenya.`)).toBeNull()
  })
  it('flags any newly present correct option of a multi-select question', () => {
    const ex = { ...single, exerciseType: 'multiple_choice', questionText: 'Which hold? Select all that apply.', choices: ['Alpha effect', 'Beta effect', 'Gamma effect'], correctAnswer: JSON.stringify(['Alpha effect', 'Gamma effect']) }
    expect(findAnswerLeak(ex, ex.questionText, `${ex.questionText} The gamma effect is large.`)).toMatch(/Gamma effect/)
    expect(findAnswerLeak(ex, ex.questionText, `${ex.questionText} The beta effect is small.`)).toBeNull()
  })
  it('flags the correct dropdown option when it is added to the text', () => {
    const ex = { ...single, exerciseType: 'dropdown', questionText: 'The effect is [Dropdown 1].', choices: ['[Dropdown 1] positive', '[Dropdown 1] negative', '[Dropdown 1] zero'], correctAnswer: JSON.stringify({ '[Dropdown 1]': 'negative' }) }
    expect(findAnswerLeak(ex, ex.questionText, 'A negative shock hit. The effect is [Dropdown 1].')).toMatch(/negative/)
  })
  it('ignores correct answers shorter than 4 characters', () => {
    const ex = { ...single, choices: ['Yes', 'No', 'Maybe so'], correctAnswer: 'Yes' }
    expect(findAnswerLeak(ex, ex.questionText, `${ex.questionText} Yes, this is about a village.`)).toBeNull()
  })
  it('matches whole words only', () => {
    const ex = { ...single, choices: ['Income', 'Wealth', 'Health'], correctAnswer: 'Income' }
    expect(findAnswerLeak(ex, ex.questionText, `${ex.questionText} Incomes were measured.`)).toBeNull()
  })
  it('flags a numeric key that newly appears, but not one already in the original or a table label', () => {
    const ex = { questionText: 'What is the effect size?', exerciseType: 'numeric', choices: '[]', correctAnswer: '0.35', explanation: 'x' }
    expect(findAnswerLeak(ex, ex.questionText, `${ex.questionText}\n| Effect | 0.35 |`)).toMatch(/0\.35/)
    expect(findAnswerLeak(ex, 'The effect was 0.35 in sample A. What is it?', 'The effect was 0.35 in sample A. What is it? Sample B is larger.')).toBeNull()
    const two = { ...ex, correctAnswer: '2' }
    expect(findAnswerLeak(two, ex.questionText, `${ex.questionText} See Table 2 and column 2.`)).toBeNull()
  })
})

describe('findEnrichmentDamage', () => {
  const dropdown = {
    questionText: 'The effect is [Dropdown 1].',
    exerciseType: 'dropdown',
    choices: ['[Dropdown 1] positive', '[Dropdown 1] negative', '[Dropdown 1] zero'],
    correctAnswer: JSON.stringify({ '[Dropdown 1]': 'negative' }),
    explanation: 'x',
  }
  it('accepts a harmless rewrite', () => {
    expect(findEnrichmentDamage(single, `${single.questionText} The study ran in Kenya in 2010.`)).toBeNull()
  })
  it('rejects an empty text', () => {
    expect(findEnrichmentDamage(single, '  ')).toMatch(/empty/)
  })
  it('rejects removing the dropdown placeholder', () => {
    expect(findEnrichmentDamage(dropdown, 'The effect is negative or positive.')).toBeTruthy()
  })
  it('rejects adding bare LaTeX', () => {
    expect(findEnrichmentDamage(single, `${single.questionText} Let \\beta denote the effect.`)).toMatch(/latex/i)
  })
  it('does not hold legacy questions to rules they already failed', () => {
    // Two choices only: fails the choice-count rule before and after, so a harmless rewrite is accepted
    const legacy = { ...single, choices: ['Rose', 'Fell'], correctAnswer: 'Rose' }
    expect(findEnrichmentDamage(legacy, `${legacy.questionText} In Kenya.`)).toBeNull()
  })
  it('rejects a rewrite that makes a select-all question render as multi-select of a single_choice', () => {
    expect(findEnrichmentDamage(single, `${single.questionText} Select all that apply.`)).toMatch(/type_mismatch/)
  })
})

describe('findEnrichmentDamage option copying', () => {
  it('rejects a text that re-prints the answer options', () => {
    const text = `${single.questionText}\n\nChoices:\n- Enrollment rose sharply\n- Enrollment fell\n- No change at all`
    expect(findEnrichmentDamage(single, text)).toMatch(/options copied/)
  })
  it('accepts a text that mentions one option word-for-word by coincidence', () => {
    expect(findEnrichmentDamage(single, `${single.questionText} Some say enrollment fell elsewhere.`)).toBeNull()
  })
})
