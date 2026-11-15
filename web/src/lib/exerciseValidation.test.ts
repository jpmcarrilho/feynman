import { describe, it, expect } from 'vitest'
import { validateExerciseStructure, latexProblems, deriveChoiceAnswer, type ValidatableExercise } from './exerciseValidation'

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
const issueCodes = (ex: ValidatableExercise, opts?: { origin?: 'generated' | 'imported' }) => validateExerciseStructure(ex, opts).map((i) => i.code)
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
  it('allows two options (true/false) only for imported questions, and never one or seven', () => {
    const tf = w(single, { choices: ['True', 'False'], correctAnswer: 'True' })
    expect(issueCodes(tf)).toContain('choice_count')
    expect(issueCodes(tf, { origin: 'generated' })).toContain('choice_count')
    expect(issueCodes(tf, { origin: 'imported' })).toEqual([])
    expect(issueCodes(w(single, { choices: ['True'], correctAnswer: 'True' }), { origin: 'imported' })).toContain('choice_count')
    expect(issueCodes(w(single, { choices: ['1', '2', '3', '4', '5', '7', '9'] }), { origin: 'imported' })).toContain('choice_count')
    // the other rules still apply: the key must be one of the options, options must differ
    expect(issueCodes(w(single, { choices: ['True', 'False'], correctAnswer: 'Maybe' }), { origin: 'imported' })).toContain('answer_not_in_choices')
    expect(issueCodes(w(single, { choices: ['True', 'True'], correctAnswer: 'True' }), { origin: 'imported' })).toContain('duplicate_choices')
  })
  it('keeps the multiple choice and dropdown minimums for imported questions', () => {
    expect(issueCodes(w(multi, { choices: ['2', '4'] }), { origin: 'imported' })).toContain('choice_count')
    expect(issueCodes(w(dropdown, { choices: ['one half', 'one third'] }), { origin: 'imported' })).toContain('choice_count')
  })
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
  it('does not flag money: the renderer escapes it before it reads math', () => {
    expect(latexProblems('It costs $100 per year or $50 per month')).toEqual([])
    expect(latexProblems('Country A earns $85,000 per head and country B $160. The ratio is 530x.')).toEqual([])
    expect(latexProblems('It costs $100 per year')).toEqual([])
    expect(latexProblems('Let $x$ and $y$ be reals')).toEqual([])
  })
  it('accepts an escaped dollar inside a math span', () => {
    expect(latexProblems('A borrower with wealth $w = \\$500$ invests $k$.')).toEqual([])
  })
})

