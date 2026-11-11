// Runs once when the Next.js server starts (docs: instrumentation.md, "called once when a new Next.js server instance is
// initiated, and must complete before the server is ready"). Picks up the ingestion work a restart interrupted. Nothing is awaited
// here: the runner queues the unfinished sources and works on them in the background.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  // `next build` loads the app to collect page data; it must not start any work
  if (process.env.NEXT_PHASE === 'phase-production-build') return
  const { resumePendingSources } = await import('@/server/ingest/runner')
  void resumePendingSources()
    .then((queued) => {
      if (queued.sources + queued.starters > 0) console.log(`[ingest] resuming ${queued.sources} file(s) and ${queued.starters} starter job(s)`)
    })
    .catch((error) => console.error('[ingest] could not resume pending work:', error))
}
