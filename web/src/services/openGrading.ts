import { generateObject } from 'ai'
import { prisma } from '@/lib/db'
import { textModel } from '@/lib/ai'
import { OpenGradeSchema, parseKeyPoints, scoreOpenGrade, type GradedBy, type OpenFeedback } from '@/lib/openAnswer'
import { gradeOpenAnswerPrompt } from '@/lib/prompts'
import { parseProfile } from '@/lib/studyspace/profile'
import { mapWithConcurrency } from '@/server/ingest/pool'

export type GenerateObjectFn = typeof generateObject

/** One model call may take this long before it is abandoned. */
export const GRADE_OPEN_TIMEOUT_MS = 25_000
/** Attempts per answer: study mode asks once (the student can self-assess), exam checking twice. */
export const STUDY_GRADE_ATTEMPTS = 1
export const EXAM_GRADE_ATTEMPTS = 2
/** Written exam answers checked at the same time. */
export const GRADE_PENDING_CONCURRENCY = 3

export interface GradeOpenInput {
  questionText: string
  /** The model answer (Exercise.correctAnswer). */
  modelAnswer: string
  keyPoints: string[]
  studentAnswer: string
  /** BCP-47 code of the feedback language (profile.contentLanguage); defaults to "en". */
  language?: string
}

export interface GradeOpenOptions {
  /** Injectable for tests; defaults to the AI SDK's generateObject. */
  generate?: GenerateObjectFn
  /** Model calls before giving up (default 1). */
  attempts?: number
  /** Per-call timeout in ms (default GRADE_OPEN_TIMEOUT_MS). */
  timeoutMs?: number
}

export interface OpenGradeResult {
  score: number
  isCorrect: boolean
  offTask: boolean
  /** Ready to store in ExerciseLog.feedback (JSON.stringify). */
  feedback: OpenFeedback
  /** Latency of the successful call. */
  ms: number
}

/**
 * Grades one written answer with one structured model call; the score is computed in code (scoreOpenGrade).
 * Returns null when the answer could not be checked: no key points, or every attempt timed out, failed or came back
 * with unusable key-point indexes. Never throws. Provider error text is logged (cut short) and never returned.
 */
export async function gradeOpenAnswer(input: GradeOpenInput, opts: GradeOpenOptions = {}): Promise<OpenGradeResult | null> {
  const keyPoints = input.keyPoints.map((k) => k.trim()).filter(Boolean)
  if (keyPoints.length === 0) return null
  const generate = (opts.generate ?? generateObject) as unknown as (args: Record<string, unknown>) => Promise<{ object: unknown }>
  const attempts = Math.max(1, Math.floor(opts.attempts ?? STUDY_GRADE_ATTEMPTS))
  const prompt = gradeOpenAnswerPrompt({
    questionText: input.questionText,
    modelAnswer: input.modelAnswer,
    keyPoints,
    studentAnswer: input.studentAnswer,
    language: input.language || 'en',
  })

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const started = Date.now()
    try {
      const { object } = await generate({
        model: textModel(),
        schema: OpenGradeSchema,
        prompt,
        maxRetries: 1,
        abortSignal: AbortSignal.timeout(opts.timeoutMs ?? GRADE_OPEN_TIMEOUT_MS),
      })
      const parsed = OpenGradeSchema.safeParse(object)
      const scored = parsed.success ? scoreOpenGrade(parsed.data, keyPoints.length) : null
      if (!parsed.success || !scored) {
        console.warn(`[open-grading] unusable grade (attempt ${attempt}/${attempts}): ${parsed.success ? 'key point indexes' : 'schema'}`)
        continue
      }
      const byIndex = new Map(parsed.data.keyPoints.map((k) => [k.index, k.status]))
      return {
        score: scored.score,
        isCorrect: scored.isCorrect,
        offTask: parsed.data.offTask,
        feedback: {
          v: 1,
          keyPoints: keyPoints.map((point, i) => ({ point, status: byIndex.get(i)! })),
          misconceptions: parsed.data.misconceptions.map((m) => m.trim()).filter(Boolean),
          text: parsed.data.feedback.trim(),
        },
        ms: Date.now() - started,
      }
    } catch (error) {
      console.warn(`[open-grading] attempt ${attempt}/${attempts} failed:`, error instanceof Error ? error.message.slice(0, 300) : 'unknown error')
    }
  }
  return null
}

/** The feedback language of an exercise's studyspace (profile.contentLanguage), "en" when there is no profile. */
export function contentLanguageOf(courseProfileJson: string | null | undefined): string {
  return parseProfile(courseProfileJson)?.contentLanguage ?? 'en'
}

export interface GradePendingResult {
  /** Written answers checked by this call. */
  graded: number
  /** Written answers that could not be checked (they stay pending). */
  failed: number
  /** Written answers of the session still waiting after this call (counting 0 until checked). */
  pending: number
}

/**
 * Checks the written answers of a completed exam that are still `pending`: three at a time, each with up to two model
 * attempts, each result written with a guarded update (`gradedBy` must still be 'pending', so two simultaneous calls
 * never write twice and a result is never overwritten). One answer failing never stops the others. Safe to repeat.
 * Returns null for an unknown session or one that is not completed.
 */
export async function gradePendingOpenLogs(sessionId: string, opts: Pick<GradeOpenOptions, 'generate' | 'timeoutMs'> = {}): Promise<GradePendingResult | null> {
  const session = await prisma.studySession.findUnique({ where: { id: sessionId }, select: { status: true } })
  if (!session || session.status !== 'completed') return null

  const logs = await prisma.exerciseLog.findMany({
    where: { sessionId, gradedBy: 'pending' },
    orderBy: { timestamp: 'asc' },
    select: {
      id: true,
      userAnswer: true,
      exercise: {
        select: { questionText: true, correctAnswer: true, keyPoints: true, topic: { select: { course: { select: { profile: true } } } } },
      },
    },
  })

  let graded = 0
  let failed = 0
  await mapWithConcurrency(logs, GRADE_PENDING_CONCURRENCY, async (log) => {
    try {
      const result = await gradeOpenAnswer(
        {
          questionText: log.exercise.questionText,
          modelAnswer: log.exercise.correctAnswer,
          keyPoints: parseKeyPoints(log.exercise.keyPoints),
          studentAnswer: log.userAnswer ?? '',
          language: contentLanguageOf(log.exercise.topic.course?.profile),
        },
        { ...opts, attempts: EXAM_GRADE_ATTEMPTS },
      )
      if (!result) {
        failed++
        return
      }
      const written = await prisma.exerciseLog.updateMany({
        where: { id: log.id, gradedBy: 'pending' },
        data: { score: result.score, isCorrect: result.isCorrect, gradedBy: 'model' satisfies GradedBy, feedback: JSON.stringify(result.feedback) },
      })
      if (written.count > 0) graded++
    } catch (error) {
      failed++
      console.error('[open-grading] could not check a written exam answer:', error instanceof Error ? error.message.slice(0, 300) : 'unknown error')
    }
  })

  const pending = await prisma.exerciseLog.count({ where: { sessionId, gradedBy: 'pending' } })
  return { graded, failed, pending }
}
