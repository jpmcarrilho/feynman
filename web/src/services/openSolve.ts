import { generateObject } from 'ai'
import { z } from 'zod'
import { textModel } from '@/lib/ai'
import { openSolvePrompt } from '@/lib/prompts'

/** Structured output of the solver. No defaults, no unions (structured-output rules). */
export const openSolveSchema = z.object({
  answerable: z.boolean(),
  issue: z.string(),
  answer: z.string(),
})
export type OpenSolution = z.infer<typeof openSolveSchema>

export type GenerateObjectFn = typeof generateObject

/** One solver call may take this long before it is abandoned. */
export const OPEN_SOLVE_TIMEOUT_MS = 40_000

export interface OpenSolveInput {
  questionText: string
  /** The grounding text the question was generated from (the same window the generator saw). */
  groundingContext: string
  /** BCP-47 code of the answer language; defaults to "en". */
  language?: string
}

export interface OpenSolveResult extends OpenSolution {
  /** Latency of the call in ms. */
  ms: number
}

/**
 * One model call: a "student" with the same grounding window answers the question. The model answer and the key points
 * are never sent. Model and provider errors propagate (the generator lets them through like a blind-solve error).
 * `generate` is injectable for tests.
 */
export async function openSolve(input: OpenSolveInput, opts: { generate?: GenerateObjectFn; timeoutMs?: number } = {}): Promise<OpenSolveResult> {
  const generate = (opts.generate ?? generateObject) as unknown as (args: Record<string, unknown>) => Promise<{ object: unknown }>
  const started = Date.now()
  const { object } = await generate({
    model: textModel(),
    schema: openSolveSchema,
    prompt: openSolvePrompt({ questionText: input.questionText, groundingContext: input.groundingContext, language: input.language || 'en' }),
    maxRetries: 1,
    abortSignal: AbortSignal.timeout(opts.timeoutMs ?? OPEN_SOLVE_TIMEOUT_MS),
  })
  const parsed = openSolveSchema.parse(object)
  return { ...parsed, answer: parsed.answer.trim(), issue: parsed.issue.trim(), ms: Date.now() - started }
}
