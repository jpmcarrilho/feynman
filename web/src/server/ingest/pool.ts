// Bounded concurrency for the ingestion stages (plan 4.3: LLM calls inside a stage run three at a time). No dependency.

/** Calls inside one stage run this many at a time. */
export const STAGE_CONCURRENCY = 3

/**
 * Runs `fn` over `items` with at most `limit` in flight and returns the results in input order. The first rejection
 * stops new items from starting and is rethrown once the running ones have settled.
 */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  let failure: { error: unknown } | null = null
  const worker = async () => {
    while (!failure && next < items.length) {
      const i = next++
      try {
        results[i] = await fn(items[i], i)
      } catch (error) {
        failure ??= { error }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  if (failure) throw (failure as { error: unknown }).error
  return results
}
