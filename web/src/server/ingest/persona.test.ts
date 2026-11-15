// Accepting, dismissing and reading the persona step against a real (temporary) database.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'

const env = vi.hoisted(() => ({ dir: '' }))
vi.mock('@ai-sdk/google', () => ({ google: vi.fn(() => 'mocked-google-model') }))
vi.mock('@/lib/db', async () => {
  const { createTestPrisma } = await import('./__fixtures__/testDb')
  const t = await createTestPrisma()
  env.dir = t.dir
  process.env.STORAGE_DIR = `${t.dir}/storage`
  return { prisma: t.prisma }
})

import { defaultProfile, parseProfile } from '@/lib/studyspace/profile'
import { LEGACY_PROFILES } from '@/lib/studyspace/legacyProfiles'

type Prisma = typeof import('@/lib/db').prisma
let prisma: Prisma
let persona: typeof import('./persona')
let n = 0

beforeAll(async () => {
  prisma = (await import('@/lib/db')).prisma
  persona = await import('./persona')
})
afterAll(async () => {
  await prisma.$disconnect()
  fs.rmSync(env.dir, { recursive: true, force: true })
})
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

async function makeSpace(opts: { starterStatus?: string | null; imported?: boolean; suggestion?: boolean } = {}) {
  const courseId = `ps-${++n}`
  await prisma.course.create({
    data: { id: courseId, code: courseId, title: 'Space', starterStatus: opts.starterStatus === undefined ? 'waiting_for_profile' : opts.starterStatus, profileSuggestion: opts.suggestion ? '{"x":1}' : null },
  })
  await prisma.source.create({ data: { id: `${courseId}-s`, courseId, originalName: 'a.md', mimeType: 'text/markdown', sizeBytes: 1, storageKey: 'k', status: 'ready' } })
  await prisma.topic.create({ data: { id: `${courseId}-t1`, courseId, sourceId: opts.imported ? null : `${courseId}-s`, order: 0, week: '01 · One', title: 'T1', content: 'c' } })
  await prisma.topic.create({ data: { id: `${courseId}-t2`, courseId, sourceId: opts.imported ? null : `${courseId}-s`, order: 1, week: '02 · Two', title: 'T2', content: 'c' } })
  return courseId
}
const valid = () => ({ ...defaultProfile({ title: 'Space' }), subject: 'Chemistry', tutorIdentity: 'a chemistry professor' })
const stored = async (id: string) => (await prisma.course.findUnique({ where: { id } }))!

describe('acceptProfile', () => {
  it('validates, stores the profile, clears the suggestion and requests starters once', async () => {
    const id = await makeSpace({ suggestion: true })
    const request = vi.fn(async () => true)
    const r = await persona.acceptProfile(id, { ...valid(), calibrationModule: '02 · Two' }, { requestStarters: request })
    expect(r).toEqual({ ok: true, starters: 'requested' })
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith(id)
    const c = await stored(id)
    expect(c.profileSuggestion).toBeNull()
    expect(parseProfile(c.profile)).toMatchObject({ subject: 'Chemistry', calibrationModule: '02 · Two' })
  })

  it('refuses an invalid profile and writes nothing', async () => {
    const id = await makeSpace({ suggestion: true })
    const request = vi.fn(async () => true)
    for (const bad of [{}, null, 'x', { ...valid(), subject: '' }, { ...valid(), tone: 'rude' }, { ...valid(), contentLanguage: 'e' }, { ...valid(), version: 2 }]) {
      const r = await persona.acceptProfile(id, bad, { requestStarters: request })
      expect(r.ok).toBe(false)
    }
    expect(request).not.toHaveBeenCalled()
    const c = await stored(id)
    expect(c.profile).toBeNull()
    expect(c.profileSuggestion).toBe('{"x":1}')
  })

  it('treats a calibration label that names no module as none', async () => {
    const id = await makeSpace()
    await persona.acceptProfile(id, { ...valid(), calibrationModule: '09 · Gone' }, { requestStarters: async () => false })
    expect(parseProfile((await stored(id)).profile)?.calibrationModule).toBeNull()
  })

  it('moves a null starter status to waiting_for_profile when a file is ready, so starters can be requested', async () => {
    const id = await makeSpace({ starterStatus: null })
    let seen: string | null = null
    await persona.acceptProfile(id, valid(), { requestStarters: async (c) => { seen = (await stored(c)).starterStatus; return true } })
    expect(seen).toBe('waiting_for_profile')
  })

  it('refuses unknown and imported studyspaces', async () => {
    const request = vi.fn(async () => true)
    expect(await persona.acceptProfile('nope', valid(), { requestStarters: request })).toMatchObject({ ok: false })
    const id = await makeSpace({ imported: true })
    expect(await persona.acceptProfile(id, valid(), { requestStarters: request })).toMatchObject({ ok: false, reason: persona.IMPORTED_TUTOR_REASON })
    expect(request).not.toHaveBeenCalled()
    expect((await stored(id)).profile).toBeNull()
  })
})

