// One structured model call of an ingestion stage: one retry, token accounting, readable failure. Shared by
// segmentation and question import so both count calls the same way.
import { generateObject } from 'ai'
import type { ZodType, z } from 'zod'
import { textModel } from '@/lib/ai'

export type GenerateObjectFn = typeof generateObject

/** An expected failure of a stage. `message` is a plain sentence that is safe to show to the student (stored in Source.error). */
export class StageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StageError'
  }
}

export type ModelStats = {
  /** Attempts sent to the model (a retry counts). The SDK may repeat a request once more on a transient HTTP error. */
  calls: number
  /** Attempts that failed or returned an unusable answer. */
  failedCalls: number
  inputTokens: number
  outputTokens: number
}

export function newModelStats(): ModelStats {
  return { calls: 0, failedCalls: 0, inputTokens: 0, outputTokens: 0 }
}

export function addModelStats(into: ModelStats, from: ModelStats): void {
  into.calls += from.calls
  into.failedCalls += from.failedCalls
  into.inputTokens += from.inputTokens
  into.outputTokens += from.outputTokens
}

/** Attempts per call: the first one and one retry. */
export const MODEL_ATTEMPTS = 2
const CALL_TIMEOUT_MS = 240_000

type Usage = { inputTokens?: number; outputTokens?: number; promptTokens?: number; completionTokens?: number } | undefined

/**
 * Calls the model for `schema`; `check` may reject a schema-valid answer by returning a reason ("no topics"). A failed
 * attempt is retried once, then a StageError("<what> failed twice: <reason>") is thrown. The provider's own error text
 * is logged on the server and never put into the message.
 */
export async function structuredCall<S extends ZodType>(opts: {
  generate?: GenerateObjectFn
  schema: S
  prompt: string
  what: string
  stats: ModelStats
  check?: (object: z.infer<S>) => string | null
}): Promise<z.infer<S>> {
  const generate = (opts.generate ?? generateObject) as unknown as (args: Record<string, unknown>) => Promise<{ object: z.infer<S>; usage?: Usage }>
  let reason = 'the model request failed'
  for (let attempt = 1; attempt <= MODEL_ATTEMPTS; attempt++) {
    opts.stats.calls++
    try {
      const result = await generate({ model: textModel(), schema: opts.schema, prompt: opts.prompt, maxRetries: 1, abortSignal: AbortSignal.timeout(CALL_TIMEOUT_MS) })
      const usage = result.usage
      opts.stats.inputTokens += usage?.inputTokens ?? usage?.promptTokens ?? 0
      opts.stats.outputTokens += usage?.outputTokens ?? usage?.completionTokens ?? 0
      const problem = result.object == null ? 'the model returned no answer' : opts.check?.(result.object)
      if (!problem) return result.object
      reason = problem
      opts.stats.failedCalls++
      console.warn(`[ingest] ${opts.what}: unusable answer (attempt ${attempt}/${MODEL_ATTEMPTS}): ${problem}`)
    } catch (error) {
      opts.stats.failedCalls++
      reason = 'the model request failed or returned an unusable answer'
      console.warn(`[ingest] ${opts.what}: attempt ${attempt}/${MODEL_ATTEMPTS} failed:`, error instanceof Error ? error.message.slice(0, 300) : error)
    }
  }
  throw new StageError(`${opts.what} failed twice (${reason}).`)
}