describe('open questions', () => {
  const open: ValidatableExercise = {
    questionText: 'Explain why a fixed-effects regression removes time-invariant differences between groups.',
    exerciseType: 'open',
    choices: [],
    correctAnswer: 'Fixed effects subtract each unit\'s mean from every variable, so anything constant within a unit over time cancels out.',
    explanation: 'A common mistake is to think fixed effects control for time-varying confounders.',
    keyPoints: ['Subtracts the unit mean from each variable', 'Anything constant within a unit cancels', 'Time-varying confounders remain'],
  }
  const codes = (over: Partial<ValidatableExercise>) => validateExerciseStructure({ ...open, ...over }).map((i) => i.code)

  it('accepts a well-formed open question, with key points as an array or as the stored JSON', () => {
    expect(codes({})).toEqual([])
    expect(codes({ keyPoints: JSON.stringify(open.keyPoints), choices: '[]' })).toEqual([])
  })

  it('accepts single-task wordings that look similar', () => {
    for (const q of [
      'Compare and contrast fixed effects and random effects.',
      'What would happen to the median voter outcome if turnout fell? Explain.',
      'Explain how supply and demand together set the price.',
      'Explain why the estimator is biased when a confounder varies over time.',
    ]) expect(codes({ questionText: q }), q).toEqual([])
  })

  it('does not apply the single-task rules to imported questions', () => {
    const q = { ...open, questionText: 'Explain X, and explain Y. In your answer, discuss Z.' }
    expect(validateExerciseStructure(q, { origin: 'imported' })).toEqual([])
    expect(validateExerciseStructure(q).map((i) => i.code)).toEqual(expect.arrayContaining(['open_instructs_coverage', 'open_multiple_tasks']))
  })

  describe('imported open questions (the file author wrote the answer)', () => {
    const imp = (over: Partial<ValidatableExercise>) => validateExerciseStructure({ ...open, ...over }, { origin: 'imported' }).map((i) => i.code)
    it('accepts a short single-sentence model answer with one key point, from 15 characters', () => {
      expect(imp({ correctAnswer: 'Because prices adjust.', keyPoints: ['Prices adjust'] })).toEqual([])
      expect(imp({ correctAnswer: 'x'.repeat(15), keyPoints: ['Short point'] })).toEqual([])
    })
    it('still refuses an answer under 15 characters or over the limit', () => {
      expect(imp({ correctAnswer: 'Prices adjust', keyPoints: ['Prices adjust'] })).toContain('model_answer_length')
      expect(imp({ correctAnswer: 'x'.repeat(1501) })).toContain('model_answer_length')
    })
    it('needs 2 to 4 key points once the answer has more than one sentence or line', () => {
      const two = 'Prices adjust to clear the market. Quantity follows the price.'
      expect(imp({ correctAnswer: two, keyPoints: ['Prices adjust'] })).toContain('key_point_count')
      expect(imp({ correctAnswer: 'Prices adjust:\n- the market clears', keyPoints: ['Prices adjust'] })).toContain('key_point_count')
      expect(imp({ correctAnswer: two, keyPoints: ['Prices adjust', 'Quantity follows price'] })).toEqual([])
    })
    it('never accepts zero or five key points', () => {
      expect(imp({ correctAnswer: 'Because prices adjust.', keyPoints: [] })).toContain('key_point_count')
      expect(imp({ keyPoints: ['point one', 'point two', 'point three', 'point four', 'point five'] })).toContain('key_point_count')
    })
    it('leaves generated questions with the strict limits', () => {
      expect(codes({ correctAnswer: 'Because prices adjust.', keyPoints: ['Prices adjust'] })).toEqual(expect.arrayContaining(['model_answer_length', 'key_point_count']))
    })
  })

  it.each([
    ['choices', { choices: ['a', 'b', 'c'] }, 'open_has_choices'],
    ['a dropdown placeholder', { questionText: 'Explain [Dropdown 1] in two sentences.' }, 'open_has_placeholder'],
    ['"which of the following"', { questionText: 'Which of the following explains fixed effects?' }, 'open_which_of_following'],
    ['a coverage instruction', { questionText: 'Explain why fixed effects remove constants. In your response, address both the mean and the error.' }, 'open_instructs_coverage'],
    ['two instructions joined by "and"', { questionText: 'Explain the impact of the compound on T cell activation, and explain why a second signal is required.' }, 'open_multiple_tasks'],
    ['a second task sentence', { questionText: 'Explain why fixed effects remove constants. Furthermore, describe what remains.' }, 'open_multiple_tasks'],
    ['two question marks', { questionText: 'Why do fixed effects remove constants? What remains?' }, 'open_multiple_tasks'],
    ['a too-short model answer', { correctAnswer: 'Because of means.' }, 'model_answer_length'],
    ['a too-long model answer', { correctAnswer: 'x'.repeat(1501) }, 'model_answer_length'],
    ['one key point', { keyPoints: ['Subtracts the unit mean'] }, 'key_point_count'],
    ['five key points', { keyPoints: ['point one', 'point two', 'point three', 'point four', 'point five'] }, 'key_point_count'],
    ['no key points', { keyPoints: null }, 'key_point_count'],
    ['duplicate key points', { keyPoints: ['Same point here', 'same  point here'] }, 'duplicate_key_points'],
    ['a tiny key point', { keyPoints: ['ok', 'A proper second key point'] }, 'key_point_length'],
    ['a huge key point', { keyPoints: ['y'.repeat(301), 'A proper second key point'] }, 'key_point_length'],
    ['bare LaTeX in the model answer', { correctAnswer: 'The estimator is \\hat{\\beta} computed after demeaning each unit over time.' }, 'latex_bare_latex'],
    ['bare LaTeX in a key point', { keyPoints: ['Uses \\bar{x} per unit', 'A proper second key point'] }, 'latex_bare_latex'],
    ['an empty explanation', { explanation: '' }, 'empty_explanation'],
  ] as [string, Partial<ValidatableExercise>, string][])('rejects %s', (_name, over, code) => {
    expect(codes(over)).toContain(code)
  })

  it('does not treat "select all that apply" prose as a type mismatch', () => {
    expect(codes({ questionText: 'Select all that apply is a phrase used in quizzes; explain why it needs several answers.' })).not.toContain('type_mismatch')
  })

  it('deriveChoiceAnswer treats open like numeric: no indexes, the written answer is kept', () => {
    expect(deriveChoiceAnswer('open', [], [], 'the model answer')).toEqual({ ok: true, correctAnswer: 'the model answer' })
    const bad = deriveChoiceAnswer('open', [], [0], 'x')
    expect(bad.ok).toBe(false)
  })
})

