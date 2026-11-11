// The initial tutor proposal against a real (temporary) database, with the model replaced by a fake.
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

import { ProfileProposalModelSchema, TutorProfileSchema } from '@/lib/studyspace/profile'
import { NOT_STUDY_MATERIAL_PREFIX } from '@/services/exerciseGenerator'

type Prisma = typeof import('@/lib/db').prisma
let prisma: Prisma
let mod: typeof import('./profileProposal')
let n = 0

beforeAll(async () => {
  prisma = (await import('@/lib/db')).prisma
  mod = await import('./profileProposal')
})
afterAll(async () => {
  await prisma.$disconnect()
  fs.rmSync(env.dir, { recursive: true, force: true })
})
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

const mix = { single_choice: 2, multiple_choice: 1, numeric: 1, dropdown: 0, open: 0 }
function answer(over: Record<string, unknown> = {}, profileOver: Record<string, unknown> = {}) {
  return {
    profile: {
      subject: 'Organic chemistry', level: 'undergraduate', tutorIdentity: 'an organic chemistry professor', tone: 'patient_coach', toneNotes: 'Go slowly.',
      defaultChatMode: 'guide', analogyDomains: ['cooking', 'cooking', 'lego'], quantitative: false, questionTypeMix: mix, quantitativeQuestionTypeMix: mix,
      contentLanguage: 'en', sampleExplanation: { concept: 'Nucleophile', explanation: 'A nucleophile donates a pair of electrons.' }, ...profileOver,
    },
    subjectsCoherent: true, subjectGroups: [], ...over,
  }
}
type Call = { prompt: string; schema: unknown }
function fake(responses: unknown | ((c: Call) => unknown), calls: Call[] = []) {
  const fn = (async (args: Call) => {
    calls.push(args)
    const object = typeof responses === 'function' ? (responses as (c: Call) => unknown)(args) : responses
    return { object, usage: { inputTokens: 10, outputTokens: 5 } }
  }) as never
  return { fn, calls }
}

async function makeSpace(statuses: ('ready' | 'failed' | 'extracting')[], opts: { goal?: string | null } = {}) {
  const k = ++n
  const courseId = `pp-${k}`
  await prisma.course.create({ data: { id: courseId, code: courseId, title: 'Chem space', goal: opts.goal ?? null } })
  const sourceIds: string[] = []
  for (const [i, status] of statuses.entries()) {
    const id = `${courseId}-s${i}`
    sourceIds.push(id)
    await prisma.source.create({
      data: { id, courseId, originalName: `file${i}.pdf`, mimeType: 'application/pdf', sizeBytes: 1, storageKey: `sources/${courseId}/${id}/original.pdf`, status, error: status === 'failed' ? 'The PDF is encrypted.' : null },
    })
    if (status === 'ready') {
      await prisma.topic.create({ data: { id: `${id}-t1`, courseId, sourceId: id, order: i * 10, week: `0${i + 1} · Module ${i}`, title: `Edited title ${i}`, content: `Body text of file ${i}`, summary: `Summary ${i}`, keyTerms: '["alkene","SN2"]' } })
      await prisma.topic.create({ data: { id: `${id}-t2`, courseId, sourceId: id, order: i * 10 + 1, week: `0${i + 1} · Module ${i}`, title: `Course logistics ${i}`, content: 'Grading policy' } })
      await prisma.exercise.create({ data: { id: `${id}-m`, topicId: `${id}-t2`, questionText: 'm', choices: '[]', correctAnswer: '', isGraded: false, origin: 'generated', status: 'rejected', reportedReason: `${NOT_STUDY_MATERIAL_PREFIX} logistics` } })
    }
  }
  return { courseId, sourceIds }
}

