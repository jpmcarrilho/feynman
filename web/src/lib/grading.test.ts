import { describe, it, expect } from 'vitest'
import { gradeAnswer, resolveExerciseType, logScore, sessionScore, formatScore, type GradableExercise } from './grading'

const arr = (...xs: string[]) => JSON.stringify(xs)

interface Case {
  name: string
  ex: GradableExercise
  answer: string | null
  score: number
  isCorrect: boolean
}

const sc = (correctAnswer: string, choices: string[] = ['a', 'b', 'c', 'd'], questionText?: string): GradableExercise => ({
  exerciseType: 'single_choice',
  choices: JSON.stringify(choices),
  correctAnswer,
  questionText,
})
const mc = (correct: string[] | string, choices: string[], questionText?: string): GradableExercise => ({
  exerciseType: 'multiple_choice',
  choices: JSON.stringify(choices),
  correctAnswer: typeof correct === 'string' ? correct : JSON.stringify(correct),
  questionText,
})
const num = (correctAnswer: string): GradableExercise => ({ exerciseType: 'numeric', choices: '[]', correctAnswer })
const dd = (correctAnswer: string, choices: string[] = []): GradableExercise => ({
  exerciseType: 'dropdown',
  choices: JSON.stringify(choices),
  correctAnswer,
})

const DD_CHOICES = [
  '[Dropdown 1] success',
  '[Dropdown 1] timing',
  '[Dropdown 2] institutional outcomes',
  '[Dropdown 2] country size',
]
const SURVEY = ['0-2 hours', '2-4 hours', 'I would prefer not to respond']