describe('dismissSuggestion and dismissSplitNotice', () => {
  it('dismiss clears only the suggestion and leaves an accepted profile alone', async () => {
    const id = await makeSpace({ suggestion: true })
    await prisma.course.update({ where: { id }, data: { profile: JSON.stringify(valid()) } })
    expect(await persona.dismissSuggestion(id)).toEqual({ ok: true })
    const c = await stored(id)
    expect(c.profileSuggestion).toBeNull()
    expect(parseProfile(c.profile)?.subject).toBe('Chemistry')
    expect(await persona.dismissSuggestion('nope')).toMatchObject({ ok: false })
  })

  it('keep together removes the split offer and keeps the proposal', async () => {
    const id = await makeSpace()
    const suggestion = { kind: 'initial', createdAt: 'now', basedOnSourceIds: [`${id}-s`], profile: valid(), rationale: 'r', excludedSources: [], split: { groups: [{ label: 'A', sourceIds: ['a'] }, { label: 'B', sourceIds: ['b'] }] } }
    await prisma.course.update({ where: { id }, data: { profileSuggestion: JSON.stringify(suggestion) } })
    await persona.dismissSplitNotice(id)
    const after = JSON.parse((await stored(id)).profileSuggestion!)
    expect(after.split).toBeNull()
    expect(after.profile.subject).toBe('Chemistry')
  })
})

describe('getPersonaStep', () => {
  it('shows the accepted profile for editing, with the modules for the calibration select', async () => {
    const id = await makeSpace({ starterStatus: 'done' })
    await prisma.course.update({ where: { id }, data: { profile: JSON.stringify({ ...valid(), calibrationModule: '02 · Two' }) } })
    const r = await persona.getPersonaStep(id)
    expect(r).toMatchObject({ ok: true, mode: 'accepted', readOnly: false, starterStatus: 'done' })
    if (r.ok) {
      expect(r.profile.calibrationModule).toBe('02 · Two')
      expect(r.modules.map((m) => m.name)).toEqual(['01 · One', '02 · Two'])
    }
  })

  it('treats a stale calibration label as none when reading', async () => {
    const id = await makeSpace()
    await prisma.course.update({ where: { id }, data: { profile: JSON.stringify({ ...valid(), calibrationModule: '07 · Renamed away' }) } })
    const r = await persona.getPersonaStep(id)
    expect(r.ok && r.profile.calibrationModule).toBeNull()
  })

  it('shows an imported studyspace read-only without proposing anything', async () => {
    const id = await makeSpace({ imported: true })
    await prisma.course.update({ where: { id }, data: { code: '14.750x' } })
    const generate = vi.fn()
    const r = await persona.getPersonaStep(id, { generate: generate as never })
    expect(r).toMatchObject({ ok: true, mode: 'accepted', readOnly: true })
    if (r.ok) expect(r.profile.subject).toBe(LEGACY_PROFILES['14.750x'].subject)
    expect(generate).not.toHaveBeenCalled()
  })

  it('reports a missing studyspace', async () => {
    expect(await persona.getPersonaStep('nope')).toMatchObject({ ok: false })
  })
})

describe('readStoredPersonaStep', () => {
  const suggestion = (id: string, ids: string[]) => JSON.stringify({ kind: 'initial', createdAt: 'now', basedOnSourceIds: ids, profile: valid(), rationale: 'r', excludedSources: [], split: null })

  it('returns a stored proposal that matches the ready files, and never calls the model', async () => {
    const id = await makeSpace()
    await prisma.course.update({ where: { id }, data: { profileSuggestion: suggestion(id, [`${id}-s`]) } })
    const r = await persona.readStoredPersonaStep(id)
    expect(r).toMatchObject({ ok: true, mode: 'proposal' })
  })

  it('returns null when a proposal would have to be made', async () => {
    const none = await makeSpace()
    expect(await persona.readStoredPersonaStep(none)).toBeNull()
    const stale = await makeSpace()
    await prisma.course.update({ where: { id: stale }, data: { profileSuggestion: suggestion(stale, ['other']) } })
    expect(await persona.readStoredPersonaStep(stale)).toBeNull()
    const processing = await makeSpace()
    await prisma.course.update({ where: { id: processing }, data: { profileSuggestion: suggestion(processing, [`${processing}-s`]) } })
    await prisma.source.update({ where: { id: `${processing}-s` }, data: { status: 'segmenting' } })
    expect(await persona.readStoredPersonaStep(processing)).toBeNull()
    expect(await persona.readStoredPersonaStep('nope')).toBeNull()
  })

  it('returns the accepted profile', async () => {
    const id = await makeSpace()
    await prisma.course.update({ where: { id }, data: { profile: JSON.stringify(valid()) } })
    expect(await persona.readStoredPersonaStep(id)).toMatchObject({ ok: true, mode: 'accepted' })
  })
})
