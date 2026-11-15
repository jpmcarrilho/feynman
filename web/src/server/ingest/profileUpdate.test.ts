// The suggested tutor update after a later upload (T26): the model call, when a suggestion is stored, the runner hook, Accept and Ignore.
// A real (temporary) database; the model is replaced by a fake.
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

import { ProfileUpdateModelSchema, TutorProfileSchema, defaultProfile, parseProfile, type TutorProfile } from '@/lib/studyspace/profile'
import { profileChanges } from '@/lib/studyspace/suggestion'
import { NOT_STUDY_MATERIAL_PREFIX } from '@/services/exerciseGenerator'
import { LEGACY_PROFILES } from '@/lib/studyspace/legacyProfiles'

type Prisma = typeof import('@/lib/db').prisma
let prisma: Prisma
let proposal: typeof import('./profileProposal')
let persona: typeof import('./persona')
let hookMod: typeof import('./profileUpdateHook')
let runner: typeof import('./runner')
let n = 0

beforeAll(async () => {
  prisma = (await import('@/lib/db')).prisma
  proposal = await import('./profileProposal')
  persona = await import('./persona')
  hookMod = await import('./profileUpdateHook')
  runner = await import('./runner')
})
afterAll(async () => {
  await prisma.$disconnect()
  fs.rmSync(env.dir, { recursive: true, force: true })
})
let warn: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

const accepted = (over: Partial<TutorProfile> = {}): TutorProfile => ({
  ...defaultProfile({ title: 'Chem' }),
  subject: 'Organic chemistry: reaction mechanisms',
  level: 'undergraduate',
  tutorIdentity: 'an organic chemistry professor',
  tone: 'exam_driller',
  toneNotes: 'Exam style.',
  defaultChatMode: 'probe',
  analogyDomains: ['cooking', 'lego'],
  quantitative: false,
  questionTypeMix: { single_choice: 0.4, multiple_choice: 0.3, numeric: 0, dropdown: 0.3, open: 0 },
  quantitativeQuestionTypeMix: { single_choice: 0.2, multiple_choice: 0.2, numeric: 0.5, dropdown: 0.1, open: 0 },
  contentLanguage: 'en',
  calibrationModule: '02 · Statistical mechanics',
  examPreset: { label: 'Final', questionCount: 40 },
  ...over,
})

/** The model's answer: the fields it may change, copied from `base` unless overridden. */
const answer = (base: TutorProfile, over: Record<string, unknown> = {}) => ({
  changeWarranted: true,
  rationale: 'The new file is a graduate-level statistical mechanics text in Portuguese.',
  subject: base.subject, level: base.level, tutorIdentity: base.tutorIdentity, analogyDomains: base.analogyDomains, quantitative: base.quantitative,
  questionTypeMix: base.questionTypeMix, quantitativeQuestionTypeMix: base.quantitativeQuestionTypeMix, contentLanguage: base.contentLanguage,
  sampleConcept: base.sampleExplanation.concept, sampleExplanation: base.sampleExplanation.explanation, ...over,
})

type Call = { prompt: string; schema: unknown }
function fake(response: unknown | ((c: Call) => unknown), calls: Call[] = []) {
  const fn = (async (args: Call) => {
    calls.push(args)
    const object = typeof response === 'function' ? (response as (c: Call) => unknown)(args) : response
    if (object instanceof Error) throw object
    return { object, usage: { inputTokens: 10, outputTokens: 5 } }
  }) as never
  return { fn, calls }
}

