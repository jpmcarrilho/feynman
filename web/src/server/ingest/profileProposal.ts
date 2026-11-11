// The initial tutor persona of a new studyspace (T25): one structured model call over the outline and a few text samples of the
// ready files, stored as Course.profileSuggestion. It is made on demand, when the owner moves from the outline step to the persona
// step (every initial file is terminal by then and the outline carries the owner's edits), never by the runner.
import { prisma } from '@/lib/db'
import {
  ChatModeEnum, PRESETS, ProfileProposalModelSchema, ProfileUpdateModelSchema, TutorProfileSchema, defaultProfile, normalizeMix, parseProfile,
  type ProfileSuggestion, type QuestionTypeMix, type TutorProfile,
} from '@/lib/studyspace/profile'
import { existingOutline, fitProposalSources, proposeProfilePrompt, profileUpdatePrompt, type ProposalOutlineSource } from '@/lib/prompts/profile'
import { UPDATABLE_FIELDS, fieldChanged, parseSuggestion } from '@/lib/studyspace/suggestion'
import { NOT_STUDY_MATERIAL_PREFIX } from '@/services/exerciseGenerator'
import { splitModuleName } from '@/services/outlineService'
import { StageError, newModelStats, structuredCall, type GenerateObjectFn } from './modelCall'

export type ProposalDeps = { generate?: GenerateObjectFn; now?: () => Date }

export type ProposalRefusal = 'not_found' | 'has_profile' | 'processing' | 'no_ready_source' | 'failed'
export type EnsureProposalResult =
  | { ok: true; suggestion: ProfileSuggestion; reused: boolean }
  | { ok: false; code: ProposalRefusal; reason: string }

type SourceRow = { id: string; originalName: string; status: string; error: string | null }

const terminal = (s: { status: string }) => s.status === 'ready' || s.status === 'failed'

/** Failed files of the first upload, named for the banner. */
export function excludedFrom(sources: SourceRow[]): ProfileSuggestion['excludedSources'] {
  return sources
    .filter((s) => s.status === 'failed')
    .map((s) => ({ id: s.id, name: s.originalName, reason: s.error?.trim() || 'The file could not be processed.' }))
}

