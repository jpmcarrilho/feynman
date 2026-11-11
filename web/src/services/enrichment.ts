import { generateObject } from 'ai'
import { z } from 'zod'
import { after } from 'next/server'
import { textModel } from '@/lib/ai'
import { prisma } from '@/lib/db'
import { enrichExercisePrompt } from '@/lib/prompts'
import { findAnswerLeak, findEnrichmentDamage, isEnrichmentCandidate, type EnrichableExercise } from '@/lib/enrichmentChecks'
import { LEGACY_VOICE_PROFILE } from '@/lib/studyspace/legacyProfiles'
import { getCourseWithProfile } from '@/services/studyspaceService'
import { blindSolve } from '@/services/blindSolve'
import { getGlobalContext, getPrecedingTopicsContext } from '@/services/contextSearch'

/**
 * Context enrichment of imported questions. Many were extracted from a sequence and refer to things the student cannot
 * see when a question is played alone ("according to column 2 of Table 2"); a model call rewrites the text with the
 * missing setup from lecture context.
 *
 * Session start never waits for it: `enrichInBackground` runs after the response, on questions the student has not
 * answered and that are not in the new session, so no question changes under a student's eyes. Enrichment is gated by a
 * blind solve: only questions the solver cannot answer as written are rewritten, and a rewrite is kept only if the
 * solver then answers it correctly.
 *
 * Session-start scheduling is OFF unless ENRICH_IN_BACKGROUND=1 (see `isBackgroundEnrichmentEnabled`); the functions
 * below can be called directly regardless of the flag.
 *
 * Measurements on imported MIT questions (real model, scratch copy of the database):
 * - Ungated (rewrite every question, checks only): 30 questions, 2 of them not answerable as written, none of those
 *   2 legitimately fixed; 4 to 6 rewrites leaked the answer (option text or worked solution pasted from the context),
 *   one fabricated a table, and one accepted rewrite turned an answerable question into an unanswerable one.
 * - Gated (this flow): 80 questions, 108 model calls (1.35 per question), 54 answerable and correct, 9 answerable but
 *   the solver disagreed with the key, 17 not answerable; 3 rewrites kept, 14 discarded (5 unchanged, 7 still not
 *   answerable, 1 wrong answer, 1 invalid). Of the 3 kept, 1 was a plain addition of missing setup, 1 replaced the
 *   question's scenario with a different one found in the context, 1 added setup that hints at the answer.
 * Known blind spots of the gate: a rewrite can substitute a different scenario from the context, and it can hint at
 * the answer without repeating any option, so neither the leak check nor the solver rejects it.
 */

/** True only when the environment variable ENRICH_IN_BACKGROUND is exactly "1". Read at call time. */
export function isBackgroundEnrichmentEnabled(): boolean {
  return process.env.ENRICH_IN_BACKGROUND === '1'
}

/** Model calls started per session start. */
export const ENRICH_MAX_PER_SESSION_START = 5
export const ENRICH_CONCURRENCY = 3

export interface EnrichableRow extends EnrichableExercise {
  id: string
  topicId: string
  questionText: string
  exerciseType: string
  choices: string | string[] | null
  correctAnswer: string
  explanation?: string | null
  originalQuestionText?: string | null
  topic?: { id?: string; courseId: string; week: string | null; order: number; className?: string | null; sourceId?: string | null } | null
}

export type EnrichmentOutcome =
  /** The solver answered the current text correctly: no context problem, marked done. */
  | { status: 'triaged-answerable'; calls: number }
  /** Answerable but the solver's answer differs from the key (wrong key or ambiguous question): marked done, text kept. */
  | { status: 'triaged-solver-disagrees'; calls: number; reason: string }
  /** Not answerable, rewritten, and the solver then answered the new text correctly. */
  | { status: 'enriched'; calls: number; questionText: string }
  /** Not answerable; the rewrite was discarded (leak:..., invalid:..., still-not-answerable, wrong-answer). Text kept, marked done. */
  | { status: 'enrichment-rejected'; calls: number; reason: string }
  | { status: 'skipped'; calls: number }
  /** A model call failed or the call budget ran out: nothing stored, retried by a later run. */
  | { status: 'failed' | 'deferred'; calls: number }