async function makeSpace(opts: { profile?: TutorProfile | null; bundle?: 'initial' | 'later'; status?: string; imported?: boolean; suggestion?: unknown } = {}) {
  const courseId = `pu-${++n}`
  const profile = opts.profile === undefined ? accepted() : opts.profile
  await prisma.course.create({
    data: { id: courseId, code: courseId, title: 'Chem space', goal: 'Pass the final', profile: profile ? JSON.stringify(profile) : null, profileSuggestion: opts.suggestion ? JSON.stringify(opts.suggestion) : null, starterStatus: 'done' },
  })
  if (opts.imported) await prisma.topic.create({ data: { id: `${courseId}-imp`, courseId, order: 0, week: 'Week_01', title: 'Imported', content: 'x' } })
  const sourceId = `${courseId}-s`
  await prisma.source.create({
    data: { id: sourceId, courseId, originalName: 'stat-mech.md', mimeType: 'text/markdown', sizeBytes: 1, storageKey: 'k', bundle: opts.bundle ?? 'later', status: opts.status ?? 'ready' },
  })
  await prisma.topic.create({ data: { id: `${sourceId}-t1`, courseId, sourceId, order: 10, week: '02 · Statistical mechanics', title: 'Partition functions', content: 'The partition function Z sums exp(-E/kT) over states.', summary: 'Z and free energy', keyTerms: '["partition function"]' } })
  await prisma.topic.create({ data: { id: `${sourceId}-t2`, courseId, sourceId, order: 11, week: '02 · Statistical mechanics', title: 'Course logistics', content: 'Grading policy text' } })
  await prisma.exercise.create({ data: { id: `${sourceId}-m`, topicId: `${sourceId}-t2`, questionText: 'm', choices: '[]', correctAnswer: '', isGraded: false, origin: 'generated', status: 'rejected', reportedReason: `${NOT_STUDY_MATERIAL_PREFIX} logistics` } })
  return { courseId, sourceId, profile }
}
const suggestionOf = async (courseId: string) => {
  const raw = (await prisma.course.findUniqueOrThrow({ where: { id: courseId } })).profileSuggestion
  return raw ? JSON.parse(raw) : null
}

