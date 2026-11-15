// Background runner of the ingestion pipeline (plan 4.3): takes uploaded sources to `ready` inside the one local Node process.
//
//  Queue      One in-memory FIFO and one loop per process, kept on globalThis so a hot reload of this module (next dev) and the
//             separate bundles of the route, the server actions and instrumentation.ts all share it: never two loops.
//  Hooks      Terminal hooks are registered by name on the same shared state (onSourceTerminal), so a hook registered through one
//             copy of this module runs from a loop started by another, and a hot reload replaces a hook instead of stacking it.
//  Claim      A source is worked on only by the holder of its lease (Source.leaseExpiresAt): an atomic update that succeeds when
//             the lease is empty or expired. The value written is the holder's token; renewals and the release compare it.
//  Lease      LEASE_MS long, renewed every HEARTBEAT_MS by a timer while a stage runs (a stage may take minutes), so a live worker
//             is never robbed. If a renewal ever finds a different value (lease lost) the worker stops after the current stage.
//  Crash      A worker that dies leaves its lease to expire (at most LEASE_MS); the next claim, at boot (instrumentation.ts) or
//             from the status safety net, continues from the source's current status. Stages are idempotent (T21/T22).
//  Order      Sources of one studyspace run one at a time in upload order (createdAt): a job for a source first works through
//             any older unfinished source of the same studyspace.
//  Cancel     removeSource/deleteStudyspace set a cancel flag that is checked between stages and between starter questions,
//             then take the lease themselves before deleting (acquireExclusive).
//  Errors     A stage that throws never ends the loop. Stages record their expected failures themselves; anything else that
//             leaves the source unchanged is recorded here with a generic reason.
import { prisma } from '@/lib/db'
import { parseProfile } from '@/lib/studyspace/profile'
import { courseHasTutor } from './profileState'
import { extractSource } from './extract'
import { segmentSource } from './segment'
import { importQuestionsForSource } from './importQuestions'
import { generateStartersForSource, newStarterBudget, starterNote, stripStarterNote } from './starters'

export type Job = { kind: 'source' | 'starters'; id: string }

/** Tunable for tests. The lease must be several heartbeats long. */
export const tuning = {
  leaseMs: 120_000,
  heartbeatMs: 30_000,
  recheckMinMs: 5_000,
  recheckMaxMs: 5 * 60_000,
  /** How long removal waits for a running stage to reach its next boundary. */
  exclusiveTimeoutMs: 25_000,
}

export const TERMINAL_STATUSES = ['ready', 'failed']
const GENERIC_ERROR = 'Something went wrong while processing this file. Use Retry; if it keeps failing, upload the file again.'
/** Stage recorded in failedStage for an unexpected failure in each status (`uploaded` retries as `extracting`). */
const FAILED_STAGE: Record<string, string> = {
  uploaded: 'extracting', extracting: 'extracting', segmenting: 'segmenting', importing_questions: 'importing_questions', generating_exercises: 'generating_exercises',
}
const MAX_STEPS_PER_SOURCE = 12

// ---------------------------------------------------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------------------------------------------------

type RunnerState = {
  version: 1
  queue: Job[]
  /** Keys of the jobs waiting in `queue`. */
  queued: Set<string>
  running: boolean
  /** Key of the job being processed. */
  current: string | null
  /** `source:<id>` / `starters:<courseId>` keys whose work must stop at the next boundary. */
  cancelled: Set<string>
  timers: Map<string, ReturnType<typeof setTimeout>>
  /** Named hooks called after a source reached ready/failed; shared by every copy of this module. */
  terminalHooks: Map<string, TerminalHook>
}

const holder = globalThis as unknown as { __feynmanIngestRunner?: RunnerState }

function state(): RunnerState {
  const s = (holder.__feynmanIngestRunner ??= {
    version: 1, queue: [], queued: new Set(), running: false, current: null, cancelled: new Set(), timers: new Map(), terminalHooks: new Map(),
  })
  // An older copy of this module (hot reload) may have created the object without newer fields
  s.cancelled ??= new Set()
  s.timers ??= new Map()
  s.terminalHooks ??= new Map()
  s.queued ??= new Set()
  s.queue ??= []
  return s
}