/** Ids being enriched by this process, so two quick session starts do not pay for the same question twice. */
const inFlight = new Set<string>()

/** Lecture context for a question: preceding lectures, else a course-wide search, else the topics of its week. */
async function loadContext(topic: NonNullable<EnrichableRow['topic']>, questionText: string): Promise<string> {
  let contextText = await getPrecedingTopicsContext(topic)
  if (!contextText) contextText = await getGlobalContext(topic.courseId, questionText)
  if (!contextText) {
    const weekTopics = await prisma.topic.findMany({ where: { courseId: topic.courseId, week: topic.week } })
    contextText = weekTopics.map((t) => `Topic: ${t.title}\nContent:\n${t.content || ''}`).join('\n\n')
  }
  return contextText ?? ''
}

function parseChoices(choices: EnrichableRow['choices']): string[] {
  if (Array.isArray(choices)) return choices.map(String)
  try {
    const parsed = choices ? JSON.parse(choices) : []
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

/** Model calls one batch may start: triage 1 per question, 3 for a question that needs enrichment. */
export const ENRICH_MAX_CALLS_PER_BATCH = 8

/** Shared by the questions of one batch; `take` reserves calls atomically (single-threaded JS, no await between check and add). */
export class CallBudget {
  used = 0
  constructor(readonly max: number) {}
  take(n: number): boolean {
    if (this.used + n > this.max) return false
    this.used += n
    return true
  }
}

function logOutcome(id: string, label: string) {
  console.info(`[enrichment] ${id} ${label}`)
}

/**
 * Gated enrichment of one question; the outcome is logged server-side (one line, no schema column records it).
 *
 * 1. Triage: blind-solve the current text (1 call). Answerable and solved correctly, or answerable but the solver
 *    disagrees with the key: nothing to enrich, `enrichedAt` is set, text and `originalQuestionText` untouched.
 * 2. Not answerable: enrich (1 call, context capped in the prompt builder), run the leak and validity checks, then
 *    blind-solve the result (1 call). The rewrite is kept only if it is answerable and solved correctly; otherwise it is
 *    discarded and `enrichedAt` is set.
 *
 * A model failure, or too little budget left for the 2 extra calls, stores nothing so a later run retries.
 * `originalQuestionText` is written once with the first text change and never overwritten; writes only apply to a row
 * whose `enrichedAt` is still null.
 */
export async function enrichExercise(exercise: EnrichableRow, budget: CallBudget = new CallBudget(ENRICH_MAX_CALLS_PER_BATCH)): Promise<EnrichmentOutcome> {
  if (!isEnrichmentCandidate(exercise) || !exercise.topic) return { status: 'skipped', calls: 0 }
  if (!budget.take(1)) return { status: 'deferred', calls: 0 }
  let calls = 1
  const markDone = (data: Record<string, unknown> = {}) =>
    prisma.exercise.updateMany({ where: { id: exercise.id, enrichedAt: null }, data: { enrichedAt: new Date(), ...data } })
  try {
    const choices = parseChoices(exercise.choices)
    const solveInput = { questionText: exercise.questionText, exerciseType: exercise.exerciseType, choices, correctAnswer: exercise.correctAnswer }
    const triage = await blindSolve(solveInput)
    if (triage.passed) {
      await markDone()
      logOutcome(exercise.id, 'triaged-answerable')
      return { status: 'triaged-answerable', calls }
    }
    if (triage.answerable) {
      await markDone()
      logOutcome(exercise.id, `triaged-solver-disagrees: ${triage.reason}`)
      return { status: 'triaged-solver-disagrees', calls, reason: triage.reason }
    }
    if (!budget.take(2)) return { status: 'deferred', calls }

    const reject = async (reason: string): Promise<EnrichmentOutcome> => {
      await markDone()
      logOutcome(exercise.id, `enrichment-rejected:${reason}`)
      return { status: 'enrichment-rejected', calls, reason }
    }

    const contextText = await loadContext(exercise.topic, exercise.questionText)
    const course = await getCourseWithProfile(exercise.topic.courseId)
    const prompt = enrichExercisePrompt(course?.profile ?? LEGACY_VOICE_PROFILE, { contextText, exercise, choices, courseCode: course?.code })
    const { object } = await generateObject({ model: textModel(), schema: z.object({ enrichedQuestionText: z.string() }), prompt })
    calls++
    const enriched = object?.enrichedQuestionText ?? ''

    const checked = { questionText: exercise.questionText, exerciseType: exercise.exerciseType, choices, correctAnswer: exercise.correctAnswer, explanation: exercise.explanation }
    if (!enriched.trim() || enriched.trim() === exercise.questionText.trim()) return reject('unchanged')
    const leak = findAnswerLeak(checked, exercise.questionText, enriched)
    if (leak) return reject(`leak: ${leak}`)
    const damage = findEnrichmentDamage(checked, enriched)
    if (damage) return reject(`invalid: ${damage}`)

    const verify = await blindSolve({ ...solveInput, questionText: enriched })
    calls++
    if (!verify.answerable) return reject('still-not-answerable')
    if (!verify.passed) return reject('wrong-answer')

    await markDone({
      questionText: enriched,
      ...(exercise.originalQuestionText == null ? { originalQuestionText: exercise.questionText } : {}),
    })
    logOutcome(exercise.id, 'enriched')
    return { status: 'enriched', calls, questionText: enriched }
  } catch (error) {
    console.error(`Failed to enrich exercise ${exercise.id} with context:`, error)
    return { status: 'failed', calls }
  }
}

/**
 * Processes up to `limit` candidates (those that pass the skip rules) with `concurrency` workers, within one shared
 * call budget (`maxCalls`). Never throws.
 */
export async function enrichBatch(
  exercises: EnrichableRow[],
  opts: { limit?: number; concurrency?: number; maxCalls?: number } = {},
): Promise<EnrichmentOutcome[]> {
  const limit = opts.limit ?? ENRICH_MAX_PER_SESSION_START
  const concurrency = opts.concurrency ?? ENRICH_CONCURRENCY
  const budget = new CallBudget(opts.maxCalls ?? ENRICH_MAX_CALLS_PER_BATCH)
  const queue = exercises.filter((e) => isEnrichmentCandidate(e) && !inFlight.has(e.id)).slice(0, limit)
  queue.forEach((e) => inFlight.add(e.id))
  const outcomes: EnrichmentOutcome[] = new Array(queue.length)
  let next = 0
  const worker = async () => {
    while (next < queue.length) {
      const i = next++
      try {
        outcomes[i] = await enrichExercise(queue[i], budget)
      } finally {
        inFlight.delete(queue[i].id)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker))
  return outcomes
}

/** Loads the exercises (with their topics) by id and runs `enrichBatch`. General entry point: no course assumptions. */
export async function enrichExercisesByIds(ids: string[], opts: Parameters<typeof enrichBatch>[1] = {}): Promise<EnrichmentOutcome[]> {
  if (ids.length === 0) return []
  const rows = await prisma.exercise.findMany({ where: { id: { in: ids } }, include: { topic: true } })
  return enrichBatch(rows as unknown as EnrichableRow[], opts)
}

/**
 * Runs `enrichBatch` after the current response is sent (Next's `after`). Outside a request, where `after` is not
 * available, it falls back to a detached promise. Never delays or fails the caller.
 */
export function enrichInBackground(exercises: EnrichableRow[]): void {
  if (exercises.length === 0) return
  const run = () => enrichBatch(exercises).catch((e) => console.error('Background enrichment failed:', e))
  try {
    after(run)
  } catch {
    void run()
  }
}