describe('suggestProfileUpdate', () => {
  it('stores an update suggestion: the accepted profile with only the changed fields replaced, validated, with the rationale', async () => {
    const { courseId, sourceId, profile } = await makeSpace()
    const { fn, calls } = fake(answer(profile!, { subject: 'Statistical mechanics', level: 'graduate', contentLanguage: 'pt-BR', tutorIdentity: 'a statistical mechanics professor' }))
    const out = await proposal.suggestProfileUpdate(courseId, sourceId, { generate: fn, now: () => new Date('2026-11-12T10:00:00Z') })
    expect(calls).toHaveLength(1)
    expect(calls[0].schema).toBe(ProfileUpdateModelSchema)
    expect(calls[0].prompt).toContain('Partition functions')
    expect(calls[0].prompt).toContain('Organic chemistry: reaction mechanisms') // the accepted profile is in the prompt
    expect(calls[0].prompt).not.toContain('Grading policy text') // not-study topics are left out
    expect(out.stored).toBe(true)
    const stored = await suggestionOf(courseId)
    expect(stored).toMatchObject({ kind: 'update', createdAt: '2026-11-12T10:00:00.000Z', basedOnSourceIds: [sourceId], excludedSources: [], split: null })
    expect(stored.rationale).toMatch(/graduate-level statistical mechanics/)
    const next = TutorProfileSchema.parse(stored.profile)
    expect(next).toMatchObject({ subject: 'Statistical mechanics', level: 'graduate', contentLanguage: 'pt-BR', tutorIdentity: 'a statistical mechanics professor' })
    // everything the owner chose is untouched
    expect(next).toMatchObject({ tone: 'exam_driller', toneNotes: 'Exam style.', defaultChatMode: 'probe', calibrationModule: '02 · Statistical mechanics', examPreset: { label: 'Final', questionCount: 40 } })
    expect(profileChanges(profile!, next).map((c) => c.field)).toEqual(['subject', 'level', 'tutorIdentity', 'contentLanguage'])
    // the accepted profile itself is not touched
    expect(parseProfile((await prisma.course.findUniqueOrThrow({ where: { id: courseId } })).profile)).toEqual(profile)
  })

  it('takes a new sample explanation when the subject or the language changes, lists it as updated, and keeps the old one otherwise', async () => {
    const { courseId, sourceId, profile } = await makeSpace()
    const fresh = { sampleConcept: 'Função de partição', sampleExplanation: 'A função de partição soma os estados ponderados pela energia.' }
    await proposal.suggestProfileUpdate(courseId, sourceId, { generate: fake(answer(profile!, { contentLanguage: 'pt-BR', ...fresh })).fn })
    const next = TutorProfileSchema.parse((await suggestionOf(courseId)).profile)
    expect(next.sampleExplanation).toEqual({ concept: fresh.sampleConcept, explanation: fresh.sampleExplanation })
    expect(profileChanges(profile!, next).map((c) => [c.field, c.to])).toEqual([['contentLanguage', 'pt-BR'], ['sampleExplanation', 'updated']])
    // a new sample without a change of subject or language is ignored; a change with an empty sample keeps the old text
    const b = await makeSpace()
    await proposal.suggestProfileUpdate(b.courseId, b.sourceId, { generate: fake(answer(b.profile!, { level: 'graduate', ...fresh })).fn })
    expect(TutorProfileSchema.parse((await suggestionOf(b.courseId)).profile).sampleExplanation).toEqual(b.profile!.sampleExplanation)
    const c = await makeSpace()
    await proposal.suggestProfileUpdate(c.courseId, c.sourceId, { generate: fake(answer(c.profile!, { subject: 'Thermo', sampleConcept: '', sampleExplanation: '' })).fn })
    expect(TutorProfileSchema.parse((await suggestionOf(c.courseId)).profile).sampleExplanation).toEqual(c.profile!.sampleExplanation)
  })

  it('ignores fields the model may not change (tone, notes, chat mode, calibration module, exam preset) even if it returns them', async () => {
    const { courseId, sourceId, profile } = await makeSpace()
    const sneaky = answer(profile!, { level: 'graduate', tone: 'patient_coach', toneNotes: 'x', defaultChatMode: 'explain', calibrationModule: null, examPreset: null })
    const out = await proposal.suggestProfileUpdate(courseId, sourceId, { generate: fake(sneaky).fn })
    expect(out.stored).toBe(true)
    expect(TutorProfileSchema.parse((await suggestionOf(courseId)).profile)).toEqual({ ...profile, level: 'graduate' })
  })

  it('stores nothing when the model says no change is warranted', async () => {
    const { courseId, sourceId, profile } = await makeSpace()
    const out = await proposal.suggestProfileUpdate(courseId, sourceId, { generate: fake(answer(profile!, { changeWarranted: false, rationale: '' })).fn })
    expect(out).toEqual({ stored: false, reason: 'no_change' })
    expect(await suggestionOf(courseId)).toBeNull()
  })

  it('stores nothing when the result does not differ from the accepted profile, also when the model only re-spaces, re-orders or re-rounds', async () => {
    const { courseId, sourceId, profile } = await makeSpace()
    const same = answer(profile!, {
      subject: `  ${profile!.subject}  `, analogyDomains: ['Lego', ' cooking '],
      questionTypeMix: { single_choice: 0.4004, multiple_choice: 0.2996, numeric: 0, dropdown: 0.3 },
    })
    const out = await proposal.suggestProfileUpdate(courseId, sourceId, { generate: fake(same).fn })
    expect(out).toEqual({ stored: false, reason: 'no_change' })
    expect(await suggestionOf(courseId)).toBeNull()
  })

  it('stores nothing when the changed profile does not validate (the call is retried once, then given up with one log line)', async () => {
    const { courseId, sourceId, profile } = await makeSpace()
    const { fn, calls } = fake(answer(profile!, { subject: '' }))
    const out = await proposal.suggestProfileUpdate(courseId, sourceId, { generate: fn })
    expect(out).toEqual({ stored: false, reason: 'failed' })
    expect(calls).toHaveLength(2)
    expect(await suggestionOf(courseId)).toBeNull()
  })

  it('a failed model call stores nothing, keeps a pending suggestion and logs one line', async () => {
    const pending = { kind: 'update', createdAt: '2026-11-11T00:00:00.000Z', basedOnSourceIds: ['x'], profile: accepted({ level: 'graduate' }), rationale: 'Earlier.', excludedSources: [], split: null }
    const { courseId, sourceId } = await makeSpace({ suggestion: pending })
    warn.mockClear()
    const out = await proposal.suggestProfileUpdate(courseId, sourceId, { generate: fake(new Error('503 overloaded')).fn })
    expect(out).toEqual({ stored: false, reason: 'failed' })
    expect(await suggestionOf(courseId)).toEqual(pending)
    expect(warn.mock.calls.filter((c: unknown[]) => String(c[0]).startsWith('[persona]'))).toHaveLength(1)
  })

  it('a newer finished file makes a fresh suggestion against the accepted profile and replaces the stored one; a file that warrants nothing leaves it', async () => {
    const pending = { kind: 'update', createdAt: '2026-11-11T00:00:00.000Z', basedOnSourceIds: ['old'], profile: accepted({ level: 'graduate' }), rationale: 'From the first file.', excludedSources: [], split: null }
    const { courseId, sourceId, profile } = await makeSpace({ suggestion: pending })
    const none = await proposal.suggestProfileUpdate(courseId, sourceId, { generate: fake(answer(profile!, { changeWarranted: false })).fn })
    expect(none.stored).toBe(false)
    expect((await suggestionOf(courseId)).rationale).toBe('From the first file.')

    const { fn, calls } = fake(answer(profile!, { subject: 'Thermodynamics' }))
    const out = await proposal.suggestProfileUpdate(courseId, sourceId, { generate: fn })
    expect(out.stored).toBe(true)
    expect(calls[0].prompt).not.toContain('From the first file.')
    const now = await suggestionOf(courseId)
    expect(now.profile.subject).toBe('Thermodynamics')
    expect(now.profile.level).toBe('undergraduate') // against the accepted profile, not on top of the old suggestion
    expect(now.basedOnSourceIds).toEqual([sourceId])
  })

  it('judges the tutor for the whole studyspace: it prompts with the files already there and never turns quantitative off or the language over from one file', async () => {
    const q = accepted({ quantitative: true, contentLanguage: 'pt-BR', level: 'undergraduate', questionTypeMix: { single_choice: 0.25, multiple_choice: 0.25, numeric: 0.25, dropdown: 0.25, open: 0 } })
    const a = await makeSpace({ profile: q })
    await prisma.source.create({ data: { id: `${a.courseId}-old`, courseId: a.courseId, originalName: 'calculus-notes.pdf', mimeType: 'application/pdf', sizeBytes: 1, storageKey: 'k', bundle: 'initial', status: 'ready' } })
    await prisma.topic.create({ data: { id: `${a.courseId}-oldt`, courseId: a.courseId, sourceId: `${a.courseId}-old`, order: 1, week: '01 · Optimisation problems', title: 'Lagrange', content: 'x' } })
    const { fn, calls } = fake(answer(q, { quantitative: false, contentLanguage: 'en', level: 'intro', questionTypeMix: { single_choice: 0.5, multiple_choice: 0.5, numeric: 0, dropdown: 0 } }))
    await proposal.suggestProfileUpdate(a.courseId, a.sourceId, { generate: fn })
    expect(calls[0].prompt).toContain('calculus-notes.pdf: Optimisation problems')
    expect(calls[0].prompt).toMatch(/whole studyspace/)
    const next = TutorProfileSchema.parse((await suggestionOf(a.courseId)).profile)
    expect(next).toMatchObject({ quantitative: true, contentLanguage: 'pt-BR', level: 'intro' })
    expect(next.questionTypeMix).toEqual(q.questionTypeMix) // numeric not reduced to zero
  })

  it('a removed source is not suggested about, and removing the file clears the suggestion that came from it', async () => {
    const { courseId, sourceId, profile } = await makeSpace()
    await proposal.suggestProfileUpdate(courseId, sourceId, { generate: fake(answer(profile!, { level: 'graduate' })).fn })
    expect((await suggestionOf(courseId)).basedOnSourceIds).toEqual([sourceId])
    const admin = await import('./admin')
    expect(await admin.removeSource(sourceId)).toEqual({ ok: true })
    expect(await suggestionOf(courseId)).toBeNull()
    // a suggestion based on another file survives the removal; an initial proposal is left alone
    const b = await makeSpace()
    const other = { kind: 'update', createdAt: '2026-11-12T10:00:00.000Z', basedOnSourceIds: ['someone-else'], profile: b.profile, rationale: 'r', excludedSources: [], split: null }
    await prisma.course.update({ where: { id: b.courseId }, data: { profileSuggestion: JSON.stringify(other) } })
    await admin.removeSource(b.sourceId)
    expect(await suggestionOf(b.courseId)).toEqual(JSON.parse(JSON.stringify(other)))
    const c = await makeSpace()
    const initial = { ...other, kind: 'initial', basedOnSourceIds: [c.sourceId] }
    await prisma.course.update({ where: { id: c.courseId }, data: { profileSuggestion: JSON.stringify(initial) } })
    await admin.removeSource(c.sourceId)
    expect(await suggestionOf(c.courseId)).toEqual(JSON.parse(JSON.stringify(initial)))
  })

  describe('applyProfileUpdate rules', () => {
    const base = accepted({ quantitative: true, contentLanguage: 'pt-BR', questionTypeMix: { single_choice: 0.25, multiple_choice: 0.25, numeric: 0.25, dropdown: 0.25, open: 0 } })
    const ask = (over: Record<string, unknown>) => answer(base, over) as never
    describe('with a written-answer share', () => {
      const withOpen = accepted({
        quantitative: true,
        questionTypeMix: { single_choice: 0.3, multiple_choice: 0.25, numeric: 0.05, dropdown: 0.2, open: 0.2 },
        quantitativeQuestionTypeMix: { single_choice: 0.2, multiple_choice: 0.15, numeric: 0.45, dropdown: 0.1, open: 0.1 },
      })
      const sum = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0)
      it("keeps the owner's open share and rescales the model's four shares into what is left", () => {
        const r = proposal.applyProfileUpdate(withOpen, answer(withOpen, { level: 'graduate', questionTypeMix: { single_choice: 0.5, multiple_choice: 0.25, numeric: 0.25, dropdown: 0 } }) as never)
        if (!('profile' in r)) throw new Error(r.problem)
        const m = r.profile.questionTypeMix
        expect(m.open).toBe(0.2)
        expect(m.single_choice).toBeCloseTo(0.4, 10)
        expect(m.multiple_choice).toBeCloseTo(0.2, 10)
        expect(m.numeric).toBeCloseTo(0.2, 10)
        expect(m.dropdown).toBe(0)
        expect(sum(m)).toBeCloseTo(1, 10)
        expect(r.changed).toEqual(['level', 'questionTypeMix'])
      })
      it('reports no change when the four shares differ from the accepted ones only by rounding', () => {
        const four = (m: typeof withOpen.questionTypeMix) => {
          const rest = 1 - m.open
          return { single_choice: Math.round((m.single_choice / rest) * 100) / 100, multiple_choice: Math.round((m.multiple_choice / rest) * 100) / 100, numeric: Math.round((m.numeric / rest) * 100) / 100, dropdown: Math.round((m.dropdown / rest) * 100) / 100 }
        }
        const r = proposal.applyProfileUpdate(withOpen, answer(withOpen, { level: 'graduate', questionTypeMix: four(withOpen.questionTypeMix), quantitativeQuestionTypeMix: four(withOpen.quantitativeQuestionTypeMix) }) as never)
        if (!('profile' in r)) throw new Error(r.problem)
        expect(r.changed).toEqual(['level'])
        expect(r.profile.questionTypeMix).toEqual(withOpen.questionTypeMix)
        expect(r.profile.quantitativeQuestionTypeMix).toEqual(withOpen.quantitativeQuestionTypeMix)
      })
      it('still never zeroes numeric while quantitative, and the banner text shows the open share', () => {
        const r = proposal.applyProfileUpdate(withOpen, answer(withOpen, { level: 'graduate', quantitativeQuestionTypeMix: { single_choice: 1, multiple_choice: 0, numeric: 0, dropdown: 0 } }) as never)
        if (!('profile' in r)) throw new Error(r.problem)
        expect(r.profile.quantitativeQuestionTypeMix).toEqual(withOpen.quantitativeQuestionTypeMix)
        const flat = accepted({ quantitative: false, questionTypeMix: { single_choice: 0.3, multiple_choice: 0.25, numeric: 0, dropdown: 0.25, open: 0.2 } })
        const shown = profileChanges(flat, applyChanged(flat, { questionTypeMix: { single_choice: 1, multiple_choice: 0, numeric: 0, dropdown: 0 } }))
        expect(shown).toEqual([{ field: 'questionTypeMix', label: 'Question types (concepts)', from: 'single choice 30%, multiple choice 25%, dropdown 25%, open answer 20%', to: 'single choice 80%, open answer 20%' }])
      })
      it('an owner who set everything to open keeps it', () => {
        const allOpen = accepted({ quantitative: false, questionTypeMix: { single_choice: 0, multiple_choice: 0, numeric: 0, dropdown: 0, open: 1 } })
        const r = proposal.applyProfileUpdate(allOpen, answer(allOpen, { level: 'graduate', questionTypeMix: { single_choice: 1, multiple_choice: 0, numeric: 0, dropdown: 0 } }) as never)
        if (!('profile' in r)) throw new Error(r.problem)
        expect(r.profile.questionTypeMix).toEqual(allOpen.questionTypeMix)
      })
      const applyChanged = (p: TutorProfile, over: Record<string, unknown>) => {
        const r = proposal.applyProfileUpdate(p, answer(p, over) as never)
        if (!('profile' in r)) throw new Error(r.problem)
        return r.profile
      }
    })
    it('quantitative goes false -> true but never true -> false', () => {
      const off = proposal.applyProfileUpdate(base, ask({ quantitative: false, level: 'graduate' }))
      expect('profile' in off && off.profile.quantitative).toBe(true)
      const flat = accepted({ quantitative: false })
      const on = proposal.applyProfileUpdate(flat, answer(flat, { quantitative: true }) as never)
      expect('profile' in on && on.profile.quantitative).toBe(true)
    })
    it('does not reduce a mix to no numeric questions while quantitative stays true', () => {
      const r = proposal.applyProfileUpdate(base, ask({ level: 'graduate', quantitativeQuestionTypeMix: { single_choice: 1, multiple_choice: 0, numeric: 0, dropdown: 0 } }))
      expect('profile' in r && r.profile.quantitativeQuestionTypeMix).toEqual(base.quantitativeQuestionTypeMix)
    })
    it('the language changes only when there are no other files, and then the model sample is used; with other files the sample stays too', () => {
      const change = ask({ contentLanguage: 'en', sampleConcept: 'Entropy', sampleExplanation: 'Entropy counts microstates.' })
      const alone = proposal.applyProfileUpdate(base, change)
      expect('profile' in alone && [alone.profile.contentLanguage, alone.profile.sampleExplanation.concept]).toEqual(['en', 'Entropy'])
      const withOthers = proposal.applyProfileUpdate(base, ask({ contentLanguage: 'en', level: 'intro', sampleConcept: 'Entropy', sampleExplanation: 'Entropy counts microstates.' }), { otherFiles: true })
      expect('profile' in withOthers && [withOthers.profile.contentLanguage, withOthers.profile.level, withOthers.profile.sampleExplanation]).toEqual(['pt-BR', 'intro', base.sampleExplanation])
    })
    it('reports nothing changed when every requested change was refused', () => {
      const r = proposal.applyProfileUpdate(base, ask({ quantitative: false, contentLanguage: 'en' }), { otherFiles: true })
      expect('changed' in r && r.changed).toEqual([])
    })
  })

  it.each([
    ['an initial file', { bundle: 'initial' as const }],
    ['a file that is not ready', { status: 'segmenting' }],
    ['a studyspace without an accepted profile', { profile: null }],
    ['an imported studyspace', { imported: true }],
  ])('never asks the model for %s', async (_name, opts) => {
    const { courseId, sourceId } = await makeSpace(opts)
    const { fn, calls } = fake(answer(accepted(), { level: 'graduate' }))
    const out = await proposal.suggestProfileUpdate(courseId, sourceId, { generate: fn })
    expect(out).toEqual({ stored: false, reason: 'not_eligible' })
    expect(calls).toHaveLength(0)
    expect(await suggestionOf(courseId)).toBeNull()
  })

  it('does not overwrite the tutor or the suggestion when the owner saved a different tutor while the model was working', async () => {
    const { courseId, sourceId, profile } = await makeSpace()
    const generate = (async () => {
      await prisma.course.update({ where: { id: courseId }, data: { profile: JSON.stringify({ ...profile, tone: 'patient_coach' }) } })
      return { object: answer(profile!, { level: 'graduate' }), usage: {} }
    }) as never
    const out = await proposal.suggestProfileUpdate(courseId, sourceId, { generate })
    expect(out).toEqual({ stored: false, reason: 'superseded' })
    expect(await suggestionOf(courseId)).toBeNull()
  })

  it('caps the prompt like the initial proposal: a huge outline and sample stay within about 24,000 characters', async () => {
    const { courseId, sourceId, profile } = await makeSpace()
    for (let i = 0; i < 400; i++) {
      await prisma.topic.create({ data: { id: `${sourceId}-big${i}`, courseId, sourceId, order: 100 + i, week: `0${3 + (i % 5)} · Module ${i % 5}`, title: `Topic number ${i} about ${'x'.repeat(60)}`, content: 'y'.repeat(20_000), summary: 's'.repeat(400), keyTerms: '["a","b","c","d","e","f"]' } })
    }
    const { fn, calls } = fake(answer(profile!, { changeWarranted: false }))
    await proposal.suggestProfileUpdate(courseId, sourceId, { generate: fn })
    expect(calls[0].prompt.length).toBeLessThan(24_000)
    expect(calls[0].prompt).toContain('more topic')
  })
})

