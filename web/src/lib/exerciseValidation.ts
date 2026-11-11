/**
 * Structural validation of a question: rejects the shapes the flashcard would render wrongly or the grader could not
 * grade. Pure and client-safe. Every rule below is derived from `Flashcard.tsx` (rendering) and `grading.ts` (grading):
 *
 * Rendering facts the rules rely on
 *   - Question text, choices (single and multiple choice) and the explanation go through `preprocessLaTeX` and then
 *     react-markdown + remark-math + rehype-katex. `preprocessLaTeX` turns `\[..\]` into `$$..$$` and `\(..\)` into
 *     `$..$`; remark-math renders `$..$` and `$$..$$`. A LaTeX command outside those delimiters is shown as raw text.
 *   - Dropdown options are `<option>` elements: plain text, no math.
 *   - A dropdown question text is split at its placeholders and each part is rendered on its own, so a math span cannot
 *     contain the placeholder. Without a placeholder no `<select>` is rendered at all.
 *   - The numeric field is `<input type="number">`: only plain numbers can be typed.
 *   - Single choice highlights the correct option by `choice.trim() === correctAnswer.trim()`; multiple choice by
 *     `JSON.parse(correctAnswer).includes(choice)` (exact strings).
 */
import { gradeAnswer, normalize, resolveExerciseType } from '@/lib/grading'

export type ExerciseKind = 'single_choice' | 'multiple_choice' | 'numeric' | 'dropdown'

export interface ValidatableExercise {
  questionText: string
  exerciseType: string
  /** The choices as an array, or as the stored JSON string. */
  choices: string[] | string
  correctAnswer: string
  explanation?: string | null
}

export interface ValidationIssue {
  /** Stable machine-readable code (stored in the audit reason of a rejected row). */
  code: string
  message: string
}

export const CHOICE_LIMITS = {
  single_choice: { min: 3, max: 6 },
  multiple_choice: { min: 3, max: 6 },
  dropdown: { min: 3, max: 5 },
} as const

export const DROPDOWN_PLACEHOLDER = '[Dropdown 1]'

// --- LaTeX ------------------------------------------------------------------------------------------------------

// The delimited spans the renderer turns into math, longest delimiters first. Inline `$..$` may not contain `$`.
const MATH_SPAN_PATTERNS = [
  /\$\$[\s\S]+?\$\$/g,
  /\\\[[\s\S]+?\\\]/g,
  /\\\([\s\S]+?\\\)/g,
  /(?<!\\)\$[^$]+?(?<!\\)\$/g,
]

function mathSpans(text: string): { spans: string[]; rest: string } {
  const spans: string[] = []
  let rest = text
  for (const pattern of MATH_SPAN_PATTERNS) {
    rest = rest.replace(pattern, (m) => {
      spans.push(m)
      return ' '
    })
  }
  return { spans, rest }
}

/** Problems with the LaTeX of one rendered text. Empty when the text renders as intended. */
export function latexProblems(text: string): string[] {
  const problems: string[] = []
  const { spans, rest } = mathSpans(text)
  if (/\\[A-Za-z]{2,}/.test(rest) || /[\w)\]}]\s?[_^]\{/.test(rest)) problems.push('bare_latex')
  if (/\\[()[\]]|\$\$/.test(rest)) problems.push('unmatched_math_delimiter')
  if (spans.some((s) => /\\\\[A-Za-z]{2,}/.test(s))) problems.push('double_escaped_latex')
  // "$5 and $10" is read as a math span and shows its prose in math italics
  const single = spans.filter((s) => s.startsWith('$') && !s.startsWith('$$'))
  if (single.some((s) => !s.includes('\\') && /(^|\s)[A-Za-z]{3,}(\s|$)/.test(s.slice(1, -1)) && /\s/.test(s.slice(1, -1).trim()))) {
    problems.push('currency_read_as_math')
  }
  return problems
}

/** Any math at all (delimited or bare): what a dropdown option may not contain. */
function hasMath(text: string): boolean {
  const { spans } = mathSpans(text)
  return spans.length > 0 || /\\[A-Za-z]{2,}/.test(text) || /\\[()[\]]/.test(text)
}