const cases: Case[] = [
  // single choice
  { name: 'single: exact match', ex: sc('Paris'), answer: 'Paris', score: 1, isCorrect: true },
  { name: 'single: case and whitespace are ignored', ex: sc('Paris'), answer: '  paris  ', score: 1, isCorrect: true },
  { name: 'single: inner whitespace collapsed', ex: sc('the  tax rate of 30%'), answer: 'the tax rate of 30%', score: 1, isCorrect: true },
  { name: 'single: trailing backslash stripped', ex: sc('x \\'), answer: 'x', score: 1, isCorrect: true },
  { name: 'single: wrong choice', ex: sc('Paris'), answer: 'London', score: 0, isCorrect: false },
  { name: 'single: numeric-looking choices are compared as text', ex: sc('2.50'), answer: '2.5', score: 0, isCorrect: false },
  { name: 'single: choice with a comma', ex: sc('Yes, but only in the short run'), answer: 'Yes, but only in the short run', score: 1, isCorrect: true },
  { name: 'single: unanswered is 0 (empty)', ex: sc('Paris'), answer: '', score: 0, isCorrect: false },
  { name: 'single: unanswered is 0 (null)', ex: sc('Paris'), answer: null, score: 0, isCorrect: false },
  { name: 'single: LaTeX backslash lost to a JSON escape still matches', ex: sc('$\rho$ is high'), answer: '$\\rho$ is high', score: 1, isCorrect: true },
  { name: 'single: legacy one-item JSON array from a select-all card', ex: sc('Not enough information', ['x', 'Not enough information']), answer: arr('Not enough information'), score: 1, isCorrect: true },

  // multiple choice
  { name: 'multi: exact set', ex: mc(['A', 'B'], ['A', 'B', 'C', 'D']), answer: arr('B', 'A'), score: 1, isCorrect: true },
  { name: 'multi: one of two right', ex: mc(['A', 'B'], ['A', 'B', 'C', 'D']), answer: arr('A'), score: 0.5, isCorrect: false },
  { name: 'multi: a wrong pick cancels a right one', ex: mc(['A', 'B'], ['A', 'B', 'C', 'D']), answer: arr('A', 'C'), score: 0, isCorrect: false },
  { name: 'multi: floor at 0', ex: mc(['A', 'B'], ['A', 'B', 'C', 'D']), answer: arr('C', 'D'), score: 0, isCorrect: false },
  { name: 'multi: two of three right', ex: mc(['A', 'B', 'C'], ['A', 'B', 'C', 'D']), answer: arr('A', 'B'), score: 2 / 3, isCorrect: false },
  { name: 'multi: all right plus one wrong is not correct', ex: mc(['A', 'B'], ['A', 'B', 'C']), answer: arr('A', 'B', 'C'), score: 0.5, isCorrect: false },
  { name: 'multi: case-insensitive set match', ex: mc(['Alpha', 'Beta'], ['Alpha', 'Beta', 'Gamma']), answer: arr('beta', 'ALPHA'), score: 1, isCorrect: true },
  { name: 'multi: duplicates in the answer count once', ex: mc(['A', 'B'], ['A', 'B', 'C']), answer: arr('A', 'A'), score: 0.5, isCorrect: false },
  { name: 'multi: single plain correct value (select-all text on a single_choice row)', ex: sc('None of the above', ['x', 'y', 'None of the above'], 'Which are true? (Select all that apply)'), answer: arr('None of the above'), score: 1, isCorrect: true },
  { name: 'multi: single correct value, wrong pick', ex: sc('None of the above', ['x', 'y', 'None of the above'], 'Which are true? Select all that apply'), answer: arr('x'), score: 0, isCorrect: false },
  { name: 'multi: empty selection', ex: mc(['A'], ['A', 'B']), answer: '[]', score: 0, isCorrect: false },
  { name: 'multi: survey item, every choice correct, any pick is full credit', ex: mc(SURVEY, SURVEY), answer: arr('I would prefer not to respond'), score: 1, isCorrect: true },
  { name: 'multi: survey item, nothing picked is still 0', ex: mc(SURVEY, SURVEY), answer: '[]', score: 0, isCorrect: false },
  { name: 'multi: LaTeX choice whose stored answer lost its backslash', ex: { exerciseType: 'multiple_choice', choices: JSON.stringify(['The ICC ($\\rho$) is high', 'B', 'C']), correctAnswer: '["The ICC ($\\rho$) is high","B"]' }, answer: JSON.stringify(['The ICC ($\\rho$) is high', 'B']), score: 1, isCorrect: true },
  { name: 'multi: plain non-JSON answer is one selection', ex: mc(['A', 'B'], ['A', 'B', 'C']), answer: 'A', score: 0.5, isCorrect: false },

  // numeric
  { name: 'numeric: exact', ex: num('0.188'), answer: '0.188', score: 1, isCorrect: true },
  { name: 'numeric: negative', ex: num('-1.4'), answer: '-1.4', score: 1, isCorrect: true },
  { name: 'numeric: trailing zeros', ex: num('20.00'), answer: '20', score: 1, isCorrect: true },
  { name: 'numeric: key -0.07 accepts -0.065', ex: num('-0.07'), answer: '-0.065', score: 1, isCorrect: true },
  { name: 'numeric: key -0.07 accepts -0.075 (boundary, inclusive)', ex: num('-0.07'), answer: '-0.075', score: 1, isCorrect: true },
  { name: 'numeric: key -0.07 rejects -0.08', ex: num('-0.07'), answer: '-0.08', score: 0, isCorrect: false },
  { name: 'numeric: whole-number key accepts 4.995', ex: num('5'), answer: '4.995', score: 1, isCorrect: true },
  { name: 'numeric: whole-number key accepts 5.005', ex: num('5'), answer: '5.005', score: 1, isCorrect: true },
  { name: 'numeric: whole-number key rejects 5.01', ex: num('5'), answer: '5.01', score: 0, isCorrect: false },
  { name: 'numeric: whole-number key rejects 5.4', ex: num('5'), answer: '5.4', score: 0, isCorrect: false },
  { name: 'numeric: trailing-zero key 20.00 accepts 20', ex: num('20.00'), answer: '20', score: 1, isCorrect: true },
  { name: 'numeric: trailing-zero key 20.00 rejects 20.2', ex: num('20.00'), answer: '20.2', score: 0, isCorrect: false },
  { name: 'numeric: one-decimal key 0.8 accepts 0.805 (boundary)', ex: num('0.8'), answer: '0.805', score: 1, isCorrect: true },
  { name: 'numeric: one-decimal key 0.8 rejects 0.81', ex: num('0.8'), answer: '0.81', score: 0, isCorrect: false },
  { name: 'numeric: three-decimal key 0.188 accepts 0.1884', ex: num('0.188'), answer: '0.1884', score: 1, isCorrect: true },
  { name: 'numeric: three-decimal key 0.188 rejects 0.19', ex: num('0.188'), answer: '0.19', score: 0, isCorrect: false },
  { name: 'numeric: three-decimal key 0.008 rejects 0', ex: num('0.008'), answer: '0', score: 0, isCorrect: false },
  { name: 'numeric: three-decimal key 0.008 accepts 0.0075', ex: num('0.008'), answer: '0.0075', score: 1, isCorrect: true },
  { name: 'numeric: large key 150000 accepts 150000.004', ex: num('150000'), answer: '150000.004', score: 1, isCorrect: true },
  { name: 'numeric: large key 150000 rejects 150001', ex: num('150000'), answer: '150001', score: 0, isCorrect: false },
  { name: 'numeric: large key 1992 rejects 2000', ex: num('1992'), answer: '2000', score: 0, isCorrect: false },
  { name: 'numeric: percent-divided key keeps two extra decimals (25.5% vs 0.255)', ex: num('25.5%'), answer: '0.255', score: 1, isCorrect: true },
  { name: 'numeric: percent-divided key rejects a near miss (25.5% vs 0.26)', ex: num('25.5%'), answer: '0.26', score: 0, isCorrect: false },
  { name: 'numeric: sign error', ex: num('2.4'), answer: '-2.4', score: 0, isCorrect: false },
  { name: 'numeric: thousands separators and dollar sign', ex: num('1250000'), answer: '$1,250,000', score: 1, isCorrect: true },
  { name: 'numeric: % only on the answer (0.25 vs 25%)', ex: num('0.25'), answer: '25%', score: 1, isCorrect: true },
  { name: 'numeric: % only on the stored value (25% vs 0.25)', ex: num('25%'), answer: '0.25', score: 1, isCorrect: true },
  { name: 'numeric: % on both sides', ex: num('12.5%'), answer: '12.5 %', score: 1, isCorrect: true },
  { name: 'numeric: % on one side, raw numbers equal', ex: num('25%'), answer: '25', score: 1, isCorrect: true },
  { name: 'numeric: not a number', ex: num('5'), answer: 'five', score: 0, isCorrect: false },
  { name: 'numeric: unanswered', ex: num('5'), answer: '', score: 0, isCorrect: false },
  { name: 'numeric: stored value is not numeric', ex: num('n/a'), answer: '5', score: 0, isCorrect: false },
  { name: 'numeric: tiny value stays strict', ex: num('0.008'), answer: '-4', score: 0, isCorrect: false },

  // dropdown
  { name: 'dropdown: two blanks, stored as pipe-separated prefixed text', ex: dd('[Dropdown 1] success | [Dropdown 2] institutional outcomes', DD_CHOICES), answer: JSON.stringify({ '[Dropdown 1]': 'success', '[Dropdown 2]': 'institutional outcomes' }), score: 1, isCorrect: true },
  { name: 'dropdown: one of two blanks right', ex: dd('[Dropdown 1] success | [Dropdown 2] institutional outcomes', DD_CHOICES), answer: JSON.stringify({ '[Dropdown 1]': 'success', '[Dropdown 2]': 'country size' }), score: 0.5, isCorrect: false },
  { name: 'dropdown: right value in the wrong blank does not count', ex: dd('[Dropdown 1] up | [Dropdown 2] down', ['[Dropdown 1] up', '[Dropdown 1] down', '[Dropdown 2] up', '[Dropdown 2] down']), answer: JSON.stringify({ '[Dropdown 1]': 'down', '[Dropdown 2]': 'up' }), score: 0, isCorrect: false },
  { name: 'dropdown: JSON array of prefixed answers, even if exerciseType says multiple_choice', ex: { exerciseType: 'multiple_choice', choices: JSON.stringify(['[Dropdown 1] converging', '[Dropdown 1] diverging', '[Dropdown 2] increasing']), correctAnswer: '["[Dropdown 1] diverging","[Dropdown 2] increasing"]' }, answer: JSON.stringify({ '[Dropdown 1]': 'diverging', '[Dropdown 2]': 'increasing' }), score: 1, isCorrect: true },
  { name: 'dropdown: single blank with the [BLANK] key', ex: dd('attenuation', ['attenuation', 'selection']), answer: '{"[BLANK]":"attenuation"}', score: 1, isCorrect: true },
  { name: 'dropdown: single blank, wrong', ex: dd('attenuation', ['attenuation', 'selection']), answer: '{"[BLANK]":"selection"}', score: 0, isCorrect: false },
  { name: 'dropdown: plain string answer', ex: dd('attenuation', ['attenuation', 'selection']), answer: 'Attenuation', score: 1, isCorrect: true },
  { name: 'dropdown: single_choice row with a prefixed answer is a dropdown', ex: { exerciseType: 'single_choice', choices: JSON.stringify(['[Dropdown 1] Select an option', '[Dropdown 1] more', '[Dropdown 1] less']), correctAnswer: '[Dropdown 1] less' }, answer: '{"[Dropdown 1]":"less"}', score: 1, isCorrect: true },
  { name: 'dropdown: expected answer is a JSON number', ex: dd('5', ['3', '5']), answer: '{"[BLANK]":"5"}', score: 1, isCorrect: true },
  { name: 'dropdown: answer text containing a percent sign', ex: dd('only 15% likely (compared to 10% for a randomly drawn household)', ['x']), answer: '{"[BLANK]":"only 15% likely (compared to 10% for a randomly drawn household)"}', score: 1, isCorrect: true },
  { name: 'dropdown: backslash-heavy LaTeX value', ex: dd('the range of null hypotheses \\(\\beta_0\\) that cannot be rejected', ['x']), answer: JSON.stringify({ '[BLANK]': 'the range of null hypotheses \\(\\beta_0\\) that cannot be rejected' }), score: 1, isCorrect: true },
  { name: 'dropdown: six blanks, one substituted (the old unordered check passed this)', ex: dd('["[Dropdown 1] (1-delta)","[Dropdown 2] /","[Dropdown 3] 2","[Dropdown 4] (1+delta)","[Dropdown 5] /","[Dropdown 6] 2"]'), answer: JSON.stringify({ '[Dropdown 1]': '(1-delta)', '[Dropdown 2]': '+', '[Dropdown 3]': '2', '[Dropdown 4]': '(1+delta)', '[Dropdown 5]': '/', '[Dropdown 6]': '2' }), score: 5 / 6, isCorrect: false },
  { name: 'dropdown: extra answers cannot reach a full score', ex: dd('attenuation'), answer: '{"[BLANK]":"attenuation","[Dropdown 2]":"x"}', score: 0.5, isCorrect: false },
  { name: 'dropdown: nothing selected', ex: dd('attenuation'), answer: '{}', score: 0, isCorrect: false },
  { name: 'dropdown: unanswered ("" as the exam flow stored it)', ex: dd('attenuation'), answer: '', score: 0, isCorrect: false },
]

