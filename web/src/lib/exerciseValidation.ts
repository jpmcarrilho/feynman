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
import { MODEL_ANSWER_MAX_CHARS, OPEN_KEY_POINTS, parseKeyPoints } from '@/lib/openAnswer'

export type ExerciseKind = 'single_choice' | 'multiple_choice' | 'numeric' | 'dropdown' | 'open'

export interface ValidatableExercise {
  questionText: string
  exerciseType: string
  /** The choices as an array, or as the stored JSON string. */
  choices: string[] | string
  correctAnswer: string
  explanation?: string | null
  /** Open questions only: the key points as an array or the stored JSON string. */
  keyPoints?: string[] | string | null
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

/** Where a question comes from. Generated questions keep the strict choice counts; imported ones come from the student's own material. */
export type ValidationOrigin = 'generated' | 'imported'
export interface ValidationOptions {
  origin?: ValidationOrigin
}
/** Single choice with a stated answer may have two options (true/false) when the question was imported. */
export const IMPORTED_SINGLE_CHOICE_MIN = 2

/** Length limits of the stored parts of an open question (the model answer's upper limit is MODEL_ANSWER_MAX_CHARS). */
export const OPEN_ANSWER_LIMITS = { modelAnswerMin: 40, keyPointMin: 5, keyPointMax: 300 } as const

const TASK_VERB = '(?:explain|describe|discuss|compare|justify|analy[sz]e|identify|define|outline|evaluate)'
/** "In your response, address ..." and the like. */
const OPEN_COVERAGE_INSTRUCTION = /\bin your (?:response|answer|explanation),?\s+(?:address|discuss|include|cover|mention|describe|explain|clarify)\b|\b(?:be sure|make sure) to (?:address|discuss|include|cover|mention)\b/i
/** Two instructions: two task verbs joined by "and", or a second sentence that opens with another task. */
const OPEN_TWO_TASKS = [
  new RegExp(`\\b${TASK_VERB}\\b[^.?!]*,?\\s+(?:and|as well as)\\s+(?:also\\s+)?${TASK_VERB}\\b`, 'i'),
  new RegExp(`[.?!]\\s+(?:furthermore|additionally|moreover|also|then|next|finally),?\\s+${TASK_VERB}\\b`, 'i'),
  /\?[^?]*\?/,
]

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
export function validateExerciseStructure(ex: ValidatableExercise, opts: ValidationOptions = {}): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const add = (code: string, message: string) => issues.push({ code, message })