// --- helpers ----------------------------------------------------------------------------------------------------

function parseChoiceList(choices: ValidatableExercise['choices']): string[] | null {
  if (Array.isArray(choices)) return choices.every((c) => typeof c === 'string') ? choices : null
  if (typeof choices !== 'string') return null
  try {
    const parsed = JSON.parse(choices)
    return Array.isArray(parsed) && parsed.every((c) => typeof c === 'string') ? parsed : null
  } catch {
    return null
  }
}

function hasDuplicates(values: string[]): boolean {
  return new Set(values.map(normalize)).size !== values.length
}

const DROPDOWN_PREFIX = /^\[Dropdown (\d+)\]\s*/

/** The student-visible option of a dropdown choice (the renderer strips a leading "[Dropdown 1]"). */
export function dropdownOption(choice: string): string {
  return choice.trim().replace(/^\[Dropdown 1\]\s*/, '').trim()
}

/** The answer string the flashcard produces when the student picks `option` in the dropdown. */
export function dropdownAnswerFor(option: string): string {
  return JSON.stringify({ [DROPDOWN_PLACEHOLDER]: option })
}

const PLAIN_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i

// --- validation -------------------------------------------------------------------------------------------------

/** All structural problems of a question; an empty list means it is acceptable. */
export function validateExerciseStructure(ex: ValidatableExercise): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const add = (code: string, message: string) => issues.push({ code, message })

  const type = ex.exerciseType as ExerciseKind
  if (!['single_choice', 'multiple_choice', 'numeric', 'dropdown'].includes(type)) {
    add('unknown_type', `Unknown exercise type "${ex.exerciseType}".`)
    return issues
  }

  const questionText = ex.questionText ?? ''
  if (!questionText.trim()) add('empty_question', 'The question text is empty.')
  if (!(ex.explanation ?? '').trim()) add('empty_explanation', 'The explanation is empty.')

  const choices = parseChoiceList(ex.choices)
  if (!choices) {
    add('choices_not_list', 'The choices are not a list of strings.')
    return issues
  }
  if (choices.some((c) => !c.trim())) add('empty_choice', 'A choice is empty.')

  // The type the app will actually render and grade must be the declared one
  const resolved = resolveExerciseType({ exerciseType: type, choices, questionText })
  if (resolved !== type) add('type_mismatch', `Declared as ${type} but the app renders it as ${resolved}.`)

  // LaTeX in the texts that are rendered with markdown + KaTeX
  const rendered: [string, string][] = [['question', questionText], ['explanation', ex.explanation ?? '']]
  if (type !== 'dropdown') choices.forEach((c, i) => rendered.push([`choice ${i + 1}`, c]))
  for (const [where, text] of rendered) {
    for (const p of latexProblems(text)) add(`latex_${p}`, `${where}: ${p.replace(/_/g, ' ')}.`)
  }

  const answer = ex.correctAnswer ?? ''
  const gradable = { exerciseType: type, choices, correctAnswer: answer, questionText }

  switch (type) {
    case 'single_choice': {
      const { min, max } = CHOICE_LIMITS.single_choice
      if (choices.length < min || choices.length > max) add('choice_count', `Single choice needs ${min}-${max} choices, has ${choices.length}.`)
      if (hasDuplicates(choices)) add('duplicate_choices', 'Two choices are the same.')
      const matches = choices.filter((c) => c.trim() === answer.trim())
      if (!answer.trim() || matches.length !== 1) add('answer_not_in_choices', 'The correct answer is not exactly one of the choices.')
      else if (!gradeAnswer(gradable, matches[0]).isCorrect) add('ungradable_answer', 'The correct choice does not grade as correct.')
      break
    }
    case 'multiple_choice': {
      const { min, max } = CHOICE_LIMITS.multiple_choice
      if (choices.length < min || choices.length > max) add('choice_count', `Multiple choice needs ${min}-${max} choices, has ${choices.length}.`)
      if (hasDuplicates(choices)) add('duplicate_choices', 'Two choices are the same.')
      let parsed: unknown
      try {
        parsed = JSON.parse(answer)
      } catch {
        parsed = undefined
      }
      if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === 'string')) {
        add('answer_not_json_array', 'The correct answer is not a JSON array of strings.')
        break
      }
      const correct = parsed as string[]
      if (correct.length === 0) add('empty_answer', 'The list of correct answers is empty.')
      if (!correct.every((c) => choices.includes(c))) add('answer_not_in_choices', 'A correct answer is not exactly one of the choices.')
      if (new Set(correct).size !== correct.length) add('duplicate_answers', 'The same correct answer is listed twice.')
      if (correct.length > 0 && correct.length >= choices.length) add('all_choices_correct', 'Every choice is correct (the grader treats that as a survey item).')
      if (correct.length > 0 && !gradeAnswer(gradable, JSON.stringify(correct)).isCorrect) add('ungradable_answer', 'The correct set does not grade as correct.')
      break
    }
    case 'numeric': {
      if (choices.length > 0) add('numeric_has_choices', 'A numeric question must have no choices.')
      const t = answer.trim()
      if (!PLAIN_NUMBER.test(t) || !Number.isFinite(Number(t))) add('answer_not_number', 'The correct answer is not a plain finite number.')
      else if (!gradeAnswer(gradable, t).isCorrect) add('ungradable_answer', 'The correct number does not grade as correct.')
      break
    }
    case 'dropdown': {
      const placeholders = questionText.match(/\[Dropdown \d+\]/g) ?? []
      if (placeholders.length !== 1 || placeholders[0] !== DROPDOWN_PLACEHOLDER) {
        add('dropdown_placeholder', `The question text needs exactly one ${DROPDOWN_PLACEHOLDER} placeholder and no other.`)
      }
      if (questionText.includes('[BLANK]')) add('dropdown_placeholder', 'The question text uses [BLANK]; only [Dropdown 1] is allowed.')
      const prefixed = choices.filter((c) => DROPDOWN_PREFIX.test(c.trim()))
      if (prefixed.length > 0 && prefixed.length !== choices.length) add('dropdown_mixed_prefix', 'Some choices carry a blank prefix and some do not.')
      if (prefixed.some((c) => !/^\[Dropdown 1\]/.test(c.trim()))) add('dropdown_placeholder', 'A choice names a blank other than [Dropdown 1].')
      const { min, max } = CHOICE_LIMITS.dropdown
      if (choices.length < min || choices.length > max) add('choice_count', `Dropdown needs ${min}-${max} options, has ${choices.length}.`)
      const options = choices.map(dropdownOption)
      if (options.some((o) => !o)) add('empty_choice', 'A dropdown option is empty.')
      if (hasDuplicates(options)) add('duplicate_choices', 'Two dropdown options are the same.')
      if (options.some(hasMath)) add('latex_in_dropdown_option', 'A dropdown option contains LaTeX; a <select> cannot render math.')
      // Math cannot span the placeholder: each part is rendered separately
      const parts = questionText.split(/(\[BLANK\]|\[Dropdown \d+\])/g).filter((p) => !/^\[(BLANK|Dropdown \d+)\]$/.test(p))
      const odd = parts.map((p) => ((p.match(/(?<!\\)\$/g) ?? []).length % 2) === 1)
      if (odd.some((o, i) => o && odd[i + 1])) add('latex_spans_placeholder', 'A math expression contains the dropdown placeholder.')
      // Exactly one option may grade as correct, and it must be the stored answer
      const correctOptions = options.filter((o) => o && gradeAnswer(gradable, dropdownAnswerFor(o)).isCorrect)
      if (correctOptions.length !== 1) add('answer_not_in_choices', `${correctOptions.length} options grade as correct; exactly one is needed.`)
      break
    }
  }
  return issues
}

/** One-line summary of issues for audit storage. */
export function summarizeIssues(issues: ValidationIssue[]): string {
  return issues.map((i) => i.code).join(',')
}
