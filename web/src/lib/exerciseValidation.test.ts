import { describe, it, expect } from 'vitest'
import { validateExerciseStructure, latexProblems, type ValidatableExercise } from './exerciseValidation'

const single: ValidatableExercise = {
  questionText: 'Which of these is a prime number?',
  exerciseType: 'single_choice',
  choices: ['4', '6', '7', '9'],
  correctAnswer: '7',
  explanation: 'Seven has no divisors other than one and itself.',
}
const multi: ValidatableExercise = {
  questionText: 'Select all that apply: which are even?',
  exerciseType: 'multiple_choice',
  choices: ['2', '3', '4', '5'],
  correctAnswer: '["2","4"]',
  explanation: 'Even numbers are divisible by two.',
}
const numeric: ValidatableExercise = {
  questionText: 'What is 0.4 + 0.4? Please enter your numeric response rounded to two decimal places (for example, -0.07).',
  exerciseType: 'numeric',
  choices: [],
  correctAnswer: '0.8',
  explanation: 'Add them.',
}
const dropdown: ValidatableExercise = {
  questionText: 'A fair coin lands heads with probability [Dropdown 1].',
  exerciseType: 'dropdown',
  choices: ['one half', 'one third', 'one quarter'],
  correctAnswer: 'one half',
  explanation: 'Two equally likely sides.',
}

const codes = (ex: ValidatableExercise) => validateExerciseStructure(ex).map((i) => i.code)
const w = (base: ValidatableExercise, patch: Partial<ValidatableExercise>): ValidatableExercise => ({ ...base, ...patch })

describe('validateExerciseStructure: well-formed questions pass', () => {
  it.each([['single', single], ['multiple', multi], ['numeric', numeric], ['dropdown', dropdown]])('%s choice', (_n, ex) => {
    expect(codes(ex)).toEqual([])
  })
  it('accepts the choices as the stored JSON string', () => {
    expect(codes(w(single, { choices: JSON.stringify(single.choices) }))).toEqual([])
  })
  it('accepts math between $ or \\( \\) delimiters in the question, choices and explanation', () => {
    expect(codes(w(single, { questionText: 'If $\\beta > 0$ and \\(\\alpha = 1\\), which holds?', choices: ['$\\beta > 0$', '\\(\\beta = 0\\)', '$$x^{2}$$'], correctAnswer: '$\\beta > 0$', explanation: 'Because $\\beta$ is positive.' }))).toEqual([])
  })
  it('accepts a [Dropdown 1] prefix on every option (the renderer strips it)', () => {
    expect(codes(w(dropdown, { choices: ['[Dropdown 1] one half', '[Dropdown 1] one third', '[Dropdown 1] one quarter'] }))).toEqual([])
  })
})

describe('validateExerciseStructure: common rules', () => {
  it('rejects an empty question or explanation and empty choices', () => {
    expect(codes(w(single, { questionText: '  ' }))).toContain('empty_question')
    expect(codes(w(single, { explanation: '' }))).toContain('empty_explanation')
    expect(codes(w(single, { choices: ['4', '', '7', '9'] }))).toContain('empty_choice')
  })
  it('rejects an unknown type and choices that are not a list of strings', () => {
    expect(codes(w(single, { exerciseType: 'essay' }))).toEqual(['unknown_type'])
    expect(codes(w(single, { choices: '{"a":1}' }))).toContain('choices_not_list')
    expect(codes(w(single, { choices: '[1,2,3]' }))).toContain('choices_not_list')
  })
  it('rejects a single choice that says "select all that apply" (the app would render checkboxes)', () => {
    expect(codes(w(single, { questionText: 'Select all that apply: which is prime?' }))).toContain('type_mismatch')
  })
  it('rejects non-dropdown types whose choices carry blank prefixes', () => {
    expect(codes(w(single, { choices: ['[Dropdown 1] 4', '[Dropdown 1] 6', '[Dropdown 1] 7'], correctAnswer: '[Dropdown 1] 7' }))).toContain('type_mismatch')
  })
})