const keyOf = (job: Job) => `${job.kind}:${job.id}`
export const sourceKey = (id: string) => `source:${id}`
export const startersKey = (courseId: string) => `starters:${courseId}`

/** True when nothing is running or waiting in this process. */
export function isRunnerIdle(): boolean {
  const s = state()
  return !s.running && s.queue.length === 0
}

export function runnerSnapshot() {
  const s = state()
  return { running: s.running, current: s.current, queued: s.queue.map(keyOf), cancelled: [...s.cancelled], timers: [...s.timers.keys()] }
}

/** Resolves when this process has nothing running or waiting (used by scripts and tests). */
export async function whenIdle(pollMs = 25): Promise<void> {
  while (!isRunnerIdle()) await new Promise((r) => setTimeout(r, pollMs))
}

// ---------------------------------------------------------------------------------------------------------------------
// Hooks (T25 registers the persona proposal here)
// ---------------------------------------------------------------------------------------------------------------------

export type TerminalHook = (info: { courseId: string; sourceId: string; status: 'ready' | 'failed' }) => Promise<void>
/**
 * Registers `hook` under `name` on the shared state, so every copy of this module (route, actions, instrumentation, hot reload)
 * sees it. Registering the same name again replaces the earlier hook. Called after a source of this process reached `ready` or
 * `failed`; errors are logged and ignored. The returned function removes the entry only if it is still this hook.
 */
export function onSourceTerminal(name: string, hook: TerminalHook): () => void {
  const hooks = state().terminalHooks
  hooks.set(name, hook)
  return () => {
    if (state().terminalHooks.get(name) === hook) state().terminalHooks.delete(name)
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------------------------------------------------

function enqueue(job: Job): boolean {
  const s = state()
  const key = keyOf(job)
  const timer = s.timers.get(key)
  if (timer) {
    clearTimeout(timer)
    s.timers.delete(key)
  }
  if (s.queued.has(key)) return false
  s.queued.add(key)
  s.queue.push(job)
  kick()
  return true
}

/** Queues a source and returns at once. Safe to call for a source that is already queued or finished. */
export function enqueueSource(id: string): void {
  enqueue({ kind: 'source', id })
}

/** Queues the starter-question job of a studyspace and returns at once. */
export function enqueueStarters(courseId: string): void {
  enqueue({ kind: 'starters', id: courseId })
}

function kick(): void {
  const s = state()
  if (s.running) return
  s.running = true
  void loop()
}

async function loop(): Promise<void> {
  const s = state()
  try {
    for (;;) {
      const job = s.queue.shift()
      if (!job) return
      s.queued.delete(keyOf(job))
      s.current = keyOf(job)
      try {
        if (job.kind === 'source') await processSourceJob(job.id)
        else await processStartersJob(job.id)
      } catch (error) {
        console.error(`[ingest] job ${keyOf(job)} failed unexpectedly:`, error)
      }
      s.current = null
    }
  } finally {
    // No await between the last queue check and this line, so a job queued meanwhile restarts the loop through kick()
    s.running = false
    s.current = null
    if (s.queue.length > 0) kick()
  }
}

/** Queues `job` again after `ms` (clamped), once; used when another process holds the lease. */
function scheduleRecheck(job: Job, ms: number): void {
  const s = state()
  const key = keyOf(job)
  if (s.timers.has(key)) return
  const delay = Math.min(tuning.recheckMaxMs, Math.max(tuning.recheckMinMs, ms))
  const timer = setTimeout(() => {
    s.timers.delete(key)
    enqueue(job)
  }, delay)
  timer.unref?.()
  s.timers.set(key, timer)
}

// ---------------------------------------------------------------------------------------------------------------------
// Lease
// ---------------------------------------------------------------------------------------------------------------------

/** A new lease value. The random part keeps two workers from ever writing the same value. */
function newLease(): Date {
  return new Date(Date.now() + tuning.leaseMs + Math.floor(Math.random() * 1000))
}

type LeaseHandle = { token: Date; lost: boolean }

/** Atomically takes the lease of a source. `anyStatus` also takes finished sources (starter pass, removal). Null when someone else holds it. */
export async function claimSource(sourceId: string, opts: { anyStatus?: boolean } = {}): Promise<LeaseHandle | null> {
  const token = newLease()
  const result = await prisma.source.updateMany({
    where: {
      id: sourceId,
      ...(opts.anyStatus ? {} : { status: { notIn: TERMINAL_STATUSES } }),
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: new Date() } }],
    },
    data: { leaseExpiresAt: token },
  })
  return result.count === 1 ? { token, lost: false } : null
}