describe('gradeAnswer', () => {
  it('has at least 30 cases', () => {
    expect(cases.length).toBeGreaterThanOrEqual(30)
  })

  it.each(cases)('$name', ({ ex, answer, score, isCorrect }) => {
    const r = gradeAnswer(ex, answer)
    expect(r.score).toBeCloseTo(score, 9)
    expect(r.isCorrect).toBe(isCorrect)
  })

  it('accepts choices already parsed into an array', () => {
    expect(gradeAnswer({ exerciseType: 'multiple_choice', choices: ['A', 'B'], correctAnswer: '["A"]' }, '["A"]').isCorrect).toBe(true)
  })

  it('isCorrect always implies a full score and the reverse', () => {
    for (const c of cases) {
      const r = gradeAnswer(c.ex, c.answer)
      if (r.isCorrect) expect(r.score).toBe(1)
      else expect(r.score).toBeLessThan(1)
    }
  })

  it('is deterministic: the same inputs always give the same result (client and server agree)', () => {
    for (const c of cases) expect(gradeAnswer(c.ex, c.answer)).toEqual(gradeAnswer({ ...c.ex }, c.answer))
  })
})

describe('resolveExerciseType', () => {
  it('prefixed choices make a dropdown', () => {
    expect(resolveExerciseType({ exerciseType: 'multiple_choice', choices: ['[Dropdown 1] a'], questionText: 'x' })).toBe('dropdown')
  })
  it('"select all that apply" makes a multi-select', () => {
    expect(resolveExerciseType({ exerciseType: 'single_choice', choices: ['a'], questionText: 'Pick them. (Select all that apply)' })).toBe('multiple_choice')
  })
  it('otherwise keeps the stored type', () => {
    expect(resolveExerciseType({ exerciseType: 'numeric', choices: '[]', questionText: 'How many?' })).toBe('numeric')
  })
})

describe('session totals', () => {
  it('uses the stored score and falls back to isCorrect for legacy logs', () => {
    expect(logScore({ score: 0.33, isCorrect: false })).toBe(0.33)
    expect(logScore({ score: null, isCorrect: true })).toBe(1)
    expect(logScore({ isCorrect: false })).toBe(0)
  })
  it('sums scores and counts only fully correct answers as correct', () => {
    const t = sessionScore([
      { score: 1, isCorrect: true },
      { score: 1 / 3, isCorrect: false },
      { score: 0, isCorrect: false },
      { score: null, isCorrect: true },
    ])
    expect(t.scoreSum).toBeCloseTo(2 + 1 / 3, 9)
    expect(t.correctCount).toBe(2)
  })
  it('formats with at most two decimals', () => {
    expect(formatScore(3)).toBe('3')
    expect(formatScore(1 / 3)).toBe('0.33')
    expect(formatScore(2.5)).toBe('2.5')
  })
})