describe('validateExerciseStructure: single choice', () => {
  it('needs 3 to 6 choices', () => {
    expect(codes(w(single, { choices: ['7', '9'] }))).toContain('choice_count')
    expect(codes(w(single, { choices: ['1', '2', '3', '4', '5', '7', '9'] }))).toContain('choice_count')
    expect(codes(w(single, { choices: ['4', '7', '9'] }))).toEqual([])
    expect(codes(w(single, { choices: ['1', '2', '3', '4', '5', '7'] }))).toEqual([])
  })
  it('needs the correct answer to be exactly one of the choices', () => {
    expect(codes(w(single, { correctAnswer: '8' }))).toContain('answer_not_in_choices')
    expect(codes(w(single, { correctAnswer: '' }))).toContain('answer_not_in_choices')
    expect(codes(w(single, { correctAnswer: '["7"]' }))).toContain('answer_not_in_choices')
  })
  it('rejects two choices that grade the same', () => {
    expect(codes(w(single, { choices: ['4', '7', ' 7 ', '9'] }))).toContain('duplicate_choices')
    expect(codes(w(single, { choices: ['Four', 'Seven', 'seven', 'Nine'], correctAnswer: 'Seven' }))).toContain('duplicate_choices')
  })
})

describe('validateExerciseStructure: multiple choice', () => {
  it('needs the correct answer to be a JSON array of strings', () => {
    expect(codes(w(multi, { correctAnswer: '2' }))).toContain('answer_not_json_array')
    expect(codes(w(multi, { correctAnswer: '2, 4' }))).toContain('answer_not_json_array')
    expect(codes(w(multi, { correctAnswer: '[2,4]' }))).toContain('answer_not_json_array')
    expect(codes(w(multi, { correctAnswer: '{"a":"2"}' }))).toContain('answer_not_json_array')
  })
  it('needs every correct answer to be exactly one of the choices', () => {
    expect(codes(w(multi, { correctAnswer: '["2","6"]' }))).toContain('answer_not_in_choices')
    expect(codes(w(multi, { correctAnswer: '["2 "]' }))).toContain('answer_not_in_choices')
  })
  it('rejects an empty list, duplicates, and a list that contains every choice', () => {
    expect(codes(w(multi, { correctAnswer: '[]' }))).toContain('empty_answer')
    expect(codes(w(multi, { correctAnswer: '["2","2"]' }))).toContain('duplicate_answers')
    expect(codes(w(multi, { correctAnswer: '["2","3","4","5"]' }))).toContain('all_choices_correct')
  })
  it('needs 3 to 6 unique choices', () => {
    expect(codes(w(multi, { choices: ['2', '4'] }))).toContain('choice_count')
    expect(codes(w(multi, { choices: ['2', '3', '4', '4'] }))).toContain('duplicate_choices')
  })
  it('catches LaTeX backslashes that JSON turned into control characters (never equal to the choice)', () => {
    const ex = w(multi, { choices: ['$\\rho$ is positive', 'b', 'c', 'd'], correctAnswer: '["$\\rho$ is positive"]' })
    expect(codes(ex)).toContain('answer_not_in_choices')
  })
})

describe('validateExerciseStructure: numeric', () => {
  it('needs empty choices', () => {
    expect(codes(w(numeric, { choices: ['0.8', '0.9', '1'] }))).toContain('numeric_has_choices')
  })
  it('needs a plain finite number the number input can hold', () => {
    for (const bad of ['', 'about 0.8', '80%', '$5', '1,000', 'NaN', 'Infinity', '1/2', '0.8.1', '1e999']) {
      expect(codes(w(numeric, { correctAnswer: bad })), bad).toContain('answer_not_number')
    }
    for (const good of ['0.8', '-0.07', '12', '.5', '+3', '1e-3']) {
      expect(codes(w(numeric, { correctAnswer: good })), good).toEqual([])
    }
  })
})