describe('the runner hook', () => {
  it('reports the check as pending until it has settled', async () => {
    const { isUpdateCheckPending } = await import('./updateCheckState')
    const { courseId, sourceId, profile } = await makeSpace()
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const h = hookMod.registerProfileUpdateHook({ generate: (async () => { await gate; return { object: answer(profile!, { level: 'graduate' }), usage: {} } }) as never })
    try {
      const hook = (globalThis as unknown as { __feynmanIngestRunner: { terminalHooks: Map<string, (i: unknown) => Promise<void>> } }).__feynmanIngestRunner.terminalHooks.get('profileUpdate')!
      expect(isUpdateCheckPending(courseId)).toBe(false)
      await hook({ courseId, sourceId, status: 'ready' })
      expect(isUpdateCheckPending(courseId)).toBe(true)
      release()
      await h.whenSettled()
      expect(isUpdateCheckPending(courseId)).toBe(false)
    } finally {
      h.unregister()
    }
  })

  it('runs the update check only for a ready later source, in the background, and reports a failure without throwing', async () => {
    const { courseId, sourceId, profile } = await makeSpace()
    const { fn, calls } = fake(answer(profile!, { level: 'graduate' }))
    const h = hookMod.registerProfileUpdateHook({ generate: fn })
    try {
      const hooks = (globalThis as unknown as { __feynmanIngestRunner: { terminalHooks: Map<string, (i: unknown) => Promise<void>> } }).__feynmanIngestRunner.terminalHooks
      expect([...hooks.keys()]).toContain('profileUpdate')
      await hooks.get('profileUpdate')!({ courseId, sourceId, status: 'failed' })
      await h.whenSettled()
      expect(calls).toHaveLength(0)
      await hooks.get('profileUpdate')!({ courseId, sourceId, status: 'ready' })
      await h.whenSettled()
      expect(calls).toHaveLength(1)
      expect((await suggestionOf(courseId)).kind).toBe('update')
    } finally {
      h.unregister()
    }
    // registering twice leaves one hook under the name
    const a = hookMod.registerProfileUpdateHook()
    const b = hookMod.registerProfileUpdateHook()
    expect([...(globalThis as unknown as { __feynmanIngestRunner: { terminalHooks: Map<string, unknown> } }).__feynmanIngestRunner.terminalHooks.keys()].filter((k) => k === 'profileUpdate')).toHaveLength(1)
    a.unregister()
    b.unregister()
    expect(typeof runner.onSourceTerminal).toBe('function')
  })

  it('checks the files of one studyspace in the order they finished, so the newer suggestion wins', async () => {
    const { courseId, sourceId, profile } = await makeSpace()
    const second = `${sourceId}-b`
    await prisma.source.create({ data: { id: second, courseId, originalName: 'second.md', mimeType: 'text/markdown', sizeBytes: 1, storageKey: 'k2', bundle: 'later', status: 'ready' } })
    await prisma.topic.create({ data: { id: `${second}-t`, courseId, sourceId: second, order: 50, week: '03 · More', title: 'Entropy', content: 'Entropy is the log of the number of microstates.' } })
    let k = 0
    const h = hookMod.registerProfileUpdateHook({
      generate: (async () => {
        const subject = `Subject ${++k}`
        await new Promise((r) => setTimeout(r, k === 1 ? 30 : 0)) // the first call is the slow one
        return { object: answer(profile!, { subject }), usage: {} }
      }) as never,
    })
    try {
      const hook = (globalThis as unknown as { __feynmanIngestRunner: { terminalHooks: Map<string, (i: unknown) => Promise<void>> } }).__feynmanIngestRunner.terminalHooks.get('profileUpdate')!
      await hook({ courseId, sourceId, status: 'ready' })
      await hook({ courseId, sourceId: second, status: 'ready' })
      await h.whenSettled()
    } finally {
      h.unregister()
    }
    expect((await suggestionOf(courseId)).profile.subject).toBe('Subject 2')
    expect((await suggestionOf(courseId)).basedOnSourceIds).toEqual([second])
  })
})

