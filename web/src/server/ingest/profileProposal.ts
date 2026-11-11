// The initial tutor persona of a new studyspace (T25): one structured model call over the outline and a few text samples of the
// ready files, stored as Course.profileSuggestion. It is made on demand, when the owner moves from the outline step to the persona
// step (every initial file is terminal by then and the outline carries the owner's edits), never by the runner.
import { prisma } from '@/lib/db'
import {
  ChatModeEnum, PRESETS, ProfileProposalModelSchema, ProfileSuggestionSchema, TutorProfileSchema, defaultProfile, normalizeMix, parseProfile,
  type ProfileSuggestion, type TutorProfile,
} from '@/lib/studyspace/profile'
import { fitProposalSources, proposeProfilePrompt, type ProposalOutlineSource } from '@/lib/prompts/profile'
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
    where: { courseId, sourceId: { in: ready.map((s) => s.id) } },
    orderBy: [{ order: 'asc' }, { id: 'asc' }],
    select: {
      id: true, sourceId: true, title: true, week: true, summary: true, keyTerms: true,
      exercises: { where: { status: 'rejected', reportedReason: { startsWith: NOT_STUDY_MATERIAL_PREFIX } }, select: { id: true }, take: 1 },
    },
  })
  const outlineSources: ProposalOutlineSource[] = []
  for (const src of ready) {
    const study = topics.filter((t) => t.sourceId === src.id && t.exercises.length === 0)
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
    outlineSources.push({ id: src.id, name: src.originalName, modules, samples })
  }

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

export function parseSuggestion(raw: string | null | undefined): ProfileSuggestion | null {
  if (!raw) return null
  try {
    const r = ProfileSuggestionSchema.safeParse(JSON.parse(raw))
    return r.success ? r.data : null
  } catch {
    return null
  }
}

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
