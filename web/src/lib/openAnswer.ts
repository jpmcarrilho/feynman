/**
 * Written ("open") answers: limits, the grader's output schema, the score rule and the stored feedback shape.
 * Pure and client-safe (no server imports): the answer card, the validator and the server grader share it.
 */
import { z } from 'zod'

/** Fewest non-space characters a written answer needs before it can be checked. */
export const OPEN_ANSWER_MIN_CHARS = 15
/** Most characters of a written answer that are stored, sent to the grader and accepted by the answer route. */
export const OPEN_ANSWER_MAX_CHARS = 2000
/** How many key points a question carries. */
export const OPEN_KEY_POINTS = { min: 2, max: 4 } as const
/** Longest model answer of a stored open question. */
export const MODEL_ANSWER_MAX_CHARS = 1500

/** What the student can give themselves when the model could not check the answer: all of it, some of it, not really. */
export const SELF_SCORES = [1, 0.5, 0] as const
export type SelfScore = (typeof SELF_SCORES)[number]

export const KEY_POINT_STATUSES = ['covered', 'partly', 'missing'] as const
export type KeyPointStatus = (typeof KEY_POINT_STATUSES)[number]

/** Where a stored open-answer score came from: the model, the student, or a written exam answer not checked yet. */
export type GradedBy = 'model' | 'self' | 'pending'

/**
 * What the grading model returns. Sent as a structured-output schema, so: no defaults, no unions. `keyPoints` lists
 * every key point once by its 0-based index; the score is computed in code (scoreOpenGrade), never by the model.
 */
export const OpenGradeSchema = z.object({
  offTask: z.boolean(),
  keyPoints: z.array(
    z.object({
      index: z.number().int(),
      status: z.enum(KEY_POINT_STATUSES),
      note: z.string(),
    }),
  ),
  misconceptions: z.array(z.string()),
  feedback: z.string(),
})
export type OpenGrade = z.infer<typeof OpenGradeSchema>

const STATUS_VALUE: Record<KeyPointStatus, number> = { covered: 1, partly: 0.5, missing: 0 }

/**
 * The score of a model grade: covered 1, partly 0.5, missing 0; the mean rounded to 0.01; any misconception caps it at
 * 0.5; an off-task answer gets 0. Null (unusable output) unless `keyPoints` holds exactly the indexes 0..n-1 once each,
 * n being the number of key points of the question.
 */
export function scoreOpenGrade(grade: OpenGrade, keyPointCount: number): { score: number; isCorrect: boolean } | null {
  if (!Number.isInteger(keyPointCount) || keyPointCount < 1) return null
  if (!Array.isArray(grade.keyPoints) || grade.keyPoints.length !== keyPointCount) return null
  const seen = new Set<number>()
  for (const k of grade.keyPoints) {
    if (!Number.isInteger(k.index) || k.index < 0 || k.index >= keyPointCount || seen.has(k.index)) return null
    seen.add(k.index)
  }
  let score = 0
  if (!grade.offTask) {
    const mean = grade.keyPoints.reduce((sum, k) => sum + STATUS_VALUE[k.status], 0) / keyPointCount
    score = Math.round(mean * 100) / 100
    if (grade.misconceptions.some((m) => m.trim())) score = Math.min(score, 0.5)
  }
  return { score, isCorrect: score === 1 }
}

/** The key points of a stored exercise (JSON string[] column, or an array): trimmed non-empty strings; [] when unusable. */
export function parseKeyPoints(raw: unknown): string[] {
  let value = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      return []
    }
  }
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean)
}

/** Stored in ExerciseLog.feedback (JSON). */
export interface OpenFeedback {
  v: 1
  keyPoints: { point: string; status: KeyPointStatus }[]
  misconceptions: string[]
  /** The grader's feedback to the student (Markdown with `$…$` math allowed); '' for a self-assessed answer. */
  text: string
  /** Present when the student scored the answer themselves. */
  selfScore?: SelfScore
}

/** Reads ExerciseLog.feedback defensively; null when it is empty or not the expected shape. */
export function parseOpenFeedback(raw: unknown): OpenFeedback | null {
  let value = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const o = value as Record<string, unknown>
  if (o.v !== 1) return null
  const keyPoints = Array.isArray(o.keyPoints)
    ? o.keyPoints.flatMap((k) => {
        const kp = k as { point?: unknown; status?: unknown } | null
        return kp && typeof kp.point === 'string' && (KEY_POINT_STATUSES as readonly unknown[]).includes(kp.status)
          ? [{ point: kp.point, status: kp.status as KeyPointStatus }]
          : []
      })
    : []
  const misconceptions = Array.isArray(o.misconceptions) ? o.misconceptions.filter((m): m is string => typeof m === 'string') : []
  const feedback: OpenFeedback = { v: 1, keyPoints, misconceptions, text: typeof o.text === 'string' ? o.text : '' }
  if ((SELF_SCORES as readonly unknown[]).includes(o.selfScore)) feedback.selfScore = o.selfScore as SelfScore
  return feedback
}

/**
 * The student's text as it enters the grading prompt: cut to OPEN_ANSWER_MAX_CHARS, then any `<student_answer>` or
 * `</student_answer>` tag in it is defused (the `<` becomes `&lt;`) so the answer cannot close the block that quotes it.
 */
export function escapeStudentAnswer(text: string): string {
  return String(text ?? '')
    .slice(0, OPEN_ANSWER_MAX_CHARS)
    .replace(/<(\s*\/?\s*student_answer)/gi, '&lt;$1')
}

/** True when the answer has at least OPEN_ANSWER_MIN_CHARS non-space characters (and is not above the maximum). */
export function isOpenAnswerLongEnough(text: string): boolean {
  return typeof text === 'string' && text.replace(/\s/g, '').length >= OPEN_ANSWER_MIN_CHARS
}

/** Written exam answers that are still waiting for the model (their score counts 0 until they are checked). */
export function countPendingOpen(logs: readonly { gradedBy?: string | null }[]): number {
  return logs.filter((l) => l.gradedBy === 'pending').length
}

/** The result line of a written answer, in the words the other question types use; "Not checked yet" while it is pending. */
export function openResultLabel(result: { score: number; gradedBy?: string | null }): string {
  if (result.gradedBy === 'pending') return 'Not checked yet'
  if (result.score >= 1) return 'Correct'
  if (result.score > 0) return `Partially correct: ${Math.round(result.score * 100) / 100} of 1`
  return 'Incorrect'
}