describe('validateExerciseStructure: dropdown', () => {
  it('needs exactly one [Dropdown 1] placeholder in the question', () => {
    expect(codes(w(dropdown, { questionText: 'No blank here.' }))).toContain('dropdown_placeholder')
    expect(codes(w(dropdown, { questionText: '[Dropdown 1] and [Dropdown 1]' }))).toContain('dropdown_placeholder')
    expect(codes(w(dropdown, { questionText: '[Dropdown 1] and [Dropdown 2]' }))).toContain('dropdown_placeholder')
    expect(codes(w(dropdown, { questionText: 'Coin: [Dropdown 2]' }))).toContain('dropdown_placeholder')
    expect(codes(w(dropdown, { questionText: 'Coin: [BLANK]' }))).toContain('dropdown_placeholder')
  })
  it('needs 3 to 5 options', () => {
    expect(codes(w(dropdown, { choices: ['one half', 'one third'] }))).toContain('choice_count')
    expect(codes(w(dropdown, { choices: ['a', 'one half', 'b', 'c', 'd', 'e'] }))).toContain('choice_count')
  })
  it('needs exactly one option to match the answer', () => {
    expect(codes(w(dropdown, { correctAnswer: 'two thirds' }))).toContain('answer_not_in_choices')
    expect(codes(w(dropdown, { choices: ['one half', 'One Half', 'one quarter'] }))).toContain('duplicate_choices')
  })
  it('rejects an answer the grader would split on "|" so that it can never match', () => {
    expect(codes(w(dropdown, { choices: ['a|b', 'one half', 'x'], correctAnswer: 'a|b' }))).toContain('answer_not_in_choices')
  })
  it('rejects LaTeX in the options, delimited or bare', () => {
    expect(codes(w(dropdown, { choices: ['$\\beta > 0$', 'one half', 'x'] }))).toContain('latex_in_dropdown_option')
    expect(codes(w(dropdown, { choices: ['\\(x\\)', 'one half', 'x'] }))).toContain('latex_in_dropdown_option')
    expect(codes(w(dropdown, { choices: ['\\beta', 'one half', 'x'] }))).toContain('latex_in_dropdown_option')
  })
  it('rejects a math expression that contains the placeholder, but not currency before it', () => {
    expect(codes(w(dropdown, { questionText: 'We have $x = [Dropdown 1] + 1$ here.' }))).toContain('latex_spans_placeholder')
    expect(codes(w(dropdown, { questionText: 'It costs \\$5 and the coin lands [Dropdown 1].' }))).toEqual([])
  })
  it('rejects mixed or foreign blank prefixes on the options', () => {
    expect(codes(w(dropdown, { choices: ['[Dropdown 1] one half', 'one third', 'one quarter'] }))).toContain('dropdown_mixed_prefix')
    expect(codes(w(dropdown, { choices: ['[Dropdown 2] one half', '[Dropdown 2] one third', '[Dropdown 2] one quarter'] }))).toContain('dropdown_placeholder')
  })
})

describe('latexProblems', () => {
  it('flags bare LaTeX commands and subscripts outside delimiters', () => {
    expect(latexProblems('\\delta_1 + \\delta_2')).toContain('bare_latex')
    expect(latexProblems('The effect \\beta is large')).toContain('bare_latex')
    expect(latexProblems('x_{i} is observed')).toContain('bare_latex')
    expect(latexProblems('$a$ and \\frac{1}{2}')).toContain('bare_latex')
  })
  it('accepts every delimiter the renderer handles', () => {
    for (const t of ['$\\beta$', '$$\\beta$$', '\\(\\beta\\)', '\\[\\beta\\]', 'plain text', 'a_b is a name', 'Cost is \\$5 per unit']) {
      expect(latexProblems(t), t).toEqual([])
    }
  })
  it('flags double-escaped commands inside math and unmatched delimiters', () => {
    expect(latexProblems('$\\\\delta$')).toContain('double_escaped_latex')
    expect(latexProblems('open \\( never closed')).toContain('unmatched_math_delimiter')
  })
  it('flags two currency amounts that the renderer would read as one math span, not a single dollar sign', () => {
    expect(latexProblems('It costs $100 per year or $50 per month')).toContain('currency_read_as_math')
    expect(latexProblems('It costs $100 per year')).toEqual([])
    expect(latexProblems('Let $x$ and $y$ be reals')).toEqual([])
  })
})