/** Gives the lease back, only if it is still ours. */
export async function releaseSource(sourceId: string, lease: LeaseHandle): Promise<void> {
  await prisma.source.updateMany({ where: { id: sourceId, leaseExpiresAt: lease.token }, data: { leaseExpiresAt: null } }).catch(() => {})
}

/** Renews the lease every heartbeat while a stage runs. `stop()` waits for a renewal in flight so the release that follows is exact. */
function startHeartbeat(sourceId: string, lease: LeaseHandle): () => Promise<void> {
  let inFlight: Promise<void> | null = null
  const timer = setInterval(() => {
    if (lease.lost || inFlight) return
    inFlight = (async () => {
      try {
        const next = newLease()
        const result = await prisma.source.updateMany({ where: { id: sourceId, leaseExpiresAt: lease.token }, data: { leaseExpiresAt: next } })
        if (result.count === 1) lease.token = next
        else lease.lost = true
      } catch (error) {
        // A busy database: try again at the next beat; the lease has several beats of margin
        console.warn(`[ingest] lease renewal for ${sourceId} failed:`, error instanceof Error ? error.message : error)
      } finally {
        inFlight = null
      }
    })()
  }, tuning.heartbeatMs)
  timer.unref?.()
  return async () => {
    clearInterval(timer)
    if (inFlight) await inFlight
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// One source
// ---------------------------------------------------------------------------------------------------------------------

type SourceOutcome = 'done' | 'busy' | 'cancelled' | 'lost' | 'gone'

const hasAcceptedProfile = courseHasTutor

/** Starter pass after the profile was accepted while a source was finishing: make sure the course job runs again. */
async function requestStartersIfProfileAppeared(courseId: string): Promise<void> {
  if (!(await hasAcceptedProfile(courseId))) return
  await prisma.course.updateMany({ where: { id: courseId, starterStatus: { in: ['waiting_for_profile', 'done', 'failed'] } }, data: { starterStatus: 'pending' } })
  enqueueStarters(courseId)
}

async function markReady(sourceId: string, note: string): Promise<void> {
  const current = await prisma.source.findUnique({ where: { id: sourceId }, select: { warning: true } })
  const warning = [stripStarterNote(current?.warning), note].filter(Boolean).join(' ') || null
  await prisma.source.updateMany({
    where: { id: sourceId, status: { in: ['importing_questions', 'generating_exercises'] } },
    data: { status: 'ready', failedStage: null, error: null, warning },
  })
}

/**
 * After the questions of a source are imported: a studyspace with an accepted profile goes on to its starter questions, a new
 * studyspace is `ready` now and its course waits for the persona (plan 4.2).
 */
async function advanceAfterImport(sourceId: string, courseId: string): Promise<void> {
  if (await hasAcceptedProfile(courseId)) {
    await prisma.source.updateMany({ where: { id: sourceId, status: 'importing_questions' }, data: { status: 'generating_exercises' } })
    return
  }
  await markReady(sourceId, '')
  await prisma.course.updateMany({ where: { id: courseId, starterStatus: null }, data: { starterStatus: 'waiting_for_profile' } })
  await requestStartersIfProfileAppeared(courseId)
}

/** Runs the stage for the source's current status. Returns false when it was interrupted (cancel, lost lease) and must not be judged. */
async function runStage(sourceId: string, courseId: string, status: string, lease: LeaseHandle): Promise<boolean> {
  const s = state()
  const key = sourceKey(sourceId)
  switch (status) {
    case 'uploaded':
    case 'extracting':
      await extractSource(sourceId)
      return true
    case 'segmenting':
      await segmentSource(sourceId)
      return true
    case 'importing_questions':
      await importQuestionsForSource(sourceId)
      await advanceAfterImport(sourceId, courseId)
      return true
    case 'generating_exercises': {
      const outcome = await generateStartersForSource(sourceId, newStarterBudget(), () => s.cancelled.has(key) || lease.lost)
      if (outcome.stoppedBy === 'cancelled') return false
      await markReady(sourceId, starterNote(outcome))
      return true
    }
    default:
      return true
  }
}

/** Records a failure the stage did not record itself. A starter-stage failure never fails the source. */
async function recordUnexpected(sourceId: string, before: string, error: unknown): Promise<void> {
  console.error(`[ingest] source ${sourceId} stage ${FAILED_STAGE[before] ?? before}:`, error)
  const now = await prisma.source.findUnique({ where: { id: sourceId }, select: { status: true } })
  if (!now || now.status !== before) return // the stage recorded its own failure, or the source moved on
  if (before === 'generating_exercises') {
    await markReady(sourceId, 'Starter questions: none could be generated; sessions generate questions on the fly.')
    return
  }
  await prisma.source.updateMany({
    where: { id: sourceId, status: before },
    data: { status: 'failed', failedStage: FAILED_STAGE[before] ?? before, error: GENERIC_ERROR },
  })
}

async function processSource(sourceId: string): Promise<SourceOutcome> {
  const s = state()
  const key = sourceKey(sourceId)
  if (s.cancelled.has(key)) return 'cancelled'
  const lease = await claimSource(sourceId)
  if (!lease) {
    const row = await prisma.source.findUnique({ where: { id: sourceId }, select: { status: true, leaseExpiresAt: true } })
    if (!row) return 'gone'
    if (!TERMINAL_STATUSES.includes(row.status)) {
      // Another process (or a worker that died) holds the lease: look again when it expires
      scheduleRecheck({ kind: 'source', id: sourceId }, row.leaseExpiresAt ? row.leaseExpiresAt.getTime() - Date.now() + 1000 : tuning.recheckMinMs)
      return 'busy'
    }
    return 'done'
  }

  const stopHeartbeat = startHeartbeat(sourceId, lease)
  let outcome: SourceOutcome = 'done'
  let finalStatus: string | null = null
  let courseId = ''
  try {
    for (let step = 0; step < MAX_STEPS_PER_SOURCE; step++) {
      if (s.cancelled.has(key)) { outcome = 'cancelled'; break }
      if (lease.lost) { outcome = 'lost'; break }
      const row = await prisma.source.findUnique({ where: { id: sourceId }, select: { status: true, courseId: true } })
      if (!row) { outcome = 'gone'; break }
      courseId = row.courseId
      if (TERMINAL_STATUSES.includes(row.status)) { finalStatus = row.status; break }
      const before = row.status
      let progressed = true
      try {
        progressed = await runStage(sourceId, row.courseId, before, lease)
      } catch (error) {
        await recordUnexpected(sourceId, before, error)
      }
      if (!progressed) { outcome = s.cancelled.has(key) ? 'cancelled' : 'lost'; break }
      // A stage that returned without moving the source would repeat forever
      const after = await prisma.source.findUnique({ where: { id: sourceId }, select: { status: true } })
      if (after && after.status === before) await recordUnexpected(sourceId, before, new Error(`stage ${before} did not advance`))
    }
    if (outcome === 'done' && finalStatus === null) {
      const row = await prisma.source.findUnique({ where: { id: sourceId }, select: { status: true } })
      finalStatus = row?.status ?? null
      if (row && !TERMINAL_STATUSES.includes(row.status)) {
        await prisma.source.updateMany({ where: { id: sourceId, status: row.status }, data: { status: 'failed', failedStage: FAILED_STAGE[row.status] ?? row.status, error: GENERIC_ERROR } })
        finalStatus = 'failed'
      }
    }
  } finally {
    await stopHeartbeat()
    await releaseSource(sourceId, lease)
  }
  if (outcome === 'done' && courseId && (finalStatus === 'ready' || finalStatus === 'failed')) {
    for (const hook of [...s.terminalHooks.values()]) {
      try {
        await hook({ courseId, sourceId, status: finalStatus })
      } catch (error) {
        console.error('[ingest] terminal hook failed:', error)
      }
    }
  }
  return outcome
}

/** The oldest unfinished source of the studyspace goes first, so uploads are processed in upload order. */
async function processSourceJob(sourceId: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const self = await prisma.source.findUnique({ where: { id: sourceId }, select: { courseId: true, status: true } })
    if (!self || TERMINAL_STATUSES.includes(self.status)) return
    const head = await prisma.source.findFirst({
      where: { courseId: self.courseId, status: { notIn: TERMINAL_STATUSES } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    })
    if (!head) return
    const outcome = await processSource(head.id)
    if (head.id === sourceId) return
    if (outcome === 'busy' || outcome === 'cancelled' || outcome === 'lost') {
      // The older source is not ours to run right now: this one waits behind it
      scheduleRecheck({ kind: 'source', id: sourceId }, tuning.recheckMinMs)
      return
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Course job: starter questions of a new studyspace
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Course.starterStatus: null (no source finished yet) → waiting_for_profile (a source is ready, no accepted profile) →
 * pending (profile accepted, job queued) → running (job started) → done | failed.
 *  done    every ready source was topped up; individual questions that could not be generated, or caps that were reached,
 *          are named in that source's warning.
 *  failed  the run was aborted: the model was unavailable (STARTER_MAX_CONSECUTIVE_FAILURES slots in a row) or an unexpected
 *          error. Sessions then generate questions on the fly; requestStarters() starts a new run (top-up, nothing is duplicated).
 * `running` after a restart is resumed like `pending`.
 */
export async function requestStarters(courseId: string): Promise<boolean> {
  const moved = await prisma.course.updateMany({ where: { id: courseId, starterStatus: { in: ['waiting_for_profile', 'failed'] } }, data: { starterStatus: 'pending' } })
  if (moved.count === 1) enqueueStarters(courseId)
  return moved.count === 1
}

async function processStartersJob(courseId: string): Promise<void> {
  const s = state()
  const key = startersKey(courseId)
  if (s.cancelled.has(key)) return
  const started = await prisma.course.updateMany({ where: { id: courseId, starterStatus: { in: ['pending', 'running'] } }, data: { starterStatus: 'running' } })
  if (started.count !== 1) return
  const fail = () => prisma.course.updateMany({ where: { id: courseId, starterStatus: 'running' }, data: { starterStatus: 'failed' } })
  try {
    const course = await prisma.course.findUnique({ where: { id: courseId }, select: { profile: true } })
    if (parseProfile(course?.profile) === null) {
      await prisma.course.updateMany({ where: { id: courseId, starterStatus: 'running' }, data: { starterStatus: 'waiting_for_profile' } })
      return
    }
    const budget = newStarterBudget()
    const sources = await prisma.source.findMany({ where: { courseId, status: 'ready' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true } })
    let skippedBusy = 0
    for (const { id } of sources) {
      if (s.cancelled.has(key) || s.cancelled.has(sourceKey(id))) return
      const lease = await claimSource(id, { anyStatus: true })
      if (!lease) { skippedBusy++; continue }
      const stopHeartbeat = startHeartbeat(id, lease)
      try {
        const outcome = await generateStartersForSource(id, budget, () => s.cancelled.has(key) || s.cancelled.has(sourceKey(id)) || lease.lost)
        if (outcome.stoppedBy === 'cancelled') return
        const row = await prisma.source.findUnique({ where: { id }, select: { warning: true } })
        const warning = [stripStarterNote(row?.warning), starterNote(outcome)].filter(Boolean).join(' ') || null
        await prisma.source.updateMany({ where: { id }, data: { warning } })
        if (outcome.stoppedBy === 'breaker') {
          await fail()
          return
        }
      } finally {
        await stopHeartbeat()
        await releaseSource(id, lease)
      }
    }
    if (skippedBusy > 0) {
      // Another process is working on some sources: stay `running` and look again shortly
      scheduleRecheck({ kind: 'starters', id: courseId }, tuning.recheckMinMs)
      return
    }
    await prisma.course.updateMany({ where: { id: courseId, starterStatus: 'running' }, data: { starterStatus: 'done' } })
  } catch (error) {
    console.error(`[ingest] starters of ${courseId}:`, error)
    await fail().catch(() => {})
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Boot and safety net
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Queues every unfinished source (oldest first) and every studyspace whose starter job was pending or running. Called once at
 * server start (src/instrumentation.ts) and by wakeIfIdle. Returns at once after queuing; the work runs in the background.
 */
export async function resumePendingSources(scope: { courseId?: string } = {}): Promise<{ sources: number; starters: number }> {
  const courseFilter = scope.courseId ? { courseId: scope.courseId } : {}
  const sources = await prisma.source.findMany({
    where: { ...courseFilter, status: { notIn: TERMINAL_STATUSES } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true },
  })
  const courses = await prisma.course.findMany({
    where: { ...(scope.courseId ? { id: scope.courseId } : {}), starterStatus: { in: ['pending', 'running'] } }, select: { id: true },
  })
  for (const { id } of sources) enqueueSource(id)
  for (const { id } of courses) enqueueStarters(id)
  return { sources: sources.length, starters: courses.length }
}

/**
 * Safety net for the status poll: when this process has nothing queued or running and the studyspace has unfinished work
 * (register did not run, a lease expired, a worker died), queue it. Does no work itself. Returns whether it queued anything.
 */
export async function wakeIfIdle(courseId: string): Promise<boolean> {
  if (!isRunnerIdle()) return false
  const queued = await resumePendingSources({ courseId })
  return queued.sources + queued.starters > 0
}

// ---------------------------------------------------------------------------------------------------------------------
// Removal support
// ---------------------------------------------------------------------------------------------------------------------

export class SourceBusyError extends Error {
  constructor() {
    super('This file is being processed right now. Try again in a minute.')
    this.name = 'SourceBusyError'
  }
}

/**
 * Stops work on `sourceIds` (and the starter job of `starterCourseId`) and takes their leases, so the caller can delete them
 * without a stage running underneath. Sets the cancel flags, waits until every lease is ours (at most `timeoutMs`; a stage
 * ends at its next boundary), and throws SourceBusyError when it cannot, releasing what it took. `release()` returns the
 * leases and clears the flags; call it in `finally`.
 */
export async function acquireExclusive(
  sourceIds: string[],
  opts: { timeoutMs?: number; starterCourseId?: string } = {},
): Promise<{ release: () => Promise<void> }> {
  const s = state()
  const keys = sourceIds.map(sourceKey)
  if (opts.starterCourseId) keys.push(startersKey(opts.starterCourseId))
  const flagged = keys.filter((k) => !s.cancelled.has(k))
  for (const k of flagged) s.cancelled.add(k)
  const held = new Map<string, LeaseHandle>()
  const release = async () => {
    for (const [id, lease] of held) await releaseSource(id, lease)
    held.clear()
    for (const k of flagged) s.cancelled.delete(k)
  }
  const deadline = Date.now() + (opts.timeoutMs ?? tuning.exclusiveTimeoutMs)
  try {
    for (const id of sourceIds) {
      for (;;) {
        const row = await prisma.source.findUnique({ where: { id }, select: { id: true } })
        if (!row) break // already gone
        const lease = await claimSource(id, { anyStatus: true })
        if (lease) {
          held.set(id, lease)
          break
        }
        if (Date.now() >= deadline) throw new SourceBusyError()
        await new Promise((r) => setTimeout(r, 300))
      }
    }
  } catch (error) {
    await release()
    throw error
  }
  return { release }
}
