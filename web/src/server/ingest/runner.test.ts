// The runner against a real (temporary) SQLite database with the pipeline stages replaced by fakes that move the status the way the
// real stages do: claim and lease, renewal, resume, ordering, hot reload, cancellation, the course starter job.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'

const env = vi.hoisted(() => ({ dir: '' }))
const stages = vi.hoisted(() => ({ extract: vi.fn(), segment: vi.fn(), importQ: vi.fn(), starters: vi.fn() }))
vi.mock('@ai-sdk/google', () => ({ google: vi.fn(() => 'mocked-google-model') }))
// One throwaway database for the whole file, also across vi.resetModules() (the hot-reload test imports a second copy of the runner)
vi.mock('@/lib/db', async () => {
  const g = globalThis as unknown as { __t23Db?: { dir: string; prisma: unknown } }
  if (!g.__t23Db) {
    const { createTestPrisma } = await import('./__fixtures__/testDb')
    g.__t23Db = await createTestPrisma()
  }
  env.dir = g.__t23Db.dir
  process.env.STORAGE_DIR = `${g.__t23Db.dir}/storage`
  return { prisma: g.__t23Db.prisma }
})
vi.mock('./extract', () => ({ extractSource: (...a: unknown[]) => stages.extract(...a) }))
vi.mock('./segment', () => ({ segmentSource: (...a: unknown[]) => stages.segment(...a) }))
vi.mock('./importQuestions', () => ({ importQuestionsForSource: (...a: unknown[]) => stages.importQ(...a) }))
vi.mock('./starters', async (orig) => {
  const actual = await orig<typeof import('./starters')>()
  return { ...actual, generateStartersForSource: (...a: unknown[]) => stages.starters(...a) }
})

import { defaultProfile } from '@/lib/studyspace/profile'

type Prisma = typeof import('@/lib/db').prisma
type Runner = typeof import('./runner')
let prisma: Prisma
let runner: Runner
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let counter = 0
async function makeCourse(extra: Record<string, unknown> = {}) {
  const id = `course-${++counter}`
  await prisma.course.create({ data: { id, code: id, title: id, ...extra } })
  return id
}
async function makeSource(courseId: string, status = 'uploaded', extra: Record<string, unknown> = {}) {
  const id = `src-${++counter}`
  await prisma.source.create({
    data: {
      id, courseId, originalName: `${id}.txt`, mimeType: 'text/plain', sizeBytes: 10, storageKey: `sources/${courseId}/${id}/original.txt`, status,
      createdAt: new Date(Date.now() - 100_000 + counter), ...extra,
    },
  })
  return id
}
const statusOf = async (id: string) => (await prisma.source.findUniqueOrThrow({ where: { id } }))
const move = (id: string, from: string | string[], to: string) =>
  prisma.source.updateMany({ where: { id, status: { in: Array.isArray(from) ? from : [from] } }, data: { status: to } })

/** Fakes of the real stages: each moves the status exactly as the real one does on success. */
function installHappyStages() {
  stages.extract.mockImplementation(async (id: string) => { await move(id, ['uploaded', 'extracting'], 'segmenting') })
  stages.segment.mockImplementation(async (id: string) => { await move(id, 'segmenting', 'importing_questions') })
  stages.importQ.mockImplementation(async () => ({ imported: 0 }))
  stages.starters.mockImplementation(async () => ({ created: 2, failedSlots: 0, notAttempted: 0, stoppedBy: null }))
}

const resetRunnerState = () => {
  const g = globalThis as unknown as { __feynmanIngestRunner?: { timers?: Map<string, ReturnType<typeof setTimeout>> } }
  for (const t of g.__feynmanIngestRunner?.timers?.values() ?? []) clearTimeout(t)
  g.__feynmanIngestRunner = undefined
}