const asStringList = (raw: string | null): string[] => {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/**
 * The split offer is kept only when the model says the subjects are not coherent and the groups are usable: at least 2 groups,
 * each naming at least one file, together naming every ready file exactly once (unknown, repeated or missing ids drop the offer).
 */
export function validateSplit(coherent: boolean, groups: { label: string; sourceIds: string[] }[], readyIds: string[]): ProfileSuggestion['split'] {
  if (coherent || groups.length < 2) return null
  const ready = new Set(readyIds)
  const seen = new Set<string>()
  const clean: { label: string; sourceIds: string[] }[] = []
  for (const [i, g] of groups.entries()) {
    const ids = g.sourceIds.filter((id) => typeof id === 'string')
    if (ids.length === 0) return null
    for (const id of ids) {
      if (!ready.has(id) || seen.has(id)) return null
      seen.add(id)
    }
    clean.push({ label: g.label.trim().replace(/\s+/g, ' ').slice(0, 80) || `Group ${i + 1}`, sourceIds: ids })
  }
  if (seen.size !== ready.size) return null
  return { groups: clean }
}

type Assembled = { profile: TutorProfile } | { problem: string }

function assemble(proposed: ReturnType<typeof ProfileProposalModelSchema.parse>['profile'], course: { title: string; goal: string | null }): Assembled {
  const base = defaultProfile(course)
  const tone = proposed.tone
  const modeCheck = ChatModeEnum.safeParse(proposed.defaultChatMode)
  const candidate = {
    ...proposed,
    version: 1 as const,
    toneNotes: (proposed.toneNotes ?? '').trim(),
    defaultChatMode: modeCheck.success ? modeCheck.data : PRESETS[tone].defaultChatMode,
    analogyDomains: [...new Set((proposed.analogyDomains ?? []).map((a) => a.trim()).filter(Boolean))].slice(0, 5),
    questionTypeMix: normalizeMix(proposed.questionTypeMix, { noNumeric: !proposed.quantitative, fallback: base.questionTypeMix }),
    quantitativeQuestionTypeMix: normalizeMix(proposed.quantitativeQuestionTypeMix, { noNumeric: !proposed.quantitative, fallback: base.quantitativeQuestionTypeMix }),
    calibrationModule: null,
    examPreset: null,
    questionTypeCycles: null,
  }
  const parsed = TutorProfileSchema.safeParse(candidate)
  return parsed.success ? { profile: parsed.data } : { problem: `the proposed tutor is not valid (${parsed.error.issues[0]?.path.join('.') || 'profile'})` }
}

const midIndex = (n: number) => Math.floor(n / 2)

const OUTLINE_TOPIC_SELECT = {
  id: true, sourceId: true, title: true, week: true, summary: true, keyTerms: true,
  exercises: { where: { status: 'rejected', reportedReason: { startsWith: NOT_STUDY_MATERIAL_PREFIX } }, select: { id: true }, take: 1 },
} as const
type OutlineTopicRow = {
  id: string; sourceId: string | null; title: string; week: string | null; summary: string | null; keyTerms: string | null; exercises: { id: string }[]
}

/** Outline (study topics only, grouped by module) and two text samples (first and middle study topic) of one file. */
async function outlineOf(src: { id: string; originalName: string }, topicsOfSource: OutlineTopicRow[]): Promise<ProposalOutlineSource> {
  const study = topicsOfSource.filter((t) => t.exercises.length === 0)
  const modules: ProposalOutlineSource['modules'] = []
  for (const t of study) {
    const title = splitModuleName(t.week ?? '').title || 'Topics'
    let m = modules.find((x) => x.title === title)
    if (!m) modules.push((m = { title, topics: [] }))
    m.topics.push({ title: t.title, summary: t.summary, keyTerms: asStringList(t.keyTerms) })
  }
  const pick = [...new Set([0, midIndex(study.length)])].filter((i) => i < study.length)
  const samples: string[] = []
  for (const i of pick) {
    const row = await prisma.topic.findUnique({ where: { id: study[i].id }, select: { content: true } })
    const text = row?.content?.trim()
    if (text) samples.push(text.slice(0, 4_000))
  }
  return { id: src.id, name: src.originalName, modules, samples }
}

/**
 * ONE structured model call. Reads the ready files of the first upload (current topic titles, summaries, key terms; topics marked
 * as not study material are left out; two text samples per file), lists failed files in `excludedSources`, and returns the
 * suggestion WITHOUT storing it. Throws StageError when the model fails twice.
 */
export async function proposeProfile(courseId: string, deps: ProposalDeps = {}): Promise<ProfileSuggestion> {
  const course = await prisma.course.findUnique({ where: { id: courseId }, select: { title: true, goal: true } })
  if (!course) throw new StageError('This studyspace no longer exists.')
  const sources = await prisma.source.findMany({
    where: { courseId, bundle: 'initial' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, originalName: true, status: true, error: true },
  })
  const ready = sources.filter((s) => s.status === 'ready')
  if (ready.length === 0) throw new StageError('No file was processed successfully, so there is nothing to base a tutor on.')

  const topics = await prisma.topic.findMany({
    where: { courseId, sourceId: { in: ready.map((s) => s.id) } }, orderBy: [{ order: 'asc' }, { id: 'asc' }], select: OUTLINE_TOPIC_SELECT,
  })
  const outlineSources: ProposalOutlineSource[] = []
  for (const src of ready) outlineSources.push(await outlineOf(src, topics.filter((t) => t.sourceId === src.id)))

  const prompt = proposeProfilePrompt({ title: course.title, goal: course.goal, sources: fitProposalSources(outlineSources) })
  const stats = newModelStats()
  const answer = await structuredCall({
    generate: deps.generate,
    schema: ProfileProposalModelSchema,
    prompt,
    what: 'The tutor proposal',
    stats,
    check: (o) => {
      const a = assemble(o.profile, course)
      return 'problem' in a ? a.problem : null
    },
  })
  const assembled = assemble(answer.profile, course)
  if ('problem' in assembled) throw new StageError(`The tutor proposal failed (${assembled.problem}).`)

  const names = ready.map((s) => s.originalName)
  const rationale = `Proposed from the outline and text samples of ${ready.length} file${ready.length === 1 ? '' : 's'}: ${names.join(', ')}.`.slice(0, 600)
  return {
    kind: 'initial',
    createdAt: (deps.now?.() ?? new Date()).toISOString(),
    basedOnSourceIds: ready.map((s) => s.id).sort(),
    profile: assembled.profile,
    rationale,
    excludedSources: excludedFrom(sources),
    split: validateSplit(answer.subjectsCoherent, answer.subjectGroups, ready.map((s) => s.id)),
  }
}

export { parseSuggestion }

const sameSet = (a: string[], b: string[]) => a.length === b.length && new Set(a).size === a.length && b.every((x) => a.includes(x))

const inflight = (): Map<string, Promise<EnsureProposalResult>> => {
  // On globalThis so a hot-reloaded copy of this module still sees a call in progress
  const g = globalThis as unknown as { __profileProposalsInflight?: Map<string, Promise<EnsureProposalResult>> }
  return (g.__profileProposalsInflight ??= new Map())
}

async function ensureOnce(courseId: string, deps: ProposalDeps, force: boolean): Promise<EnsureProposalResult> {
  const course = await prisma.course.findUnique({ where: { id: courseId }, select: { profile: true, profileSuggestion: true } })
  if (!course) return { ok: false, code: 'not_found', reason: 'This studyspace no longer exists.' }
  if (parseProfile(course.profile)) return { ok: false, code: 'has_profile', reason: 'This studyspace already has a tutor.' }
  const sources = await prisma.source.findMany({
    where: { courseId, bundle: 'initial' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, originalName: true, status: true, error: true },
  })
  if (sources.some((s) => !terminal(s))) {
    return { ok: false, code: 'processing', reason: 'Some files are still being processed. Wait until they are done, then continue.' }
  }
  const ready = sources.filter((s) => s.status === 'ready').map((s) => s.id)
  if (ready.length === 0) {
    return { ok: false, code: 'no_ready_source', reason: 'No file was processed successfully. Retry or remove the files that failed, or add other files.' }
  }
  const excluded = excludedFrom(sources)
  const stored = parseSuggestion(course.profileSuggestion)
  if (!force && stored && stored.kind === 'initial' && sameSet(stored.basedOnSourceIds, ready)) {
    if (JSON.stringify(stored.excludedSources) === JSON.stringify(excluded)) return { ok: true, suggestion: stored, reused: true }
    // Only the list of failed files changed (one was removed or failed later): no new model call
    const refreshed = { ...stored, excludedSources: excluded }
    await prisma.course.updateMany({ where: { id: courseId, profile: null }, data: { profileSuggestion: JSON.stringify(refreshed) } })
    return { ok: true, suggestion: refreshed, reused: true }
  }
  let suggestion: ProfileSuggestion
  try {
    suggestion = await proposeProfile(courseId, deps)
  } catch (error) {
    const detail = error instanceof StageError ? error.message : 'Something went wrong while contacting the model.'
    if (!(error instanceof StageError)) console.error('[persona] proposal failed:', error)
    return { ok: false, code: 'failed', reason: `${detail} Try again, or start with the default tutor.` }
  }
  // Only stored while the studyspace still has no accepted profile
  const stored2 = await prisma.course.updateMany({ where: { id: courseId, profile: null }, data: { profileSuggestion: JSON.stringify(suggestion) } })
  if (stored2.count !== 1) return { ok: false, code: 'has_profile', reason: 'This studyspace already has a tutor.' }
  return { ok: true, suggestion, reused: false }
}

/**
 * The initial proposal for the persona step. Returns the stored suggestion while it matches the current set of ready files of the
 * first upload; otherwise (no suggestion, other files, or `force` for Regenerate) makes one model call and stores the result.
 * Refuses, with a reason, when the studyspace already has an accepted profile, files are still being processed, or no file is ready.
 * Two concurrent calls for one studyspace share a single model call (in this process).
 */
export function ensureInitialProposal(courseId: string, deps: ProposalDeps = {}, opts: { force?: boolean } = {}): Promise<EnsureProposalResult> {
  const map = inflight()
  const running = map.get(courseId)
  if (running) return running
  const p = ensureOnce(courseId, deps, !!opts.force).finally(() => {
    if (map.get(courseId) === p) map.delete(courseId)
  })
  map.set(courseId, p)
  return p
}

// ---------------------------------------------------------------------------------------------------------------------
// Suggested update after a later upload (T26)
// ---------------------------------------------------------------------------------------------------------------------

type UpdateModelOutput = ReturnType<typeof ProfileUpdateModelSchema.parse>

/**
 * The accepted profile with the fields the model returned laid over it. Only UPDATABLE_FIELDS can change; a field whose value is the
 * same apart from spacing, case, order of domains or a rounding of the shares keeps the accepted value exactly, so it is never listed as
 * changed. Returns the profile and the fields that really differ, or the reason the result is not a valid profile. Pure.
 */
export function applyProfileUpdate(accepted: TutorProfile, o: UpdateModelOutput, ctx: { otherFiles?: boolean } = {}): { profile: TutorProfile; changed: (typeof UPDATABLE_FIELDS)[number][] } | { problem: string } {
  // A file adds to the studyspace, it does not replace it, so some changes are never made from one file, whatever the model says:
  //  - quantitative can go false -> true, never true -> false;
  //  - while quantitative stays true, a mix is not reduced to no numeric questions;
  //  - with other files in the studyspace the content language does not change (they are in the accepted language, and one file in
  //    another language is not a reason to switch the tutor).
  const quantitative = accepted.quantitative || o.quantitative
  const keepNumeric = (proposed: QuestionTypeMix, current: QuestionTypeMix): QuestionTypeMix => {
    const next = normalizeMix(proposed, { fallback: current })
    return quantitative && current.numeric > 0 && next.numeric === 0 ? current : next
  }
  const languageKept = !!ctx.otherFiles && fieldChanged('contentLanguage', accepted, { ...accepted, contentLanguage: o.contentLanguage.trim() })
  const candidate: Record<string, unknown> = {
    ...accepted,
    subject: o.subject.trim(),
    level: o.level,
    tutorIdentity: o.tutorIdentity.trim(),
    analogyDomains: [...new Set(o.analogyDomains.map((a) => a.trim()).filter(Boolean))].slice(0, 5),
    quantitative,
    questionTypeMix: keepNumeric(o.questionTypeMix, accepted.questionTypeMix),
    quantitativeQuestionTypeMix: keepNumeric(o.quantitativeQuestionTypeMix, accepted.quantitativeQuestionTypeMix),
    contentLanguage: languageKept ? accepted.contentLanguage : o.contentLanguage.trim(),
  }
  // A new sample explanation is taken only when the subject or the content language changes, and only a usable one
  const concept = (o.sampleConcept ?? '').trim()
  const explanation = (o.sampleExplanation ?? '').trim()
  const subjectOrLanguage = fieldChanged('subject', accepted, candidate as unknown as TutorProfile) || fieldChanged('contentLanguage', accepted, candidate as unknown as TutorProfile)
  // (a sample written in the language the model wanted is not used when that language was kept out)
  candidate.sampleExplanation = !languageKept && subjectOrLanguage && concept && explanation && explanation.length <= 1200 ? { concept: concept.slice(0, 200), explanation } : accepted.sampleExplanation
  for (const f of UPDATABLE_FIELDS) {
    if (!fieldChanged(f, accepted, candidate as unknown as TutorProfile)) candidate[f] = accepted[f]
  }
  const parsed = TutorProfileSchema.safeParse(candidate)
  if (!parsed.success) return { problem: `the updated tutor is not valid (${parsed.error.issues[0]?.path.join('.') || 'profile'})` }
  return { profile: parsed.data, changed: UPDATABLE_FIELDS.filter((f) => fieldChanged(f, accepted, parsed.data)) }
}

export type UpdateOutcome =
  | { stored: true; suggestion: ProfileSuggestion }
  | { stored: false; reason: 'not_eligible' | 'no_change' | 'failed' | 'superseded' }

/**
 * ONE structured model call: given the accepted profile and the outline and a short sample of the new file, does the file call for a
 * change of the tutor? Stores `ProfileSuggestion { kind: 'update' }` in Course.profileSuggestion only when ALL of these hold:
 *  - the source has bundle `later`, status `ready`, and its studyspace has a stored, valid profile and is not an imported studyspace;
 *  - the model says a change is warranted;
 *  - the profile with the model's fields laid over it validates with TutorProfileSchema and differs from the accepted one in at least
 *    one of subject, level, tutor identity, analogy domains, quantitative flag, the two mixes, content language;
 *  - the accepted profile is still the one that was read (a tutor saved meanwhile wins).
 * A stored update suggestion is replaced by the new one (always built against the accepted profile, never on top of the old
 * suggestion); when the new file warrants nothing, the stored one stays. A failed model call stores nothing and logs one line.
 */
export async function suggestProfileUpdate(courseId: string, sourceId: string, deps: ProposalDeps = {}): Promise<UpdateOutcome> {
  const course = await prisma.course.findUnique({ where: { id: courseId }, select: { title: true, goal: true, profile: true, profileSuggestion: true } })
  const source = await prisma.source.findUnique({ where: { id: sourceId }, select: { id: true, courseId: true, originalName: true, bundle: true, status: true } })
  if (!course || !source || source.courseId !== courseId || source.bundle !== 'later' || source.status !== 'ready') return { stored: false, reason: 'not_eligible' }
  const accepted = parseProfile(course.profile)
  if (!accepted) return { stored: false, reason: 'not_eligible' }
  if ((await prisma.topic.count({ where: { courseId, sourceId: null } })) > 0) return { stored: false, reason: 'not_eligible' }
  const existing = parseSuggestion(course.profileSuggestion)
  if (existing && existing.kind !== 'update') return { stored: false, reason: 'not_eligible' }

  try {
    const topics = await prisma.topic.findMany({ where: { courseId, sourceId }, orderBy: [{ order: 'asc' }, { id: 'asc' }], select: OUTLINE_TOPIC_SELECT })
    const outline = await outlineOf(source, topics)
    if (outline.modules.length === 0) return { stored: false, reason: 'no_change' } // nothing to study in it
    const [fitted] = fitProposalSources([outline])
    // What the studyspace already holds: the tutor is judged for all of it, with the new file added
    const others = await prisma.source.findMany({ where: { courseId, status: 'ready', id: { not: sourceId } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, originalName: true } })
    const otherTopics = others.length === 0 ? [] : await prisma.topic.findMany({ where: { courseId, sourceId: { in: others.map((o) => o.id) } }, orderBy: [{ order: 'asc' }, { id: 'asc' }], select: { sourceId: true, week: true } })
    const existing = existingOutline(others.map((o) => ({
      name: o.originalName,
      modules: [...new Set(otherTopics.filter((t) => t.sourceId === o.id).map((t) => splitModuleName(t.week ?? '').title).filter(Boolean))],
    })))
    const hasOthers = others.length > 0 || (await prisma.topic.count({ where: { courseId, sourceId: null } })) > 0
    const stats = newModelStats()
    const answer = await structuredCall({
      generate: deps.generate,
      schema: ProfileUpdateModelSchema,
      prompt: profileUpdatePrompt({ title: course.title, goal: course.goal, profile: accepted, source: fitted, existing }),
      what: 'The tutor update check',
      stats,
      check: (o) => {
        if (!o.changeWarranted) return null
        const a = applyProfileUpdate(accepted, o, { otherFiles: hasOthers })
        return 'problem' in a ? a.problem : null
      },
    })
    if (!answer.changeWarranted) return { stored: false, reason: 'no_change' }
    const applied = applyProfileUpdate(accepted, answer, { otherFiles: hasOthers })
    if ('problem' in applied || applied.changed.length === 0) return { stored: false, reason: 'no_change' }

    const rationale = (answer.rationale.trim().replace(/\s+/g, ' ') || `The new file "${source.originalName}" suggests a different focus than the current tutor.`).slice(0, 600)
    const suggestion: ProfileSuggestion = {
      kind: 'update',
      createdAt: (deps.now?.() ?? new Date()).toISOString(),
      basedOnSourceIds: [sourceId],
      profile: applied.profile,
      rationale,
      excludedSources: [],
      split: null,
    }
    // The file may have been removed while the model was working: a suggestion about a file that is gone is not stored
    if ((await prisma.source.count({ where: { id: sourceId } })) === 0) return { stored: false, reason: 'not_eligible' }
    const stored = await prisma.course.updateMany({ where: { id: courseId, profile: course.profile }, data: { profileSuggestion: JSON.stringify(suggestion) } })
    return stored.count === 1 ? { stored: true, suggestion } : { stored: false, reason: 'superseded' }
  } catch (error) {
    console.warn(`[persona] tutor update check for source ${sourceId} stored nothing: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown error'}`)
    return { stored: false, reason: 'failed' }
  }
}