  const type = ex.exerciseType as ExerciseKind
  if (!['single_choice', 'multiple_choice', 'numeric', 'dropdown', 'open'].includes(type)) {
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
  const keyPoints = type === 'open' ? parseKeyPoints(ex.keyPoints) : []
  if (type === 'open') {
    rendered.push(['model answer', ex.correctAnswer ?? ''])
    keyPoints.forEach((k, i) => rendered.push([`key point ${i + 1}`, k]))
  }
  for (const [where, text] of rendered) {
    for (const p of latexProblems(text)) add(`latex_${p}`, `${where}: ${p.replace(/_/g, ' ')}.`)
  }

  const answer = ex.correctAnswer ?? ''
  const gradable = { exerciseType: type, choices, correctAnswer: answer, questionText }

  switch (type) {
    case 'single_choice': {
      const { max } = CHOICE_LIMITS.single_choice
      const min = opts.origin === 'imported' ? IMPORTED_SINGLE_CHOICE_MIN : CHOICE_LIMITS.single_choice.min
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
    case 'open': {
      if (choices.length > 0) add('open_has_choices', 'An open question must have no choices.')
      if (/\[Dropdown \d+\]|\[BLANK\]/.test(questionText)) add('open_has_placeholder', 'An open question cannot contain a [Dropdown n] or [BLANK] placeholder.')
      if (/which\s+of\s+the\s+following/i.test(questionText)) add('open_which_of_following', 'An open question cannot ask "which of the following".')
      // A generated question has one task and does not tell the student what to cover (imported questions are the file's own)
      if (opts.origin !== 'imported') {
        if (OPEN_COVERAGE_INSTRUCTION.test(questionText)) add('open_instructs_coverage', 'An open question must not tell the student which points to cover ("in your response, address ...").')
        if (OPEN_TWO_TASKS.some((re) => re.test(questionText))) add('open_multiple_tasks', 'An open question must have exactly one task, not two instructions joined together.')
      }
      const len = answer.trim().length
      if (len < OPEN_ANSWER_LIMITS.modelAnswerMin || len > MODEL_ANSWER_MAX_CHARS) {
        add('model_answer_length', `The model answer needs ${OPEN_ANSWER_LIMITS.modelAnswerMin}-${MODEL_ANSWER_MAX_CHARS} characters, has ${len}.`)
      }
      if (keyPoints.length < OPEN_KEY_POINTS.min || keyPoints.length > OPEN_KEY_POINTS.max) {
        add('key_point_count', `An open question needs ${OPEN_KEY_POINTS.min}-${OPEN_KEY_POINTS.max} key points, has ${keyPoints.length}.`)
      }
      if (hasDuplicates(keyPoints)) add('duplicate_key_points', 'Two key points are the same.')
      if (keyPoints.some((k) => k.length < OPEN_ANSWER_LIMITS.keyPointMin || k.length > OPEN_ANSWER_LIMITS.keyPointMax)) {
        add('key_point_length', `A key point needs ${OPEN_ANSWER_LIMITS.keyPointMin}-${OPEN_ANSWER_LIMITS.keyPointMax} characters.`)
      }
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

/** Issue code of a bad `correctChoiceIndexes` list (model output of generation and of question import). */
export const INVALID_CHOICE_INDEXES = 'invalid_correct_choice_indexes'

/**
 * The stored `correctAnswer` of a question whose model output names the correct options by their 0-based index in
 * `choices`, so the model never retypes or JSON-encodes option text (LaTeX backslashes break both):
 *   - single_choice, dropdown: exactly one index; the answer is that option's text, byte for byte;
 *   - multiple_choice: one or more distinct indexes; the answer is JSON.stringify of the selected option texts in
 *     choice order;
 *   - numeric: no indexes; `fallback` (the numeric string the model wrote) is returned unchanged.
 * Anything else is a structural problem with code INVALID_CHOICE_INDEXES. Unknown types are left to
 * validateExerciseStructure (the fallback is returned).
 */
export function deriveChoiceAnswer(
  type: string,
  choices: string[],
  indexes: number[],
  fallback: string,
): { ok: true; correctAnswer: string } | { ok: false; issue: ValidationIssue } {
  const fail = (message: string) => ({ ok: false as const, issue: { code: INVALID_CHOICE_INDEXES, message } })
  const list = Array.isArray(indexes) ? indexes : []
  if (type === 'numeric' || type === 'open') {
    return list.length === 0 ? { ok: true, correctAnswer: fallback } : fail(`A ${type} question must have no correct choice indexes.`)
  }
  if (type !== 'single_choice' && type !== 'multiple_choice' && type !== 'dropdown') return { ok: true, correctAnswer: fallback }
  if (list.length === 0) return fail('No correct choice index was given.')
  const bad = list.find((i) => !Number.isInteger(i) || i < 0 || i >= choices.length)
  if (bad !== undefined) return fail(`Correct choice index ${bad} is out of range (0-${choices.length - 1}).`)
  if (new Set(list).size !== list.length) return fail('The same correct choice index is listed twice.')
  if (type !== 'multiple_choice') {
    return list.length === 1 ? { ok: true, correctAnswer: choices[list[0]] } : fail(`${type} needs exactly one correct choice index, got ${list.length}.`)
  }
  return { ok: true, correctAnswer: JSON.stringify([...list].sort((a, b) => a - b).map((i) => choices[i])) }
}

/** One-line summary of issues for audit storage. */
export function summarizeIssues(issues: ValidationIssue[]): string {
  return issues.map((i) => i.code).join(',')
}