beforeAll(async () => {
  prisma = (await import('@/lib/db')).prisma
  runner = await import('./runner')
})
afterAll(async () => {
  await prisma.$disconnect()
  fs.rmSync(env.dir, { recursive: true, force: true })
})
beforeEach(async () => {
  vi.resetAllMocks()
  resetRunnerState()
  // Leftovers of earlier tests must not be picked up by resumePendingSources
  await prisma.source.updateMany({ where: { status: { notIn: ['ready', 'failed'] } }, data: { status: 'failed', leaseExpiresAt: null } })
  await prisma.course.updateMany({ where: { starterStatus: { in: ['pending', 'running'] } }, data: { starterStatus: 'done' } })
  Object.assign(runner.tuning, { leaseMs: 120_000, heartbeatMs: 30_000, recheckMinMs: 5, recheckMaxMs: 60 })
  installHappyStages()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(async () => {
  await runner.whenIdle()
  resetRunnerState()
  vi.restoreAllMocks()
})

describe('stage mapping', () => {
  it('takes a new space from uploaded to ready, skips the starter stage and leaves the course waiting for the persona', async () => {
    const course = await makeCourse()
    const src = await makeSource(course)
    runner.enqueueSource(src)
    await runner.whenIdle()
    const row = await statusOf(src)
    expect(row.status).toBe('ready')
    expect(row.leaseExpiresAt).toBeNull()
    expect(stages.extract).toHaveBeenCalledTimes(1)
    expect(stages.segment).toHaveBeenCalledTimes(1)
    expect(stages.importQ).toHaveBeenCalledTimes(1)
    expect(stages.starters).not.toHaveBeenCalled()
    expect((await prisma.course.findUniqueOrThrow({ where: { id: course } })).starterStatus).toBe('waiting_for_profile')
  })

  it('does not overwrite an existing starterStatus', async () => {
    const course = await makeCourse({ starterStatus: 'done' })
    const src = await makeSource(course)
    runner.enqueueSource(src)
    await runner.whenIdle()
    expect((await prisma.course.findUniqueOrThrow({ where: { id: course } })).starterStatus).toBe('done')
  })

  it('a space with an accepted profile runs generating_exercises and records the starter note in the warning', async () => {
    const course = await makeCourse({ profile: JSON.stringify(defaultProfile({ title: 'x' })) })
    const src = await makeSource(course, 'uploaded', { bundle: 'later', warning: 'Earlier warning.' })
    stages.starters.mockResolvedValue({ created: 4, failedSlots: 1, notAttempted: 0, stoppedBy: null })
    runner.enqueueSource(src)
    await runner.whenIdle()
    const row = await statusOf(src)
    expect(row.status).toBe('ready')
    expect(stages.starters).toHaveBeenCalledTimes(1)
    expect(row.warning).toBe('Earlier warning. Starter questions: 4 created, 1 could not be generated.')
    // running the starter stage again replaces the note instead of repeating it
    await prisma.source.update({ where: { id: src }, data: { status: 'generating_exercises' } })
    runner.enqueueSource(src)
    await runner.whenIdle()
    expect((await statusOf(src)).warning).toBe('Earlier warning. Starter questions: 4 created, 1 could not be generated.')
  })

  it('an imported studyspace (topics without a source, no stored profile) runs generating_exercises for a later file and keeps its starter status', async () => {
    const course = await makeCourse({ starterStatus: 'done' })
    await prisma.topic.create({ data: { id: `imp-${course}`, courseId: course, order: 0, week: 'Week_01', title: 'Imported', content: 'x' } })
    const src = await makeSource(course, 'uploaded', { bundle: 'later' })
    runner.enqueueSource(src)
    await runner.whenIdle()
    expect((await statusOf(src)).status).toBe('ready')
    expect(stages.starters).toHaveBeenCalledTimes(1)
    expect((await prisma.course.findUniqueOrThrow({ where: { id: course } })).starterStatus).toBe('done')
  })

  it('calls the registered terminal hooks with the studyspace, the file and its final status', async () => {
    const course = await makeCourse({ profile: JSON.stringify(defaultProfile({ title: 'x' })) })
    const src = await makeSource(course, 'uploaded', { bundle: 'later' })
    const seen: unknown[] = []
    const off = runner.onSourceTerminal('t26-probe', async (info) => { seen.push(info) })
    try {
      runner.enqueueSource(src)
      await runner.whenIdle()
    } finally {
      off()
    }
    expect(seen).toEqual([{ courseId: course, sourceId: src, status: 'ready' }])
  })

  it('a starter-stage crash never fails the source', async () => {
    const course = await makeCourse({ profile: JSON.stringify(defaultProfile({ title: 'x' })) })
    const src = await makeSource(course, 'generating_exercises')
    stages.starters.mockRejectedValue(new Error('boom'))
    runner.enqueueSource(src)
    await runner.whenIdle()
    const row = await statusOf(src)
    expect(row.status).toBe('ready')
    expect(row.warning).toMatch(/Starter questions: none could be generated/)
  })

  it('resumes from the current status: a source in segmenting is not extracted again', async () => {
    const course = await makeCourse()
    const src = await makeSource(course, 'segmenting')
    runner.enqueueSource(src)
    await runner.whenIdle()
    expect(stages.extract).not.toHaveBeenCalled()
    expect(stages.segment).toHaveBeenCalledTimes(1)
    expect((await statusOf(src)).status).toBe('ready')
  })

  it('leaves finished sources alone', async () => {
    const course = await makeCourse()
    const ready = await makeSource(course, 'ready')
    const failed = await makeSource(course, 'failed', { failedStage: 'segmenting', error: 'x' })
    runner.enqueueSource(ready)
    runner.enqueueSource(failed)
    await runner.whenIdle()
    expect(stages.extract).not.toHaveBeenCalled()
    expect(stages.segment).not.toHaveBeenCalled()
    expect((await statusOf(failed)).error).toBe('x')
  })
})

describe('errors', () => {
  it('keeps the failure a stage recorded itself and goes on with the next source', async () => {
    const course = await makeCourse()
    const bad = await makeSource(course)
    const good = await makeSource(course)
    stages.extract.mockImplementation(async (id: string) => {
      if (id === bad) {
        await prisma.source.updateMany({ where: { id, status: 'uploaded' }, data: { status: 'failed', failedStage: 'extracting', error: 'Document too long (3 chars, limit 2)' } })
        throw new Error('ExtractionError stand-in')
      }
      await move(id, ['uploaded', 'extracting'], 'segmenting')
    })
    runner.enqueueSource(bad)
    runner.enqueueSource(good)
    await runner.whenIdle()
    const b = await statusOf(bad)
    expect([b.status, b.failedStage, b.error]).toEqual(['failed', 'extracting', 'Document too long (3 chars, limit 2)'])
    expect((await statusOf(good)).status).toBe('ready')
  })

  it('records an unexpected error with a generic reason and the right failedStage, and the loop continues', async () => {
    const course = await makeCourse()
    const bad = await makeSource(course)
    const good = await makeSource(course)
    stages.extract.mockImplementation(async (id: string) => {
      if (id === bad) throw new Error('SQLITE internals that must not reach the student')
      await move(id, ['uploaded', 'extracting'], 'segmenting')
    })
    runner.enqueueSource(bad)
    runner.enqueueSource(good)
    await runner.whenIdle()
    const b = await statusOf(bad)
    expect(b.status).toBe('failed')
    expect(b.failedStage).toBe('extracting')
    expect(b.error).toBe('Something went wrong while processing this file. Use Retry; if it keeps failing, upload the file again.')
    expect(b.error).not.toMatch(/SQLITE/)
    expect(b.leaseExpiresAt).toBeNull()
    expect((await statusOf(good)).status).toBe('ready')
  })

  it('fails a source whose stage returns without advancing it instead of looping forever', async () => {
    const course = await makeCourse()
    const src = await makeSource(course, 'segmenting')
    stages.segment.mockResolvedValue(undefined)
    runner.enqueueSource(src)
    await runner.whenIdle()
    const row = await statusOf(src)
    expect([row.status, row.failedStage]).toEqual(['failed', 'segmenting'])
    expect(stages.segment).toHaveBeenCalledTimes(1)
  })
})

describe('lease', () => {
  it('does not touch a source whose lease is held by someone else, and picks it up after the lease expires', async () => {
    const course = await makeCourse()
    const src = await makeSource(course, 'segmenting', { leaseExpiresAt: new Date(Date.now() + 250) })
    runner.enqueueSource(src)
    await runner.whenIdle()
    expect(stages.segment).not.toHaveBeenCalled()
    expect(runner.runnerSnapshot().timers).toContain(`source:${src}`)
    // the recheck timer is clamped to recheckMaxMs (60 ms here) and repeats until the lease has expired
    for (let i = 0; i < 100 && (await statusOf(src)).status !== 'ready'; i++) await sleep(20)
    expect((await statusOf(src)).status).toBe('ready')
    expect(stages.segment).toHaveBeenCalledTimes(1)
  })

  it('takes over a source whose worker died (expired lease) from its current status', async () => {
    const course = await makeCourse()
    const src = await makeSource(course, 'importing_questions', { leaseExpiresAt: new Date(Date.now() - 1000) })
    runner.enqueueSource(src)
    await runner.whenIdle()
    expect(stages.extract).not.toHaveBeenCalled()
    expect(stages.importQ).toHaveBeenCalledTimes(1)
    expect((await statusOf(src)).status).toBe('ready')
  })

  it('two claims at once: exactly one wins', async () => {
    const course = await makeCourse()
    const src = await makeSource(course, 'segmenting')
    const [a, b] = await Promise.all([runner.claimSource(src), runner.claimSource(src)])
    expect([a, b].filter(Boolean)).toHaveLength(1)
  })

  it('renews the lease while a stage outlives it, so the stage is not stolen, and releases it at the end', async () => {
    Object.assign(runner.tuning, { leaseMs: 300, heartbeatMs: 60 })
    const course = await makeCourse()
    const src = await makeSource(course, 'segmenting')
    let stolen: unknown = 'not tried'
    stages.segment.mockImplementation(async (id: string) => {
      await sleep(700) // more than two lease lengths
      stolen = await runner.claimSource(id)
      await move(id, 'segmenting', 'importing_questions')
    })
    runner.enqueueSource(src)
    await runner.whenIdle()
    expect(stolen).toBeNull()
    const row = await statusOf(src)
    expect(row.status).toBe('ready')
    expect(row.leaseExpiresAt).toBeNull()
  })

  it('a worker that lost its lease stops after the current stage', async () => {
    Object.assign(runner.tuning, { leaseMs: 300, heartbeatMs: 40 })
    const course = await makeCourse()
    const src = await makeSource(course, 'segmenting')
    stages.segment.mockImplementation(async (id: string) => {
      // another process takes the lease over by writing its own value
      await prisma.source.updateMany({ where: { id }, data: { leaseExpiresAt: new Date(Date.now() + 5000) } })
      await sleep(150)
      await move(id, 'segmenting', 'importing_questions')
    })
    runner.enqueueSource(src)
    await runner.whenIdle()
    const row = await statusOf(src)
    expect(row.status).toBe('importing_questions') // the next stage did not run
    expect(stages.importQ).not.toHaveBeenCalled()
    expect(row.leaseExpiresAt).not.toBeNull() // the other holder's lease was not released by us
  })
})

describe('order and queue', () => {
  it('processes the sources of one studyspace in upload order even when queued the other way round', async () => {
    const course = await makeCourse()
    const first = await makeSource(course)
    const second = await makeSource(course)
    const order: string[] = []
    stages.extract.mockImplementation(async (id: string) => { order.push(id); await move(id, ['uploaded', 'extracting'], 'segmenting') })
    runner.enqueueSource(second)
    runner.enqueueSource(first)
    await runner.whenIdle()
    expect(order).toEqual([first, second])
  })

  it('never runs two stages at once, also when two copies of the module (hot reload) enqueue', async () => {
    const copyA = runner
    vi.resetModules()
    const copyB: Runner = await import('./runner')
    expect(copyB).not.toBe(copyA)
    Object.assign(copyB.tuning, { recheckMinMs: 5, recheckMaxMs: 60 })
    const c1 = await makeCourse()
    const c2 = await makeCourse()
    const s1 = await makeSource(c1)
    const s2 = await makeSource(c2)
    let active = 0
    let maxActive = 0
    stages.extract.mockImplementation(async (id: string) => {
      active++
      maxActive = Math.max(maxActive, active)
      await sleep(40)
      active--
      await move(id, ['uploaded', 'extracting'], 'segmenting')
    })
    copyA.enqueueSource(s1)
    copyB.enqueueSource(s2)
    copyB.enqueueSource(s1) // a duplicate while queued is ignored
    expect(copyA.runnerSnapshot().queued.length + (copyA.runnerSnapshot().running ? 1 : 0)).toBeGreaterThan(0)
    await copyA.whenIdle()
    await copyB.whenIdle()
    expect(maxActive).toBe(1)
    expect(stages.extract).toHaveBeenCalledTimes(2)
  })

  it('a job queued while the loop is finishing is still run', async () => {
    const course = await makeCourse()
    const a = await makeSource(course)
    const course2 = await makeCourse()
    const b = await makeSource(course2)
    runner.enqueueSource(a)
    await runner.whenIdle()
    runner.enqueueSource(b)
    await runner.whenIdle()
    expect((await statusOf(a)).status).toBe('ready')
    expect((await statusOf(b)).status).toBe('ready')
  })

  it('a cancelled source is not processed', async () => {
    const course = await makeCourse()
    const src = await makeSource(course)
    const handle = await runner.acquireExclusive([src])
    runner.enqueueSource(src)
    await runner.whenIdle()
    expect(stages.extract).not.toHaveBeenCalled()
    await handle.release()
  })
})

describe('boot resume and the safety net', () => {
  it('resumePendingSources queues unfinished sources oldest first and the pending/running starter jobs', async () => {
    const c1 = await makeCourse()
    const older = await makeSource(c1, 'importing_questions')
    const newer = await makeSource(c1, 'uploaded')
    await makeSource(c1, 'ready')
    await makeSource(c1, 'failed', { failedStage: 'segmenting' })
    const c2 = await makeCourse({ starterStatus: 'running', profile: JSON.stringify(defaultProfile({ title: 'x' })) })
    await makeCourse({ starterStatus: 'done' })
    const order: string[] = []
    stages.importQ.mockImplementation(async (id: string) => { order.push(id) })
    stages.extract.mockImplementation(async (id: string) => { order.push(id); await move(id, ['uploaded', 'extracting'], 'segmenting') })
    const queued = await runner.resumePendingSources()
    expect(queued).toEqual({ sources: 2, starters: 1 })
    await runner.whenIdle()
    expect(order[0]).toBe(older)
    expect(order).toContain(newer)
    expect((await prisma.course.findUniqueOrThrow({ where: { id: c2 } })).starterStatus).toBe('done')
  })

  it('wakeIfIdle queues unfinished work of one studyspace only when the runner is idle', async () => {
    const c1 = await makeCourse()
    const c2 = await makeCourse()
    const mine = await makeSource(c1, 'segmenting')
    const other = await makeSource(c2, 'segmenting')
    expect(await runner.wakeIfIdle(c1)).toBe(true)
    await runner.whenIdle()
    expect((await statusOf(mine)).status).toBe('ready')
    expect((await statusOf(other)).status).toBe('segmenting')
    expect(await runner.wakeIfIdle(c1)).toBe(false) // nothing left
  })
})

describe('terminal hook', () => {
  it('is called when a source becomes ready or failed, and a throwing hook does not stop the loop', async () => {
    const course = await makeCourse()
    const a = await makeSource(course)
    const b = await makeSource(course)
    const seen: string[] = []
    runner.onSourceTerminal('test', async ({ sourceId, status }) => { seen.push(`${sourceId}:${status}`); throw new Error('hook failed') })
    stages.extract.mockImplementation(async (id: string) => {
      if (id === a) throw new Error('x')
      await move(id, ['uploaded', 'extracting'], 'segmenting')
    })
    runner.enqueueSource(a)
    runner.enqueueSource(b)
    await runner.whenIdle()
    expect(seen).toEqual([`${a}:failed`, `${b}:ready`])
  })
})

describe('terminal hooks (shared state)', () => {
  it('registering the same name twice keeps only the latest hook, and it runs once', async () => {
    const course = await makeCourse()
    const src = await makeSource(course)
    const first = vi.fn(async () => {})
    const second = vi.fn(async () => {})
    runner.onSourceTerminal('persona', first)
    runner.onSourceTerminal('persona', second)
    runner.enqueueSource(src)
    await runner.whenIdle()
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('a hook registered through another copy of the module is called for ready and for failed', async () => {
    const copyA = runner
    vi.resetModules()
    const copyB: Runner = await import('./runner')
    const seen: string[] = []
    const off = copyB.onSourceTerminal('other-copy', async ({ status }) => { seen.push(status) })
    const course = await makeCourse()
    const ok = await makeSource(course)
    const bad = await makeSource(course)
    stages.extract.mockImplementation(async (id: string) => {
      if (id === bad) throw new Error('x')
      await move(id, ['uploaded', 'extracting'], 'segmenting')
    })
    copyA.enqueueSource(ok)
    copyA.enqueueSource(bad)
    await copyA.whenIdle()
    expect(seen).toEqual(['ready', 'failed'])
    // removing deletes only a hook that is still the same one
    const replacement = vi.fn(async () => {})
    copyA.onSourceTerminal('other-copy', replacement)
    off()
    expect(copyA.runnerSnapshot()).toBeDefined()
    const again = await makeSource(course)
    copyA.enqueueSource(again)
    await copyA.whenIdle()
    expect(replacement).toHaveBeenCalledTimes(1)
  })

  it('a throwing hook does not stop the next hook or the loop', async () => {
    const course = await makeCourse()
    const a = await makeSource(course)
    const b = await makeSource(course)
    const later = vi.fn(async () => {})
    runner.onSourceTerminal('throws', async () => { throw new Error('boom') })
    runner.onSourceTerminal('after', later)
    runner.enqueueSource(a)
    runner.enqueueSource(b)
    await runner.whenIdle()
    expect(later).toHaveBeenCalledTimes(2)
    expect((await statusOf(b)).status).toBe('ready')
  })
})

describe('starter job', () => {
  const profile = () => JSON.stringify(defaultProfile({ title: 'x' }))

  it('walks waiting_for_profile -> pending -> running -> done, once, over the ready sources', async () => {
    const course = await makeCourse({ profile: profile(), starterStatus: 'waiting_for_profile' })
    const s1 = await makeSource(course, 'ready')
    await makeSource(course, 'failed', { failedStage: 'segmenting' })
    const s2 = await makeSource(course, 'ready')
    const during: (string | null)[] = []
    stages.starters.mockImplementation(async () => {
      during.push((await prisma.course.findUniqueOrThrow({ where: { id: course } })).starterStatus)
      return { created: 3, failedSlots: 1, notAttempted: 0, stoppedBy: null }
    })
    expect(await runner.requestStarters(course)).toBe(true)
    expect(await runner.requestStarters(course)).toBe(false) // pending already: exactly one job
    await runner.whenIdle()
    expect(during).toEqual(['running', 'running'])
    expect(stages.starters).toHaveBeenCalledTimes(2)
    expect((await prisma.course.findUniqueOrThrow({ where: { id: course } })).starterStatus).toBe('done')
    for (const id of [s1, s2]) {
      const row = await statusOf(id)
      expect(row.warning).toBe('Starter questions: 3 created, 1 could not be generated.')
      expect(row.leaseExpiresAt).toBeNull()
    }
  })

  it('needs an accepted profile: without one the course goes back to waiting_for_profile', async () => {
    const course = await makeCourse({ starterStatus: 'pending' })
    await makeSource(course, 'ready')
    runner.enqueueStarters(course)
    await runner.whenIdle()
    expect(stages.starters).not.toHaveBeenCalled()
    expect((await prisma.course.findUniqueOrThrow({ where: { id: course } })).starterStatus).toBe('waiting_for_profile')
  })

  it('ends as failed when the model is unavailable, and requestStarters can start it again', async () => {
    const course = await makeCourse({ profile: profile(), starterStatus: 'pending' })
    await makeSource(course, 'ready')
    await makeSource(course, 'ready')
    stages.starters.mockResolvedValueOnce({ created: 0, failedSlots: 5, notAttempted: 3, stoppedBy: 'breaker' })
    runner.enqueueStarters(course)
    await runner.whenIdle()
    expect(stages.starters).toHaveBeenCalledTimes(1) // the second source was not tried
    expect((await prisma.course.findUniqueOrThrow({ where: { id: course } })).starterStatus).toBe('failed')
    expect(await runner.requestStarters(course)).toBe(true)
    await runner.whenIdle()
    expect((await prisma.course.findUniqueOrThrow({ where: { id: course } })).starterStatus).toBe('done')
  })

  it('is resumable: a course left running by a dead process is finished at boot', async () => {
    const course = await makeCourse({ profile: profile(), starterStatus: 'running' })
    await makeSource(course, 'ready')
    await runner.resumePendingSources()
    await runner.whenIdle()
    expect((await prisma.course.findUniqueOrThrow({ where: { id: course } })).starterStatus).toBe('done')
  })

  it('stays running and looks again when another process holds a source, then finishes', async () => {
    const course = await makeCourse({ profile: profile(), starterStatus: 'pending' })
    const busy = await makeSource(course, 'ready', { leaseExpiresAt: new Date(Date.now() + 150) })
    runner.enqueueStarters(course)
    await runner.whenIdle()
    expect((await prisma.course.findUniqueOrThrow({ where: { id: course } })).starterStatus).toBe('running')
    for (let i = 0; i < 100 && (await prisma.course.findUniqueOrThrow({ where: { id: course } })).starterStatus !== 'done'; i++) await sleep(20)
    expect((await prisma.course.findUniqueOrThrow({ where: { id: course } })).starterStatus).toBe('done')
    expect(stages.starters).toHaveBeenCalledTimes(1)
    expect((await statusOf(busy)).leaseExpiresAt).toBeNull()
  })

  it('a profile accepted while the last source was finishing still gets its starters', async () => {
    const course = await makeCourse({ profile: null })
    const src = await makeSource(course, 'importing_questions')
    // the owner accepts the persona while the import stage is running
    stages.importQ.mockImplementation(async () => {
      await prisma.course.update({ where: { id: course }, data: { profile: profile() } })
    })
    runner.enqueueSource(src)
    await runner.whenIdle()
    // the advance step saw the profile: the source went through generating_exercises instead
    expect(stages.starters).toHaveBeenCalledTimes(1)
    expect((await statusOf(src)).status).toBe('ready')
  })
})

describe('acquireExclusive (removal support)', () => {
  it('stops a running source at its next stage boundary and hands over the lease', async () => {
    const course = await makeCourse()
    const src = await makeSource(course, 'segmenting')
    let release!: () => void
    stages.segment.mockImplementation(async (id: string) => {
      await new Promise<void>((r) => { release = r })
      await move(id, 'segmenting', 'importing_questions')
    })
    runner.enqueueSource(src)
    while (!release) await sleep(5)
    const pending = runner.acquireExclusive([src], { timeoutMs: 3000 })
    await sleep(50)
    release() // the stage finishes; the cancel flag then ends the work before importing_questions
    const handle = await pending
    expect(stages.importQ).not.toHaveBeenCalled()
    expect((await statusOf(src)).status).toBe('importing_questions')
    await handle.release()
    await runner.whenIdle()
  })

  it('refuses with SourceBusyError when the stage does not end in time, and clears its flags', async () => {
    const course = await makeCourse()
    const src = await makeSource(course, 'segmenting', { leaseExpiresAt: new Date(Date.now() + 60_000) })
    await expect(runner.acquireExclusive([src], { timeoutMs: 400 })).rejects.toBeInstanceOf(runner.SourceBusyError)
    expect(runner.runnerSnapshot().cancelled).toEqual([])
  })
})