describe('lettered choices', () => {
  const base = { questionText: 'Which is right?', exerciseType: 'single_choice', correctAnswer: 'b. Two', explanation: 'Because.' }
  it('rejects a generated question whose choices carry list letters, in any order', () => {
    const issues = validateExerciseStructure({ ...base, choices: ['c. Three', 'b. Two', 'a. One'] })
    expect(issues.map((i) => i.code)).toContain('choices_lettered')
  })
  it('does not reject plain options, a single lettered option, or an imported question', () => {
    expect(validateExerciseStructure({ ...base, correctAnswer: 'Two', choices: ['One', 'Two', 'Three'] }).map((i) => i.code)).not.toContain('choices_lettered')
    expect(validateExerciseStructure({ ...base, correctAnswer: 'a lot', choices: ['a lot', 'Two', 'Three'] }).map((i) => i.code)).not.toContain('choices_lettered')
    expect(validateExerciseStructure({ ...base, choices: ['a. One', 'b. Two', 'c. Three'] }, { origin: 'imported' }).map((i) => i.code)).not.toContain('choices_lettered')
  })
})

describe('explanations that cite option letters', () => {
  const ok = { questionText: 'Which is right?', exerciseType: 'single_choice', choices: ['One', 'Two', 'Three'], correctAnswer: 'Two' }
  it('rejects a generated question whose explanation says "statements a and c"', () => {
    expect(validateExerciseStructure({ ...ok, explanation: 'Statements a, b, and c are correct.' }).map((i) => i.code)).toContain('explanation_cites_letter')
    expect(validateExerciseStructure({ ...ok, explanation: 'Option b is correct because it holds.' }).map((i) => i.code)).toContain('explanation_cites_letter')
    expect(validateExerciseStructure({ ...ok, explanation: 'The first three statements are correct; the fourth is not.' }).map((i) => i.code)).toContain('explanation_cites_letter')
  })
  it('accepts a scenario with capital letters, plain prose and imported explanations', () => {
    expect(validateExerciseStructure({ ...ok, explanation: 'Under Option A the tenant bears risk; Contract B shares it. A good answer names both.' }).map((i) => i.code)).not.toContain('explanation_cites_letter')
    expect(validateExerciseStructure({ ...ok, explanation: 'The answer is two.' }).map((i) => i.code)).not.toContain('explanation_cites_letter')
    expect(validateExerciseStructure({ ...ok, explanation: 'Option b is correct.' }, { origin: 'imported' }).map((i) => i.code)).not.toContain('explanation_cites_letter')
  })
})