describe('proposeProfile', () => {
  it('builds the profile, leaves out failed files and not-study topics, and names the failed files', async () => {
    const { courseId, sourceIds } = await makeSpace(['ready', 'failed', 'ready'], { goal: 'Pass the exam' })
    const { fn, calls } = fake(answer())
    const s = await mod.proposeProfile(courseId, { generate: fn })
    expect(calls).toHaveLength(1)
    expect(calls[0].schema).toBe(ProfileProposalModelSchema)
    expect(calls[0].prompt).toContain('Edited title 0')
    expect(calls[0].prompt).toContain('Body text of file 2')
    expect(calls[0].prompt).toContain('Pass the exam')
    expect(calls[0].prompt).not.toContain('Course logistics')
    expect(calls[0].prompt).not.toContain('Grading policy')
    expect(calls[0].prompt).not.toContain('file1.pdf')
    expect(s.excludedSources).toEqual([{ id: sourceIds[1], name: 'file1.pdf', reason: 'The PDF is encrypted.' }])
    expect(s.basedOnSourceIds).toEqual([sourceIds[0], sourceIds[2]])
    expect(s.kind).toBe('initial')
    expect(TutorProfileSchema.safeParse(s.profile).success).toBe(true)
    expect(s.profile).toMatchObject({ version: 1, calibrationModule: null, examPreset: null, questionTypeCycles: null, defaultChatMode: 'guide', analogyDomains: ['cooking', 'lego'] })
  })

  it('normalizes the mixes and zeroes numeric for a non-quantitative subject', async () => {
    const { courseId } = await makeSpace(['ready'])
    const s = await mod.proposeProfile(courseId, { generate: fake(answer()).fn })
    for (const m of [s.profile.questionTypeMix, s.profile.quantitativeQuestionTypeMix]) {
      expect(m.numeric).toBe(0)
      expect(Object.values(m).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10)
      expect(m.single_choice).toBeCloseTo(2 / 3, 10)
    }
    const q = await mod.proposeProfile(courseId, { generate: fake(answer({}, { quantitative: true })).fn })
    expect(q.profile.questionTypeMix.numeric).toBeCloseTo(0.25, 10)
  })

  it('keeps a proposed open share, caps one above 0.3 and scales the other shares into the rest', async () => {
    const { courseId } = await makeSpace(['ready'])
    const ok = await mod.proposeProfile(courseId, { generate: fake(answer({}, { quantitative: true, questionTypeMix: { single_choice: 2, multiple_choice: 1, numeric: 1, dropdown: 0, open: 1 } })).fn })
    expect(ok.profile.questionTypeMix.open).toBeCloseTo(0.2, 10)
    const heavy = await mod.proposeProfile(courseId, { generate: fake(answer({}, { quantitative: true, questionTypeMix: { single_choice: 1, multiple_choice: 1, numeric: 0, dropdown: 0, open: 8 }, quantitativeQuestionTypeMix: { single_choice: 0, multiple_choice: 0, numeric: 0, dropdown: 0, open: 1 } })).fn })
    expect(heavy.profile.questionTypeMix.open).toBeCloseTo(0.3, 10)
    expect(heavy.profile.questionTypeMix.single_choice).toBeCloseTo(0.35, 10)
    expect(Object.values(heavy.profile.questionTypeMix).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10)
    // only open asked for: capped, and the rest comes from the default mix
    const m = heavy.profile.quantitativeQuestionTypeMix
    expect(m.open).toBeCloseTo(0.3, 10)
    expect(Object.values(m).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10)
    expect(m.numeric).toBeGreaterThan(0)
    // no numeric for a non-quantitative subject, whatever the open share
    const flat = await mod.proposeProfile(courseId, { generate: fake(answer({}, { quantitative: false, questionTypeMix: { single_choice: 0, multiple_choice: 0, numeric: 1, dropdown: 0, open: 1 } })).fn })
    expect(flat.profile.questionTypeMix.numeric).toBe(0)
    expect(flat.profile.questionTypeMix.open).toBeCloseTo(0.3, 10)
    expect(TutorProfileSchema.safeParse(flat.profile).success).toBe(true)
  })

  it('takes the default chat mode of the tone preset when the model gives none', async () => {
    const { courseId } = await makeSpace(['ready'])
    const out = answer({}, { tone: 'patient_coach' })
    delete (out.profile as Record<string, unknown>).defaultChatMode
    const s = await mod.proposeProfile(courseId, { generate: fake(out).fn })
    expect(s.profile.defaultChatMode).toBe('guide')
  })

  it('keeps a split only when the subjects are not coherent and the groups cover every ready file exactly once', async () => {
    const { courseId, sourceIds } = await makeSpace(['ready', 'ready', 'failed'])
    const [a, b] = sourceIds
    const groups = [{ label: 'Chemistry', sourceIds: [a] }, { label: 'History', sourceIds: [b] }]
    const ok = await mod.proposeProfile(courseId, { generate: fake(answer({ subjectsCoherent: false, subjectGroups: groups })).fn })
    expect(ok.split).toEqual({ groups })
    const coherent = await mod.proposeProfile(courseId, { generate: fake(answer({ subjectsCoherent: true, subjectGroups: groups })).fn })
    expect(coherent.split).toBeNull()
    for (const bad of [
      [{ label: 'One', sourceIds: [a, b] }], // only one group
      [{ label: 'A', sourceIds: [a] }, { label: 'B', sourceIds: [] }], // empty group
      [{ label: 'A', sourceIds: [a] }, { label: 'B', sourceIds: ['unknown'] }], // unknown id
      [{ label: 'A', sourceIds: [a, b] }, { label: 'B', sourceIds: [b] }], // repeated
      [{ label: 'A', sourceIds: [a] }, { label: 'B', sourceIds: [sourceIds[2]] }], // failed file / b missing
    ]) {
      const s = await mod.proposeProfile(courseId, { generate: fake(answer({ subjectsCoherent: false, subjectGroups: bad })).fn })
      expect(s.split).toBeNull()
    }
  })

  it('retries once on an invalid answer and then fails with a readable message', async () => {
    const { courseId } = await makeSpace(['ready'])
    const calls: Call[] = []
    await expect(mod.proposeProfile(courseId, { generate: fake(answer({}, { subject: '' }), calls).fn })).rejects.toThrow(/failed twice/)
    expect(calls).toHaveLength(2)
  })

  it('keeps the prompt small for a 60-topic studyspace', async () => {
    const { courseId, sourceIds } = await makeSpace(['ready'])
    for (let i = 0; i < 60; i++) {
      await prisma.topic.create({ data: { id: `${courseId}-big${i}`, courseId, sourceId: sourceIds[0], order: 100 + i, week: '01 · Module 0', title: `Topic ${i} ${'x'.repeat(60)}`, content: 'c'.repeat(20_000), summary: 's'.repeat(400), keyTerms: JSON.stringify(['a'.repeat(30), 'b'.repeat(30), 'c', 'd', 'e', 'f']) } })
    }
    const { fn, calls } = fake(answer())
    await mod.proposeProfile(courseId, { generate: fn })
    expect(calls[0].prompt.length).toBeLessThan(26_000)
  })
})