describe('Accept and Ignore of an update', () => {
  const pendingFor = (profile: TutorProfile, over: Record<string, unknown> = {}) => ({
    kind: 'update', createdAt: '2026-11-12T10:00:00.000Z', basedOnSourceIds: ['s'], profile: { ...profile, level: 'graduate', subject: 'Statistical mechanics' }, rationale: 'Because.', excludedSources: [], split: null, ...over,
  })

  it('Accept writes exactly the suggested profile, clears the suggestion and requests no starter run', async () => {
    const profile = accepted()
    const { courseId } = await makeSpace({ suggestion: pendingFor(profile) })
    await prisma.course.update({ where: { id: courseId }, data: { starterStatus: 'failed' } }) // acceptProfile would restart a failed run
    const result = await persona.acceptUpdateSuggestion(courseId, '2026-11-12T10:00:00.000Z')
    expect(result).toEqual({ ok: true })
    const row = await prisma.course.findUniqueOrThrow({ where: { id: courseId } })
    expect(row.profileSuggestion).toBeNull()
    expect(parseProfile(row.profile)).toEqual({ ...profile, level: 'graduate', subject: 'Statistical mechanics' })
    expect(row.starterStatus).toBe('failed') // untouched: no starter run was requested
  })

  it('Accept refuses a suggestion that was replaced meanwhile, and one that is not an update', async () => {
    const profile = accepted()
    const { courseId } = await makeSpace({ suggestion: pendingFor(profile) })
    expect(await persona.acceptUpdateSuggestion(courseId, '2020-01-01T00:00:00.000Z')).toEqual({ ok: false, reason: persona.SUGGESTION_CHANGED_REASON })
    expect(parseProfile((await prisma.course.findUniqueOrThrow({ where: { id: courseId } })).profile)).toEqual(profile)
    await prisma.course.update({ where: { id: courseId }, data: { profileSuggestion: JSON.stringify(pendingFor(profile, { kind: 'initial' })) } })
    expect((await persona.acceptUpdateSuggestion(courseId, '2026-11-12T10:00:00.000Z')).ok).toBe(false)
    expect((await persona.acceptUpdateSuggestion('missing', 'x')).ok).toBe(false)
  })

  it('Ignore removes only the suggestion the owner saw and leaves the profile alone', async () => {
    const profile = accepted()
    const { courseId } = await makeSpace({ suggestion: pendingFor(profile) })
    expect(await persona.dismissSuggestion(courseId, '2020-01-01T00:00:00.000Z')).toEqual({ ok: true })
    expect(await suggestionOf(courseId)).not.toBeNull() // a newer one stays
    expect(await persona.dismissSuggestion(courseId, '2026-11-12T10:00:00.000Z')).toEqual({ ok: true })
    expect(await suggestionOf(courseId)).toBeNull()
    expect(parseProfile((await prisma.course.findUniqueOrThrow({ where: { id: courseId } })).profile)).toEqual(profile)
    expect(await persona.dismissSuggestion('missing')).toEqual({ ok: false, reason: 'Studyspace not found.' })
  })

  it('an imported studyspace can never accept an update (and none is ever stored for it)', async () => {
    const legacy = LEGACY_PROFILES['14.750x'] ?? Object.values(LEGACY_PROFILES)[0]
    const { courseId } = await makeSpace({ profile: legacy, imported: true, suggestion: pendingFor(legacy) })
    const result = await persona.acceptUpdateSuggestion(courseId, '2026-11-12T10:00:00.000Z')
    expect(result).toEqual({ ok: false, reason: persona.IMPORTED_TUTOR_REASON })
    expect(parseProfile((await prisma.course.findUniqueOrThrow({ where: { id: courseId } })).profile)).toEqual(legacy)
  })
})
