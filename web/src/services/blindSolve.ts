import { generateObject } from 'ai'
import { z } from 'zod'
import { textModel } from '@/lib/ai'
import { gradeAnswer, resolveExerciseType } from '@/lib/grading'
import { dropdownAnswerFor, dropdownOption } from '@/lib/exerciseValidation'
import { blindSolvePrompt } from '@/lib/prompts'

export const blindSolveSchema = z.object({
  answerable: z.boolean(),
  issue: z.string(),
  answer: z.array(z.string()),
})
export type BlindSolution = z.infer<typeof blindSolveSchema>

export interface BlindSolveInput {
  questionText: string
  exerciseType: string
  /** Choices as stored (array or JSON string). */
  choices: string[] | string
  correctAnswer: string
}

export interface BlindSolveResult {
  passed: boolean
  /** Why it failed ('' when it passed). */
  reason: string
  answerable: boolean
  /** The answer string as the flashcard would have produced it. */
  userAnswer: string
  score: number
  ms: number
}

function toChoiceList(choices: BlindSolveInput['choices']): string[] {
  if (Array.isArray(choices)) return choices.map(String)
  try {
    const parsed = JSON.parse(choices)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

/** The answer string the flashcard would send for a solver's answer list, per rendered type. */
export function solutionToUserAnswer(type: string, answer: string[]): string {
  switch (type) {
    case 'multiple_choice':
      return JSON.stringify(answer)
    case 'dropdown':
      return answer.length > 0 ? dropdownAnswerFor(dropdownOption(answer[0])) : ''
    default:
      return answer[0] ?? ''
  }
}

/**
 * Pure part of the check. A question passes when the solver says it is answerable and its answer grades as FULLY
 * correct (`isCorrect`, score 1) against the stored answer with the one grader. Partial credit does not pass: a
 * multi-select question that a competent solver gets only partly right is ambiguous or wrong, and the student
 * would be graded against the same key.
 */
export function judgeSolution(ex: BlindSolveInput, solution: BlindSolution): Omit<BlindSolveResult, 'ms'> {
  const choices = toChoiceList(ex.choices)
  const type = resolveExerciseType({ exerciseType: ex.exerciseType, choices, questionText: ex.questionText })
  const userAnswer = solutionToUserAnswer(type, solution.answer)
  const grade = gradeAnswer({ exerciseType: ex.exerciseType, choices, correctAnswer: ex.correctAnswer, questionText: ex.questionText }, userAnswer)
  if (!solution.answerable) {
    return { passed: false, reason: `not_answerable: ${solution.issue.trim() || 'no reason given'}`, answerable: false, userAnswer, score: grade.score }
  }
  if (!grade.isCorrect) {
    return { passed: false, reason: `mismatch (score ${Math.round(grade.score * 100) / 100}): solver answered ${userAnswer || '(nothing)'}`, answerable: true, userAnswer, score: grade.score }
  }
  return { passed: true, reason: '', answerable: true, userAnswer, score: grade.score }
}

/** One model call: the solver sees the question text, the type and the choices, nothing else. */
export async function blindSolve(ex: BlindSolveInput): Promise<BlindSolveResult> {
  const choices = toChoiceList(ex.choices)
  const type = resolveExerciseType({ exerciseType: ex.exerciseType, choices, questionText: ex.questionText })
  const shownChoices = type === 'dropdown' ? choices.map(dropdownOption) : choices
  const started = Date.now()
  const { object } = await generateObject({
    model: textModel(),
    schema: blindSolveSchema,
    prompt: blindSolvePrompt({ questionText: ex.questionText, exerciseType: type, choices: shownChoices }),
  })
  const ms = Date.now() - started
  return { ...judgeSolution(ex, object), ms }
}