describe('ensureInitialProposal', () => {
  it('refuses while files are processing, with no ready file, and when a profile is accepted', async () => {
    const a = await makeSpace(['ready', 'extracting'])
    expect(await mod.ensureInitialProposal(a.courseId, { generate: fake(answer()).fn })).toMatchObject({ ok: false, code: 'processing' })
    const b = await makeSpace(['failed'])
    expect(await mod.ensureInitialProposal(b.courseId, { generate: fake(answer()).fn })).toMatchObject({ ok: false, code: 'no_ready_source' })
    const c = await makeSpace(['ready'])
    await prisma.course.update({ where: { id: c.courseId }, data: { profile: JSON.stringify((await mod.proposeProfile(c.courseId, { generate: fake(answer()).fn })).profile) } })
    const { fn, calls } = fake(answer())
    expect(await mod.ensureInitialProposal(c.courseId, { generate: fn })).toMatchObject({ ok: false, code: 'has_profile' })
    expect(calls).toHaveLength(0)
    expect(await mod.ensureInitialProposal('missing', { generate: fn })).toMatchObject({ ok: false, code: 'not_found' })
  })

  it('stores the proposal, reuses it while the ready files match, and regenerates when they change', async () => {
    const { courseId, sourceIds } = await makeSpace(['ready'])
    const { fn, calls } = fake(answer())
    const first = await mod.ensureInitialProposal(courseId, { generate: fn })
    expect(first).toMatchObject({ ok: true, reused: false })
    const stored = await prisma.course.findUnique({ where: { id: courseId } })
    expect(mod.parseSuggestion(stored!.profileSuggestion)?.basedOnSourceIds).toEqual(sourceIds)
    expect(calls).toHaveLength(1)

    const again = await mod.ensureInitialProposal(courseId, { generate: fn })
    expect(again).toMatchObject({ ok: true, reused: true })
    expect(calls).toHaveLength(1)

    // a second ready file arrives
    const id2 = `${courseId}-extra`
    await prisma.source.create({ data: { id: id2, courseId, originalName: 'extra.pdf', mimeType: 'application/pdf', sizeBytes: 1, storageKey: 'k', status: 'ready' } })
    await prisma.topic.create({ data: { id: `${id2}-t`, courseId, sourceId: id2, order: 50, week: '02 · Two', title: 'Extra topic', content: 'x' } })
    const third = await mod.ensureInitialProposal(courseId, { generate: fn })
    expect(third).toMatchObject({ ok: true, reused: false })
    expect(calls).toHaveLength(2)

    // force (Regenerate)
    await mod.ensureInitialProposal(courseId, { generate: fn }, { force: true })
    expect(calls).toHaveLength(3)
  })

  it('refreshes only the list of failed files without a model call', async () => {
    const { courseId, sourceIds } = await makeSpace(['ready', 'failed'])
    const { fn, calls } = fake(answer())
    await mod.ensureInitialProposal(courseId, { generate: fn })
    await prisma.source.delete({ where: { id: sourceIds[1] } })
    const r = await mod.ensureInitialProposal(courseId, { generate: fn })
    expect(r).toMatchObject({ ok: true, reused: true })
    expect(r.ok && r.suggestion.excludedSources).toEqual([])
    expect(calls).toHaveLength(1)
  })

  it('makes one model call for two concurrent calls', async () => {
    const { courseId } = await makeSpace(['ready'])
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const calls: Call[] = []
    const fn = (async (args: Call) => {
      calls.push(args)
      await gate
      return { object: answer(), usage: {} }
    }) as never
    const p1 = mod.ensureInitialProposal(courseId, { generate: fn })
    const p2 = mod.ensureInitialProposal(courseId, { generate: fn })
    await new Promise((r) => setTimeout(r, 50))
    release()
    const [r1, r2] = await Promise.all([p1, p2])
    expect(calls).toHaveLength(1)
    expect(r1).toBe(r2)
    expect(r1.ok).toBe(true)
  })

  it('reports a model failure with a reason and stores nothing', async () => {
    const { courseId } = await makeSpace(['ready'])
    const failing = (async () => { throw new Error('boom') }) as never
    const r = await mod.ensureInitialProposal(courseId, { generate: failing })
    expect(r).toMatchObject({ ok: false, code: 'failed' })
    expect(!r.ok && r.reason).toMatch(/default tutor/)
    expect((await prisma.course.findUnique({ where: { id: courseId } }))!.profileSuggestion).toBeNull()
  })
})
